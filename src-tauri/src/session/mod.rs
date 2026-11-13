use crate::protocol::session::{EntryRow, Header, Result, parse_entry};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{BufRead, Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 100_000;
pub const MAX_SESSIONS: usize = 4;
pub const MAX_LIBRARY_BYTES: usize = 128 * 1024 * 1024;

pub struct StoredEntry {
    pub row: EntryRow,
    pub raw: Arc<str>,
    search: String,
}

pub struct Session {
    pub header: Header,
    pub raw_header: Arc<str>,
    pub entries: Vec<StoredEntry>,
    pub skipped: usize,
    pub raw_bytes: usize,
    index: HashMap<String, usize>,
}

impl Session {
    pub fn entry(&self, id: &str) -> Option<&StoredEntry> {
        self.index.get(id).map(|i| &self.entries[*i])
    }

    pub fn write(&self, mut writer: impl Write) -> Result<()> {
        writeln!(writer, "{}", self.raw_header).map_err(|e| e.to_string())?;
        for entry in &self.entries {
            writeln!(writer, "{}", entry.raw).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn query(
        &self,
        search: &str,
        filter: &str,
        offset: usize,
        limit: usize,
        revision: u32,
    ) -> QueryPage {
        let search = search.to_lowercase();
        let matches = |entry: &&StoredEntry| {
            let row = &entry.row;
            let accepted = match filter {
                "errors" => row.state == "failed" || row.status.is_some_and(|s| s >= 400),
                "pending" => row.state == "pending",
                "pinned" => row.pinned,
                _ => true,
            };
            accepted && entry.search.contains(&search)
        };
        let total = self.entries.iter().filter(matches).count();
        let rows = self
            .entries
            .iter()
            .filter(matches)
            .skip(offset)
            .take(limit.min(500))
            .map(|e| e.row.clone())
            .collect();
        QueryPage {
            total,
            offset,
            rows,
            revision,
        }
    }
}

#[derive(Serialize)]
pub struct QueryPage {
    pub total: usize,
    pub offset: usize,
    pub rows: Vec<EntryRow>,
    pub revision: u32,
}

pub fn read_session(
    mut reader: impl BufRead,
    cancel: &AtomicBool,
    mut progress: impl FnMut(usize),
) -> Result<Session> {
    let mut session: Option<Session> = None;
    let mut total = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let mut bytes = Vec::new();
        let count = reader
            .by_ref()
            .take((MAX_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        total += count;
        if total > MAX_FILE_BYTES {
            return Err("fileTooLarge".into());
        }
        if count > MAX_LINE_BYTES {
            return Err("lineTooLarge".into());
        }
        progress(total);
        let line = match std::str::from_utf8(&bytes) {
            Ok(text) => {
                if total == count {
                    text.trim_start_matches('\u{feff}').trim()
                } else {
                    text.trim()
                }
            }
            Err(_) => {
                if let Some(session) = &mut session {
                    session.skipped += 1;
                    continue;
                }
                return Err("invalidHeader".into());
            }
        };
        if line.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => {
                if let Some(session) = &mut session {
                    session.skipped += 1;
                    continue;
                }
                return Err("invalidHeader".into());
            }
        };
        let Some(session) = &mut session else {
            session = Some(Session {
                header: Header::parse(&value).map_err(|_| "invalidHeader")?,
                raw_header: line.into(),
                entries: Vec::new(),
                skipped: 0,
                raw_bytes: line.len(),
                index: HashMap::new(),
            });
            continue;
        };
        match parse_entry(&value) {
            Ok(row) => {
                let search = format!(
                    "{} {} {} {}",
                    row.method,
                    row.url,
                    row.source,
                    row.status.map(|s| s.to_string()).unwrap_or_default()
                )
                .to_lowercase();
                let existing = session.index.get(&row.id).copied();
                if existing.is_none() && session.entries.len() >= MAX_ENTRIES {
                    return Err("tooManyEntries".into());
                }
                let entry = StoredEntry {
                    row,
                    raw: line.into(),
                    search,
                };
                session.raw_bytes += line.len();
                if let Some(index) = existing {
                    session.raw_bytes -= session.entries[index].raw.len();
                    session.entries[index] = entry;
                } else {
                    session
                        .index
                        .insert(entry.row.id.clone(), session.entries.len());
                    session.entries.push(entry);
                }
            }
            Err(_) => session.skipped += 1,
        }
    }
    session.ok_or_else(|| "invalidHeader".into())
}

#[derive(Default)]
pub struct Library {
    next_id: u64,
    pub sessions: HashMap<String, (String, Arc<Session>)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub filename: String,
    pub header: Header,
    pub entry_count: usize,
    pub skipped: usize,
    pub newer_format: bool,
    pub raw_bytes: usize,
}

impl Library {
    pub fn insert(&mut self, filename: String, session: Session) -> Result<SessionSummary> {
        let bytes: usize = self.sessions.values().map(|(_, s)| s.raw_bytes).sum();
        if self.sessions.len() >= MAX_SESSIONS || bytes + session.raw_bytes > MAX_LIBRARY_BYTES {
            return Err("libraryFull".into());
        }
        self.next_id += 1;
        let id = format!("file-{}", self.next_id);
        let summary = SessionSummary {
            id: id.clone(),
            filename: filename.clone(),
            header: session.header.clone(),
            entry_count: session.entries.len(),
            skipped: session.skipped,
            newer_format: session.header.format_version > 1,
            raw_bytes: session.raw_bytes,
        };
        self.sessions.insert(id, (filename, Arc::new(session)));
        Ok(summary)
    }

    pub fn get(&self, id: &str) -> Result<Arc<Session>> {
        self.sessions
            .get(id)
            .map(|(_, s)| Arc::clone(s))
            .ok_or_else(|| "sessionNotFound".into())
    }

    pub fn summaries(&self) -> Vec<SessionSummary> {
        let mut summaries: Vec<_> = self
            .sessions
            .iter()
            .map(|(id, (filename, session))| SessionSummary {
                id: id.clone(),
                filename: filename.clone(),
                header: session.header.clone(),
                entry_count: session.entries.len(),
                skipped: session.skipped,
                newer_format: session.header.format_version > 1,
                raw_bytes: session.raw_bytes,
            })
            .collect();
        summaries.sort_by(|a, b| a.id.cmp(&b.id));
        summaries
    }
}
