import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  Eraser,
  FoldVertical,
  Pause,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Terminal,
  UnfoldVertical,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { writeClipboard } from "../../lib/clipboard";
import { commands } from "../../lib/commands/dispatcher";
import { useCommand } from "../../lib/commands/react";
import { api, desktop } from "../../lib/ipc/client";
import type {
  RemoteBodyHint,
  Scope,
  StreamKindFilter,
  StreamQuery,
  StreamSearchMode,
  TimeRange,
} from "../../lib/ipc/types";
import { renderStreamLineText } from "../detail/jsonHighlight";
import {
  STREAM_CHUNK_SIZE,
  StreamChunkCache,
  planPrefetchChunks,
} from "./chunkCache";

/** 单行固定高度（像素），行级虚拟化严格等高以保证上下滚动零跳动。 */
export const STREAM_LINE_HEIGHT = 20;
/** 自动按需拉取远端正文的最大字节数（128 KiB）。 */
const AUTO_BODY_MAX_BYTES = 128 * 1024;
/** 远端正文并发拉取上限，避免撞到后端 32 并发保护线。 */
const MAX_BODY_CONCURRENCY = 3;

export interface StreamViewState {
  search: string;
  searchMode: StreamSearchMode;
  kindFilter: StreamKindFilter;
  following: boolean;
  autoLoadBody: boolean;
  minTimestampMicros: number | null;
  compactAll: boolean;
  collapsedBlocks: string[];
}

export const emptyStreamView: StreamViewState = {
  search: "",
  searchMode: "filter",
  kindFilter: "all",
  following: true,
  autoLoadBody: true,
  minTimestampMicros: null,
  compactAll: false,
  collapsedBlocks: [],
};

export interface StreamSelection {
  blockId: string;
  kind: string;
  sessionId: string | null;
  entryId: string | null;
  runId: string | null;
  eventId: string | null;
}

function isTextualMediaType(mediaType: string | null): boolean {
  if (!mediaType) return true;
  const lower = mediaType.toLowerCase();
  if (
    lower.startsWith("image/") ||
    lower.startsWith("video/") ||
    lower.startsWith("audio/") ||
    lower.includes("octet-stream") ||
    lower.includes("pdf") ||
    lower.includes("zip") ||
    lower.includes("gzip")
  ) {
    return false;
  }
  return true;
}

export function ConsoleStream({
  scope,
  version,
  range,
  view,
  selected,
  live,
  locateEntry,
  onLocateHandled,
  onQuickSymbolicate,
  onViewChange,
  onSelect,
  onError,
}: {
  scope: Scope;
  version: string;
  range: TimeRange;
  view: StreamViewState;
  selected: StreamSelection | null;
  live?: boolean;
  locateEntry?: { entryId: string; nonce: number } | null;
  onLocateHandled?: () => void;
  onQuickSymbolicate?: (selection: StreamSelection) => void;
  onViewChange: (update: Partial<StreamViewState>) => void;
  onSelect: (selection: StreamSelection | null) => void;
  onError: (error: string) => void;
}) {
  const { t } = useTranslation();
  const [debouncedSearch, setDebouncedSearch] = useState(view.search);
  const [totalLines, setTotalLines] = useState(0);
  const [totalBlocks, setTotalBlocks] = useState(0);
  const [latestTs, setLatestTs] = useState<number | null>(null);
  const [renderTick, setRenderTick] = useState(0);
  const [bodyTick, setBodyTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);
  const [loadingBodyKey, setLoadingBodyKey] = useState<string | null>(null);
  const [pausedBaseLines, setPausedBaseLines] = useState(0);
  const [matchLines, setMatchLines] = useState<number[]>([]);
  const [matchLimited, setMatchLimited] = useState(false);
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const [flashLine, setFlashLine] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const cacheRef = useRef(new StreamChunkCache());
  const inFlightChunks = useRef(new Set<string>());
  const revisionRef = useRef(0);
  const criteriaGenRef = useRef(0);
  const lastScrollTop = useRef(0);
  const scrollDirection = useRef<-1 | 0 | 1>(0);
  const ignoreScroll = useRef(false);
  const attemptedBodies = useRef(new Set<string>());
  const activeBodyFetches = useRef(0);
  const bodyQueue = useRef<RemoteBodyHint[]>([]);

  const searchMode = view.searchMode ?? "filter";
  const collapsedBlocks = view.collapsedBlocks ?? [];
  const compactAll = !!view.compactAll;
  const minTimestampMicros = view.minTimestampMicros ?? null;

  const tzOffsetEastSeconds = useMemo(
    () => -new Date().getTimezoneOffset() * 60,
    [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(view.search), 180);
    return () => clearTimeout(timer);
  }, [view.search]);

  const criteriaKey = useMemo(
    () =>
      JSON.stringify({
        scope,
        range,
        search: searchMode === "filter" ? debouncedSearch.trim() : "",
        searchMode,
        kindFilter: view.kindFilter,
        minTimestampMicros,
        compactAll,
        collapsedBlocks,
      }),
    [
      scope,
      range,
      debouncedSearch,
      searchMode,
      view.kindFilter,
      minTimestampMicros,
      compactAll,
      collapsedBlocks,
    ],
  );
  const dataVersion = `${version}:${bodyTick}:${retry}`;

  const makeQuery = useCallback(
    (
      lineOffset: number,
      lineLimit: number,
      revision: number,
      overrideSearch?: string,
    ): StreamQuery => {
      const parsed = JSON.parse(criteriaKey) as {
        range: TimeRange;
        search: string;
        searchMode: StreamSearchMode;
        kindFilter: StreamKindFilter;
        minTimestampMicros: number | null;
        compactAll: boolean;
        collapsedBlocks: string[];
      };
      return {
        search: overrideSearch ?? parsed.search,
        searchMode: parsed.searchMode,
        kindFilter: parsed.kindFilter,
        range: parsed.range,
        minTimestampMicros: parsed.minTimestampMicros,
        compactAll: parsed.compactAll,
        collapsedBlocks: parsed.collapsedBlocks,
        lineOffset,
        lineLimit,
        tzOffsetEastSeconds,
        revision,
      };
    },
    [criteriaKey, tzOffsetEastSeconds],
  );

  useCommand("view.follow", () => {
    const next = !view.following;
    setPausedBaseLines(totalLines);
    onViewChange({ following: next });
  });
  useCommand("edit.clearSelection", () => onSelect(null), !!selected);

  const virtualizer = useVirtualizer({
    count: totalLines,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => STREAM_LINE_HEIGHT,
    overscan: 30,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const firstVisible = virtualItems[0]?.index ?? 0;
  const lastVisible =
    virtualItems[virtualItems.length - 1]?.index ??
    firstVisible + STREAM_CHUNK_SIZE;

  // 跳转到指定全局行号并闪烁提示
  const jumpToLine = useCallback(
    (targetLine: number) => {
      if (targetLine < 0) return;
      onViewChange({ following: false });
      setPausedBaseLines(totalLines);
      ignoreScroll.current = true;
      virtualizer.scrollToIndex(targetLine, { align: "center" });
      setFlashLine(targetLine);
      window.setTimeout(() => {
        ignoreScroll.current = false;
      }, 120);
      window.setTimeout(() => {
        setFlashLine((cur) => (cur === targetLine ? null : cur));
      }, 1400);
    },
    [onViewChange, totalLines, virtualizer],
  );
  const jumpToLineRef = useRef(jumpToLine);
  jumpToLineRef.current = jumpToLine;

  // 切换作用域或筛选条件时重置缓存
  useEffect(() => {
    criteriaGenRef.current += 1;
    cacheRef.current.clear();
    inFlightChunks.current.clear();
    attemptedBodies.current.clear();
    bodyQueue.current = [];
    setTotalLines(0);
    setTotalBlocks(0);
    setLoading(true);
    setFailed(false);
    setNotice("");
    setPausedBaseLines(0);
    scrollDirection.current = 0;
    lastScrollTop.current = 0;
    if (!view.following) scrollRef.current?.scrollTo({ top: 0 });
    setRenderTick((v) => v + 1);
  }, [criteriaKey]);

  const fetchChunk = useCallback(
    (chunkIndex: number, expectedGen: number, expectedVersion: string) => {
      const key = `${expectedGen}:${expectedVersion}:${chunkIndex}`;
      if (inFlightChunks.current.has(key)) return;
      if (cacheRef.current.isFresh(chunkIndex, expectedVersion)) return;

      inFlightChunks.current.add(key);
      const reqRev = ++revisionRef.current;
      const offset = chunkIndex * STREAM_CHUNK_SIZE;
      const query = makeQuery(offset, STREAM_CHUNK_SIZE, reqRev);

      void api
        .stream(scope, query)
        .then((page) => {
          inFlightChunks.current.delete(key);
          if (expectedGen !== criteriaGenRef.current) return;
          if (page.revision !== reqRev) return;

          cacheRef.current.setPage(chunkIndex, expectedVersion, page);
          cacheRef.current.pruneOutOfRange(page.totalLines);
          setTotalLines(page.totalLines);
          setTotalBlocks(page.totalBlocks);
          if (page.latestTimestampMicros != null) {
            setLatestTs(page.latestTimestampMicros);
          }
          setLoading(false);
          setFailed(false);
          setRenderTick((v) => v + 1);

          if (view.following && page.totalLines > 0) {
            const latestChunk = Math.floor(
              (page.totalLines - 1) / STREAM_CHUNK_SIZE,
            );
            if (
              latestChunk !== chunkIndex &&
              !cacheRef.current.isFresh(latestChunk, expectedVersion)
            ) {
              fetchChunk(latestChunk, expectedGen, expectedVersion);
              if (latestChunk > 0) {
                fetchChunk(latestChunk - 1, expectedGen, expectedVersion);
              }
            }
          }
        })
        .catch((error) => {
          inFlightChunks.current.delete(key);
          if (expectedGen !== criteriaGenRef.current) return;
          setLoading(false);
          setFailed(true);
          onError(String(error));
        });
    },
    [makeQuery, scope, view.following, onError],
  );

  // 双向预加载调度
  useEffect(() => {
    const gen = criteriaGenRef.current;
    if (totalLines === 0) {
      fetchChunk(0, gen, dataVersion);
      return;
    }

    if (view.following) {
      const tailChunk = Math.floor((totalLines - 1) / STREAM_CHUNK_SIZE);
      fetchChunk(tailChunk, gen, dataVersion);
      if (tailChunk > 0) fetchChunk(tailChunk - 1, gen, dataVersion);
      return;
    }

    const planned = planPrefetchChunks(
      firstVisible,
      lastVisible,
      totalLines,
      scrollDirection.current,
    );
    for (const chunkIndex of planned) {
      fetchChunk(chunkIndex, gen, dataVersion);
    }
  }, [
    firstVisible,
    lastVisible,
    totalLines,
    dataVersion,
    criteriaKey,
    view.following,
    fetchChunk,
  ]);

  // 上下文定位模式下查询全局命中行列表
  useEffect(() => {
    const needle = debouncedSearch.trim();
    if (searchMode !== "locate" || !needle) {
      setMatchLines((prev) => (prev.length === 0 ? prev : []));
      setMatchLimited(false);
      setCurrentMatchIdx(0);
      return;
    }
    let active = true;
    void api
      .findStreamMatches(scope, makeQuery(0, 1, 0, needle))
      .then((res) => {
        if (!active) return;
        setMatchLines(res.lineIndices);
        setMatchLimited(res.limited);
        setCurrentMatchIdx(0);
        if (res.lineIndices.length > 0) {
          jumpToLineRef.current(res.lineIndices[0]);
        }
      })
      .catch(() => {
        if (active) setMatchLines((prev) => (prev.length === 0 ? prev : []));
      });
    return () => {
      active = false;
    };
  }, [debouncedSearch, searchMode, scope, dataVersion, makeQuery]);

  // 响应从「网络」列表右键发来的跨 Tab 定位请求
  useEffect(() => {
    if (!locateEntry || totalLines === 0) return;
    let active = true;
    void api
      .locateStreamEntry(
        scope,
        makeQuery(0, 1, 0),
        locateEntry.entryId,
        "http-request",
      )
      .then((lineNo) => {
        if (!active) return;
        if (lineNo !== null && lineNo !== undefined) {
          jumpToLineRef.current(lineNo);
        } else {
          setNotice(t("streamLocateNotFound"));
        }
        onLocateHandled?.();
      })
      .catch(() => {
        if (active) onLocateHandled?.();
      });
    return () => {
      active = false;
    };
  }, [locateEntry, totalLines, scope, makeQuery, onLocateHandled, t]);

  useLayoutEffect(() => {
    if (!view.following || totalLines <= 0) return;
    ignoreScroll.current = true;
    virtualizer.scrollToIndex(totalLines - 1, { align: "end" });
    setPausedBaseLines(totalLines);
    const timer = window.setTimeout(() => {
      ignoreScroll.current = false;
    }, 90);
    return () => clearTimeout(timer);
  }, [view.following, totalLines, virtualizer]);

  // 远端正文并发限流队列
  const pumpBodyQueue = useCallback(() => {
    while (
      activeBodyFetches.current < MAX_BODY_CONCURRENCY &&
      bodyQueue.current.length > 0
    ) {
      const hint = bodyQueue.current.shift()!;
      const bodyKey = `${hint.sessionId}:${hint.entryId}:${hint.side}`;
      activeBodyFetches.current += 1;
      setLoadingBodyKey(bodyKey);
      void api
        .body(hint.sessionId, hint.entryId, hint.side)
        .then(() => {
          setBodyTick((v) => v + 1);
        })
        .catch(() => {
          /* 设备离线或已淘汰时静默跳过 */
        })
        .finally(() => {
          activeBodyFetches.current -= 1;
          setLoadingBodyKey((cur) => (cur === bodyKey ? null : cur));
          pumpBodyQueue();
        });
    }
  }, []);

  useEffect(() => {
    if (!live || !view.autoLoadBody || !desktop) return;
    const hints = cacheRef.current.collectRemoteHints();
    let enqueued = false;
    for (const line of hints) {
      const hint = line.remoteBody;
      if (!hint) continue;
      if (!isTextualMediaType(hint.mediaType)) continue;
      if (hint.size !== null && hint.size > AUTO_BODY_MAX_BYTES) continue;
      const bodyKey = `${hint.sessionId}:${hint.entryId}:${hint.side}`;
      if (attemptedBodies.current.has(bodyKey)) continue;
      attemptedBodies.current.add(bodyKey);
      bodyQueue.current.push(hint);
      enqueued = true;
    }
    if (enqueued) pumpBodyQueue();
  }, [renderTick, live, view.autoLoadBody, pumpBodyQueue]);

  const loadRemoteBodyNow = useCallback(
    (hint: RemoteBodyHint) => {
      const bodyKey = `${hint.sessionId}:${hint.entryId}:${hint.side}`;
      attemptedBodies.current.add(bodyKey);
      bodyQueue.current.unshift(hint);
      pumpBodyQueue();
    },
    [pumpBodyQueue],
  );

  const handleCopyBlock = useCallback(
    async (blockId: string) => {
      try {
        const text = await api.copyStreamBlock(
          scope,
          makeQuery(0, 1, 0),
          blockId,
        );
        await writeClipboard(text);
        setNotice(t("copied"));
      } catch (error) {
        onError(String(error));
      }
    },
    [scope, makeQuery, t, onError],
  );

  const handleExportStream = useCallback(async () => {
    if (!desktop) return;
    try {
      if (await api.exportStreamText(scope, makeQuery(0, 1, 0))) {
        setNotice(t("streamExported"));
      }
    } catch (error) {
      onError(String(error));
    }
  }, [scope, makeQuery, t, onError]);

  const toggleBlockCollapse = useCallback(
    (blockId: string) => {
      if (compactAll) {
        // 全局紧凑模式下点击单块时，先切回展开模式并保留用户意图
        onViewChange({ compactAll: false, collapsedBlocks: [] });
        return;
      }
      const exists = collapsedBlocks.includes(blockId);
      const next = exists
        ? collapsedBlocks.filter((id) => id !== blockId)
        : [...collapsedBlocks, blockId];
      onViewChange({ collapsedBlocks: next });
    },
    [compactAll, collapsedBlocks, onViewChange],
  );

  const handleClearScreen = useCallback(() => {
    const baseline = latestTs ?? Date.now() * 1000;
    onViewChange({ minTimestampMicros: baseline, following: true });
    setNotice(t("streamClearedHint"));
  }, [latestTs, onViewChange, t]);

  const stepMatch = useCallback(
    (delta: number) => {
      if (matchLines.length === 0) return;
      const next =
        (currentMatchIdx + delta + matchLines.length) % matchLines.length;
      setCurrentMatchIdx(next);
      jumpToLine(matchLines[next]);
    },
    [matchLines, currentMatchIdx, jumpToLine],
  );

  const pauseFollowing = useCallback(() => {
    if (!view.following) return;
    setPausedBaseLines(totalLines);
    onViewChange({ following: false });
  }, [view.following, totalLines, onViewChange]);

  const resumeFollowing = useCallback(() => {
    onViewChange({ following: true });
    if (totalLines > 0) {
      ignoreScroll.current = true;
      virtualizer.scrollToIndex(totalLines - 1, { align: "end" });
      window.setTimeout(() => {
        ignoreScroll.current = false;
      }, 90);
    }
  }, [onViewChange, totalLines, virtualizer]);

  const unreadLines =
    !view.following && totalLines > pausedBaseLines
      ? totalLines - pausedBaseLines
      : 0;
  const activeNeedle = debouncedSearch.trim();
  const activeMatchLine =
    searchMode === "locate" && matchLines.length > 0
      ? matchLines[currentMatchIdx]
      : null;

  return (
    <div
      className="stream-console"
      onKeyDown={(event) => {
        // ⌘/Ctrl + K 在控制台聚焦时快捷清屏
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          event.key.toLowerCase() === "l"
        ) {
          event.preventDefault();
          handleClearScreen();
        }
      }}
    >
      <div className="stream-toolbar">
        <div className="stream-search-row">
          <label className="search-field stream-search">
            <Search size={13} />
            <input
              data-search
              aria-label={t("streamSearch")}
              placeholder={t("streamSearch")}
              value={view.search}
              onChange={(event) => onViewChange({ search: event.target.value })}
              onKeyDown={(event) => {
                if (
                  searchMode === "locate" &&
                  event.key === "Enter" &&
                  matchLines.length > 0
                ) {
                  event.preventDefault();
                  stepMatch(event.shiftKey ? -1 : 1);
                }
              }}
            />
            {view.search && (
              <button
                type="button"
                aria-label={t("dismiss")}
                onClick={() => onViewChange({ search: "" })}
              >
                <X size={13} />
              </button>
            )}
          </label>
          <div className="segmented stream-mode-switch" role="group">
            <button
              type="button"
              aria-pressed={searchMode === "filter"}
              className={searchMode === "filter" ? "active" : ""}
              onClick={() => onViewChange({ searchMode: "filter" })}
              title={t("streamModeFilterHint")}
            >
              {t("streamModeFilter")}
            </button>
            <button
              type="button"
              aria-pressed={searchMode === "locate"}
              className={searchMode === "locate" ? "active" : ""}
              onClick={() => onViewChange({ searchMode: "locate" })}
              title={t("streamModeLocateHint")}
            >
              {t("streamModeLocate")}
            </button>
          </div>
          {searchMode === "locate" && activeNeedle && (
            <div className="stream-match-nav">
              <span className="num-cell muted">
                {matchLines.length > 0
                  ? `${currentMatchIdx + 1}/${matchLines.length}${matchLimited ? "+" : ""}`
                  : "0/0"}
              </span>
              <Button
                size="icon"
                variant="ghost"
                disabled={matchLines.length === 0}
                aria-label={t("previousMatch")}
                onClick={() => stepMatch(-1)}
              >
                <ChevronUp size={13} />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                disabled={matchLines.length === 0}
                aria-label={t("nextMatch")}
                onClick={() => stepMatch(1)}
              >
                <ChevronDown size={13} />
              </Button>
            </div>
          )}
        </div>

        <div className="stream-controls">
          <div className="segmented" role="group" aria-label={t("filters")}>
            {(
              [
                ["all", "streamAll"],
                ["network", "streamNetwork"],
                ["logs", "streamLogs"],
                ["errors", "streamErrors"],
              ] as const
            ).map(([filter, label]) => (
              <button
                key={filter}
                type="button"
                aria-pressed={view.kindFilter === filter}
                className={view.kindFilter === filter ? "active" : ""}
                onClick={() => onViewChange({ kindFilter: filter })}
              >
                {t(label)}
              </button>
            ))}
          </div>
          <div className="stream-actions">
            {live && (
              <label className="stream-toggle" title={t("streamAutoBodyHint")}>
                <input
                  type="checkbox"
                  checked={view.autoLoadBody}
                  onChange={(event) =>
                    onViewChange({ autoLoadBody: event.target.checked })
                  }
                />
                <span>{t("streamAutoBody")}</span>
              </label>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={compactAll}
              onClick={() =>
                onViewChange({
                  compactAll: !compactAll,
                  collapsedBlocks: [],
                })
              }
              title={t(compactAll ? "streamExpandAll" : "streamCompactAll")}
            >
              {compactAll ? (
                <UnfoldVertical size={12} />
              ) : (
                <FoldVertical size={12} />
              )}
              {t(compactAll ? "streamExpandAll" : "streamCompactAll")}
            </Button>
            {minTimestampMicros !== null ? (
              <Button
                size="sm"
                variant="default"
                className="is-cleared-chip"
                onClick={() => onViewChange({ minTimestampMicros: null })}
                title={t("streamRestoreHistory")}
              >
                <RotateCcw size={12} />
                {t("streamRestoreHistory")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={totalBlocks === 0}
                onClick={handleClearScreen}
                title={t("streamClear")}
              >
                <Eraser size={12} />
                {t("streamClear")}
              </Button>
            )}
            <Button
              size="sm"
              aria-pressed={view.following}
              className={view.following ? "is-following" : ""}
              onClick={() => commands.dispatch("view.follow")}
            >
              {view.following ? <Pause size={12} /> : <Play size={12} />}
              {t(view.following ? "pauseFollow" : "followLatest")}
            </Button>
            {desktop && (
              <Button
                size="sm"
                disabled={totalBlocks === 0}
                onClick={() => void handleExportStream()}
                title={t("streamExport")}
              >
                <Download size={12} />
                {t("streamExport")}
              </Button>
            )}
          </div>
        </div>
      </div>

      {notice && (
        <div className="inline-note stream-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="inline-dismiss"
            aria-label={t("dismiss")}
            onClick={() => setNotice("")}
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="stream-viewport-wrap">
        <div
          ref={scrollRef}
          className="stream-scroll"
          role="log"
          aria-label={t("stream")}
          aria-live="off"
          aria-busy={loading}
          onWheel={(event) => {
            if (event.deltaY < 0) pauseFollowing();
          }}
          onScroll={() => {
            const el = scrollRef.current;
            if (!el) return;
            const currentTop = el.scrollTop;
            if (currentTop > lastScrollTop.current) scrollDirection.current = 1;
            else if (currentTop < lastScrollTop.current)
              scrollDirection.current = -1;
            lastScrollTop.current = currentTop;

            if (
              view.following &&
              !ignoreScroll.current &&
              el.scrollHeight - el.scrollTop - el.clientHeight > 64
            ) {
              pauseFollowing();
            }
          }}
        >
          {failed ? (
            <div className="table-empty">
              <p>{t("unexpected", { error: "stream" })}</p>
              <Button onClick={() => setRetry((v) => v + 1)}>
                {t("retry")}
              </Button>
            </div>
          ) : totalLines === 0 ? (
            <div className="table-empty">
              <Terminal />
              <h2>
                {t(
                  loading
                    ? "loading"
                    : minTimestampMicros !== null
                      ? "streamClearedEmpty"
                      : "streamEmpty",
                )}
              </h2>
              {!loading && (
                <p>
                  {t(
                    minTimestampMicros !== null
                      ? "streamClearedHint"
                      : "streamEmptyHint",
                  )}
                </p>
              )}
              {minTimestampMicros !== null && (
                <Button
                  size="sm"
                  onClick={() => onViewChange({ minTimestampMicros: null })}
                >
                  <RotateCcw size={12} />
                  {t("streamRestoreHistory")}
                </Button>
              )}
            </div>
          ) : (
            <div
              className="virtual-space stream-canvas"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualItems.map((item) => {
                const line = cacheRef.current.getLine(item.index);
                if (!line) {
                  return (
                    <div
                      key={`placeholder-${item.index}`}
                      className="stream-line stream-placeholder"
                      style={{
                        height: STREAM_LINE_HEIGHT,
                        transform: `translateY(${item.start}px)`,
                      }}
                    >
                      <span className="stream-gutter">{item.index + 1}</span>
                      <span className="stream-text muted">…</span>
                    </div>
                  );
                }

                const isSelected = selected?.blockId === line.blockId;
                const isHovered = hoveredBlockId === line.blockId;
                const isHeader = line.role === "header";
                const canCollapse =
                  isHeader && (line.collapsed || line.blockLineCount > 3);
                const showActions = isHeader && (isHovered || isSelected);
                const isRemoteClickable =
                  line.role === "remote" && !!line.remoteBody;
                const isMatchRow = activeMatchLine === item.index;
                const isFlashRow = flashLine === item.index;

                return (
                  <div
                    key={item.index}
                    data-block-id={line.blockId}
                    data-role={line.role}
                    className={`stream-line stream-kind-${line.kind} stream-level-${line.level} stream-role-${line.role}${isSelected ? " is-selected" : ""}${isHovered ? " is-hovered" : ""}${isRemoteClickable ? " is-remote-action" : ""}${isMatchRow ? " is-active-match" : ""}${isFlashRow ? " is-flash" : ""}`}
                    style={{
                      height: STREAM_LINE_HEIGHT,
                      transform: `translateY(${item.start}px)`,
                    }}
                    onMouseEnter={() => setHoveredBlockId(line.blockId)}
                    onMouseLeave={() =>
                      setHoveredBlockId((cur) =>
                        cur === line.blockId ? null : cur,
                      )
                    }
                    onClick={() => {
                      if (isRemoteClickable && line.remoteBody) {
                        loadRemoteBodyNow(line.remoteBody);
                      }
                      onSelect({
                        blockId: line.blockId,
                        kind: line.kind,
                        sessionId: line.sessionId,
                        entryId: line.entryId,
                        runId: line.runId,
                        eventId: line.eventId,
                      });
                    }}
                  >
                    <span className="stream-gutter" aria-hidden="true">
                      {canCollapse ? (
                        <button
                          type="button"
                          className="stream-fold-btn"
                          aria-label={t(
                            line.collapsed ? "expandNode" : "collapseNode",
                          )}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleBlockCollapse(line.blockId);
                          }}
                        >
                          {line.collapsed ? (
                            <ChevronRight size={11} />
                          ) : (
                            <ChevronDown size={11} />
                          )}
                        </button>
                      ) : (
                        item.index + 1
                      )}
                    </span>
                    <span className="stream-text">
                      {renderStreamLineText(
                        line.text,
                        line.role === "body",
                        activeNeedle,
                      )}
                      {isHeader &&
                        line.collapsed &&
                        (line.hiddenLines ?? 0) > 0 && (
                          <span className="stream-collapsed-pill">
                            +{line.hiddenLines} {t("streamHiddenLines")}
                          </span>
                        )}
                    </span>
                    <span className="stream-row-tools">
                      {isHeader &&
                        desktop &&
                        line.kind === "exception" &&
                        line.runId &&
                        line.eventId &&
                        onQuickSymbolicate && (
                          <button
                            type="button"
                            className="stream-symbolicate-btn"
                            title={t("quickSymbolicateHint")}
                            onClick={(event) => {
                              event.stopPropagation();
                              onQuickSymbolicate({
                                blockId: line.blockId,
                                kind: line.kind,
                                sessionId: line.sessionId,
                                entryId: line.entryId,
                                runId: line.runId,
                                eventId: line.eventId,
                              });
                            }}
                          >
                            <Sparkles size={10} />
                            <span>{t("symbolicateStack")}</span>
                          </button>
                        )}
                      {isHeader &&
                        line.pairLine !== null &&
                        line.pairLine !== undefined &&
                        line.pairLabel && (
                          <button
                            type="button"
                            className="stream-pair-btn"
                            title={t("streamJumpPair")}
                            onClick={(event) => {
                              event.stopPropagation();
                              jumpToLine(line.pairLine!);
                            }}
                          >
                            <ArrowUpDown size={10} />
                            <span>{line.pairLabel}</span>
                          </button>
                        )}
                      {showActions && (
                        <button
                          type="button"
                          className="stream-copy-btn"
                          aria-label={t("streamCopyBlock")}
                          title={t("streamCopyBlock")}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleCopyBlock(line.blockId);
                          }}
                        >
                          <Copy size={11} />
                          <span>{t("streamCopyBlock")}</span>
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {!view.following && totalLines > 0 && (
          <button
            type="button"
            className="stream-jump-fab"
            onClick={resumeFollowing}
          >
            <ArrowDown size={13} />
            {unreadLines > 0
              ? t("streamJumpNewLines", { count: unreadLines })
              : t("streamJumpLatest")}
          </button>
        )}
      </div>

      <div className="diagnostic-stats stream-footer">
        <span>
          {t("streamStats", {
            blocks: totalBlocks.toLocaleString(),
            lines: totalLines.toLocaleString(),
          })}
          {" · "}
          {t("streamCachedChunks", { count: cacheRef.current.size })}
        </span>
        {loadingBodyKey && (
          <span className="stream-fetching">{t("streamLoadingBody")}</span>
        )}
        {!view.following && <span>{t("pausedHint")}</span>}
      </div>
    </div>
  );
}
