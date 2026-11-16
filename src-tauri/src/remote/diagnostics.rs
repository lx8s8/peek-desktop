use crate::protocol::{diagnostics::DiagnosticEvent, session::Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

const MAX_EVENTS: usize = 2000;
const MAX_BYTES: usize = 4 * 1024 * 1024;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn eviction_preserves_important_events_and_acknowledgement_after_overflow() {
        let mut store = DiagnosticStore::default();
        let key = store
            .begin(
                "device".into(),
                "run".into(),
                None,
                "connection".into(),
                CancellationToken::new(),
            )
            .unwrap();
        let run = store.runs.get_mut(&key).unwrap();
        for sequence in 1..=MAX_EVENTS + 10 {
            let raw=json!({"eventId":format!("event-{sequence}"),"runId":"run","emitterId":"main","sequence":sequence.to_string(),"occurredAt":"2026-11-13T00:00:00Z","kind":"log","level":if sequence==1{"error"}else{"info"},"source":"synthetic","message":"synthetic"}).to_string();
            run.batch("main", vec![StoredDiagnostic::parse(&raw).unwrap()])
                .unwrap();
        }
        assert_eq!(run.count(), MAX_EVENTS);
        assert_eq!(run.evicted, 10);
        assert!(run.detail("event-1").is_ok());
        assert!(run.detail("event-2").is_err());
        assert_eq!(
            run.accepted_strings()["main"],
            (MAX_EVENTS + 10).to_string()
        );
        for sequence in MAX_EVENTS + 11..MAX_EVENTS + 90 {
            run.gap(
                "main",
                sequence as u64,
                sequence as u64,
                "syntheticOverflow",
            )
            .unwrap();
        }
        assert_eq!(run.gaps.len(), 64);
        assert_eq!(run.gap_count, 79);
    }
}

pub struct StoredDiagnostic {
    pub event: DiagnosticEvent,
    pub raw: Arc<str>,
    search: Arc<str>,
    pub(crate) fingerprint: Option<String>,
}
impl StoredDiagnostic {
    pub(crate) fn search_text(&self) -> Arc<str> {
        self.search.clone()
    }
    pub(crate) fn matches_search(&self, search: &str) -> bool {
        self.search.contains(search)
    }
    pub fn parse(raw: &str) -> Result<Self> {
        let event = DiagnosticEvent::parse(raw)?;
        if [
            &event.event_id,
            &event.run_id,
            &event.emitter_id,
            &event.source,
        ]
        .iter()
        .any(|s| s.len() > 256)
        {
            return Err("eventIdentityTooLarge".into());
        }
        let search = raw.to_lowercase().into();
        let fingerprint = crate::query::fingerprint(&event);
        Ok(Self {
            event,
            raw: raw.into(),
            search,
            fingerprint,
        })
    }
}
pub struct DiagnosticRun {
    pub device_id: String,
    pub run_id: String,
    pub network_key: Option<String>,
    pub connection_id: String,
    pub online: bool,
    pub cancel: CancellationToken,
    pub accepted: BTreeMap<String, u64>,
    pub(crate) events: VecDeque<StoredDiagnostic>,
    pub(crate) bytes: usize,
    pub received: u64,
    pub duplicates: u64,
    pub evicted: u64,
    pub gap_count: u64,
    pub version: u64,
    pub gaps: VecDeque<Gap>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub emitter_id: String,
    pub from_sequence: String,
    pub to_sequence: String,
    pub reason: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRunInfo {
    pub id: String,
    pub device_id: String,
    pub run_id: String,
    pub network_session_key: Option<String>,
    pub online: bool,
    pub count: usize,
    pub received: u64,
    pub duplicates: u64,
    pub evicted: u64,
    pub gap_count: u64,
    pub version: u64,
    pub gaps: Vec<Gap>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRow {
    pub fingerprint: Option<String>,
    pub exception_type: Option<String>,
    pub related_network_entry_id: Option<String>,
    pub event_id: String,
    pub sequence: String,
    pub occurred_at: String,
    pub kind: String,
    pub level: String,
    pub source: String,
    pub tag: Option<String>,
    pub message: String,
    pub emitter_id: String,
    pub truncated: bool,
}
#[derive(Serialize)]
pub struct DiagnosticPage {
    pub total: usize,
    pub offset: usize,
    pub rows: Vec<DiagnosticRow>,
    pub revision: u32,
}

#[derive(Default)]
pub struct DiagnosticStore {
    pub runs: HashMap<String, DiagnosticRun>,
}
impl DiagnosticStore {
    pub fn begin(
        &mut self,
        device: String,
        run: String,
        network_key: Option<String>,
        connection: String,
        cancel: CancellationToken,
    ) -> Result<String> {
        if run.is_empty() || run.len() > 256 {
            return Err("invalidRunId".into());
        }
        let id = format!("diagnostic-{}", super::store::session_key(&device, &run));
        if !self.runs.contains_key(&id) && self.runs.len() >= 8 {
            return Err("diagnosticCapacity".into());
        }
        if let Some(existing) = self.runs.get_mut(&id) {
            if existing.network_key != network_key {
                return Err("sessionBindingChanged".into());
            }
            existing.cancel.cancel();
            existing.connection_id = connection;
            existing.cancel = cancel;
            existing.online = true;
            existing.version += 1;
        } else {
            self.runs.insert(
                id.clone(),
                DiagnosticRun {
                    device_id: device,
                    run_id: run,
                    network_key,
                    connection_id: connection,
                    online: true,
                    cancel,
                    accepted: BTreeMap::new(),
                    events: VecDeque::new(),
                    bytes: 0,
                    received: 0,
                    duplicates: 0,
                    evicted: 0,
                    gap_count: 0,
                    version: 1,
                    gaps: VecDeque::new(),
                },
            );
        }
        Ok(id)
    }
    pub fn active(&mut self, id: &str, connection: &str) -> Result<&mut DiagnosticRun> {
        self.runs
            .get_mut(id)
            .filter(|r| r.online && r.connection_id == connection)
            .ok_or_else(|| "staleConnection".into())
    }
    pub fn summaries(&self) -> Vec<DiagnosticRunInfo> {
        self.runs
            .iter()
            .map(|(id, r)| DiagnosticRunInfo {
                id: id.clone(),
                device_id: r.device_id.clone(),
                run_id: r.run_id.clone(),
                network_session_key: r.network_key.clone(),
                online: r.online,
                count: r.events.len(),
                received: r.received,
                duplicates: r.duplicates,
                evicted: r.evicted,
                gap_count: r.gap_count,
                version: r.version,
                gaps: r.gaps.iter().cloned().collect(),
            })
            .collect()
    }
}
impl DiagnosticRun {
    pub(crate) fn events(&self) -> impl Iterator<Item = &StoredDiagnostic> {
        self.events.iter()
    }
    pub fn count(&self) -> usize {
        self.events.len()
    }
    pub fn accepted_strings(&self) -> BTreeMap<String, String> {
        self.accepted
            .iter()
            .map(|(id, seq)| (id.clone(), seq.to_string()))
            .collect()
    }
    pub fn batch(&mut self, emitter: &str, events: Vec<StoredDiagnostic>) -> Result<String> {
        if events.is_empty() || events.len() > 64 || emitter.is_empty() || emitter.len() > 256 {
            return Err("invalidBatch".into());
        }
        if !self.accepted.contains_key(emitter) && self.accepted.len() >= 16 {
            return Err("emitterCapacity".into());
        }
        let mut accepted = self.accepted.get(emitter).copied().unwrap_or(0);
        let original = accepted;
        let mut ids: HashSet<String> = self
            .events
            .iter()
            .map(|e| e.event.event_id.clone())
            .collect();
        let mut planned = HashMap::new();
        let mut fresh = Vec::new();
        let mut duplicates = 0;
        for stored in events {
            let e = &stored.event;
            if e.run_id != self.run_id || e.emitter_id != emitter {
                return Err("eventBindingMismatch".into());
            }
            let seq = e.sequence.parse::<u64>().map_err(|_| "invalidSequence")?;
            if seq <= accepted {
                if seq > original && planned.get(&seq) != Some(&e.event_id) {
                    return Err("sequenceConflict".into());
                }
                duplicates += 1;
                continue;
            }
            if accepted.checked_add(1) != Some(seq) {
                return Err("sequenceGap".into());
            }
            if !ids.insert(e.event_id.clone()) {
                return Err("eventIdConflict".into());
            }
            planned.insert(seq, e.event_id.clone());
            accepted = seq;
            fresh.push(stored);
        }
        for stored in fresh {
            self.bytes += stored.raw.len();
            self.events.push_back(stored);
            self.received += 1;
            while self.events.len() > MAX_EVENTS || self.bytes > MAX_BYTES {
                let index = self
                    .events
                    .iter()
                    .position(|e| matches!(e.event.level.as_str(), "verbose" | "debug" | "info"))
                    .unwrap_or(0);
                if let Some(old) = self.events.remove(index) {
                    self.bytes -= old.raw.len();
                    self.evicted += 1;
                }
            }
        }
        self.accepted.insert(emitter.into(), accepted);
        self.duplicates += duplicates;
        self.version += 1;
        Ok(accepted.to_string())
    }
    pub fn gap(&mut self, emitter: &str, from: u64, to: u64, reason: &str) -> Result<String> {
        if emitter.is_empty() || emitter.len() > 256 || from == 0 || to < from || reason.len() > 128
        {
            return Err("invalidGap".into());
        }
        if !self.accepted.contains_key(emitter) && self.accepted.len() >= 16 {
            return Err("emitterCapacity".into());
        }
        let accepted = self.accepted.get(emitter).copied().unwrap_or(0);
        if to <= accepted {
            return Ok(accepted.to_string());
        }
        let next = accepted.checked_add(1).ok_or("invalidGap")?;
        if from > next {
            return Err("sequenceGap".into());
        }
        self.gaps.push_back(Gap {
            emitter_id: emitter.into(),
            from_sequence: next.to_string(),
            to_sequence: to.to_string(),
            reason: reason.into(),
        });
        while self.gaps.len() > 64 {
            self.gaps.pop_front();
        }
        self.gap_count = self.gap_count.saturating_add(to - next + 1);
        self.accepted.insert(emitter.into(), to);
        self.version += 1;
        Ok(to.to_string())
    }
    pub fn detail(&self, id: &str) -> Result<Arc<str>> {
        self.events
            .iter()
            .find(|e| e.event.event_id == id)
            .map(|e| e.raw.clone())
            .ok_or_else(|| "diagnosticEvicted".into())
    }
    pub fn query(
        &self,
        search: &str,
        level: &str,
        exceptions: bool,
        offset: usize,
        limit: usize,
        revision: u32,
    ) -> DiagnosticPage {
        let search = search.to_lowercase();
        let matches = |e: &&StoredDiagnostic| {
            (level == "all" || e.event.level == level)
                && (!exceptions || e.event.kind == "exception")
                && e.search.contains(&search)
        };
        let total = self.events.iter().filter(matches).count();
        let rows = self
            .events
            .iter()
            .filter(matches)
            .skip(offset)
            .take(limit.min(300))
            .map(|e| DiagnosticRow {
                fingerprint: e.fingerprint.clone(),
                exception_type: e
                    .event
                    .exception
                    .as_ref()
                    .and_then(|exception| exception.r#type.clone()),
                related_network_entry_id: e.event.related_network_entry_id.clone(),
                event_id: e.event.event_id.clone(),
                sequence: e.event.sequence.clone(),
                occurred_at: e.event.occurred_at.clone(),
                kind: e.event.kind.clone(),
                level: e.event.level.clone(),
                source: e.event.source.clone(),
                tag: e.event.tag.clone(),
                message: e.event.message.chars().take(240).collect(),
                emitter_id: e.event.emitter_id.clone(),
                truncated: e.event.truncated,
            })
            .collect();
        DiagnosticPage {
            total,
            offset,
            rows,
            revision,
        }
    }
}
