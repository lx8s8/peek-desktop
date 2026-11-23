import type { StreamLine, StreamPage } from "../../lib/ipc/types";

/** 每次 IPC 预加载分片的行数。 */
export const STREAM_CHUNK_SIZE = 200;
/** 前端内存最多保留的分片数量（40 × 200 = 8,000 行），防止 WebView 内存膨胀。 */
export const MAX_CACHED_CHUNKS = 40;
/** 顺滚动方向提前预加载的分片数。 */
const PREFETCH_AHEAD = 2;
/** 逆滚动方向保留缓冲预加载的分片数。 */
const PREFETCH_BEHIND = 1;

interface CachedChunk {
  version: string;
  lines: Map<number, StreamLine>;
}

/**
 * 基于 LRU 淘汰与 Stale-While-Revalidate（旧帧保留）的分块行缓存。
 * 在实时高吞吐更新时，先用旧版本渲染避免闪白，新分片返回后无缝替换并清理过期页。
 */
export class StreamChunkCache {
  private chunks = new Map<number, CachedChunk>();

  get size(): number {
    return this.chunks.size;
  }

  clear(): void {
    this.chunks.clear();
  }

  /** 读取单行，不区分是否过期（用于无闪烁渲染），并刷新 LRU 热度。 */
  getLine(lineIndex: number): StreamLine | undefined {
    const chunkIndex = Math.floor(lineIndex / STREAM_CHUNK_SIZE);
    const entry = this.chunks.get(chunkIndex);
    if (!entry) return undefined;
    // 移至 Map 尾部标记为最近使用
    this.chunks.delete(chunkIndex);
    this.chunks.set(chunkIndex, entry);
    return entry.lines.get(lineIndex);
  }

  /** 判断某分片是否已缓存且匹配当前数据版本。 */
  isFresh(chunkIndex: number, version: string): boolean {
    const entry = this.chunks.get(chunkIndex);
    return !!entry && entry.version === version;
  }

  /** 写入分页结果，并执行有界 LRU 淘汰。 */
  setPage(chunkIndex: number, version: string, page: StreamPage): void {
    const map = new Map<number, StreamLine>();
    for (const line of page.lines) {
      map.set(line.lineIndex, line);
    }
    this.chunks.delete(chunkIndex);
    this.chunks.set(chunkIndex, { version, lines: map });
    while (this.chunks.size > MAX_CACHED_CHUNKS) {
      const oldest = this.chunks.keys().next().value;
      if (oldest === undefined) break;
      this.chunks.delete(oldest);
    }
  }

  /** 清理超出当前总行数范围的尾部陈旧分片。 */
  pruneOutOfRange(totalLines: number): void {
    const maxChunk =
      totalLines <= 0 ? -1 : Math.floor((totalLines - 1) / STREAM_CHUNK_SIZE);
    for (const key of Array.from(this.chunks.keys())) {
      if (key > maxChunk) {
        this.chunks.delete(key);
      }
    }
  }

  /** 收集当前缓存中所有包含远端未加载正文提示的行。 */
  collectRemoteHints(): StreamLine[] {
    const result: StreamLine[] = [];
    for (const chunk of this.chunks.values()) {
      for (const line of chunk.lines.values()) {
        if (line.remoteBody) result.push(line);
      }
    }
    return result;
  }
}

/**
 * 按当前视口行范围与滚动方向生成按优先级排序的预加载分片队列：
 * 1. 可视区内的分片优先；
 * 2. 顺滚动方向多预取 2 片（400 行）；
 * 3. 反方向缓冲 1 片（200 行）。
 */
export function planPrefetchChunks(
  firstVisibleLine: number,
  lastVisibleLine: number,
  totalLines: number,
  direction: -1 | 0 | 1,
): number[] {
  if (totalLines <= 0) return [0];
  const maxChunk = Math.floor((totalLines - 1) / STREAM_CHUNK_SIZE);
  const startChunk = Math.max(
    0,
    Math.min(
      maxChunk,
      Math.floor(Math.max(0, firstVisibleLine) / STREAM_CHUNK_SIZE),
    ),
  );
  const endChunk = Math.max(
    startChunk,
    Math.min(
      maxChunk,
      Math.floor(Math.max(0, lastVisibleLine) / STREAM_CHUNK_SIZE),
    ),
  );

  const ordered: number[] = [];
  const seen = new Set<number>();
  const add = (idx: number) => {
    if (idx >= 0 && idx <= maxChunk && !seen.has(idx)) {
      seen.add(idx);
      ordered.push(idx);
    }
  };

  // 第一优先级：当前视口覆盖的分片
  for (let c = startChunk; c <= endChunk; c++) add(c);

  // 第二优先级：按滚动方向双向预加载
  if (direction < 0) {
    for (let step = 1; step <= PREFETCH_AHEAD; step++) add(startChunk - step);
    for (let step = 1; step <= PREFETCH_BEHIND; step++) add(endChunk + step);
  } else {
    for (let step = 1; step <= PREFETCH_AHEAD; step++) add(endChunk + step);
    for (let step = 1; step <= PREFETCH_BEHIND; step++) add(startChunk - step);
  }

  return ordered;
}
