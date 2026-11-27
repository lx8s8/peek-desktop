pub mod spill;

use crate::protocol::session::{
    EntryRow, Header, Result, extract_response_json_fields, parse_entry, parse_timestamp_micros,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cmp::Ordering,
    collections::HashMap,
    io::{BufRead, Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering as AtomicOrdering},
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
    pub(crate) search: String,
    pub(crate) started_at_micros: i64,
    pub(crate) response_fields: Vec<(String, String)>,
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
        let started_at_micros = parse_timestamp_micros(&row.started_at);
        let response_fields = extract_response_json_fields(&value["response"]["body"]);
        let search = format!(
            "{} {} {} {} {}",
            row.method,
            row.url,
            row.source,
            row.status.map(|s| s.to_string()).unwrap_or_default(),
            row.graphql_operation.as_deref().unwrap_or("")
        )
        .to_lowercase();
        Ok(Self {
            row,
            raw: raw.into(),
            search,
            started_at_micros,
            response_fields,
        })
    }
}

/// HTTP 200 响应的自定义业务错误码识别规则（支持多候选字段名与点号嵌套路径）。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BizErrorRule {
    pub enabled: bool,
    pub code_field: String,
    pub ok_values: Vec<String>,
    pub success_field: Option<String>,
    pub message_field: Option<String>,
}

impl BizErrorRule {
    /// 仅对 HTTP 2xx 的 JSON 响应评估业务异常，命中时返回简洁摘要（如 `50001 · token expired`）。
    pub fn evaluate(&self, status: Option<i64>, fields: &[(String, String)]) -> Option<String> {
        if !self.enabled || fields.is_empty() || !status.is_some_and(|s| (200..300).contains(&s)) {
            return None;
        }
        let lookup_any = |spec: &str| -> Option<&str> {
            for candidate in spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                if let Some((_, val)) = fields
                    .iter()
                    .find(|(key, _)| key.eq_ignore_ascii_case(candidate))
                {
                    return Some(val.as_str());
                }
            }
            None
        };

        let mut error_tag: Option<String> = None;

        if let Some(success_spec) = self.success_field.as_deref()
            && let Some(val) = lookup_any(success_spec)
            && matches!(val.trim().to_ascii_lowercase().as_str(), "false" | "0")
        {
            error_tag = Some("false".to_owned());
        }

        if let Some(val) = lookup_any(&self.code_field) {
            let trimmed = val.trim();
            let is_ok = self
                .ok_values
                .iter()
                .map(|v| v.trim())
                .filter(|v| !v.is_empty())
                .any(|ok| ok.eq_ignore_ascii_case(trimmed));
            if !is_ok && !trimmed.is_empty() {
                error_tag = Some(trimmed.to_owned());
            }
        }

        let tag = error_tag?;
        let msg = self
            .message_field
            .as_deref()
            .and_then(lookup_any)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        Some(match msg {
            Some(text) => {
                let clipped: String = text.chars().take(48).collect();
                format!("{tag} · {clipped}")
            }
            None => tag,
        })
    }
}

/// 接口聚合统计单行结果。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointStatRow {
    pub key: String,
    pub method: String,
    pub host: String,
    pub normalized_path: String,
    pub graphql_operation: Option<String>,
    pub count: usize,
    pub error_count: usize,
    pub biz_error_count: usize,
    pub pending_count: usize,
    pub slow_count: usize,
    pub avg_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
    pub total_bytes: u64,
    pub sample_entry_id: String,
    pub sample_url: String,
}

/// 当前会话的接口聚合统计总览报告。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointStatsReport {
    pub total_requests: usize,
    pub total_errors: usize,
    pub total_biz_errors: usize,
    pub total_slow: usize,
    pub total_bytes: u64,
    pub endpoints: Vec<EndpointStatRow>,
}

/// 将 URL 中的数字 ID、UUID 与长十六进制段归一化为 `:id`，用于聚合同一接口的多次调用。
pub fn normalize_endpoint_path(url: &str, graphql_op: Option<&str>) -> (String, String) {
    let Ok(parsed) = url::Url::parse(url) else {
        return (String::new(), url.to_owned());
    };
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    let mut segments = Vec::new();
    for seg in parsed.path().split('/').filter(|s| !s.is_empty()) {
        if is_dynamic_path_segment(seg) {
            segments.push(":id");
        } else {
            segments.push(seg);
        }
    }
    let mut path = format!("/{}", segments.join("/"));
    if let Some(op) = graphql_op.filter(|s| !s.is_empty()) {
        path.push_str(&format!(" [{op}]"));
    }
    (host, path)
}

fn is_dynamic_path_segment(seg: &str) -> bool {
    if seg.is_empty() {
        return false;
    }
    // 纯数字 ID
    if seg.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    // 标准 UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
    if seg.len() == 36
        && seg.as_bytes()[8] == b'-'
        && seg.as_bytes()[13] == b'-'
        && seg.as_bytes()[18] == b'-'
        && seg.as_bytes()[23] == b'-'
        && seg
            .chars()
            .enumerate()
            .all(|(i, c)| matches!(i, 8 | 13 | 18 | 23) || c.is_ascii_hexdigit())
    {
        return true;
    }
    // 长十六进制或 ObjectId (如 24/32/40/64 位 hex)
    if seg.len() >= 16 && seg.chars().all(|c| c.is_ascii_hexdigit()) {
        return true;
    }
    false
}

/// 零分配 ASCII 大小写不敏感子串匹配（非 ASCII 字符回退为完整 Unicode 小写匹配）。
pub fn contains_ignore_case(haystack: &str, needle_lower: &str) -> bool {
    if needle_lower.is_empty() {
        return true;
    }
    if needle_lower.is_ascii() {
        let needle = needle_lower.as_bytes();
        let hay = haystack.as_bytes();
        if needle.len() > hay.len() {
            return false;
        }
        return hay
            .windows(needle.len())
            .any(|window| window.eq_ignore_ascii_case(needle));
    }
    haystack.to_lowercase().contains(needle_lower)
}

/// 网络请求列表窗口查询附加参数（支持域名、方法、状态码段、业务错误规则、慢请求阈值、降噪、跨请求正文搜索、多列排序与软清屏水位线）。
#[derive(Clone, Copy, Debug, Default)]
pub struct QueryOptions<'a> {
    pub host_filter: Option<&'a str>,
    pub exclude_patterns: &'a [String],
    pub method_filter: Option<&'a str>,
    pub status_filter: Option<&'a str>,
    pub search_body: bool,
    pub sort_by: Option<&'a str>,
    pub sort_dir: Option<&'a str>,
    pub after_seq: Option<u64>,
    pub max_bytes: Option<usize>,
    pub min_duration_ms: Option<f64>,
    pub biz_error_rule: Option<&'a BizErrorRule>,
}

#[derive(Clone)]
pub struct Session {
    pub header: Header,
    pub raw_header: Arc<str>,
    pub entries: Vec<StoredEntry>,
    pub skipped: usize,
    pub raw_bytes: usize,
    next_seq: u64,
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
            next_seq: 1,
            index: HashMap::new(),
        }
    }
    pub fn upsert(&mut self, entry: StoredEntry) {
        self.upsert_with_inherited(entry, None);
    }
    /// 插入或更新记录，支持从冷存储回迁时继承原接入序号 `seq` 与固定状态 `pinned`。
    pub fn upsert_with_inherited(
        &mut self,
        mut entry: StoredEntry,
        inherited: Option<(u64, bool)>,
    ) {
        self.raw_bytes += entry.raw.len();
        if let Some(index) = self.index.get(&entry.row.id).copied() {
            let previous = &self.entries[index];
            // 已有记录更新（如 pending -> completed）保持原接入序号与固定状态
            entry.row.seq = previous.row.seq;
            entry.row.pinned |= previous.row.pinned;
            self.raw_bytes -= previous.raw.len();
            self.entries[index] = entry;
        } else {
            if let Some((old_seq, old_pinned)) = inherited {
                entry.row.seq = old_seq;
                entry.row.pinned |= old_pinned;
                if old_seq >= self.next_seq {
                    self.next_seq = old_seq.saturating_add(1);
                }
            } else {
                entry.row.seq = self.next_seq;
                self.next_seq = self.next_seq.saturating_add(1);
            }
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
    /// 达到容量上限时按 FIFO 淘汰最早记录，并尽量优先保留用户手动固定（pinned）的记录。
    pub fn evict_prefix(&mut self, count: usize) {
        let _ = self.evict_prefix_extract(count);
    }

    /// 淘汰最早记录并返回被移出的记录列表，供实时会话写入磁盘冷存储以支持清屏历史完整回溯。
    pub fn evict_prefix_extract(&mut self, count: usize) -> Vec<StoredEntry> {
        let target = count.min(self.entries.len());
        if target == 0 {
            return Vec::new();
        }
        let mut remove_flags = vec![false; self.entries.len()];
        let mut removed = 0usize;
        // 第一轮：优先从头部淘汰未固定记录（天然先回收清屏前隐藏的早期历史）
        for (idx, entry) in self.entries.iter().enumerate() {
            if removed == target {
                break;
            }
            if !entry.row.pinned {
                remove_flags[idx] = true;
                removed += 1;
            }
        }
        // 第二轮：若剩余全是固定记录，仍按 FIFO 淘汰以严守内存硬上限
        if removed < target {
            for (idx, flag) in remove_flags.iter_mut().enumerate() {
                if removed == target {
                    break;
                }
                if !*flag {
                    *flag = true;
                    removed += 1;
                    let _ = idx;
                }
            }
        }
        let mut kept = Vec::with_capacity(self.entries.len() - removed);
        let mut evicted = Vec::with_capacity(removed);
        for (idx, entry) in self.entries.drain(..).enumerate() {
            if remove_flags[idx] {
                self.raw_bytes -= entry.raw.len();
                evicted.push(entry);
            } else {
                kept.push(entry);
            }
        }
        self.entries = kept;
        self.index.clear();
        for (index, entry) in self.entries.iter().enumerate() {
            self.index.insert(entry.row.id.clone(), index);
        }
        evicted
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
        self.query_with_options(
            search,
            filter,
            offset,
            limit,
            revision,
            range,
            QueryOptions {
                host_filter,
                exclude_patterns,
                ..Default::default()
            },
        )
    }

    /// 完整窗口查询：支持软清屏水位线（`after_seq`）、方法/状态筛选、跨请求正文搜索、排序与容量统计。
    #[allow(clippy::too_many_arguments)]
    pub fn query_with_options(
        &self,
        search: &str,
        filter: &str,
        offset: usize,
        limit: usize,
        revision: u32,
        range: &crate::query::ParsedRange,
        options: QueryOptions<'_>,
    ) -> QueryPage {
        self.query_with_spill(
            None, search, filter, offset, limit, revision, range, options,
        )
    }

    /// 联合查询冷存储（磁盘溢出历史）与热内存区，支持软清屏回溯、方法/状态筛选、跨请求正文全文检索与多列排序。
    #[allow(clippy::too_many_arguments)]
    pub fn query_with_spill(
        &self,
        mut spill: Option<&mut spill::SpillStore>,
        search: &str,
        filter: &str,
        offset: usize,
        limit: usize,
        revision: u32,
        range: &crate::query::ParsedRange,
        options: QueryOptions<'_>,
    ) -> QueryPage {
        let search_lower = search.to_lowercase();
        let host_lower = options
            .host_filter
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase);
        let method_upper = options
            .method_filter
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("all"))
            .map(str::to_ascii_uppercase);
        let status_filter = options
            .status_filter
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("all"))
            .map(str::to_ascii_lowercase);
        let excludes: Vec<String> = options
            .exclude_patterns
            .iter()
            .map(|p| p.trim().to_lowercase())
            .filter(|p| !p.is_empty())
            .collect();
        let after_seq = options.after_seq;

        let mut latest_seq = self
            .entries
            .iter()
            .map(|entry| entry.row.seq)
            .max()
            .unwrap_or(0);
        if let Some(cold) = spill.as_deref() {
            latest_seq = latest_seq.max(
                cold.entries
                    .iter()
                    .map(|entry| entry.row.seq)
                    .max()
                    .unwrap_or(0),
            );
        }

        let mut hidden_count = 0usize;
        let mut host_counts: HashMap<String, usize> = HashMap::new();
        let mut record_host = |row: &EntryRow| {
            if after_seq.is_some_and(|mark| row.seq <= mark) {
                hidden_count += 1;
                return;
            }
            if let Ok(parsed) = url::Url::parse(&row.url)
                && let Some(host) = parsed.host_str()
            {
                *host_counts.entry(host.to_lowercase()).or_insert(0) += 1;
            }
        };
        if let Some(cold) = spill.as_deref() {
            for entry in &cold.entries {
                record_host(&entry.row);
            }
        }
        for entry in &self.entries {
            record_host(&entry.row);
        }
        let mut host_list: Vec<(String, usize)> = host_counts.into_iter().collect();
        host_list.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let hosts: Vec<String> = host_list.into_iter().take(12).map(|(h, _)| h).collect();

        let biz_rule = options.biz_error_rule.filter(|r| r.enabled);
        let min_duration_ms = options
            .min_duration_ms
            .filter(|v| v.is_finite() && *v > 0.0);

        let matches_meta = |row: &EntryRow, biz_err: Option<&str>| -> bool {
            if after_seq.is_some_and(|mark| row.seq <= mark) {
                return false;
            }
            let accepted = match filter {
                "errors" => {
                    row.state == "failed"
                        || row.status.is_some_and(|s| s >= 400)
                        || biz_err.is_some()
                }
                "pending" => row.state == "pending",
                "pinned" => row.pinned,
                _ => true,
            };
            if !accepted || !range.includes(&row.started_at) {
                return false;
            }
            if let Some(min_ms) = min_duration_ms
                && !row.duration_ms.is_some_and(|d| d >= min_ms)
            {
                return false;
            }
            if let Some(target_method) = &method_upper
                && !row.method.eq_ignore_ascii_case(target_method)
            {
                return false;
            }
            if let Some(target_status) = &status_filter {
                let status_ok = match target_status.as_str() {
                    "2xx" => row.status.is_some_and(|s| (200..300).contains(&s)),
                    "3xx" => row.status.is_some_and(|s| (300..400).contains(&s)),
                    "4xx" => row.status.is_some_and(|s| (400..500).contains(&s)),
                    "5xx" => row.status.is_some_and(|s| s >= 500),
                    "failed" => row.state == "failed",
                    "bizerror" => biz_err.is_some(),
                    _ => true,
                };
                if !status_ok {
                    return false;
                }
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

        let sort_field = options
            .sort_by
            .filter(|field| matches!(*field, "time" | "duration" | "size"));
        let desc = options
            .sort_dir
            .is_some_and(|dir| dir.eq_ignore_ascii_case("desc"));

        struct MatchedRef {
            is_hot: bool,
            idx: usize,
            started_at_micros: i64,
            duration_ms: Option<f64>,
            response_bytes: Option<u64>,
            seq: u64,
            biz_error: Option<String>,
        }
        // 统一候选引用索引：区分来自冷区（false）还是热区（true）
        let mut matched_refs: Vec<MatchedRef> = Vec::new();
        if let Some(cold) = spill.as_deref_mut() {
            for idx in 0..cold.entries.len() {
                let biz_error = biz_rule.and_then(|rule| {
                    rule.evaluate(
                        cold.entries[idx].row.status,
                        &cold.entries[idx].response_fields,
                    )
                });
                let meta_ok = matches_meta(&cold.entries[idx].row, biz_error.as_deref());
                if !meta_ok {
                    continue;
                }
                let text_ok = if search_lower.is_empty()
                    || cold.entries[idx].search.contains(&search_lower)
                {
                    true
                } else if options.search_body {
                    let (off, len) = (cold.entries[idx].offset, cold.entries[idx].len);
                    cold.read_raw_at(off, len)
                        .is_some_and(|raw| contains_ignore_case(&raw, &search_lower))
                } else {
                    false
                };
                if text_ok {
                    let e = &cold.entries[idx];
                    matched_refs.push(MatchedRef {
                        is_hot: false,
                        idx,
                        started_at_micros: e.started_at_micros,
                        duration_ms: e.row.duration_ms,
                        response_bytes: e.row.response_bytes,
                        seq: e.row.seq,
                        biz_error,
                    });
                }
            }
        }
        for (idx, entry) in self.entries.iter().enumerate() {
            let biz_error =
                biz_rule.and_then(|rule| rule.evaluate(entry.row.status, &entry.response_fields));
            if !matches_meta(&entry.row, biz_error.as_deref()) {
                continue;
            }
            let text_ok = if search_lower.is_empty() || entry.search.contains(&search_lower) {
                true
            } else if options.search_body {
                contains_ignore_case(&entry.raw, &search_lower)
            } else {
                false
            };
            if text_ok {
                matched_refs.push(MatchedRef {
                    is_hot: true,
                    idx,
                    started_at_micros: entry.started_at_micros,
                    duration_ms: entry.row.duration_ms,
                    response_bytes: entry.row.response_bytes,
                    seq: entry.row.seq,
                    biz_error,
                });
            }
        }

        if let Some(field) = sort_field {
            matched_refs.sort_by(|a, b| {
                let primary = match field {
                    "time" => {
                        let ord = a.started_at_micros.cmp(&b.started_at_micros);
                        if desc { ord.reverse() } else { ord }
                    }
                    "duration" => match (a.duration_ms, b.duration_ms) {
                        (Some(x), Some(y)) => {
                            let ord = x.total_cmp(&y);
                            if desc { ord.reverse() } else { ord }
                        }
                        (Some(_), None) => Ordering::Less,
                        (None, Some(_)) => Ordering::Greater,
                        (None, None) => Ordering::Equal,
                    },
                    "size" => match (a.response_bytes, b.response_bytes) {
                        (Some(x), Some(y)) => {
                            let ord = x.cmp(&y);
                            if desc { ord.reverse() } else { ord }
                        }
                        (Some(_), None) => Ordering::Less,
                        (None, Some(_)) => Ordering::Greater,
                        (None, None) => Ordering::Equal,
                    },
                    _ => Ordering::Equal,
                };
                primary.then_with(|| a.seq.cmp(&b.seq))
            });
        } else if spill.is_some() {
            // 冷热双层合并时保证按原始接入顺序（seq 升序）呈现，避免乱序
            matched_refs.sort_by_key(|item| item.seq);
        }

        let total = matched_refs.len();
        let cold_ref = spill.as_deref();
        let rows: Vec<EntryRow> = matched_refs
            .into_iter()
            .skip(offset)
            .take(limit.min(500))
            .map(|item| {
                let mut row = if item.is_hot {
                    self.entries[item.idx].row.clone()
                } else {
                    cold_ref.unwrap().entries[item.idx].row.clone()
                };
                row.biz_error = item.biz_error;
                row
            })
            .collect();

        let (spilled_count, spilled_bytes) = spill
            .as_deref()
            .map_or((0, 0), |cold| (cold.len(), cold.retained_bytes()));

        QueryPage {
            total,
            offset,
            rows,
            revision,
            hosts,
            latest_seq,
            hidden_count,
            total_bytes: self.raw_bytes,
            max_bytes: options.max_bytes,
            spilled_count,
            spilled_bytes,
        }
    }

    /// 汇总当前会话（含磁盘冷存储）的接口聚合统计：识别高频重复请求、慢接口与报错热点。
    pub fn endpoint_stats(
        &self,
        spill: Option<&spill::SpillStore>,
        range: &crate::query::ParsedRange,
        after_seq: Option<u64>,
        biz_rule: Option<&BizErrorRule>,
    ) -> EndpointStatsReport {
        struct Acc {
            method: String,
            host: String,
            normalized_path: String,
            graphql_operation: Option<String>,
            count: usize,
            error_count: usize,
            biz_error_count: usize,
            pending_count: usize,
            slow_count: usize,
            durations: Vec<f64>,
            total_bytes: u64,
            sample_entry_id: String,
            sample_url: String,
            sample_priority: (u8, i64),
        }

        let active_rule = biz_rule.filter(|r| r.enabled);
        let mut total_requests = 0usize;
        let mut total_errors = 0usize;
        let mut total_biz_errors = 0usize;
        let mut total_slow = 0usize;
        let mut total_bytes = 0u64;
        let mut groups: HashMap<String, Acc> = HashMap::new();

        let mut ingest = |row: &EntryRow, fields: &[(String, String)]| {
            if after_seq.is_some_and(|mark| row.seq <= mark) || !range.includes(&row.started_at) {
                return;
            }
            total_requests += 1;
            let biz_err = active_rule.and_then(|rule| rule.evaluate(row.status, fields));
            let is_http_err = row.state == "failed" || row.status.is_some_and(|s| s >= 400);
            let is_err = is_http_err || biz_err.is_some();
            let is_slow = row.duration_ms.is_some_and(|d| d >= 800.0);
            let bytes = row.response_bytes.unwrap_or(0);

            if is_err {
                total_errors += 1;
            }
            if biz_err.is_some() {
                total_biz_errors += 1;
            }
            if is_slow {
                total_slow += 1;
            }
            total_bytes = total_bytes.saturating_add(bytes);

            let method = row.method.to_ascii_uppercase();
            let (host, normalized_path) =
                normalize_endpoint_path(&row.url, row.graphql_operation.as_deref());
            let key = format!("{method} {host}{normalized_path}");
            let priority = (
                if is_err { 2 } else { 1 },
                row.duration_ms.map(|d| (d * 100.0) as i64).unwrap_or(0),
            );

            let acc = groups.entry(key).or_insert_with(|| Acc {
                method: method.clone(),
                host: host.clone(),
                normalized_path: normalized_path.clone(),
                graphql_operation: row.graphql_operation.clone(),
                count: 0,
                error_count: 0,
                biz_error_count: 0,
                pending_count: 0,
                slow_count: 0,
                durations: Vec::new(),
                total_bytes: 0,
                sample_entry_id: row.id.clone(),
                sample_url: row.url.clone(),
                sample_priority: priority,
            });
            acc.count += 1;
            if is_err {
                acc.error_count += 1;
            }
            if biz_err.is_some() {
                acc.biz_error_count += 1;
            }
            if row.state == "pending" {
                acc.pending_count += 1;
            }
            if is_slow {
                acc.slow_count += 1;
            }
            if let Some(ms) = row.duration_ms {
                acc.durations.push(ms);
            }
            acc.total_bytes = acc.total_bytes.saturating_add(bytes);
            if priority >= acc.sample_priority {
                acc.sample_priority = priority;
                acc.sample_entry_id = row.id.clone();
                acc.sample_url = row.url.clone();
            }
        };

        if let Some(cold) = spill {
            for entry in &cold.entries {
                ingest(&entry.row, &entry.response_fields);
            }
        }
        for entry in &self.entries {
            ingest(&entry.row, &entry.response_fields);
        }

        let mut endpoints: Vec<EndpointStatRow> = groups
            .into_iter()
            .map(|(key, mut acc)| {
                acc.durations.sort_by(|a, b| a.total_cmp(b));
                let len = acc.durations.len();
                let (avg_ms, p50_ms, p95_ms, max_ms) = if len == 0 {
                    (0.0, 0.0, 0.0, 0.0)
                } else {
                    let sum: f64 = acc.durations.iter().sum();
                    let p50 = acc.durations[len / 2];
                    let p95 = acc.durations[((len - 1) * 95) / 100];
                    let max = acc.durations[len - 1];
                    (sum / len as f64, p50, p95, max)
                };
                EndpointStatRow {
                    key,
                    method: acc.method,
                    host: acc.host,
                    normalized_path: acc.normalized_path,
                    graphql_operation: acc.graphql_operation,
                    count: acc.count,
                    error_count: acc.error_count,
                    biz_error_count: acc.biz_error_count,
                    pending_count: acc.pending_count,
                    slow_count: acc.slow_count,
                    avg_ms,
                    p50_ms,
                    p95_ms,
                    max_ms,
                    total_bytes: acc.total_bytes,
                    sample_entry_id: acc.sample_entry_id,
                    sample_url: acc.sample_url,
                }
            })
            .collect();

        endpoints.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then_with(|| b.p95_ms.total_cmp(&a.p95_ms))
                .then_with(|| a.key.cmp(&b.key))
        });
        endpoints.truncate(200);

        EndpointStatsReport {
            total_requests,
            total_errors,
            total_biz_errors,
            total_slow,
            total_bytes,
            endpoints,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPage {
    pub total: usize,
    pub offset: usize,
    pub rows: Vec<EntryRow>,
    pub revision: u32,
    pub hosts: Vec<String>,
    pub latest_seq: u64,
    pub hidden_count: usize,
    pub total_bytes: usize,
    pub max_bytes: Option<usize>,
    pub spilled_count: usize,
    pub spilled_bytes: u64,
}

pub fn read_session(
    mut reader: impl BufRead,
    cancel: &AtomicBool,
    mut progress: impl FnMut(usize),
) -> Result<Session> {
    let mut session: Option<Session> = None;
    let mut total = 0;
    loop {
        if cancel.load(AtomicOrdering::Relaxed) {
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
                next_seq: 1,
                index: HashMap::new(),
            });
            continue;
        };
        match parse_entry(&value) {
            Ok(mut row) => {
                let started_at_micros = parse_timestamp_micros(&row.started_at);
                let response_fields = extract_response_json_fields(&value["response"]["body"]);
                let search = format!(
                    "{} {} {} {} {}",
                    row.method,
                    row.url,
                    row.source,
                    row.status.map(|s| s.to_string()).unwrap_or_default(),
                    row.graphql_operation.as_deref().unwrap_or("")
                )
                .to_lowercase();
                let existing = session.index.get(&row.id).copied();
                if existing.is_none() && session.entries.len() >= MAX_ENTRIES {
                    return Err("tooManyEntries".into());
                }
                if let Some(index) = existing {
                    row.seq = session.entries[index].row.seq;
                } else {
                    row.seq = session.next_seq;
                    session.next_seq = session.next_seq.saturating_add(1);
                }
                let entry = StoredEntry {
                    row,
                    raw: line.into(),
                    search,
                    started_at_micros,
                    response_fields,
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
    pub spilled_count: usize,
    pub spilled_bytes: u64,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::ParsedRange;
    use serde_json::json;

    fn sample_header() -> (Header, String) {
        let raw = json!({
            "format": "peek",
            "formatVersion": 1,
            "peekVersion": "2.1.1",
            "platform": "macos",
            "startedAt": "2026-11-24T00:00:00Z"
        })
        .to_string();
        let header = Header::parse(&serde_json::from_str(&raw).unwrap()).unwrap();
        (header, raw)
    }

    fn make_entry(
        id: &str,
        started_at: &str,
        completed_at: Option<&str>,
        body_text: Option<&str>,
    ) -> StoredEntry {
        let mut obj = json!({
            "id": id,
            "source": "dio",
            "startedAt": started_at,
            "request": { "method": "GET", "url": format!("https://api.example.test/{id}") }
        });
        if let Some(done) = completed_at {
            obj["completedAt"] = json!(done);
            obj["response"] = json!({
                "status": 200,
                "headers": [],
                "body": body_text.map_or_else(
                    || json!({ "kind": "empty" }),
                    |t| json!({ "kind": "text", "text": t })
                )
            });
        }
        StoredEntry::parse(&obj.to_string()).unwrap()
    }

    #[test]
    fn soft_clear_uses_monotonic_seq_and_eviction_preserves_pinned_entries() {
        let (header, raw_header) = sample_header();
        let mut session = Session::empty(header, raw_header);
        session.upsert(make_entry(
            "a",
            "2026-11-24T00:00:01Z",
            Some("2026-11-24T00:00:01.100Z"),
            Some("hi"),
        ));
        session.upsert(make_entry(
            "b",
            "2026-11-24T00:00:02Z",
            Some("2026-11-24T00:00:02.200Z"),
            Some("hello"),
        ));
        session.upsert(make_entry("c", "2026-11-24T00:00:03Z", None, None));
        session.toggle_pin("a").unwrap();

        // 在第 3 条处记录清屏水位线
        let initial = session.query_with_options(
            "",
            "all",
            0,
            100,
            1,
            &ParsedRange::default(),
            QueryOptions::default(),
        );
        assert_eq!(initial.latest_seq, 3);
        let mark = initial.latest_seq;

        // 清屏前的 pending 请求完成后更新，应保留原 seq（不蹦出到清屏后）
        session.upsert(make_entry(
            "c",
            "2026-11-24T00:00:03Z",
            Some("2026-11-24T00:00:04.000Z"),
            Some("done"),
        ));
        // 新到达的请求在清屏之后
        session.upsert(make_entry(
            "d",
            "2026-11-24T00:00:05Z",
            Some("2026-11-24T00:00:05.050Z"),
            Some("new"),
        ));

        let cleared = session.query_with_options(
            "",
            "all",
            0,
            100,
            2,
            &ParsedRange::default(),
            QueryOptions {
                after_seq: Some(mark),
                ..Default::default()
            },
        );
        assert_eq!(cleared.total, 1);
        assert_eq!(cleared.rows[0].id, "d");
        assert_eq!(cleared.hidden_count, 3);

        // 触发淘汰 1 条时，跳过已固定的 a，优先淘汰未固定的最旧记录 b，且清屏水位线依然精准
        session.evict_prefix(1);
        assert!(session.entry("a").is_some());
        assert!(session.entry("b").is_none());

        let after_evict = session.query_with_options(
            "",
            "all",
            0,
            100,
            3,
            &ParsedRange::default(),
            QueryOptions {
                after_seq: Some(mark),
                ..Default::default()
            },
        );
        assert_eq!(after_evict.total, 1);
        assert_eq!(after_evict.rows[0].id, "d");
        assert_eq!(after_evict.hidden_count, 2);
    }

    #[test]
    fn sorts_by_time_duration_and_size_with_nulls_always_last() {
        let (header, raw_header) = sample_header();
        let mut session = Session::empty(header, raw_header);
        session.upsert(make_entry(
            "slow",
            "2026-11-24T00:00:02Z",
            Some("2026-11-24T00:00:02.900Z"),
            Some("xx"),
        ));
        session.upsert(make_entry("pending", "2026-11-24T00:00:03Z", None, None));
        session.upsert(make_entry(
            "big",
            "2026-11-24T00:00:01Z",
            Some("2026-11-24T00:00:01.100Z"),
            Some("0123456789abcdef"),
        ));

        let by_duration_desc = session.query_with_options(
            "",
            "all",
            0,
            50,
            1,
            &ParsedRange::default(),
            QueryOptions {
                sort_by: Some("duration"),
                sort_dir: Some("desc"),
                ..Default::default()
            },
        );
        let ids: Vec<&str> = by_duration_desc
            .rows
            .iter()
            .map(|r| r.id.as_str())
            .collect();
        assert_eq!(ids, vec!["slow", "big", "pending"]);

        let by_duration_asc = session.query_with_options(
            "",
            "all",
            0,
            50,
            2,
            &ParsedRange::default(),
            QueryOptions {
                sort_by: Some("duration"),
                sort_dir: Some("asc"),
                ..Default::default()
            },
        );
        let ids: Vec<&str> = by_duration_asc.rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["big", "slow", "pending"]);

        let by_size_desc = session.query_with_options(
            "",
            "all",
            0,
            50,
            3,
            &ParsedRange::default(),
            QueryOptions {
                sort_by: Some("size"),
                sort_dir: Some("desc"),
                ..Default::default()
            },
        );
        let ids: Vec<&str> = by_size_desc.rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["big", "slow", "pending"]);

        let by_time_desc = session.query_with_options(
            "",
            "all",
            0,
            50,
            4,
            &ParsedRange::default(),
            QueryOptions {
                sort_by: Some("time"),
                sort_dir: Some("desc"),
                ..Default::default()
            },
        );
        let ids: Vec<&str> = by_time_desc.rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["pending", "slow", "big"]);
    }

    #[test]
    fn supports_body_search_method_status_filters_and_disk_spill_recall() {
        let (header, raw_header) = sample_header();
        let mut session = Session::empty(header, raw_header);

        let make_custom = |id: &str, method: &str, status: i64, body: &str| {
            let raw = json!({
                "id": id,
                "source": "dio",
                "startedAt": "2026-11-24T00:00:01Z",
                "completedAt": "2026-11-24T00:00:01.080Z",
                "request": { "method": method, "url": format!("https://api.example.test/{id}") },
                "response": { "status": status, "headers": [], "body": { "kind": "text", "text": body } }
            })
            .to_string();
            StoredEntry::parse(&raw).unwrap()
        };

        session.upsert(make_custom(
            "order-create",
            "POST",
            201,
            r#"{"orderNo":"ORD-889900","msg":"下单成功"}"#,
        ));
        session.upsert(make_custom(
            "order-fail",
            "POST",
            502,
            r#"{"error":"UPSTREAM_TIMEOUT"}"#,
        ));
        session.upsert(make_custom(
            "profile-get",
            "GET",
            200,
            r#"{"user":"alice"}"#,
        ));

        // 未开启搜正文时，仅匹配 URL/方法/状态，不会命中响应体字段
        let meta_only = session.query_with_options(
            "ord-889900",
            "all",
            0,
            50,
            1,
            &ParsedRange::default(),
            QueryOptions::default(),
        );
        assert_eq!(meta_only.total, 0);

        // 开启跨请求正文全文检索，支持大小写不敏感 ASCII 与中文匹配
        let body_ascii = session.query_with_options(
            "ord-889900",
            "all",
            0,
            50,
            2,
            &ParsedRange::default(),
            QueryOptions {
                search_body: true,
                ..Default::default()
            },
        );
        assert_eq!(body_ascii.total, 1);
        assert_eq!(body_ascii.rows[0].id, "order-create");

        let body_zh = session.query_with_options(
            "下单成功",
            "all",
            0,
            50,
            3,
            &ParsedRange::default(),
            QueryOptions {
                search_body: true,
                ..Default::default()
            },
        );
        assert_eq!(body_zh.total, 1);
        assert_eq!(body_zh.rows[0].id, "order-create");

        // 方法与状态码段组合筛选
        let post_5xx = session.query_with_options(
            "",
            "all",
            0,
            50,
            4,
            &ParsedRange::default(),
            QueryOptions {
                method_filter: Some("POST"),
                status_filter: Some("5xx"),
                ..Default::default()
            },
        );
        assert_eq!(post_5xx.total, 1);
        assert_eq!(post_5xx.rows[0].id, "order-fail");

        // 模拟热内存溢出到磁盘冷存储：冷区记录可完整回溯、全文搜索、固定并读回原文
        let mut spill = spill::SpillStore::default();
        for item in session.evict_prefix_extract(1) {
            assert!(spill.push(
                item.row,
                item.search,
                item.started_at_micros,
                item.response_fields,
                &item.raw
            ));
        }
        assert!(session.entry("order-create").is_none());
        assert_eq!(spill.len(), 1);
        assert!(
            spill
                .read_raw("order-create")
                .unwrap()
                .contains("ORD-889900")
        );
        assert_eq!(spill.toggle_pin("order-create"), Some(true));

        let recalled = session.query_with_spill(
            Some(&mut spill),
            "ORD-889900",
            "pinned",
            0,
            50,
            5,
            &ParsedRange::default(),
            QueryOptions {
                search_body: true,
                ..Default::default()
            },
        );
        assert_eq!(recalled.total, 1);
        assert_eq!(recalled.rows[0].id, "order-create");
        assert!(recalled.rows[0].pinned);
        assert_eq!(recalled.spilled_count, 1);
        assert!(recalled.spilled_bytes > 0);
    }

    #[test]
    fn graphql_extraction_biz_error_rule_and_endpoint_stats_work() {
        let (header, raw_header) = sample_header();
        let mut session = Session::empty(header, raw_header);

        // 1. 普通 HTTP 200 但业务码报错的订单接口（两个不同数字 ID 应归一化聚合为 /orders/:id）
        let biz_fail = json!({
            "id": "ord-1",
            "source": "dio",
            "startedAt": "2026-11-27T01:00:00.000Z",
            "completedAt": "2026-11-27T01:00:01.200Z",
            "request": {"method": "GET", "url": "https://api.example.test/v1/orders/10001"},
            "response": {
                "status": 200,
                "body": {"kind": "text", "text": "{\"code\":50001,\"msg\":\"token expired\"}"}
            }
        });
        let biz_ok = json!({
            "id": "ord-2",
            "source": "dio",
            "startedAt": "2026-11-27T01:00:02.000Z",
            "completedAt": "2026-11-27T01:00:02.150Z",
            "request": {"method": "GET", "url": "https://api.example.test/v1/orders/20002"},
            "response": {
                "status": 200,
                "body": {"kind": "text", "text": "{\"code\":0,\"msg\":\"ok\"}"}
            }
        });
        // 2. GraphQL 请求自动提取 operationName
        let gql = json!({
            "id": "gql-1",
            "source": "dio",
            "startedAt": "2026-11-27T01:00:03.000Z",
            "completedAt": "2026-11-27T01:00:03.080Z",
            "request": {
                "method": "POST",
                "url": "https://api.example.test/graphql",
                "body": {"kind": "text", "text": "{\"operationName\":\"GetUserProfile\",\"query\":\"query GetUserProfile { me { id } }\"}"}
            },
            "response": {
                "status": 200,
                "body": {"kind": "text", "text": "{\"data\":{\"me\":{\"id\":\"1\"}}}"}
            }
        });
        session.upsert(StoredEntry::parse(&biz_fail.to_string()).unwrap());
        session.upsert(StoredEntry::parse(&biz_ok.to_string()).unwrap());
        session.upsert(StoredEntry::parse(&gql.to_string()).unwrap());

        assert_eq!(
            session
                .entry("gql-1")
                .unwrap()
                .row
                .graphql_operation
                .as_deref(),
            Some("GetUserProfile")
        );

        let rule = BizErrorRule {
            enabled: true,
            code_field: "code,errCode".into(),
            ok_values: vec!["0".into(), "200".into()],
            success_field: Some("success".into()),
            message_field: Some("msg,message".into()),
        };

        // 业务错误筛选应仅命中 ord-1 且返回清晰摘要
        let biz_errors = session.query_with_options(
            "",
            "all",
            0,
            50,
            1,
            &ParsedRange::default(),
            QueryOptions {
                status_filter: Some("bizError"),
                biz_error_rule: Some(&rule),
                ..Default::default()
            },
        );
        assert_eq!(biz_errors.total, 1);
        assert_eq!(biz_errors.rows[0].id, "ord-1");
        assert_eq!(
            biz_errors.rows[0].biz_error.as_deref(),
            Some("50001 · token expired")
        );

        // 慢请求阈值筛选（>= 1000ms）应命中 ord-1 (1200ms)
        let slow_only = session.query_with_options(
            "",
            "all",
            0,
            50,
            2,
            &ParsedRange::default(),
            QueryOptions {
                min_duration_ms: Some(1000.0),
                ..Default::default()
            },
        );
        assert_eq!(slow_only.total, 1);
        assert_eq!(slow_only.rows[0].id, "ord-1");

        // 接口聚合统计：两个数字 ID 订单接口合并为 /v1/orders/:id，GraphQL 携带 [GetUserProfile]
        let stats = session.endpoint_stats(None, &ParsedRange::default(), None, Some(&rule));
        assert_eq!(stats.total_requests, 3);
        assert_eq!(stats.total_errors, 1);
        assert_eq!(stats.total_biz_errors, 1);
        assert_eq!(stats.total_slow, 1);
        assert_eq!(stats.endpoints.len(), 2);
        assert_eq!(stats.endpoints[0].normalized_path, "/v1/orders/:id");
        assert_eq!(stats.endpoints[0].count, 2);
        assert_eq!(stats.endpoints[0].biz_error_count, 1);
        assert_eq!(stats.endpoints[0].sample_entry_id, "ord-1");
        assert_eq!(
            stats.endpoints[1].normalized_path,
            "/graphql [GetUserProfile]"
        );
    }
}
