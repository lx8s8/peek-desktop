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
pub const MAX_SESSIONS: usize = 12;
pub const MAX_LIBRARY_BYTES: usize = 192 * 1024 * 1024;

#[derive(Clone)]
pub struct StoredEntry {
    pub row: EntryRow,
    pub raw: Arc<str>,
    search: String,
}

impl StoredEntry {
    pub fn parse(raw: &str) -> Result<Self> {
        let value: Value = serde_json::from_str(raw).map_err(|_| "invalidEntry")?;
        let mut row = parse_entry(&value)?;
        use sha2::{Digest, Sha256};
        row.content_revision = Sha256::digest(raw.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let search = format!(
            "{} {} {} {}",
            row.method,
            row.url,
            row.source,
            row.status.map(|s| s.to_string()).unwrap_or_default()
        )
        .to_lowercase();
        Ok(Self {
            row,
            raw: raw.into(),
            search,
        })
    }
}

#[derive(Clone)]
pub struct Session {
    pub header: Header,
    pub raw_header: Arc<str>,
    pub entries: Vec<StoredEntry>,
    pub skipped: usize,
    pub raw_bytes: usize,
    index: HashMap<String, usize>,
}

impl Session {
    pub fn empty(header: Header, raw_header: String) -> Self {
        Self {
            raw_bytes: raw_header.len(),
            header,
            raw_header: raw_header.into(),
            entries: Vec::new(),
            skipped: 0,
            index: HashMap::new(),
        }
    }
    pub fn upsert(&mut self, entry: StoredEntry) {
        self.raw_bytes += entry.raw.len();
        if let Some(index) = self.index.get(&entry.row.id).copied() {
            self.raw_bytes -= self.entries[index].raw.len();
            self.entries[index] = entry;
        } else {
            self.index.insert(entry.row.id.clone(), self.entries.len());
            self.entries.push(entry);
        }
    }
    pub fn remove(&mut self, id: &str) {
        if let Some(index) = self.index.remove(id) {
            self.raw_bytes -= self.entries.remove(index).raw.len();
            for index in index..self.entries.len() {
                self.index.insert(self.entries[index].row.id.clone(), index);
            }
        }
    }
    pub fn evict_prefix(&mut self, count: usize) {
        let count = count.min(self.entries.len());
        for entry in self.entries.drain(..count) {
            self.raw_bytes -= entry.raw.len();
        }
        self.index.clear();
        for (index, entry) in self.entries.iter().enumerate() {
            self.index.insert(entry.row.id.clone(), index);
        }
    }
    pub fn entry(&self, id: &str) -> Option<&StoredEntry> {
        self.index.get(id).map(|i| &self.entries[*i])
    }

    /// 切换指定记录的桌面端固定状态（Pinned）。
    pub fn toggle_pin(&mut self, id: &str) -> Result<bool> {
        let index = *self.index.get(id).ok_or("entryNotFound")?;
        let entry = &mut self.entries[index];
        entry.row.pinned = !entry.row.pinned;
        Ok(entry.row.pinned)
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
        self.query_range(
            search,
            filter,
            offset,
            limit,
            revision,
            &crate::query::ParsedRange::default(),
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub fn query_range(
        &self,
        search: &str,
        filter: &str,
        offset: usize,
        limit: usize,
        revision: u32,
        range: &crate::query::ParsedRange,
    ) -> QueryPage {
        self.query_range_filtered(search, filter, offset, limit, revision, range, None, &[])
    }

    /// 支持 Host 快捷筛选与路径/关键词降噪屏蔽的窗口查询，同时汇总 Top 12 Host。
    #[allow(clippy::too_many_arguments)]
    pub fn query_range_filtered(
        &self,
        search: &str,
        filter: &str,
        offset: usize,
        limit: usize,
        revision: u32,
        range: &crate::query::ParsedRange,
        host_filter: Option<&str>,
        exclude_patterns: &[String],
    ) -> QueryPage {
        let search = search.to_lowercase();
        let host_lower = host_filter
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase);
        let excludes: Vec<String> = exclude_patterns
            .iter()
            .map(|p| p.trim().to_lowercase())
            .filter(|p| !p.is_empty())
            .collect();

        // 统计当前会话频次最高的 Top 12 Host，供界面快速筛选胶囊使用
        let mut host_counts: HashMap<String, usize> = HashMap::new();
        for entry in &self.entries {
            if let Ok(parsed) = url::Url::parse(&entry.row.url)
                && let Some(host) = parsed.host_str()
            {
                *host_counts.entry(host.to_lowercase()).or_insert(0) += 1;
            }
        }
        let mut host_list: Vec<(String, usize)> = host_counts.into_iter().collect();
        host_list.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let hosts: Vec<String> = host_list.into_iter().take(12).map(|(h, _)| h).collect();

        let matches = |entry: &&StoredEntry| {
            let row = &entry.row;
            let accepted = match filter {
                "errors" => row.state == "failed" || row.status.is_some_and(|s| s >= 400),
                "pending" => row.state == "pending",
                "pinned" => row.pinned,
                _ => true,
            };
            if !accepted || !entry.search.contains(&search) || !range.includes(&row.started_at) {
                return false;
            }
            if let Some(target_host) = &host_lower {
                let host_ok = url::Url::parse(&row.url)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_lowercase))
                    .is_some_and(|h| h == *target_host);
                if !host_ok {
                    return false;
                }
            }
            if !excludes.is_empty() {
                let url_lower = row.url.to_lowercase();
                if excludes.iter().any(|pattern| url_lower.contains(pattern)) {
                    return false;
                }
            }
            true
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
            hosts,
        }
    }
}

#[derive(Serialize)]
pub struct QueryPage {
    pub total: usize,
    pub offset: usize,
    pub rows: Vec<EntryRow>,
    pub revision: u32,
    pub hosts: Vec<String>,
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
    pub archives: HashMap<String, crate::archive::NetworkOrigin>,
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
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub live: Option<LiveInfo>,
    pub archive: Option<crate::archive::NetworkOrigin>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveInfo {
    pub device_id: String,
    pub network_session_id: String,
    pub online: bool,
    pub syncing: bool,
    pub generation: u64,
    pub version: u64,
    pub dropped: u64,
    pub evicted: u64,
    pub diagnostic_count: usize,
    pub diagnostics_online: bool,
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
            live: None,
            archive: None,
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

    /// 切换离线会话中某条记录的固定状态。
    pub fn toggle_pin(&mut self, id: &str, entry_id: &str) -> Result<bool> {
        let (_, session) = self.sessions.get_mut(id).ok_or("sessionNotFound")?;
        Arc::make_mut(session).toggle_pin(entry_id)
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
                live: None,
                archive: self.archives.get(id).cloned(),
            })
            .collect();
        summaries.sort_by(|a, b| a.id.cmp(&b.id));
        summaries
    }
}
