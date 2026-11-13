//! Windowed review queries. No body or event attributes are sent in list rows.
use crate::{
    protocol::{
        diagnostics::DiagnosticEvent,
        session::{EntryRow, Result},
    },
    remote::{
        diagnostics::{DiagnosticRow, DiagnosticRun, DiagnosticStore, StoredDiagnostic},
        server::Remote,
    },
};
use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TimeRange {
    pub from: Option<String>,
    pub to: Option<String>,
}
#[derive(Default)]
pub struct ParsedRange {
    from: Option<DateTime<FixedOffset>>,
    to: Option<DateTime<FixedOffset>>,
}
impl TimeRange {
    pub fn parse(&self) -> Result<ParsedRange> {
        let parse = |value: &Option<String>| {
            value
                .as_ref()
                .map(|text| {
                    DateTime::parse_from_rfc3339(text).map_err(|_| "invalidTimeRange".to_string())
                })
                .transpose()
        };
        let from = parse(&self.from)?;
        let to = parse(&self.to)?;
        if from.zip(to).is_some_and(|(a, b)| a > b) {
            return Err("invalidTimeRange".into());
        }
        Ok(ParsedRange { from, to })
    }
}
impl ParsedRange {
    pub fn includes(&self, time: &str) -> bool {
        if self.from.is_none() && self.to.is_none() {
            return true;
        }
        DateTime::parse_from_rfc3339(time).is_ok_and(|time| {
            self.from.is_none_or(|from| time >= from) && self.to.is_none_or(|to| time <= to)
        })
    }
}
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Scope {
    Network { id: String },
    Diagnostic { id: String },
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewQuery {
    pub search: String,
    pub level: String,
    pub source: String,
    pub tag: String,
    pub emitter: String,
    pub exceptions: bool,
    pub grouped: bool,
    pub fingerprint: Option<String>,
    pub range: TimeRange,
    pub offset: usize,
    pub limit: usize,
    pub revision: u32,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facets {
    sources: Vec<String>,
    tags: Vec<String>,
    emitters: Vec<String>,
    limited: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionGroup {
    fingerprint: String,
    exception_type: String,
    message: String,
    count: usize,
    first_at: String,
    last_at: String,
    latest_event_id: String,
}
#[derive(Serialize)]
pub struct ReviewPage {
    total: usize,
    offset: usize,
    revision: u32,
    rows: Vec<DiagnosticRow>,
    groups: Vec<ExceptionGroup>,
    facets: Facets,
}
fn clipped(text: &str) -> String {
    text.chars().take(240).collect()
}
pub fn fingerprint(event: &DiagnosticEvent) -> Option<String> {
    use sha2::{Digest, Sha256};
    event
        .exception
        .as_ref()
        .filter(|_| event.kind == "exception")
        .map(|exception| {
            let key = serde_json::to_string(&(
                &exception.r#type,
                &event.message,
                &exception.message,
                &exception.stack_trace,
            ))
            .expect("strings serialize");
            Sha256::digest(key.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect()
        })
}
fn row(stored: &StoredDiagnostic) -> DiagnosticRow {
    let event = &stored.event;
    DiagnosticRow {
        event_id: event.event_id.clone(),
        sequence: event.sequence.clone(),
        occurred_at: event.occurred_at.clone(),
        kind: event.kind.clone(),
        level: event.level.clone(),
        source: event.source.clone(),
        tag: event.tag.as_deref().map(clipped),
        message: clipped(&event.message),
        emitter_id: event.emitter_id.clone(),
        truncated: event.truncated,
        fingerprint: stored.fingerprint.clone(),
        exception_type: event
            .exception
            .as_ref()
            .and_then(|e| e.r#type.as_deref())
            .map(clipped),
        related_network_entry_id: event.related_network_entry_id.as_deref().map(clipped),
    }
}
pub fn review(run: &DiagnosticRun, query: &ReviewQuery) -> Result<ReviewPage> {
    let range = query.range.parse()?;
    let search = query.search.to_lowercase();
    let mut sources = BTreeSet::new();
    let mut tags = BTreeSet::new();
    let mut emitters = BTreeSet::new();
    let mut limited = false;
    for stored in run.events() {
        let event = &stored.event;
        for (set, value) in [
            (&mut sources, Some(event.source.as_str())),
            (&mut tags, event.tag.as_deref()),
            (&mut emitters, Some(event.emitter_id.as_str())),
        ] {
            if let Some(value) = value {
                if value.len() <= 256 && set.len() < 100 {
                    set.insert(value.to_owned());
                } else if !set.contains(value) {
                    limited = true;
                }
            }
        }
    }
    let matches: Vec<_> = run
        .events()
        .filter(|stored| {
            let event = &stored.event;
            (query.level.is_empty() || query.level == "all" || event.level == query.level)
                && (query.source.is_empty() || event.source == query.source)
                && (query.tag.is_empty() || event.tag.as_deref() == Some(query.tag.as_str()))
                && (query.emitter.is_empty() || event.emitter_id == query.emitter)
                && (!query.exceptions || event.kind == "exception")
                && query
                    .fingerprint
                    .as_ref()
                    .is_none_or(|value| stored.fingerprint.as_ref() == Some(value))
                && range.includes(&event.occurred_at)
                && stored.matches_search(&search)
        })
        .collect();
    let facets = Facets {
        sources: sources.into_iter().collect(),
        tags: tags.into_iter().collect(),
        emitters: emitters.into_iter().collect(),
        limited,
    };
    let (rows, groups, total) = if query.grouped {
        let mut groups: BTreeMap<String, ExceptionGroup> = BTreeMap::new();
        for stored in &matches {
            let event = &stored.event;
            let Some(key) = stored.fingerprint.clone() else {
                continue;
            };
            let group = groups.entry(key.clone()).or_insert_with(|| ExceptionGroup {
                fingerprint: key,
                exception_type: clipped(
                    event
                        .exception
                        .as_ref()
                        .and_then(|e| e.r#type.as_deref())
                        .unwrap_or("Exception"),
                ),
                message: clipped(&event.message),
                count: 0,
                first_at: event.occurred_at.clone(),
                last_at: event.occurred_at.clone(),
                latest_event_id: event.event_id.clone(),
            });
            group.count += 1;
            if timestamp(&event.occurred_at) < timestamp(&group.first_at) {
                group.first_at = event.occurred_at.clone();
            }
            if timestamp(&event.occurred_at) >= timestamp(&group.last_at) {
                group.last_at = event.occurred_at.clone();
                group.latest_event_id = event.event_id.clone();
            }
        }
        let mut groups: Vec<_> = groups.into_values().collect();
        groups.sort_by(|a, b| {
            timestamp(&b.last_at)
                .cmp(&timestamp(&a.last_at))
                .then(a.fingerprint.cmp(&b.fingerprint))
        });
        let total = groups.len();
        (
            vec![],
            groups
                .into_iter()
                .skip(query.offset)
                .take(query.limit.clamp(1, 300))
                .collect(),
            total,
        )
    } else {
        (
            matches
                .iter()
                .skip(query.offset)
                .take(query.limit.clamp(1, 300))
                .map(|e| row(e))
                .collect(),
            vec![],
            matches.len(),
        )
    };
    Ok(ReviewPage {
        total,
        offset: query.offset,
        revision: query.revision,
        rows,
        groups,
        facets,
    })
}
fn timestamp(value: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(value).ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRow {
    id: String,
    pub kind: String,
    occurred_at: String,
    level: String,
    source: String,
    message: String,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub entry_id: Option<String>,
    pub event_id: Option<String>,
    association: String,
    related_network_entry_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePage {
    total: usize,
    offset: usize,
    revision: u32,
    rows: Vec<TimelineRow>,
}
struct TimelineDiagnostic {
    key: String,
    row: DiagnosticRow,
    search: std::sync::Arc<str>,
    related: Option<String>,
}
fn timeline_snapshot(scope: &Scope, store: &DiagnosticStore) -> Result<Vec<TimelineDiagnostic>> {
    if let Scope::Diagnostic { id } = scope
        && !store.runs.contains_key(id)
    {
        return Err("diagnosticNotFound".into());
    }
    let mut records = vec![];
    for (key, run) in &store.runs {
        let included = match scope {
            Scope::Network { id } => run.network_key.as_ref() == Some(id),
            Scope::Diagnostic { id } => id == key,
        };
        if included {
            for stored in run.events() {
                records.push(TimelineDiagnostic {
                    key: key.clone(),
                    row: row(stored),
                    search: stored.search_text(),
                    related: stored.event.related_network_entry_id.clone(),
                });
            }
        }
    }
    Ok(records)
}
pub fn timeline(
    scope: &Scope,
    network: Vec<EntryRow>,
    store: &DiagnosticStore,
    query: &ReviewQuery,
) -> Result<TimelinePage> {
    merge_timeline(scope, network, timeline_snapshot(scope, store)?, query)
}
fn merge_timeline(
    scope: &Scope,
    network: Vec<EntryRow>,
    diagnostics: Vec<TimelineDiagnostic>,
    query: &ReviewQuery,
) -> Result<TimelinePage> {
    let range = query.range.parse()?;
    let search = query.search.to_lowercase();
    let network_id = match scope {
        Scope::Network { id } => Some(id.as_str()),
        _ => None,
    };
    let ids: HashSet<_> = network.iter().map(|row| row.id.as_str()).collect();
    let mut rows = vec![];
    for entry in &network {
        if range.includes(&entry.started_at)
            && format!(
                "{} {} {} {}",
                entry.method,
                entry.url,
                entry.source,
                entry.status.unwrap_or_default()
            )
            .to_lowercase()
            .contains(&search)
        {
            rows.push(TimelineRow {
                id: format!("network:{}", entry.id),
                kind: "network".into(),
                occurred_at: entry.started_at.clone(),
                level: entry.state.into(),
                source: entry.source.clone(),
                message: clipped(&format!("{} {}", entry.method, entry.url)),
                session_id: network_id.map(String::from),
                entry_id: Some(entry.id.clone()),
                run_id: None,
                event_id: None,
                association: "time".into(),
                related_network_entry_id: None,
            });
        }
    }
    for diagnostic in diagnostics {
        let event = diagnostic.row;
        if !range.includes(&event.occurred_at) || !diagnostic.search.contains(&search) {
            continue;
        }
        let association = match diagnostic.related.as_deref() {
            Some(id) if network_id.is_some() && ids.contains(id) => "explicit",
            Some(_) => "unavailable",
            None => "time",
        };
        rows.push(TimelineRow {
            id: format!("diagnostic:{}:{}", diagnostic.key, event.event_id),
            kind: event.kind,
            occurred_at: event.occurred_at,
            level: event.level,
            source: event.source,
            message: event.message,
            session_id: network_id.map(String::from),
            entry_id: None,
            run_id: Some(diagnostic.key),
            event_id: Some(event.event_id),
            association: association.into(),
            related_network_entry_id: diagnostic.related,
        });
    }
    rows.sort_by_cached_key(|row| (timestamp(&row.occurred_at), row.id.clone()));
    let total = rows.len();
    let rows = rows
        .into_iter()
        .skip(query.offset)
        .take(query.limit.clamp(1, 300))
        .collect();
    Ok(TimelinePage {
        total,
        offset: query.offset,
        revision: query.revision,
        rows,
    })
}
impl Remote {
    pub fn review_diagnostics(&self, id: &str, query: &ReviewQuery) -> Result<ReviewPage> {
        let store = self.diagnostics.lock().map_err(|_| "internalError")?;
        review(store.runs.get(id).ok_or("diagnosticNotFound")?, query)
    }
    pub fn timeline(
        &self,
        scope: &Scope,
        network: Vec<EntryRow>,
        query: &ReviewQuery,
    ) -> Result<TimelinePage> {
        let diagnostics = {
            let store = self.diagnostics.lock().map_err(|_| "internalError")?;
            timeline_snapshot(scope, &store)?
        };
        merge_timeline(scope, network, diagnostics, query)
    }
    pub fn network_rows(&self, id: &str) -> Result<Vec<EntryRow>> {
        Ok(self
            .store
            .lock()
            .map_err(|_| "internalError")?
            .sessions
            .get(id)
            .ok_or("sessionNotFound")?
            .current
            .entries
            .iter()
            .map(|e| e.row.clone())
            .collect())
    }
}

impl Remote {
    #[allow(clippy::too_many_arguments)]
    pub fn query_range(
        &self,
        id: &str,
        search: &str,
        filter: &str,
        offset: usize,
        limit: usize,
        revision: u32,
        range: &ParsedRange,
    ) -> Result<crate::session::QueryPage> {
        Ok(self
            .store
            .lock()
            .map_err(|_| "internalError")?
            .sessions
            .get(id)
            .ok_or("sessionNotFound")?
            .current
            .query_range(search, filter, offset, limit, revision, range))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        protocol::session::Header,
        remote::diagnostics::StoredDiagnostic,
        session::{Session, StoredEntry},
    };
    use serde_json::{Value, json};
    use tokio_util::sync::CancellationToken;
    fn store() -> (DiagnosticStore, String) {
        let mut store = DiagnosticStore::default();
        let id = store
            .begin(
                "device".into(),
                "run".into(),
                Some("network-one".into()),
                "connection".into(),
                CancellationToken::new(),
            )
            .unwrap();
        (store, id)
    }
    fn push(
        store: &mut DiagnosticStore,
        id: &str,
        seq: u64,
        time: &str,
        kind: &str,
        related: Option<&str>,
    ) {
        let mut event = json!({"eventId":format!("event-{seq}"),"runId":store.runs[id].run_id,"emitterId":"main","sequence":seq.to_string(),"occurredAt":time,"kind":kind,"level":if kind=="exception"{"error"}else{"info"},"source":"business","tag":"payments","message":"synthetic message","attributes":{"secretMarker":"searchable attribute"},"relatedNetworkEntryId":related});
        if kind == "exception" {
            event["exception"] = json!({"type":"StateError","message":"synthetic error","stackTrace":"#0 OriginalFrame\n#1 Caller"});
        }
        store
            .runs
            .get_mut(id)
            .unwrap()
            .batch(
                "main",
                vec![StoredDiagnostic::parse(&event.to_string()).unwrap()],
            )
            .unwrap();
    }
    fn entry(id: &str, time: &str) -> StoredEntry {
        StoredEntry::parse(&json!({"id":id,"source":"synthetic","startedAt":time,"request":{"method":"GET","url":"https://synthetic.example.test"}}).to_string()).unwrap()
    }
    #[test]
    fn diagnostic_filters_full_text_and_groups_preserve_members_in_retained_window() {
        let (mut store, id) = store();
        push(
            &mut store,
            &id,
            1,
            "2026-11-13T00:00:00.000003Z",
            "exception",
            None,
        );
        push(
            &mut store,
            &id,
            2,
            "2026-11-13T00:00:00.000001Z",
            "exception",
            None,
        );
        push(
            &mut store,
            &id,
            3,
            "2026-11-13T00:00:00.000002Z",
            "log",
            None,
        );
        let run = &store.runs[&id];
        let query = ReviewQuery {
            search: "OriginalFrame".into(),
            source: "business".into(),
            tag: "payments".into(),
            emitter: "main".into(),
            grouped: true,
            limit: 300,
            revision: 17,
            ..Default::default()
        };
        let page = review(run, &query).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.groups[0].count, 2);
        assert_eq!(page.groups[0].first_at, "2026-11-13T00:00:00.000001Z");
        assert_eq!(page.groups[0].last_at, "2026-11-13T00:00:00.000003Z");
        let members = review(
            run,
            &ReviewQuery {
                fingerprint: Some(page.groups[0].fingerprint.clone()),
                limit: 300,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(members.total, 2);
        assert_eq!(members.rows[0].event_id, "event-1");
        assert!(run.detail("event-1").unwrap().contains("OriginalFrame"));
        let raw = serde_json::to_string(&members).unwrap();
        assert!(!raw.contains("secretMarker"));
        assert!(!raw.contains("stackTrace"));
        assert_eq!(
            review(
                run,
                &ReviewQuery {
                    tag: "other".into(),
                    ..Default::default()
                }
            )
            .unwrap()
            .total,
            0
        );
        assert_eq!(
            review(
                run,
                &ReviewQuery {
                    search: "searchable attribute".into(),
                    ..Default::default()
                }
            )
            .unwrap()
            .total,
            3
        );
    }
    #[test]
    fn timeline_uses_microsecond_order_explicit_links_and_exact_session_scope() {
        let (mut store, id) = store();
        push(
            &mut store,
            &id,
            1,
            "2026-11-13T00:00:00.0000015Z",
            "log",
            Some("request"),
        );
        push(
            &mut store,
            &id,
            2,
            "2026-11-13T00:00:00.000002Z",
            "exception",
            Some("evicted"),
        );
        let other = store
            .begin(
                "other-device".into(),
                "run".into(),
                Some("network-two".into()),
                "other".into(),
                CancellationToken::new(),
            )
            .unwrap();
        push(
            &mut store,
            &other,
            1,
            "2026-11-13T00:00:00Z",
            "log",
            Some("request"),
        );
        let scope = Scope::Network {
            id: "network-one".into(),
        };
        let page = timeline(
            &scope,
            vec![entry("request", "2026-11-13T00:00:00.000001Z").row],
            &store,
            &ReviewQuery {
                limit: 300,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.rows[0].kind, "network");
        assert_eq!(page.rows[1].association, "explicit");
        assert_eq!(page.rows[2].association, "unavailable");
        assert!(
            page.rows
                .iter()
                .all(|row| row.run_id.as_deref() != Some(other.as_str()))
        );
        let independent = timeline(
            &Scope::Diagnostic { id: other },
            vec![],
            &store,
            &ReviewQuery {
                limit: 300,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(independent.total, 1);
        assert_eq!(independent.rows[0].association, "unavailable");
    }
    #[test]
    fn shared_time_range_is_inclusive_and_rejects_invalid_or_reversed_input() {
        assert!(
            TimeRange {
                from: Some("bad".into()),
                to: None
            }
            .parse()
            .is_err()
        );
        assert!(
            TimeRange {
                from: Some("2026-11-13T00:00:02Z".into()),
                to: Some("2026-11-13T00:00:01Z".into())
            }
            .parse()
            .is_err()
        );
        let range = TimeRange {
            from: Some("2026-11-13T08:00:00.000002+08:00".into()),
            to: Some("2026-11-13T00:00:00.000003Z".into()),
        };
        let mut session=Session::empty(Header::parse(&json!({"format":"peek","formatVersion":1,"peekVersion":"2.1.1","platform":"macos","startedAt":"2026-11-13T00:00:00Z"})).unwrap(),"{}".into());
        for index in 1..=3 {
            session.upsert(entry(
                &index.to_string(),
                &format!("2026-11-13T00:00:00.00000{index}Z"),
            ));
        }
        assert_eq!(
            session
                .query_range("", "all", 0, 300, 1, &range.parse().unwrap())
                .total,
            2
        );
        let (mut store, id) = store();
        for index in 1..=3 {
            push(
                &mut store,
                &id,
                index,
                &format!("2026-11-13T00:00:00.00000{index}Z"),
                "log",
                None,
            );
        }
        assert_eq!(
            review(
                &store.runs[&id],
                &ReviewQuery {
                    range,
                    limit: 300,
                    ..Default::default()
                }
            )
            .unwrap()
            .total,
            2
        );
    }
    #[test]
    fn timeline_pages_are_stable_bounded_and_contain_no_payloads() {
        let network = (0..350)
            .map(|index| entry(&format!("request-{index:04}"), "2026-11-13T00:00:00Z").row)
            .collect();
        let page = timeline(
            &Scope::Network {
                id: "network".into(),
            },
            network,
            &DiagnosticStore::default(),
            &ReviewQuery {
                offset: 30,
                limit: 999,
                revision: 19,
                ..Default::default()
            },
        )
        .unwrap();
        let value: Value = serde_json::to_value(page).unwrap();
        assert_eq!(value["total"], 350);
        assert_eq!(value["rows"].as_array().unwrap().len(), 300);
        assert_eq!(value["revision"], 19);
        assert_eq!(value["rows"][0]["entryId"], "request-0030");
        assert!(value["rows"][0].get("body").is_none());
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRef {
    pub run_id: String,
    pub event_id: String,
}
impl Remote {
    pub fn selected_diagnostics(
        &self,
        selection: &[DiagnosticRef],
    ) -> Result<Vec<std::sync::Arc<str>>> {
        if selection.is_empty() || selection.len() > 300 {
            return Err("invalidSelection".into());
        }
        let store = self.diagnostics.lock().map_err(|_| "internalError")?;
        let mut seen = HashSet::new();
        let mut records = vec![];
        for item in selection {
            if seen.insert((&item.run_id, &item.event_id)) {
                records.push(
                    store
                        .runs
                        .get(&item.run_id)
                        .ok_or("diagnosticNotFound")?
                        .detail(&item.event_id)?,
                );
            }
        }
        Ok(records)
    }
}
pub fn copy_diagnostics(records: &[std::sync::Arc<str>], kind: &str) -> Result<String> {
    let mut output = String::new();
    for raw in records {
        let text = match kind {
            "raw" => raw.to_string(),
            "message" | "stack" => {
                let value: serde_json::Value =
                    serde_json::from_str(raw).map_err(|_| "invalidDiagnostic")?;
                let field = if kind == "message" {
                    &value["message"]
                } else {
                    &value["exception"]["stackTrace"]
                };
                field.as_str().unwrap_or_default().to_owned()
            }
            _ => return Err("invalidCopyKind".into()),
        };
        if !output.is_empty() {
            output.push_str(if kind == "raw" { "\n" } else { "\n\n" });
        }
        output.push_str(&text);
        if output.len() > 1024 * 1024 {
            return Err("selectionTooLarge".into());
        }
    }
    if output.is_empty() {
        return Err("noCopyContent".into());
    }
    Ok(output)
}

#[cfg(test)]
mod export_tests {
    use super::*;
    #[test]
    fn selection_copy_and_atomic_jsonl_export_keep_raw_numbers_and_stack() {
        let raw:std::sync::Arc<str>=r##"{"message":"original message","attributes":{"id":900719925474099312345,"decimal":0.12345678901234567890,"duplicate":1,"duplicate":2},"exception":{"stackTrace":"#0 Original\n#1 Caller"}}"##.into();
        assert_eq!(
            copy_diagnostics(std::slice::from_ref(&raw), "raw").unwrap(),
            raw.as_ref()
        );
        assert_eq!(
            copy_diagnostics(std::slice::from_ref(&raw), "stack").unwrap(),
            "#0 Original\n#1 Caller"
        );
        assert!(copy_diagnostics(std::slice::from_ref(&raw), "unknown").is_err());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("selected.jsonl");
        std::fs::write(&path, "old").unwrap();
        crate::storage::save_diagnostics(&path, std::slice::from_ref(&raw)).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), format!("{raw}\n"));
        let large: std::sync::Arc<str> = "x".repeat(1024 * 1024 + 1).into();
        assert_eq!(
            copy_diagnostics(&[large], "raw").err().unwrap(),
            "selectionTooLarge"
        );
    }
}
