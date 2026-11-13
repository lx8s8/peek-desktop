use crate::{
    protocol::session::{Header, Result},
    session::{LiveInfo, Session, SessionSummary, StoredEntry},
};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

pub const MAX_LIVE_SESSIONS: usize = 8;
const MAX_LIVE_BYTES: usize = 8 * 1024 * 1024;
const MAX_LIVE_ENTRIES: usize = 10_000;

pub struct LiveSession {
    pub device_id: String,
    pub network_id: String,
    pub connection_id: String,
    pub current: Session,
    pub staging: Option<Session>,
    pub generation: u64,
    pub version: u64,
    pub online: bool,
    pub dropped: u64,
    pub evicted: u64,
    pub sender: mpsc::Sender<Value>,
    pub cancel: CancellationToken,
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

impl LiveStore {
    #[allow(clippy::too_many_arguments)]
    pub fn begin(
        &mut self,
        device_id: &str,
        network_id: &str,
        connection_id: &str,
        mut header: Value,
        sender: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<String> {
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
        if !self.sessions.contains_key(&key) && self.sessions.len() >= MAX_LIVE_SESSIONS {
            return Err("liveCapacity".into());
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
        } else {
            self.sessions.insert(
                key.clone(),
                LiveSession {
                    device_id: device_id.into(),
                    network_id: network_id.into(),
                    connection_id: connection_id.into(),
                    current: Session::empty(parsed.clone(), raw.clone()),
                    staging: Some(Session::empty(parsed, raw)),
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
        Ok(key)
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
        let target = session.staging.as_mut().unwrap_or(&mut session.current);
        target.upsert(entry);
        while target.raw_bytes > MAX_LIVE_BYTES || target.entries.len() > MAX_LIVE_ENTRIES {
            let count = (target.entries.len() / 8).max(1);
            target.evict_prefix(count);
            session.evicted += count as u64;
        }
        session.version += 1;
        Ok(())
    }
    pub fn remove(&mut self, key: &str, connection_id: &str, id: &str) {
        if let Some(s) = self.active_mut(key, connection_id) {
            s.staging.as_mut().unwrap_or(&mut s.current).remove(id);
            s.version += 1;
        }
    }
    pub fn synced(&mut self, key: &str, connection_id: &str) {
        if let Some(s) = self.active_mut(key, connection_id) {
            if let Some(staging) = s.staging.take() {
                s.current = staging;
                s.version += 1;
            }
        }
    }
    pub fn clear(&mut self, key: &str, connection_id: &str) {
        if self.active_mut(key, connection_id).is_none() {
            return;
        }
        if let Some(s) = self.active_mut(key, connection_id) {
            s.current = Session::empty(s.current.header.clone(), s.current.raw_header.to_string());
            if let Some(staging) = &mut s.staging {
                *staging = Session::empty(staging.header.clone(), staging.raw_header.to_string());
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
                entry_count: s.current.entries.len(),
                skipped: s.current.skipped,
                newer_format: false,
                raw_bytes: s.current.raw_bytes,
                live: Some(LiveInfo {
                    device_id: s.device_id.clone(),
                    network_session_id: s.network_id.clone(),
                    online: s.online,
                    syncing: s.staging.is_some(),
                    generation: s.generation,
                    version: s.version,
                    dropped: s.dropped,
                    evicted: s.evicted,
                    diagnostic_count: 0,
                    diagnostics_online: false,
                }),
            })
            .collect()
    }
}
