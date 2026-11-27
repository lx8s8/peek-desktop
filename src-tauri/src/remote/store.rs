use crate::{
    protocol::session::{Header, Result, parse_timestamp_micros},
    session::{LiveInfo, MAX_ENTRIES, Session, SessionSummary, StoredEntry, spill::SpillStore},
};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

pub const MAX_LIVE_SESSIONS: usize = 8;
pub(crate) const MAX_LIVE_BYTES: usize = 8 * 1024 * 1024;
const MAX_LIVE_ENTRIES: usize = 10_000;

pub struct LiveSession {
    pub device_id: String,
    pub network_id: String,
    pub connection_id: String,
    pub current: Session,
    pub staging: Option<Session>,
    /// 磁盘溢出冷存储：热内存满 8 MiB / 10,000 条后自动转存旧记录，支持清屏后完整回溯。
    pub spill: SpillStore,
    pub staging_spill: Option<SpillStore>,
    pub generation: u64,
    pub version: u64,
    pub online: bool,
    pub dropped: u64,
    pub evicted: u64,
    pub sender: mpsc::Sender<Value>,
    pub cancel: CancellationToken,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn retention_is_bounded_and_stale_connections_cannot_clear_a_replacement() {
        let mut store = LiveStore::default();
        let header =
            json!({"peekVersion":"2.1.1","platform":"macos","startedAt":"2026-11-13T00:00:00Z"});
        let (tx, _rx) = mpsc::channel(16);
        let key = store
            .begin(
                "device",
                "run",
                "old",
                header.clone(),
                tx.clone(),
                CancellationToken::new(),
            )
            .unwrap();
        for index in 0..=MAX_LIVE_ENTRIES {
            let raw = json!({"id":index.to_string(),"source":"synthetic","startedAt":"2026-11-13T00:00:00Z","request":{"method":"GET","url":"https://synthetic.example.test"}}).to_string();
            store
                .upsert(&key, "old", StoredEntry::parse(&raw).unwrap())
                .unwrap();
        }
        store.synced(&key, "old");
        let session = &store.sessions[&key];
        assert!(session.current.entries.len() <= MAX_LIVE_ENTRIES);
        assert!(session.current.raw_bytes <= MAX_LIVE_BYTES);
        assert!(session.evicted > 0);
        assert!(session.current.entry("0").is_none());
        let retained = session.current.entries.len();
        store
            .begin("device", "run", "new", header, tx, CancellationToken::new())
            .unwrap();
        store.clear(&key, "old");
        store.disconnect(&key, "old");
        assert_eq!(store.sessions[&key].current.entries.len(), retained);
        assert!(store.sessions[&key].online);
        assert_eq!(store.sessions[&key].generation, 2);
    }

    #[test]
    fn capacity_auto_evicts_oldest_offline_session_and_snapshot_merges_spill() {
        let mut store = LiveStore::default();
        let (tx, _rx) = mpsc::channel(16);
        let mut keys = Vec::new();
        for idx in 0..MAX_LIVE_SESSIONS {
            let header = json!({
                "peekVersion":"2.1.1",
                "platform":"ios",
                "startedAt": format!("2026-11-27T01:0{idx}:00Z")
            });
            let key = store
                .begin(
                    "dev-1",
                    &format!("run-{idx}"),
                    &format!("conn-{idx}"),
                    header,
                    tx.clone(),
                    CancellationToken::new(),
                )
                .unwrap();
            keys.push(key);
        }
        // 将第 1 条（最早）设为离线，第 9 次新连接应自动淘汰该离线运行而不报错
        store.disconnect(&keys[0], "conn-0");
        let ninth_header =
            json!({"peekVersion":"2.1.1","platform":"ios","startedAt":"2026-11-27T02:00:00Z"});
        let (ninth_key, evicted) = store
            .begin_with_eviction(
                "dev-1",
                "run-8",
                "conn-8",
                ninth_header,
                tx.clone(),
                CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(evicted.as_deref(), Some(keys[0].as_str()));
        assert!(!store.sessions.contains_key(&keys[0]));
        assert!(store.sessions.contains_key(&ninth_key));

        // 8 个会话全在线时再连第 9 个，仍应受容量上限拒绝
        let tenth_header =
            json!({"peekVersion":"2.1.1","platform":"ios","startedAt":"2026-11-27T02:05:00Z"});
        let rejected = store.begin_with_eviction(
            "dev-1",
            "run-9",
            "conn-9",
            tenth_header,
            tx,
            CancellationToken::new(),
        );
        assert_eq!(rejected.err().as_deref(), Some("liveCapacity"));

        // 验证冷存储导出合并：向冷区写入一条早期记录后，snapshot_session(true) 应完整包含冷热两层
        let session = store.sessions.get_mut(&ninth_key).unwrap();
        session.staging = None;
        let old_raw = json!({"id":"cold-1","source":"dio","startedAt":"2026-11-27T02:00:01Z","request":{"method":"GET","url":"https://api.example.test/old"}}).to_string();
        let old_entry = StoredEntry::parse(&old_raw).unwrap();
        session.spill.push(
            old_entry.row,
            old_entry.search,
            old_entry.started_at_micros,
            old_entry.response_fields,
            &old_entry.raw,
        );
        let hot_raw = json!({"id":"hot-1","source":"dio","startedAt":"2026-11-27T02:00:02Z","request":{"method":"GET","url":"https://api.example.test/hot"}}).to_string();
        session
            .current
            .upsert(StoredEntry::parse(&hot_raw).unwrap());
        let merged = session.snapshot_session(true, 1024 * 1024);
        assert_eq!(merged.entries.len(), 2);
        assert!(merged.entry("cold-1").is_some());
        assert!(merged.entry("hot-1").is_some());
    }
}
pub struct PendingBody {
    pub session_id: String,
    pub entry_id: String,
    pub side: String,
    pub connection_id: String,
    pub generation: u64,
    pub original: Arc<str>,
    pub reply: oneshot::Sender<Result<()>>,
}
#[derive(Default)]
pub struct LiveStore {
    pub sessions: HashMap<String, LiveSession>,
    pub pending: HashMap<String, PendingBody>,
}

pub fn session_key(device_id: &str, network_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash: String = Sha256::digest(format!("{device_id}\0{network_id}"))
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("live-{hash}")
}

impl LiveSession {
    /// 构建可导出的完整会话快照；开启 `include_spill` 时将磁盘冷存记录按 `seq` 合并进结果（严守文件容量上限）。
    pub fn snapshot_session(&mut self, include_spill: bool, max_bytes: usize) -> Session {
        if !include_spill || self.spill.is_empty() {
            return self.current.clone();
        }
        let budget_bytes = max_bytes.saturating_sub(self.current.raw_bytes);
        let budget_entries = MAX_ENTRIES.saturating_sub(self.current.entries.len());
        let cold_entries = self.spill.export_entries(budget_entries, budget_bytes);
        if cold_entries.is_empty() {
            return self.current.clone();
        }
        let mut merged = Session::empty(
            self.current.header.clone(),
            self.current.raw_header.to_string(),
        );
        merged.skipped = self.current.skipped;
        let mut combined = Vec::with_capacity(cold_entries.len() + self.current.entries.len());
        combined.extend(cold_entries);
        combined.extend(self.current.entries.iter().cloned());
        combined.sort_by_key(|entry| entry.row.seq);
        for entry in combined {
            let seq = entry.row.seq;
            let pinned = entry.row.pinned;
            merged.upsert_with_inherited(entry, Some((seq, pinned)));
        }
        merged
    }
}

impl LiveStore {
    /// 是否存在可被自动回收的离线会话（用于容量满时的准入判定）。
    pub fn has_evictable_offline(&self) -> bool {
        self.sessions.values().any(|session| !session.online)
    }

    /// 按优先级自动回收一条离线会话：优先同设备空离线 -> 同设备最早离线 -> 全局空离线 -> 全局最早离线。
    pub fn evict_oldest_offline(&mut self, preferred_device_id: &str) -> Option<String> {
        let candidate = self
            .sessions
            .iter()
            .filter(|(_, session)| !session.online)
            .min_by_key(|(key, session)| {
                let different_device = session.device_id != preferred_device_id;
                let has_entries = !session.current.entries.is_empty() || !session.spill.is_empty();
                let started_micros = parse_timestamp_micros(&session.current.header.started_at);
                (
                    different_device,
                    has_entries,
                    started_micros,
                    session.version,
                    (*key).clone(),
                )
            })
            .map(|(key, _)| key.clone())?;
        self.cancel_pending(&candidate, "sessionNotFound");
        if let Some(removed) = self.sessions.remove(&candidate) {
            removed.cancel.cancel();
        }
        Some(candidate)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn begin(
        &mut self,
        device_id: &str,
        network_id: &str,
        connection_id: &str,
        header: Value,
        sender: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<String> {
        self.begin_with_eviction(device_id, network_id, connection_id, header, sender, cancel)
            .map(|(key, _)| key)
    }

    /// 建立或复用实时会话；容量触顶时自动回收最早离线会话并返回 `(当前会话 key, 被回收离线会话 key)`。
    #[allow(clippy::too_many_arguments)]
    pub fn begin_with_eviction(
        &mut self,
        device_id: &str,
        network_id: &str,
        connection_id: &str,
        mut header: Value,
        sender: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<(String, Option<String>)> {
        if network_id.is_empty() || network_id.len() > 256 {
            return Err("invalidSessionId".into());
        }
        let parsed = Header::parse_session(&header, 1)?;
        if parsed.name.as_ref().is_some_and(|name| name.len() > 256) {
            return Err("invalidSessionName".into());
        }
        header["format"] = "peek".into();
        header["formatVersion"] = 1.into();
        let raw = header.to_string();
        let key = session_key(device_id, network_id);
        let mut evicted_key = None;
        if !self.sessions.contains_key(&key) && self.sessions.len() >= MAX_LIVE_SESSIONS {
            evicted_key = self.evict_oldest_offline(device_id);
            if evicted_key.is_none() {
                return Err("liveCapacity".into());
            }
        }
        if let Some(session) = self.sessions.get_mut(&key) {
            session.cancel.cancel();
            session.generation += 1;
            session.version += 1;
            session.connection_id = connection_id.into();
            session.online = true;
            session.sender = sender;
            session.cancel = cancel;
            session.staging = Some(Session::empty(parsed, raw));
            session.staging_spill = Some(SpillStore::default());
        } else {
            self.sessions.insert(
                key.clone(),
                LiveSession {
                    device_id: device_id.into(),
                    network_id: network_id.into(),
                    connection_id: connection_id.into(),
                    current: Session::empty(parsed.clone(), raw.clone()),
                    staging: Some(Session::empty(parsed, raw)),
                    spill: SpillStore::default(),
                    staging_spill: Some(SpillStore::default()),
                    generation: 1,
                    version: 1,
                    online: true,
                    dropped: 0,
                    evicted: 0,
                    sender,
                    cancel,
                },
            );
        }
        self.cancel_pending(&key, "bodyStale");
        Ok((key, evicted_key))
    }
    pub fn active_mut(&mut self, key: &str, connection_id: &str) -> Option<&mut LiveSession> {
        self.sessions
            .get_mut(key)
            .filter(|s| s.online && s.connection_id == connection_id)
    }
    pub fn upsert(&mut self, key: &str, connection_id: &str, entry: StoredEntry) -> Result<()> {
        let session = self
            .active_mut(key, connection_id)
            .ok_or("staleConnection")?;
        if entry.raw.len() + session.current.raw_header.len() > MAX_LIVE_BYTES {
            return Err("entryTooLarge".into());
        }
        let (target, spill) = if let Some(staging) = session.staging.as_mut() {
            let staging_spill = session
                .staging_spill
                .get_or_insert_with(SpillStore::default);
            (staging, staging_spill)
        } else {
            (&mut session.current, &mut session.spill)
        };
        // 若更新的记录先前已溢出到磁盘冷存储，将其移出冷区并继承原 seq 与 pinned 状态
        let inherited = spill.remove(&entry.row.id);
        target.upsert_with_inherited(entry, inherited);
        while target.raw_bytes > MAX_LIVE_BYTES || target.entries.len() > MAX_LIVE_ENTRIES {
            let count = (target.entries.len() / 8).max(1);
            let evicted = target.evict_prefix_extract(count);
            session.evicted += evicted.len() as u64;
            for item in evicted {
                spill.push(
                    item.row,
                    item.search,
                    item.started_at_micros,
                    item.response_fields,
                    &item.raw,
                );
            }
        }
        session.version += 1;
        Ok(())
    }
    pub fn remove(&mut self, key: &str, connection_id: &str, id: &str) {
        if let Some(s) = self.active_mut(key, connection_id) {
            if let Some(staging) = s.staging.as_mut() {
                staging.remove(id);
                if let Some(spill) = s.staging_spill.as_mut() {
                    let _ = spill.remove(id);
                }
            } else {
                s.current.remove(id);
                let _ = s.spill.remove(id);
            }
            s.version += 1;
        }
    }
    pub fn synced(&mut self, key: &str, connection_id: &str) {
        if let Some(s) = self.active_mut(key, connection_id)
            && let Some(staging) = s.staging.take()
        {
            s.current = staging;
            s.spill = s.staging_spill.take().unwrap_or_default();
            s.version += 1;
        }
    }
    pub fn clear(&mut self, key: &str, connection_id: &str) {
        if self.active_mut(key, connection_id).is_none() {
            return;
        }
        if let Some(s) = self.active_mut(key, connection_id) {
            s.current = Session::empty(s.current.header.clone(), s.current.raw_header.to_string());
            s.spill.clear();
            if let Some(staging) = &mut s.staging {
                *staging = Session::empty(staging.header.clone(), staging.raw_header.to_string());
            }
            if let Some(staging_spill) = &mut s.staging_spill {
                staging_spill.clear();
            }
            s.generation += 1;
            s.version += 1;
        }
        self.cancel_pending(key, "bodyStale");
    }
    pub fn disconnect(&mut self, key: &str, connection_id: &str) {
        if let Some(s) = self.active_mut(key, connection_id) {
            s.online = false;
            s.staging = None;
            s.staging_spill = None;
            s.version += 1;
            self.cancel_pending(key, "deviceOffline");
        }
    }
    pub fn cancel_pending(&mut self, key: &str, reason: &str) {
        let pending: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, p)| p.session_id == key)
            .map(|(id, _)| id.clone())
            .collect();
        for id in pending {
            if let Some(p) = self.pending.remove(&id) {
                let _ = p.reply.send(Err(reason.into()));
            }
        }
    }
    pub fn summaries(&self) -> Vec<SessionSummary> {
        self.sessions
            .iter()
            .map(|(id, s)| SessionSummary {
                id: id.clone(),
                filename: s
                    .current
                    .header
                    .name
                    .clone()
                    .unwrap_or_else(|| s.current.header.platform.clone()),
                header: s.current.header.clone(),
                entry_count: s.current.entries.len() + s.spill.len(),
                skipped: s.current.skipped,
                newer_format: false,
                raw_bytes: s.current.raw_bytes,
                archive: None,
                live: Some(LiveInfo {
                    device_id: s.device_id.clone(),
                    network_session_id: s.network_id.clone(),
                    online: s.online,
                    syncing: s.staging.is_some(),
                    generation: s.generation,
                    version: s.version,
                    dropped: s.dropped,
                    evicted: s.evicted,
                    spilled_count: s.spill.len(),
                    spilled_bytes: s.spill.retained_bytes(),
                    diagnostic_count: 0,
                    diagnostics_online: false,
                }),
            })
            .collect()
    }
}
