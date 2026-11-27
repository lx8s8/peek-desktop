//! 实时会话磁盘溢出冷存储：
//! 当实时热内存达到 8 MiB / 10,000 条上限时，将最早被移出热区的记录原始载荷追加写入匿名临时文件，
//! 内存仅保留极轻量的检索索引（offset + len + EntryRow），使清屏前的历史记录仍可完整回溯、全文搜索、查看详情与重发。
//! 进程正常或异常退出时，匿名临时文件由操作系统自动回收，不残留垃圾文件。

use crate::protocol::session::EntryRow;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    sync::Arc,
};

/// 单个实时会话冷存储最多保留的记录条数。
pub const MAX_SPILL_ENTRIES: usize = 50_000;
/// 单个实时会话冷存储临时文件有效数据上限（256 MiB）。
pub const MAX_SPILL_BYTES: u64 = 256 * 1024 * 1024;

/// 冷存储内存轻量索引项（不含原始请求/响应大 JSON 载荷）。
#[derive(Clone)]
pub struct SpillEntry {
    pub row: EntryRow,
    pub search: String,
    pub started_at_micros: i64,
    pub response_fields: Vec<(String, String)>,
    pub offset: u64,
    pub len: usize,
}

/// 基于匿名临时文件的追加式冷存储仓库。
#[derive(Default)]
pub struct SpillStore {
    file: Option<File>,
    write_pos: u64,
    retained_bytes: u64,
    dropped_count: u64,
    pub entries: Vec<SpillEntry>,
    index: HashMap<String, usize>,
}

impl SpillStore {
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn retained_bytes(&self) -> u64 {
        self.retained_bytes
    }

    pub fn dropped_count(&self) -> u64 {
        self.dropped_count
    }

    pub fn clear(&mut self) {
        self.file = None;
        self.write_pos = 0;
        self.retained_bytes = 0;
        self.dropped_count = 0;
        self.entries.clear();
        self.index.clear();
    }

    /// 将热区移出的记录落盘归档到临时文件；若磁盘不可写则静默降级返回 `false`。
    pub fn push(
        &mut self,
        row: EntryRow,
        search: String,
        started_at_micros: i64,
        response_fields: Vec<(String, String)>,
        raw: &str,
    ) -> bool {
        // 同 ID 若之前已在冷区，先移除旧索引避免重复
        if self.index.contains_key(&row.id) {
            let _ = self.remove(&row.id);
        }
        if self.file.is_none() {
            match tempfile::tempfile() {
                Ok(file) => self.file = Some(file),
                Err(_) => {
                    self.dropped_count += 1;
                    return false;
                }
            }
        }
        let Some(file) = self.file.as_mut() else {
            self.dropped_count += 1;
            return false;
        };
        let bytes = raw.as_bytes();
        let offset = self.write_pos;
        if file.seek(SeekFrom::Start(offset)).is_err() || file.write_all(bytes).is_err() {
            self.dropped_count += 1;
            return false;
        }
        self.write_pos = offset.saturating_add(bytes.len() as u64);
        self.retained_bytes = self.retained_bytes.saturating_add(bytes.len() as u64);
        self.index.insert(row.id.clone(), self.entries.len());
        self.entries.push(SpillEntry {
            row,
            search,
            started_at_micros,
            response_fields,
            offset,
            len: bytes.len(),
        });
        self.enforce_limits();
        true
    }

    /// 冷区超限时优先从头部丢弃未固定记录，严守 50,000 条 / 256 MiB 磁盘上限。
    fn enforce_limits(&mut self) {
        if self.entries.len() <= MAX_SPILL_ENTRIES && self.retained_bytes <= MAX_SPILL_BYTES {
            return;
        }
        let mut remove_flags = vec![false; self.entries.len()];
        let mut cur_len = self.entries.len();
        let mut cur_bytes = self.retained_bytes;

        for (idx, entry) in self.entries.iter().enumerate() {
            if cur_len <= MAX_SPILL_ENTRIES && cur_bytes <= MAX_SPILL_BYTES {
                break;
            }
            if !entry.row.pinned {
                remove_flags[idx] = true;
                cur_len -= 1;
                cur_bytes = cur_bytes.saturating_sub(entry.len as u64);
            }
        }
        if cur_len > MAX_SPILL_ENTRIES || cur_bytes > MAX_SPILL_BYTES {
            for (idx, entry) in self.entries.iter().enumerate() {
                if cur_len <= MAX_SPILL_ENTRIES && cur_bytes <= MAX_SPILL_BYTES {
                    break;
                }
                if !remove_flags[idx] {
                    remove_flags[idx] = true;
                    cur_len -= 1;
                    cur_bytes = cur_bytes.saturating_sub(entry.len as u64);
                }
            }
        }

        let mut kept = Vec::with_capacity(cur_len);
        for (idx, entry) in self.entries.drain(..).enumerate() {
            if remove_flags[idx] {
                self.dropped_count += 1;
            } else {
                kept.push(entry);
            }
        }
        self.entries = kept;
        self.retained_bytes = cur_bytes;
        self.rebuild_index();
    }

    fn rebuild_index(&mut self) {
        self.index.clear();
        for (idx, entry) in self.entries.iter().enumerate() {
            self.index.insert(entry.row.id.clone(), idx);
        }
    }

    /// 移除指定 ID 的冷区索引并返回原 `(seq, pinned)`，供热区更新记录继承状态。
    pub fn remove(&mut self, id: &str) -> Option<(u64, bool)> {
        let index = self.index.remove(id)?;
        let entry = self.entries.remove(index);
        self.retained_bytes = self.retained_bytes.saturating_sub(entry.len as u64);
        for idx in index..self.entries.len() {
            self.index.insert(self.entries[idx].row.id.clone(), idx);
        }
        Some((entry.row.seq, entry.row.pinned))
    }

    pub fn entry_row(&self, id: &str) -> Option<EntryRow> {
        self.index.get(id).map(|&idx| self.entries[idx].row.clone())
    }

    pub fn toggle_pin(&mut self, id: &str) -> Option<bool> {
        let idx = *self.index.get(id)?;
        let entry = &mut self.entries[idx];
        entry.row.pinned = !entry.row.pinned;
        Some(entry.row.pinned)
    }

    /// 按索引偏移量从临时文件精确读回单条原始 JSON 记录。
    pub fn read_raw(&mut self, id: &str) -> Option<Arc<str>> {
        let &idx = self.index.get(id)?;
        let (offset, len) = (self.entries[idx].offset, self.entries[idx].len);
        self.read_raw_at(offset, len).map(Arc::from)
    }

    /// 按文件偏移与字节数读取原始 JSON 文本（供正文全文搜索与详情加载复用）。
    pub fn read_raw_at(&mut self, offset: u64, len: usize) -> Option<String> {
        let file = self.file.as_mut()?;
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut buf = vec![0u8; len];
        file.read_exact(&mut buf).ok()?;
        String::from_utf8(buf).ok()
    }

    /// 导出时在字节和条数预算内读回冷区记录（从最新到最早优先保留，最后按 seq 升序输出）。
    pub fn export_entries(
        &mut self,
        max_entries: usize,
        max_bytes: usize,
    ) -> Vec<crate::session::StoredEntry> {
        if self.entries.is_empty() || max_entries == 0 || max_bytes == 0 {
            return Vec::new();
        }
        let mut selected_indices = Vec::new();
        let mut used_bytes = 0usize;
        // 优先纳入固定记录，再从最新向最早纳入普通记录，确保最关键的历史不丢失
        for (idx, entry) in self.entries.iter().enumerate().rev() {
            if entry.row.pinned
                && selected_indices.len() < max_entries
                && used_bytes.saturating_add(entry.len) <= max_bytes
            {
                selected_indices.push(idx);
                used_bytes = used_bytes.saturating_add(entry.len);
            }
        }
        for (idx, entry) in self.entries.iter().enumerate().rev() {
            if !entry.row.pinned
                && selected_indices.len() < max_entries
                && used_bytes.saturating_add(entry.len) <= max_bytes
            {
                selected_indices.push(idx);
                used_bytes = used_bytes.saturating_add(entry.len);
            }
        }
        selected_indices.sort_unstable();
        let mut out = Vec::with_capacity(selected_indices.len());
        for idx in selected_indices {
            let meta = self.entries[idx].clone();
            if let Some(raw) = self.read_raw_at(meta.offset, meta.len) {
                out.push(crate::session::StoredEntry {
                    row: meta.row,
                    raw: Arc::from(raw),
                    search: meta.search,
                    started_at_micros: meta.started_at_micros,
                    response_fields: meta.response_fields,
                });
            }
        }
        out
    }
}
