//! 高性能连续控制台日志流引擎：
//! 1. 将网络请求拆分为 `[http-request]` 与 `[http-response]`/`[http-error]`，按时间戳与诊断日志交错输出；
//! 2. 通过“单块格式化缓存 + 快照前缀和行索引”实现 `O(log N)` 行级切片查询，支持前端固定行高虚拟滚动与预加载；
//! 3. 支持清屏基线、上下文定位搜索跳转、请求↔响应配对跳转、单块/全局折叠，以及自动去除 `flutter:` 前缀与重复框线。

use crate::{
    protocol::session::{Result, body_size},
    query::{ParsedRange, Scope, TimeRange},
    remote::{diagnostics::DiagnosticStore, server::Remote},
    session::StoredEntry,
};
use chrono::{DateTime, FixedOffset, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::Write,
    sync::Arc,
};

/// 单条日志块最多展开的行数上限，避免极端超大载荷拖垮内存。
const MAX_BLOCK_LINES: usize = 20_000;
/// 单条正文文本最大格式化字节数（1 MiB），与正文预览上限保持一致。
const MAX_BLOCK_PREVIEW_BYTES: usize = 1024 * 1024;
/// 单行最大字符宽度，超过后自动软切行以保障固定行高渲染流畅。
const MAX_LINE_CHARS: usize = 500;
/// 单块格式化缓存容量上限。
const MAX_BLOCK_CACHE: usize = 24_000;
/// 快照索引缓存容量上限。
const MAX_SNAPSHOT_CACHE: usize = 6;
/// 单次 IPC 分片最多返回的行数。
const MAX_PAGE_LINES: usize = 400;
/// 定位模式下最多返回的搜索命中行数量。
const MAX_STREAM_MATCHES: usize = 5_000;
/// 框线水平横线（固定美观宽度）。
const BOX_RULE: &str = "──────────────────────────────────────────────────────────────────────────────────────────────────────────────";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StreamQuery {
    pub search: String,
    /// 搜索模式：`filter`（过滤只看匹配块）或 `locate`（保留上下文并高亮定位）。
    pub search_mode: String,
    pub kind_filter: String,
    pub range: TimeRange,
    /// 清屏基线（微秒时间戳）：仅展示该时间点之后的记录，为 None 时展示全量历史。
    pub min_timestamp_micros: Option<i64>,
    /// 手动折叠的 blockId 集合。
    pub collapsed_blocks: Vec<String>,
    /// 是否全局切换为紧凑模式（仅展示框线与标题行）。
    pub compact_all: bool,
    pub line_offset: usize,
    pub line_limit: usize,
    pub tz_offset_east_seconds: i32,
    pub revision: u32,
}

impl Default for StreamQuery {
    fn default() -> Self {
        Self {
            search: String::new(),
            search_mode: "filter".into(),
            kind_filter: "all".into(),
            range: TimeRange::default(),
            min_timestamp_micros: None,
            collapsed_blocks: Vec::new(),
            compact_all: false,
            line_offset: 0,
            line_limit: 200,
            tz_offset_east_seconds: 0,
            revision: 0,
        }
    }
}

/// 远端未加载正文提示，供前端按需或低并发自动拉取。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBodyHint {
    pub session_id: String,
    pub entry_id: String,
    pub side: String,
    pub size: Option<u64>,
    pub media_type: Option<String>,
}

/// 每一行的语义角色，便于前端直接按轻量 CSS 类着色。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineRole {
    Top,
    Header,
    Meta,
    Body,
    Error,
    Remote,
    Bottom,
}

#[derive(Clone, Debug)]
struct BlockLine {
    text: String,
    role: LineRole,
}

#[derive(Clone, Debug)]
pub struct FormattedBlock {
    pub block_id: String,
    pub kind: String,
    pub level: String,
    pub occurred_at: String,
    pub timestamp_micros: i64,
    pub sub_order: u8,
    pub session_id: Option<String>,
    pub entry_id: Option<String>,
    pub run_id: Option<String>,
    pub event_id: Option<String>,
    pub remote_body: Option<RemoteBodyHint>,
    pub pair_summary: Option<String>,
    pub search_text: Arc<str>,
    lines: Vec<BlockLine>,
}

impl FormattedBlock {
    pub fn line_count(&self) -> usize {
        self.lines.len()
    }

    /// 导出该日志块的完整标准框线纯文本（不含 `flutter:` 前缀）。
    pub fn to_plain_text(&self) -> String {
        let estimated: usize = self.lines.iter().map(|line| line.text.len() + 1).sum();
        let mut out = String::with_capacity(estimated);
        for (idx, line) in self.lines.iter().enumerate() {
            if idx > 0 {
                out.push('\n');
            }
            out.push_str(&line.text);
        }
        out
    }
}

/// 返回给前端虚拟列表的单行 DTO。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamLine {
    pub line_index: usize,
    pub block_id: String,
    pub block_start_line: usize,
    pub block_line_count: usize,
    pub kind: String,
    pub level: String,
    pub role: LineRole,
    pub text: String,
    pub occurred_at: String,
    pub session_id: Option<String>,
    pub entry_id: Option<String>,
    pub run_id: Option<String>,
    pub event_id: Option<String>,
    pub remote_body: Option<RemoteBodyHint>,
    pub collapsed: bool,
    pub hidden_lines: usize,
    pub pair_line: Option<usize>,
    pub pair_label: Option<String>,
}

/// 分片查询结果。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamPage {
    pub total_lines: usize,
    pub total_blocks: usize,
    pub line_offset: usize,
    pub revision: u32,
    pub latest_timestamp_micros: Option<i64>,
    pub lines: Vec<StreamLine>,
}

/// 上下文定位模式下的搜索命中行集合。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamMatches {
    pub line_indices: Vec<usize>,
    pub limited: bool,
}

/// 诊断事件轻快照（脱离锁后构建日志流，避免阻塞写入线程）。
#[derive(Clone)]
pub struct DiagnosticRawItem {
    pub run_key: String,
    pub event_id: String,
    pub occurred_at: String,
    pub kind: String,
    pub level: String,
    pub raw: Arc<str>,
    pub search: Arc<str>,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct BlockCacheKey {
    item_key: String,
    revision: String,
    tz_offset_east_seconds: i32,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct SnapshotKey {
    scope_kind: String,
    scope_id: String,
    version_stamp: String,
    search: String,
    search_mode: String,
    kind_filter: String,
    from: Option<String>,
    to: Option<String>,
    min_timestamp_micros: Option<i64>,
    collapsed_signature: String,
    compact_all: bool,
    tz_offset_east_seconds: i32,
}

/// 块在快照中的视图元信息（支持单块折叠与请求↔响应配对跳转）。
struct SnapshotEntry {
    block: Arc<FormattedBlock>,
    collapsed: bool,
    visible_lines: usize,
    hidden_lines: usize,
    pair_line: Option<usize>,
    pair_label: Option<String>,
}

pub struct StreamSnapshot {
    entries: Vec<SnapshotEntry>,
    /// 前缀和数组：长度 = entries.len() + 1，`prefix_lines[i]` 为第 i 个块的起始行号。
    pub prefix_lines: Vec<usize>,
    pub latest_timestamp_micros: Option<i64>,
}

impl StreamSnapshot {
    pub fn total_lines(&self) -> usize {
        self.prefix_lines.last().copied().unwrap_or(0)
    }

    pub fn total_blocks(&self) -> usize {
        self.entries.len()
    }

    fn visible_line(entry: &SnapshotEntry, local_idx: usize) -> &BlockLine {
        if entry.collapsed {
            let total = entry.block.lines.len();
            match local_idx {
                0 => &entry.block.lines[0],
                1 => &entry.block.lines[1.min(total - 1)],
                _ => &entry.block.lines[total - 1],
            }
        } else {
            &entry.block.lines[local_idx]
        }
    }

    /// 使用二分查找在 `O(log B + limit)` 时间内切出指定行区间。
    pub fn slice(&self, line_offset: usize, line_limit: usize, revision: u32) -> StreamPage {
        let total_lines = self.total_lines();
        let total_blocks = self.total_blocks();
        let limit = line_limit.clamp(1, MAX_PAGE_LINES);
        if total_lines == 0 || line_offset >= total_lines {
            return StreamPage {
                total_lines,
                total_blocks,
                line_offset,
                revision,
                latest_timestamp_micros: self.latest_timestamp_micros,
                lines: Vec::new(),
            };
        }
        let end_line = (line_offset + limit).min(total_lines);
        let mut lines = Vec::with_capacity(end_line - line_offset);

        let mut block_idx = self
            .prefix_lines
            .partition_point(|&start| start <= line_offset)
            .saturating_sub(1);
        let mut cursor = line_offset;

        while cursor < end_line && block_idx < self.entries.len() {
            let entry = &self.entries[block_idx];
            let block = &entry.block;
            let block_start = self.prefix_lines[block_idx];
            let block_len = entry.visible_lines;
            let block_end = block_start + block_len;
            let take_end = end_line.min(block_end);

            for line_no in cursor..take_end {
                let local_idx = line_no - block_start;
                let line = Self::visible_line(entry, local_idx);
                let is_header = line.role == LineRole::Header;
                lines.push(StreamLine {
                    line_index: line_no,
                    block_id: block.block_id.clone(),
                    block_start_line: block_start,
                    block_line_count: block_len,
                    kind: block.kind.clone(),
                    level: block.level.clone(),
                    role: line.role,
                    text: line.text.clone(),
                    occurred_at: block.occurred_at.clone(),
                    session_id: block.session_id.clone(),
                    entry_id: block.entry_id.clone(),
                    run_id: block.run_id.clone(),
                    event_id: block.event_id.clone(),
                    remote_body: if line.role == LineRole::Remote || is_header {
                        block.remote_body.clone()
                    } else {
                        None
                    },
                    collapsed: entry.collapsed,
                    hidden_lines: if is_header { entry.hidden_lines } else { 0 },
                    pair_line: if is_header { entry.pair_line } else { None },
                    pair_label: if is_header {
                        entry.pair_label.clone()
                    } else {
                        None
                    },
                });
            }

            cursor = take_end;
            block_idx += 1;
        }

        StreamPage {
            total_lines,
            total_blocks,
            line_offset,
            revision,
            latest_timestamp_micros: self.latest_timestamp_micros,
            lines,
        }
    }

    /// 扫描当前快照中命中关键词的所有可见行号（用于上下文定位模式逐个跳转）。
    pub fn find_matches(&self, needle: &str) -> StreamMatches {
        let needle_lower = needle.trim().to_lowercase();
        if needle_lower.is_empty() {
            return StreamMatches {
                line_indices: Vec::new(),
                limited: false,
            };
        }
        let mut line_indices = Vec::new();
        let mut limited = false;
        for (idx, entry) in self.entries.iter().enumerate() {
            // 先在块级小写搜索文本中快速预筛，未命中整块跳过
            if !entry.block.search_text.contains(&needle_lower) {
                continue;
            }
            let block_start = self.prefix_lines[idx];
            for local_idx in 0..entry.visible_lines {
                let line = Self::visible_line(entry, local_idx);
                if matches!(line.role, LineRole::Top | LineRole::Bottom) {
                    continue;
                }
                if line.text.to_lowercase().contains(&needle_lower) {
                    if line_indices.len() >= MAX_STREAM_MATCHES {
                        limited = true;
                        return StreamMatches {
                            line_indices,
                            limited,
                        };
                    }
                    line_indices.push(block_start + local_idx);
                }
            }
        }
        StreamMatches {
            line_indices,
            limited,
        }
    }

    /// 根据网络请求 `entry_id` 定位其在日志流中的首行行号（优先匹配请求块或指定类型）。
    pub fn locate_entry(&self, entry_id: &str, preferred_kind: Option<&str>) -> Option<usize> {
        let mut fallback = None;
        for (idx, entry) in self.entries.iter().enumerate() {
            if entry.block.entry_id.as_deref() == Some(entry_id) {
                let line_no = self.prefix_lines[idx];
                if preferred_kind.is_none_or(|k| entry.block.kind == k) {
                    return Some(line_no);
                }
                if fallback.is_none() {
                    fallback = Some(line_no);
                }
            }
        }
        fallback
    }

    /// 获取单个日志块的完整纯文本（即便当前处于折叠态，复制的依然是完整原文）。
    pub fn block_text(&self, block_id: &str) -> Result<String> {
        self.entries
            .iter()
            .find(|entry| entry.block.block_id == block_id)
            .map(|entry| entry.block.to_plain_text())
            .ok_or_else(|| "entryNotFound".into())
    }

    /// 流式写入当前视图下的全部框线纯文本（适合导出大文件）。
    pub fn write_all(&self, mut writer: impl Write) -> Result<()> {
        for (idx, entry) in self.entries.iter().enumerate() {
            if idx > 0 {
                writer.write_all(b"\n").map_err(|e| e.to_string())?;
            }
            for line in &entry.block.lines {
                writer
                    .write_all(line.text.as_bytes())
                    .map_err(|e| e.to_string())?;
                writer.write_all(b"\n").map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}

/// 进程级流式日志两级缓存：
/// - `blocks` 缓存单条记录的排版结果，实时增量写入时老记录 100% 命中；
/// - `snapshots` 缓存排好序的前缀和索引，上下滚动切片完全 `O(log B)`。
#[derive(Default)]
pub struct StreamCache {
    blocks: HashMap<BlockCacheKey, Vec<Arc<FormattedBlock>>>,
    block_order: VecDeque<BlockCacheKey>,
    snapshots: VecDeque<(SnapshotKey, Arc<StreamSnapshot>)>,
}

impl StreamCache {
    fn get_or_format_network(
        &mut self,
        session_id: &str,
        entry: &StoredEntry,
        tz_offset_east_seconds: i32,
    ) -> Vec<Arc<FormattedBlock>> {
        let key = BlockCacheKey {
            item_key: format!("net:{session_id}:{}", entry.row.id),
            revision: entry.row.content_revision.clone(),
            tz_offset_east_seconds,
        };
        if let Some(cached) = self.blocks.get(&key) {
            return cached.clone();
        }
        let formatted = format_network_entry(session_id, entry, tz_offset_east_seconds);
        self.insert_block(key, formatted.clone());
        formatted
    }

    fn get_or_format_diagnostic(
        &mut self,
        item: &DiagnosticRawItem,
        tz_offset_east_seconds: i32,
    ) -> Arc<FormattedBlock> {
        let key = BlockCacheKey {
            item_key: format!("diag:{}:{}", item.run_key, item.event_id),
            revision: String::new(),
            tz_offset_east_seconds,
        };
        if let Some(cached) = self.blocks.get(&key)
            && let Some(first) = cached.first()
        {
            return Arc::clone(first);
        }
        let formatted = Arc::new(format_diagnostic_event(item, tz_offset_east_seconds));
        self.insert_block(key, vec![Arc::clone(&formatted)]);
        formatted
    }

    fn insert_block(&mut self, key: BlockCacheKey, value: Vec<Arc<FormattedBlock>>) {
        if self.blocks.len() >= MAX_BLOCK_CACHE {
            let drop_count = MAX_BLOCK_CACHE / 2;
            for _ in 0..drop_count {
                if let Some(oldest) = self.block_order.pop_front() {
                    self.blocks.remove(&oldest);
                } else {
                    break;
                }
            }
        }
        self.block_order.push_back(key.clone());
        self.blocks.insert(key, value);
    }

    pub fn build_snapshot(
        &mut self,
        scope: &Scope,
        version_stamp: String,
        network: &[StoredEntry],
        diagnostics: &[DiagnosticRawItem],
        query: &StreamQuery,
    ) -> Result<Arc<StreamSnapshot>> {
        let range = query.range.parse()?;
        let tz = clamp_tz_offset(query.tz_offset_east_seconds);
        let search_lower = query.search.trim().to_lowercase();
        let search_mode = normalize_search_mode(&query.search_mode);
        let filter_by_search = search_mode == "filter" && !search_lower.is_empty();
        let kind_filter = normalize_kind_filter(&query.kind_filter);
        let (scope_kind, scope_id) = match scope {
            Scope::Network { id } => ("network".to_string(), id.clone()),
            Scope::Diagnostic { id } => ("diagnostic".to_string(), id.clone()),
        };

        let mut collapsed_sorted = query.collapsed_blocks.clone();
        collapsed_sorted.sort();
        collapsed_sorted.dedup();
        let collapsed_signature = collapsed_sorted.join("\x1f");

        let snap_key = SnapshotKey {
            scope_kind,
            scope_id: scope_id.clone(),
            version_stamp,
            search: if filter_by_search {
                search_lower.clone()
            } else {
                String::new()
            },
            search_mode: search_mode.to_string(),
            kind_filter: kind_filter.to_string(),
            from: query.range.from.clone(),
            to: query.range.to.clone(),
            min_timestamp_micros: query.min_timestamp_micros,
            collapsed_signature,
            compact_all: query.compact_all,
            tz_offset_east_seconds: tz,
        };

        if let Some(pos) = self.snapshots.iter().position(|(k, _)| k == &snap_key) {
            let entry = self.snapshots.remove(pos).unwrap();
            let snapshot = Arc::clone(&entry.1);
            self.snapshots.push_back(entry);
            return Ok(snapshot);
        }

        let mut blocks: Vec<Arc<FormattedBlock>> = Vec::new();
        let mut latest_timestamp_micros: Option<i64> = None;
        let search_needle = if filter_by_search {
            search_lower.as_str()
        } else {
            ""
        };

        // 1. 组装网络请求/响应块
        if matches!(kind_filter, "all" | "network" | "errors") {
            let network_session_id = match scope {
                Scope::Network { id } => id.as_str(),
                Scope::Diagnostic { .. } => "",
            };
            for entry in network {
                let items = self.get_or_format_network(network_session_id, entry, tz);
                for block in items {
                    latest_timestamp_micros = Some(
                        latest_timestamp_micros.map_or(block.timestamp_micros, |cur| {
                            cur.max(block.timestamp_micros)
                        }),
                    );
                    if query
                        .min_timestamp_micros
                        .is_some_and(|min_ts| block.timestamp_micros <= min_ts)
                    {
                        continue;
                    }
                    if matches_stream_filters(&block, kind_filter, &range, search_needle) {
                        blocks.push(block);
                    }
                }
            }
        }

        // 2. 组装诊断日志/异常块
        if matches!(kind_filter, "all" | "logs" | "errors") {
            for item in diagnostics {
                let item_ts = parse_micros(&item.occurred_at);
                latest_timestamp_micros =
                    Some(latest_timestamp_micros.map_or(item_ts, |cur| cur.max(item_ts)));
                if query
                    .min_timestamp_micros
                    .is_some_and(|min_ts| item_ts <= min_ts)
                {
                    continue;
                }
                if kind_filter == "errors"
                    && item.kind != "exception"
                    && !matches!(item.level.as_str(), "error" | "critical" | "warning")
                {
                    continue;
                }
                if !range.includes(&item.occurred_at) {
                    continue;
                }
                if !search_needle.is_empty() && !item.search.contains(search_needle) {
                    continue;
                }
                let block = self.get_or_format_diagnostic(item, tz);
                if matches_stream_filters(&block, kind_filter, &range, search_needle) {
                    blocks.push(block);
                }
            }
        }

        // 按精确时间戳、请求先于响应顺序、block_id 稳定排序
        blocks.sort_by(|a, b| {
            a.timestamp_micros
                .cmp(&b.timestamp_micros)
                .then(a.sub_order.cmp(&b.sub_order))
                .then(a.block_id.cmp(&b.block_id))
        });

        let collapsed_set: HashSet<&str> = collapsed_sorted.iter().map(String::as_str).collect();
        let mut prefix_lines = Vec::with_capacity(blocks.len() + 1);
        let mut entries = Vec::with_capacity(blocks.len());
        let mut total = 0usize;
        prefix_lines.push(0);

        for block in blocks {
            let full_lines = block.line_count();
            let collapsible = full_lines > 3;
            let collapsed = collapsible
                && (query.compact_all || collapsed_set.contains(block.block_id.as_str()));
            let visible_lines = if collapsed { 3 } else { full_lines };
            let hidden_lines = full_lines.saturating_sub(visible_lines);
            total += visible_lines;
            prefix_lines.push(total);
            entries.push(SnapshotEntry {
                block,
                collapsed,
                visible_lines,
                hidden_lines,
                pair_line: None,
                pair_label: None,
            });
        }

        // 一次线性扫描建立请求↔响应配对跳转索引
        let mut req_map: HashMap<&str, usize> = HashMap::new();
        let mut res_map: HashMap<&str, (usize, Option<String>)> = HashMap::new();
        for (idx, entry) in entries.iter().enumerate() {
            if let Some(eid) = entry.block.entry_id.as_deref() {
                let start_line = prefix_lines[idx];
                if entry.block.kind == "http-request" {
                    req_map.insert(eid, start_line);
                } else if matches!(entry.block.kind.as_str(), "http-response" | "http-error") {
                    res_map.insert(eid, (start_line, entry.block.pair_summary.clone()));
                }
            }
        }
        let pair_updates: Vec<(Option<usize>, Option<String>)> = entries
            .iter()
            .map(|entry| {
                let Some(eid) = entry.block.entry_id.as_deref() else {
                    return (None, None);
                };
                if entry.block.kind == "http-request" {
                    if let Some((line, summary)) = res_map.get(eid) {
                        return (Some(*line), summary.clone());
                    }
                } else if matches!(entry.block.kind.as_str(), "http-response" | "http-error")
                    && let Some(line) = req_map.get(eid)
                {
                    return (Some(*line), Some("↑ 请求".into()));
                }
                (None, None)
            })
            .collect();
        for (entry, (pair_line, pair_label)) in entries.iter_mut().zip(pair_updates) {
            entry.pair_line = pair_line;
            entry.pair_label = pair_label;
        }

        let snapshot = Arc::new(StreamSnapshot {
            entries,
            prefix_lines,
            latest_timestamp_micros,
        });

        if self.snapshots.len() >= MAX_SNAPSHOT_CACHE {
            self.snapshots.pop_front();
        }
        self.snapshots.push_back((snap_key, Arc::clone(&snapshot)));
        Ok(snapshot)
    }
}

/// 从 `DiagnosticStore` 快速提取作用域内的诊断事件轻快照及版本戳。
pub fn diagnostic_snapshot(
    scope: &Scope,
    store: &DiagnosticStore,
) -> Result<(String, Vec<DiagnosticRawItem>)> {
    if let Scope::Diagnostic { id } = scope
        && !store.runs.contains_key(id)
    {
        return Err("diagnosticNotFound".into());
    }
    let mut versions: Vec<(String, u64)> = Vec::new();
    let mut items: Vec<DiagnosticRawItem> = Vec::new();
    for (key, run) in &store.runs {
        let included = match scope {
            Scope::Network { id } => run.network_key.as_ref() == Some(id),
            Scope::Diagnostic { id } => id == key,
        };
        if included {
            versions.push((key.clone(), run.version));
            for stored in run.events() {
                items.push(DiagnosticRawItem {
                    run_key: key.clone(),
                    event_id: stored.event.event_id.clone(),
                    occurred_at: stored.event.occurred_at.clone(),
                    kind: stored.event.kind.clone(),
                    level: stored.event.level.clone(),
                    raw: Arc::clone(&stored.raw),
                    search: stored.search_text(),
                });
            }
        }
    }
    versions.sort_by(|a, b| a.0.cmp(&b.0));
    let version_stamp = versions
        .into_iter()
        .map(|(k, v)| format!("{k}:{v}"))
        .collect::<Vec<_>>()
        .join(",");
    Ok((version_stamp, items))
}

impl Remote {
    /// 获取实时网络会话的完整记录快照（仅克隆 `Arc<str>` 引用，极快释放锁）。
    pub fn network_entries(&self, id: &str) -> Result<(u64, Vec<StoredEntry>)> {
        let store = self.store.lock().map_err(|_| "internalError")?;
        let session = store.sessions.get(id).ok_or("sessionNotFound")?;
        Ok((session.version, session.current.entries.clone()))
    }

    /// 获取与当前作用域关联的诊断事件轻快照。
    pub fn diagnostic_raw_items(&self, scope: &Scope) -> Result<(String, Vec<DiagnosticRawItem>)> {
        let store = self.diagnostics.lock().map_err(|_| "internalError")?;
        diagnostic_snapshot(scope, &store)
    }
}

fn clamp_tz_offset(seconds: i32) -> i32 {
    seconds.clamp(-86_399, 86_399)
}

fn normalize_kind_filter(filter: &str) -> &'static str {
    match filter {
        "network" => "network",
        "logs" => "logs",
        "errors" => "errors",
        _ => "all",
    }
}

fn normalize_search_mode(mode: &str) -> &'static str {
    if mode == "locate" { "locate" } else { "filter" }
}

fn matches_stream_filters(
    block: &FormattedBlock,
    kind_filter: &str,
    range: &ParsedRange,
    search_lower: &str,
) -> bool {
    let kind_ok = match kind_filter {
        "network" => matches!(
            block.kind.as_str(),
            "http-request" | "http-response" | "http-error"
        ),
        "logs" => matches!(block.kind.as_str(), "log" | "exception"),
        "errors" => {
            block.kind == "http-error"
                || block.kind == "exception"
                || matches!(block.level.as_str(), "error" | "critical" | "warning")
        }
        _ => true,
    };
    if !kind_ok {
        return false;
    }
    if !range.includes(&block.occurred_at) {
        return false;
    }
    if !search_lower.is_empty() && !block.search_text.contains(search_lower) {
        return false;
    }
    true
}

fn parse_micros(rfc3339: &str) -> i64 {
    DateTime::parse_from_rfc3339(rfc3339)
        .map(|dt| dt.timestamp_micros())
        .unwrap_or(0)
}

fn format_local_time(rfc3339: &str, tz_offset_east_seconds: i32) -> String {
    let Ok(parsed) = DateTime::parse_from_rfc3339(rfc3339) else {
        return rfc3339.to_string();
    };
    let offset = FixedOffset::east_opt(clamp_tz_offset(tz_offset_east_seconds))
        .unwrap_or_else(|| FixedOffset::east_opt(0).unwrap());
    let local = parsed.with_timezone(&offset);
    let ms = local.nanosecond() / 1_000_000;
    format!(
        "{:02}:{:02}:{:02} {:03}ms",
        local.hour(),
        local.minute(),
        local.second(),
        ms
    )
}

fn strip_flutter_prefix(line: &str) -> &str {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix("flutter: ") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("flutter:") {
        rest.strip_prefix(' ').unwrap_or(rest)
    } else {
        line
    }
}

fn clean_message_lines(message: &str) -> Vec<String> {
    let raw_lines: Vec<&str> = message.lines().map(strip_flutter_prefix).collect();
    if raw_lines.is_empty() {
        return vec![String::new()];
    }
    let has_box = raw_lines.len() >= 2
        && raw_lines
            .first()
            .is_some_and(|l| l.trim_start().starts_with("┌─"))
        && raw_lines
            .last()
            .is_some_and(|l| l.trim_start().starts_with("└─"));
    let slice = if has_box {
        &raw_lines[1..raw_lines.len() - 1]
    } else {
        &raw_lines[..]
    };
    let mut cleaned = Vec::with_capacity(slice.len());
    for line in slice {
        let stripped = if has_box {
            let t = line.trim_start();
            if let Some(rest) = t.strip_prefix("│ ") {
                rest
            } else if let Some(rest) = t.strip_prefix('│') {
                rest
            } else {
                line
            }
        } else {
            line
        };
        cleaned.push(stripped.to_string());
    }
    if cleaned.is_empty() {
        cleaned.push(String::new());
    }
    cleaned
}

fn push_wrapped_line(
    lines: &mut Vec<BlockLine>,
    prefix: &str,
    content: &str,
    role: LineRole,
    truncated_flag: &mut bool,
) {
    if lines.len() >= MAX_BLOCK_LINES {
        *truncated_flag = true;
        return;
    }
    if content.chars().count() <= MAX_LINE_CHARS {
        lines.push(BlockLine {
            text: format!("{prefix}{content}"),
            role,
        });
        return;
    }
    let mut chunk = String::new();
    let mut count = 0usize;
    let mut first = true;
    for ch in content.chars() {
        chunk.push(ch);
        count += 1;
        if count >= MAX_LINE_CHARS {
            if lines.len() >= MAX_BLOCK_LINES {
                *truncated_flag = true;
                return;
            }
            let p = if first { prefix } else { "│   " };
            lines.push(BlockLine {
                text: format!("{p}{chunk}"),
                role,
            });
            chunk.clear();
            count = 0;
            first = false;
        }
    }
    if !chunk.is_empty() {
        if lines.len() >= MAX_BLOCK_LINES {
            *truncated_flag = true;
            return;
        }
        let p = if first { prefix } else { "│   " };
        lines.push(BlockLine {
            text: format!("{p}{chunk}"),
            role,
        });
    }
}

fn push_labeled_multiline(
    lines: &mut Vec<BlockLine>,
    label: &str,
    body_text: &str,
    role: LineRole,
    truncated_flag: &mut bool,
) {
    let mut iter = body_text.lines();
    if let Some(first) = iter.next() {
        push_wrapped_line(lines, &format!("│ {label}"), first, role, truncated_flag);
    } else {
        push_wrapped_line(lines, &format!("│ {label}"), "", role, truncated_flag);
    }
    for next in iter {
        if lines.len() >= MAX_BLOCK_LINES {
            *truncated_flag = true;
            break;
        }
        push_wrapped_line(lines, "│ ", next, role, truncated_flag);
    }
}

fn format_headers_json(headers_val: &Value) -> Option<String> {
    let pairs = headers_val.as_array()?;
    if pairs.is_empty() {
        return None;
    }
    let mut map = Map::new();
    for pair in pairs {
        let Some(items) = pair.as_array() else {
            continue;
        };
        if items.len() != 2 {
            continue;
        }
        let Some(name) = items[0].as_str() else {
            continue;
        };
        let Some(val) = items[1].as_str() else {
            continue;
        };
        if let Some(existing) = map.get_mut(name) {
            match existing {
                Value::Array(arr) => arr.push(Value::String(val.to_string())),
                prev => {
                    let first = prev.take();
                    *prev = Value::Array(vec![first, Value::String(val.to_string())]);
                }
            }
        } else {
            map.insert(name.to_string(), Value::String(val.to_string()));
        }
    }
    if map.is_empty() {
        return None;
    }
    serde_json::to_string_pretty(&Value::Object(map)).ok()
}

fn format_bytes_label(size: Option<u64>) -> String {
    let Some(bytes) = size else {
        return "未知大小".into();
    };
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.2} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

fn http_status_reason(status: i64) -> &'static str {
    match status {
        100 => "Continue",
        101 => "Switching Protocols",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        206 => "Partial Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "",
    }
}

fn clip_utf8(text: &str, max_bytes: usize) -> (&str, bool) {
    if text.len() <= max_bytes {
        return (text, false);
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

fn append_http_body(
    lines: &mut Vec<BlockLine>,
    body: &Value,
    session_id: &str,
    entry_id: &str,
    side: &str,
    truncated_flag: &mut bool,
) -> Option<RemoteBodyHint> {
    if body.is_null() {
        return None;
    }
    let kind = body["kind"].as_str().unwrap_or("empty");
    let media_type = body["type"].as_str().map(String::from);
    let size = body_size(body);
    match kind {
        "empty" => None,
        "text" => {
            let text = body["text"].as_str().unwrap_or("");
            if text.is_empty() {
                return None;
            }
            let (clipped, clipped_by_bytes) = clip_utf8(text, MAX_BLOCK_PREVIEW_BYTES);
            let trimmed = clipped.trim();
            let formatted =
                if !clipped_by_bytes && (trimmed.starts_with('{') || trimmed.starts_with('[')) {
                    serde_json::from_str::<Value>(trimmed)
                        .ok()
                        .and_then(|val| serde_json::to_string_pretty(&val).ok())
                        .unwrap_or_else(|| clipped.to_string())
                } else {
                    clipped.to_string()
                };
            push_labeled_multiline(lines, "Data: ", &formatted, LineRole::Body, truncated_flag);
            if clipped_by_bytes || body["truncated"].as_bool().unwrap_or(false) {
                push_wrapped_line(
                    lines,
                    "│ ",
                    &format!(
                        "… 正文已截断（总计 {}），可在右侧详情查看完整内容",
                        format_bytes_label(size)
                    ),
                    LineRole::Meta,
                    truncated_flag,
                );
            }
            None
        }
        "form" => {
            if let Ok(pretty) = serde_json::to_string_pretty(body) {
                push_labeled_multiline(lines, "Data: ", &pretty, LineRole::Body, truncated_flag);
            }
            None
        }
        "bytes" => {
            let mt = media_type.as_deref().unwrap_or("application/octet-stream");
            push_wrapped_line(
                lines,
                "│ Data: ",
                &format!("[二进制正文 · {} · {}]", format_bytes_label(size), mt),
                LineRole::Meta,
                truncated_flag,
            );
            None
        }
        "remote" => {
            let mt = media_type.as_deref().unwrap_or("text/json");
            push_wrapped_line(
                lines,
                "│ Data: ",
                &format!(
                    "[远端正文未拉取 · {} · {} · 点击加载完整内容]",
                    format_bytes_label(size),
                    mt
                ),
                LineRole::Remote,
                truncated_flag,
            );
            Some(RemoteBodyHint {
                session_id: session_id.to_string(),
                entry_id: entry_id.to_string(),
                side: side.to_string(),
                size,
                media_type,
            })
        }
        "unavailable" => {
            let reason = body["reason"].as_str().unwrap_or("notCaptured");
            push_wrapped_line(
                lines,
                "│ Data: ",
                &format!("[正文不可用: {reason}]"),
                LineRole::Meta,
                truncated_flag,
            );
            None
        }
        _ => None,
    }
}

fn finalize_block(
    lines: &mut Vec<BlockLine>,
    truncated: bool,
    base: FormattedBlockMeta,
) -> FormattedBlock {
    if truncated {
        lines.push(BlockLine {
            text: format!(
                "│ … 超出单条最大展示行数（{MAX_BLOCK_LINES} 行），请在右侧详情查看完整内容"
            ),
            role: LineRole::Meta,
        });
    }
    lines.push(BlockLine {
        text: format!("└{BOX_RULE}"),
        role: LineRole::Bottom,
    });
    let mut search_buf = String::new();
    for line in lines.iter() {
        if matches!(line.role, LineRole::Top | LineRole::Bottom) {
            continue;
        }
        search_buf.push_str(&line.text);
        search_buf.push('\n');
    }
    FormattedBlock {
        block_id: base.block_id,
        kind: base.kind,
        level: base.level,
        occurred_at: base.occurred_at,
        timestamp_micros: base.timestamp_micros,
        sub_order: base.sub_order,
        session_id: base.session_id,
        entry_id: base.entry_id,
        run_id: base.run_id,
        event_id: base.event_id,
        remote_body: base.remote_body,
        pair_summary: base.pair_summary,
        search_text: search_buf.to_lowercase().into(),
        lines: std::mem::take(lines),
    }
}

struct FormattedBlockMeta {
    block_id: String,
    kind: String,
    level: String,
    occurred_at: String,
    timestamp_micros: i64,
    sub_order: u8,
    session_id: Option<String>,
    entry_id: Option<String>,
    run_id: Option<String>,
    event_id: Option<String>,
    remote_body: Option<RemoteBodyHint>,
    pair_summary: Option<String>,
}

fn format_network_entry(
    session_id: &str,
    entry: &StoredEntry,
    tz_offset_east_seconds: i32,
) -> Vec<Arc<FormattedBlock>> {
    let value: Value = match serde_json::from_str(&entry.raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let row = &entry.row;
    let mut blocks = Vec::with_capacity(2);

    // 1. 生成 [http-request] 块
    {
        let mut lines = Vec::with_capacity(16);
        let mut truncated = false;
        lines.push(BlockLine {
            text: format!("┌{BOX_RULE}"),
            role: LineRole::Top,
        });
        let time_str = format_local_time(&row.started_at, tz_offset_east_seconds);
        push_wrapped_line(
            &mut lines,
            "│ ",
            &format!("[http-request] | {time_str} | [{}] {}", row.method, row.url),
            LineRole::Header,
            &mut truncated,
        );
        if let Some(headers_json) = format_headers_json(&value["request"]["headers"]) {
            push_labeled_multiline(
                &mut lines,
                "Headers: ",
                &headers_json,
                LineRole::Body,
                &mut truncated,
            );
        }
        let remote_body = append_http_body(
            &mut lines,
            &value["request"]["body"],
            session_id,
            &row.id,
            "request",
            &mut truncated,
        );
        let block = finalize_block(
            &mut lines,
            truncated,
            FormattedBlockMeta {
                block_id: format!("req:{}:{}", session_id, row.id),
                kind: "http-request".into(),
                level: "request".into(),
                occurred_at: row.started_at.clone(),
                timestamp_micros: parse_micros(&row.started_at),
                sub_order: 0,
                session_id: Some(session_id.to_string()),
                entry_id: Some(row.id.clone()),
                run_id: None,
                event_id: None,
                remote_body,
                pair_summary: None,
            },
        );
        blocks.push(Arc::new(block));
    }

    // 2. 若请求已完成或失败，生成 [http-response] / [http-error] 块
    let completed_at = value["completedAt"].as_str();
    if let Some(done_at) = completed_at {
        let time_str = format_local_time(done_at, tz_offset_east_seconds);
        let response = &value["response"];
        let failure = &value["failure"];
        if !failure.is_null() {
            let mut lines = Vec::with_capacity(8);
            let mut truncated = false;
            lines.push(BlockLine {
                text: format!("┌{BOX_RULE}"),
                role: LineRole::Top,
            });
            push_wrapped_line(
                &mut lines,
                "│ ",
                &format!("[http-error] | {time_str} | [{}] {}", row.method, row.url),
                LineRole::Error,
                &mut truncated,
            );
            let kind = failure["kind"].as_str().unwrap_or("error");
            let message = failure["message"].as_str().unwrap_or("");
            let duration = row
                .duration_ms
                .map(|ms| format!(" ({ms:.0}ms)"))
                .unwrap_or_default();
            push_wrapped_line(
                &mut lines,
                "│ ",
                &format!("Error: {kind}{duration} · {message}"),
                LineRole::Error,
                &mut truncated,
            );
            let pair_summary = Some(match row.duration_ms {
                Some(ms) => format!("↓ ERR · {ms:.0}ms"),
                None => "↓ ERR".into(),
            });
            let block = finalize_block(
                &mut lines,
                truncated,
                FormattedBlockMeta {
                    block_id: format!("err:{}:{}", session_id, row.id),
                    kind: "http-error".into(),
                    level: "error".into(),
                    occurred_at: done_at.to_string(),
                    timestamp_micros: parse_micros(done_at),
                    sub_order: 2,
                    session_id: Some(session_id.to_string()),
                    entry_id: Some(row.id.clone()),
                    run_id: None,
                    event_id: None,
                    remote_body: None,
                    pair_summary,
                },
            );
            blocks.push(Arc::new(block));
        } else if !response.is_null() {
            let mut lines = Vec::with_capacity(32);
            let mut truncated = false;
            let status = row.status.unwrap_or(0);
            let is_err = status >= 400;
            lines.push(BlockLine {
                text: format!("┌{BOX_RULE}"),
                role: LineRole::Top,
            });
            push_wrapped_line(
                &mut lines,
                "│ ",
                &format!(
                    "[http-response] | {time_str} | [{}] {}",
                    row.method, row.url
                ),
                if is_err {
                    LineRole::Error
                } else {
                    LineRole::Header
                },
                &mut truncated,
            );
            let duration_suffix = row
                .duration_ms
                .map(|ms| format!("  ({ms:.0}ms)"))
                .unwrap_or_default();
            push_wrapped_line(
                &mut lines,
                "│ ",
                &format!("Status: {status}{duration_suffix}"),
                if is_err {
                    LineRole::Error
                } else {
                    LineRole::Meta
                },
                &mut truncated,
            );
            let reason = http_status_reason(status);
            if !reason.is_empty() {
                push_wrapped_line(
                    &mut lines,
                    "│ ",
                    &format!("Message: {reason}"),
                    LineRole::Meta,
                    &mut truncated,
                );
            }
            let remote_body = append_http_body(
                &mut lines,
                &response["body"],
                session_id,
                &row.id,
                "response",
                &mut truncated,
            );
            let pair_summary = Some(match row.duration_ms {
                Some(ms) => format!("↓ {status} · {ms:.0}ms"),
                None => format!("↓ {status}"),
            });
            let block = finalize_block(
                &mut lines,
                truncated,
                FormattedBlockMeta {
                    block_id: format!("res:{}:{}", session_id, row.id),
                    kind: "http-response".into(),
                    level: if is_err {
                        "error".into()
                    } else {
                        "response".into()
                    },
                    occurred_at: done_at.to_string(),
                    timestamp_micros: parse_micros(done_at),
                    sub_order: 2,
                    session_id: Some(session_id.to_string()),
                    entry_id: Some(row.id.clone()),
                    run_id: None,
                    event_id: None,
                    remote_body,
                    pair_summary,
                },
            );
            blocks.push(Arc::new(block));
        }
    }

    blocks
}

fn format_diagnostic_event(
    item: &DiagnosticRawItem,
    tz_offset_east_seconds: i32,
) -> FormattedBlock {
    let value: Value = serde_json::from_str(&item.raw).unwrap_or(Value::Null);
    let mut lines = Vec::with_capacity(16);
    let mut truncated = false;

    lines.push(BlockLine {
        text: format!("┌{BOX_RULE}"),
        role: LineRole::Top,
    });

    let time_str = format_local_time(&item.occurred_at, tz_offset_east_seconds);
    let level = item.level.as_str();
    let header_role = if item.kind == "exception" || matches!(level, "error" | "critical") {
        LineRole::Error
    } else {
        LineRole::Header
    };

    let raw_message = value["message"].as_str().unwrap_or("");
    let cleaned_lines = clean_message_lines(raw_message);
    let first_line = cleaned_lines.first().map(String::as_str).unwrap_or("");

    let tag = value["tag"]
        .as_str()
        .filter(|t| !t.is_empty() && *t != level);
    let tag_prefix = match tag {
        Some(t) if !first_line.starts_with(&format!("[{t}]")) => format!("[{t}] "),
        _ => String::new(),
    };

    push_wrapped_line(
        &mut lines,
        "│ ",
        &format!("[{level}] | {time_str} | {tag_prefix}{first_line}"),
        header_role,
        &mut truncated,
    );

    for extra in cleaned_lines.iter().skip(1) {
        if lines.len() >= MAX_BLOCK_LINES {
            truncated = true;
            break;
        }
        push_wrapped_line(&mut lines, "│ ", extra, LineRole::Body, &mut truncated);
    }

    if let Some(attrs) = value["attributes"].as_object()
        && !attrs.is_empty()
        && let Ok(pretty) = serde_json::to_string_pretty(&value["attributes"])
    {
        for line in pretty.lines() {
            if lines.len() >= MAX_BLOCK_LINES {
                truncated = true;
                break;
            }
            push_wrapped_line(&mut lines, "│ ", line, LineRole::Body, &mut truncated);
        }
    }

    if let Some(exc) = value["exception"].as_object() {
        let exc_type = exc
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("Exception");
        let exc_msg = exc.get("message").and_then(Value::as_str).unwrap_or("");
        if !exc_msg.is_empty() && exc_msg != first_line {
            push_wrapped_line(
                &mut lines,
                "│ ",
                &format!("Exception: {exc_type}: {exc_msg}"),
                LineRole::Error,
                &mut truncated,
            );
        } else {
            push_wrapped_line(
                &mut lines,
                "│ ",
                &format!("Exception: {exc_type}"),
                LineRole::Error,
                &mut truncated,
            );
        }
        if let Some(stack) = exc.get("stackTrace").and_then(Value::as_str)
            && !stack.trim().is_empty()
        {
            for frame in stack.lines() {
                if lines.len() >= MAX_BLOCK_LINES {
                    truncated = true;
                    break;
                }
                push_wrapped_line(&mut lines, "│ ", frame, LineRole::Error, &mut truncated);
            }
        }
    }

    finalize_block(
        &mut lines,
        truncated,
        FormattedBlockMeta {
            block_id: format!("diag:{}:{}", item.run_key, item.event_id),
            kind: item.kind.clone(),
            level: item.level.clone(),
            occurred_at: item.occurred_at.clone(),
            timestamp_micros: parse_micros(&item.occurred_at),
            sub_order: 1,
            session_id: None,
            entry_id: None,
            run_id: Some(item.run_key.clone()),
            event_id: Some(item.event_id.clone()),
            remote_body: None,
            pair_summary: None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::diagnostics::StoredDiagnostic;
    use serde_json::json;

    fn sample_network_entry(
        id: &str,
        started_at: &str,
        completed_at: Option<&str>,
        response_body: Value,
    ) -> StoredEntry {
        let mut obj = json!({
            "id": id,
            "source": "dio",
            "startedAt": started_at,
            "request": {
                "method": "GET",
                "url": "https://web.example.test/api/apps/version",
                "headers": [
                    ["User-Agent", "Demo App/60371"],
                    ["APP-VERSION", "60371"]
                ]
            }
        });
        if let Some(done) = completed_at {
            obj["completedAt"] = Value::String(done.to_string());
            obj["response"] = json!({
                "status": 200,
                "headers": [["Content-Type", "application/json"]],
                "body": response_body
            });
        }
        StoredEntry::parse(&obj.to_string()).unwrap()
    }

    fn sample_diag(seq: u64, time: &str, message: &str, attrs: Value) -> DiagnosticRawItem {
        let raw = json!({
            "eventId": format!("ev-{seq}"),
            "runId": "run-1",
            "emitterId": "main",
            "sequence": seq.to_string(),
            "occurredAt": time,
            "kind": "log",
            "level": "info",
            "source": "talker",
            "tag": "info",
            "message": message,
            "attributes": attrs
        })
        .to_string();
        let stored = StoredDiagnostic::parse(&raw).unwrap();
        let search = stored.search_text();
        DiagnosticRawItem {
            run_key: "diag-run-1".into(),
            event_id: stored.event.event_id,
            occurred_at: stored.event.occurred_at,
            kind: stored.event.kind,
            level: stored.event.level,
            raw: stored.raw,
            search,
        }
    }

    #[test]
    fn interleaves_http_request_logs_and_http_response_without_flutter_prefix() {
        let mut cache = StreamCache::default();
        let net = vec![sample_network_entry(
            "req-1",
            "2026-11-23T01:30:10.514Z",
            Some("2026-11-23T01:30:11.279Z"),
            json!({
                "kind": "text",
                "type": "application/json",
                "text": "{\"vCode\":60384,\"vName\":\"6.2.19\"}"
            }),
        )];
        let diags = vec![
            sample_diag(
                1,
                "2026-11-23T01:30:10.507Z",
                "flutter: [device-fingerprint-att] status_before=denied",
                json!({}),
            ),
            sample_diag(
                2,
                "2026-11-23T01:30:10.800Z",
                "[device-fingerprint-response] [AISecurius]",
                json!({"token": "abc", "elapsedMs": 764}),
            ),
        ];

        let query = StreamQuery {
            tz_offset_east_seconds: 8 * 3600,
            line_limit: 200,
            ..Default::default()
        };
        let snap = cache
            .build_snapshot(
                &Scope::Network {
                    id: "live-1".into(),
                },
                "v1".into(),
                &net,
                &diags,
                &query,
            )
            .unwrap();

        assert_eq!(snap.total_blocks(), 4);
        assert_eq!(snap.entries[0].block.kind, "log");
        assert_eq!(snap.entries[1].block.kind, "http-request");
        assert_eq!(snap.entries[2].block.kind, "log");
        assert_eq!(snap.entries[3].block.kind, "http-response");

        // 验证请求↔响应配对跳转行号与标签
        assert_eq!(snap.entries[1].pair_line, Some(snap.prefix_lines[3]));
        assert!(
            snap.entries[1]
                .pair_label
                .as_deref()
                .unwrap()
                .contains("200")
        );
        assert_eq!(snap.entries[3].pair_line, Some(snap.prefix_lines[1]));

        let full_text = snap
            .entries
            .iter()
            .map(|e| e.block.to_plain_text())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!full_text.contains("flutter:"));
        assert!(full_text.contains("[info] | 09:30:10 507ms | [device-fingerprint-att]"));
        assert!(full_text.contains("\"vCode\": 60384"));
    }

    #[test]
    fn supports_locate_mode_clear_baseline_and_block_collapsing() {
        let mut cache = StreamCache::default();
        let net = vec![sample_network_entry(
            "req-1",
            "2026-11-23T01:30:10.514Z",
            Some("2026-11-23T01:30:11.279Z"),
            json!({
                "kind": "text",
                "type": "application/json",
                "text": "{\"vCode\":60384,\"vName\":\"6.2.19\"}"
            }),
        )];
        let diags = vec![sample_diag(
            1,
            "2026-11-23T01:30:10.507Z",
            "early boot message",
            json!({}),
        )];

        // 1. locate 模式下保留全部块，并能精确找出命中行号
        let locate_snap = cache
            .build_snapshot(
                &Scope::Network {
                    id: "live-2".into(),
                },
                "v1".into(),
                &net,
                &diags,
                &StreamQuery {
                    search: "60384".into(),
                    search_mode: "locate".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(locate_snap.total_blocks(), 3);
        let matches = locate_snap.find_matches("60384");
        assert_eq!(matches.line_indices.len(), 1);
        assert_eq!(
            locate_snap.locate_entry("req-1", Some("http-request")),
            Some(3)
        );

        // 2. 折叠单块为 3 行但仍可复制完整正文
        let collapsed_snap = cache
            .build_snapshot(
                &Scope::Network {
                    id: "live-2".into(),
                },
                "v1".into(),
                &net,
                &diags,
                &StreamQuery {
                    collapsed_blocks: vec!["res:live-2:req-1".into()],
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(collapsed_snap.entries[2].visible_lines, 3);
        assert!(collapsed_snap.entries[2].hidden_lines > 0);
        assert!(
            collapsed_snap
                .block_text("res:live-2:req-1")
                .unwrap()
                .contains("60384")
        );

        // 3. 清屏基线仅展示新事件
        let baseline = parse_micros("2026-11-23T01:30:10.600Z");
        let cleared_snap = cache
            .build_snapshot(
                &Scope::Network {
                    id: "live-2".into(),
                },
                "v1".into(),
                &net,
                &diags,
                &StreamQuery {
                    min_timestamp_micros: Some(baseline),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(cleared_snap.total_blocks(), 1);
        assert_eq!(cleared_snap.entries[0].block.kind, "http-response");
    }

    #[test]
    fn line_slicing_uses_prefix_sum_accurately_across_large_blocks() {
        let mut cache = StreamCache::default();
        let big_array: Vec<u64> = (0..300).collect();
        let net = vec![sample_network_entry(
            "big",
            "2026-11-23T01:30:10.000Z",
            Some("2026-11-23T01:30:11.000Z"),
            json!({
                "kind": "text",
                "type": "application/json",
                "text": serde_json::to_string(&json!({"items": big_array})).unwrap()
            }),
        )];
        let snap = cache
            .build_snapshot(
                &Scope::Network {
                    id: "live-big".into(),
                },
                "v1".into(),
                &net,
                &[],
                &StreamQuery::default(),
            )
            .unwrap();
        assert!(snap.total_lines() > 300);

        let page = snap.slice(120, 50, 7);
        assert_eq!(page.revision, 7);
        assert_eq!(page.lines.len(), 50);
        assert_eq!(page.lines[0].line_index, 120);
        assert_eq!(page.lines[49].line_index, 169);
        assert_eq!(page.total_lines, snap.total_lines());
    }

    #[test]
    fn strips_nested_talker_box_lines_and_surfaces_remote_body_hint() {
        let mut cache = StreamCache::default();
        let net = vec![sample_network_entry(
            "rem",
            "2026-11-23T01:30:10.000Z",
            Some("2026-11-23T01:30:11.000Z"),
            json!({
                "kind": "remote",
                "type": "application/json",
                "size": 2048
            }),
        )];
        let boxed_diag = vec![sample_diag(
            1,
            "2026-11-23T01:30:10.500Z",
            "flutter: ┌────────\nflutter: │ hello world\nflutter: │ {\"k\": 1}\nflutter: └────────",
            json!({}),
        )];
        let snap = cache
            .build_snapshot(
                &Scope::Network {
                    id: "live-rem".into(),
                },
                "v1".into(),
                &net,
                &boxed_diag,
                &StreamQuery::default(),
            )
            .unwrap();

        let diag_text = snap.entries[1].block.to_plain_text();
        assert_eq!(diag_text.matches('┌').count(), 1);
        assert!(!diag_text.contains("flutter:"));
        assert!(diag_text.contains("hello world"));

        let res_block = &snap.entries[2].block;
        assert_eq!(
            res_block.remote_body.as_ref().map(|h| h.side.as_str()),
            Some("response")
        );
        assert_eq!(
            res_block.remote_body.as_ref().and_then(|h| h.size),
            Some(2048)
        );
    }
}
