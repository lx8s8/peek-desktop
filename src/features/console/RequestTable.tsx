import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Code2,
  Columns3,
  Copy,
  Eraser,
  EyeOff,
  Filter as FilterIcon,
  GitCompareArrows,
  Pin,
  Play,
  Repeat,
  RotateCcw,
  SearchX,
  Terminal,
  TerminalSquare,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { api } from "../../lib/ipc/client";
import type {
  EntryRow,
  Filter,
  QueryPage,
  RequestSortField,
  RequestStatusFilter,
  SortDirection,
  TimeRange,
} from "../../lib/ipc/types";
import {
  DEFAULT_OPTIONAL_COLUMNS,
  DEFAULT_REQUEST_COLUMN_WIDTHS,
  formatBytes,
  readRequestTableLayout,
  writeRequestTableLayout,
  type OptionalRequestColumn,
  type RequestTableLayoutPrefs,
} from "../../lib/preferences";

const SORTABLE_COLUMN_MAP: Partial<Record<string, RequestSortField>> = {
  durationMs: "duration",
  responseBytes: "size",
  startedAt: "time",
};

const OPTIONAL_COLUMN_LABELS: {
  id: OptionalRequestColumn;
  labelKey: string;
}[] = [
  { id: "durationMs", labelKey: "duration" },
  { id: "waterfall", labelKey: "waterfall" },
  { id: "responseBytes", labelKey: "size" },
  { id: "startedAt", labelKey: "time" },
  { id: "source", labelKey: "source" },
];

export interface RequestTableMeta {
  latestSeq: number;
  hiddenCount: number;
  totalBytes: number;
  maxBytes: number | null;
  spilledCount: number;
  spilledBytes: number;
}

/** 将完整 URL 拆分为高亮 Path+Query 与弱化 Host，方便抓包时快速扫读接口名。 */
function splitUrl(raw: string): {
  host: string;
  path: string;
  pathname: string;
} {
  try {
    const parsed = new URL(raw);
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
    return { host: parsed.host, path, pathname: parsed.pathname || "/" };
  } catch {
    return { host: "", path: raw, pathname: raw };
  }
}

/** 计算状态码语义样式类。 */
function statusTone(state: EntryRow["state"], status: number | null): string {
  if (state === "failed") return "status-failed";
  if (state === "pending" || status === null) return "status-pending";
  if (status >= 500) return "status-5xx";
  if (status >= 400) return "status-4xx";
  if (status >= 300) return "status-3xx";
  return "status-2xx";
}

export type RequestCopyKind = "url" | "curl" | "dio" | "fetch" | "body";

export function RequestTable({
  sessionId,
  version,
  live,
  search,
  filter,
  range,
  hostFilter,
  excludePatterns,
  methodFilter,
  statusFilter,
  searchBody = false,
  sortBy,
  sortDir = "desc",
  afterSeq,
  clearMarkSeq,
  clearEvictedCount = 0,
  selectedId,
  compareAnchor,
  onSelect,
  onCount,
  onMeta,
  onHosts,
  onSortChange,
  onRestoreHistory,
  onDismissClear,
  onPinToggle,
  onFilterHost,
  onExcludePath,
  onLocateInStream,
  onReplay,
  onQuickRepeat,
  onRepeatBatch,
  onSetCompareAnchor,
  onCompareWithAnchor,
  onCopyAction,
  onError,
}: {
  sessionId: string;
  version?: number;
  live?: boolean;
  search: string;
  filter: Filter;
  range?: TimeRange;
  hostFilter?: string | null;
  excludePatterns?: string[];
  methodFilter?: string | null;
  statusFilter?: RequestStatusFilter | null;
  searchBody?: boolean;
  sortBy?: RequestSortField | null;
  sortDir?: SortDirection;
  afterSeq?: number | null;
  clearMarkSeq?: number | null;
  clearEvictedCount?: number;
  selectedId?: string;
  compareAnchor?: EntryRow | null;
  onSelect: (entry: EntryRow) => void;
  onCount: (count: number) => void;
  onMeta?: (meta: RequestTableMeta) => void;
  onHosts?: (hosts: string[]) => void;
  onSortChange?: (field: RequestSortField | null, dir: SortDirection) => void;
  onRestoreHistory?: () => void;
  onDismissClear?: () => void;
  onPinToggle?: (entry: EntryRow) => void;
  onFilterHost?: (host: string) => void;
  onExcludePath?: (pattern: string) => void;
  onLocateInStream?: (entry: EntryRow) => void;
  onReplay?: (entry: EntryRow) => void;
  onQuickRepeat?: (entry: EntryRow) => void;
  onRepeatBatch?: (entry: EntryRow) => void;
  onSetCompareAnchor?: (entry: EntryRow) => void;
  onCompareWithAnchor?: (entry: EntryRow) => void;
  onCopyAction?: (entry: EntryRow, kind: RequestCopyKind) => void;
  onError: (error: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const rangeKey = JSON.stringify(range ?? {});
  const excludeKey = JSON.stringify(excludePatterns ?? []);
  const scroll = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<QueryPage>({
    total: 0,
    offset: 0,
    rows: [],
    revision: 0,
  });
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const revision = useRef(0);
  const navRevision = useRef(0);
  const loadedSessionRef = useRef<string | null>(null);
  const lastRetryRef = useRef(0);
  const callbacksRef = useRef({ onCount, onMeta, onHosts, onError });
  callbacksRef.current = { onCount, onMeta, onHosts, onError };
  const [failure, setFailure] = useState(false);
  const [sortStatus, setSortStatus] = useState("");
  const [tableLayout, setTableLayout] = useState<RequestTableLayoutPrefs>(() =>
    readRequestTableLayout(),
  );
  const [colMenuPos, setColMenuPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    entry: EntryRow;
  } | null>(null);

  const updateLayout = (
    updater: (prev: RequestTableLayoutPrefs) => RequestTableLayoutPrefs,
  ) => {
    setTableLayout((prev) => {
      const next = updater(prev);
      writeRequestTableLayout(next);
      return next;
    });
  };

  function startColumnResize(
    colId: string,
    event: React.PointerEvent<HTMLSpanElement>,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth =
      tableLayout.widths[colId] ?? DEFAULT_REQUEST_COLUMN_WIDTHS[colId] ?? 72;
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = Math.max(
        44,
        Math.min(240, Math.round(startWidth + delta)),
      );
      updateLayout((prev) => ({
        ...prev,
        widths: { ...prev.widths, [colId]: nextWidth },
      }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  useEffect(() => {
    if (!colMenuPos) return;
    const close = () => setColMenuPos(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setColMenuPos(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [colMenuPos]);

  const virtualizer = useVirtualizer({
    count: page.total,
    getScrollElement: () => scroll.current,
    estimateSize: () => 34,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const start = items[0]?.index ?? 0;

  useEffect(() => {
    setOffset(0);
    if (loadedSessionRef.current !== sessionId) {
      setPage({ total: 0, offset: 0, rows: [], revision: 0 });
      setLoading(true);
    }
    scroll.current?.scrollTo({ top: 0 });
    ++navRevision.current;
  }, [
    sessionId,
    search,
    filter,
    rangeKey,
    hostFilter,
    excludeKey,
    methodFilter,
    statusFilter,
    searchBody,
    sortBy,
    sortDir,
    afterSeq,
  ]);

  useEffect(() => {
    setOffset(Math.max(0, Math.floor(start / 100) * 100 - 100));
  }, [start]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    const request = ++revision.current;
    let active = true;
    const isRetry = retry !== lastRetryRef.current;
    lastRetryRef.current = retry;
    // 仅在首次加载该会话或显式重试时展示「加载中」，同会话内清屏与实时推送静默刷新避免画面闪烁
    if (loadedSessionRef.current !== sessionId || isRetry) {
      setLoading(true);
    }
    setFailure(false);
    const parsedRange = JSON.parse(rangeKey) as TimeRange;
    const parsedExcludes = JSON.parse(excludeKey) as string[];
    const hasExtra = !!(
      hostFilter ||
      parsedExcludes.length > 0 ||
      methodFilter ||
      statusFilter ||
      searchBody ||
      sortBy ||
      afterSeq != null
    );
    const promise = hasExtra
      ? api.query(
          sessionId,
          search,
          filter,
          offset,
          request,
          300,
          parsedRange,
          hostFilter,
          parsedExcludes,
          sortBy,
          sortDir,
          afterSeq,
          methodFilter,
          statusFilter,
          searchBody,
        )
      : api.query(sessionId, search, filter, offset, request, 300, parsedRange);

    void promise
      .then((result) => {
        if (
          !active ||
          request !== revision.current ||
          result.revision !== request
        )
          return;
        loadedSessionRef.current = sessionId;
        setPage(result);
        callbacksRef.current.onCount(result.total);
        callbacksRef.current.onMeta?.({
          latestSeq: result.latestSeq ?? 0,
          hiddenCount: result.hiddenCount ?? 0,
          totalBytes: result.totalBytes ?? 0,
          maxBytes: result.maxBytes ?? null,
          spilledCount: result.spilledCount ?? 0,
          spilledBytes: result.spilledBytes ?? 0,
        });
        if (result.hosts) callbacksRef.current.onHosts?.(result.hosts);
        setLoading(false);
      })
      .catch((error) => {
        if (active) {
          setLoading(false);
          setFailure(true);
          callbacksRef.current.onError(String(error));
        }
      });
    return () => {
      active = false;
    };
  }, [
    sessionId,
    search,
    filter,
    offset,
    retry,
    version,
    rangeKey,
    hostFilter,
    excludeKey,
    methodFilter,
    statusFilter,
    searchBody,
    sortBy,
    sortDir,
    afterSeq,
  ]);

  const maxPageDuration = useMemo(() => {
    let max = 200;
    for (const row of page.rows) {
      if (row.durationMs !== null && row.durationMs > max) {
        max = row.durationMs;
      }
    }
    return max;
  }, [page.rows]);

  const columns = useMemo<ColumnDef<EntryRow>[]>(() => {
    const all: ColumnDef<EntryRow>[] = [
      {
        id: "method",
        accessorKey: "method",
        header: t("method"),
        cell: (info) => {
          const row = info.row.original;
          return (
            <span className="method-cell-wrap">
              {onPinToggle && (
                <button
                  type="button"
                  className={`pin-btn ${row.pinned ? "is-pinned" : ""}`}
                  title={t(row.pinned ? "unpinRequest" : "pinRequest")}
                  aria-label={t(row.pinned ? "unpinRequest" : "pinRequest")}
                  aria-pressed={row.pinned}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPinToggle(row);
                  }}
                >
                  <Pin size={11} />
                </button>
              )}
              <span
                className={`method-pill method method-${row.method.toLowerCase()}`}
              >
                {String(info.getValue())}
              </span>
            </span>
          );
        },
      },
      {
        id: "status",
        accessorKey: "status",
        header: t("status"),
        cell: (info) => {
          const row = info.row.original;
          return (
            <span
              className={`status-pill ${statusTone(row.state, row.status)}`}
            >
              {row.status ?? (row.state === "pending" ? "…" : "ERR")}
            </span>
          );
        },
      },
      {
        id: "url",
        accessorKey: "url",
        header: t("url"),
        cell: (info) => {
          const raw = info.row.original.url;
          const { host, path } = splitUrl(raw);
          const isAnchor = compareAnchor?.id === info.row.original.id;
          return (
            <span className="url-cell" title={raw}>
              {isAnchor && <span className="diff-anchor-pill">A</span>}
              <span className="url-path">{path}</span>
              {host && <span className="url-host">{host}</span>}
            </span>
          );
        },
      },
      ...(tableLayout.visible.durationMs
        ? ([
            {
              id: "durationMs",
              accessorKey: "durationMs",
              header: t("duration"),
              cell: (info) => {
                const ms = info.row.original.durationMs;
                if (ms === null)
                  return <span className="num-cell muted">—</span>;
                const slow =
                  ms >= 2500 ? "is-very-slow" : ms >= 800 ? "is-slow" : "";
                return (
                  <span
                    className={`num-cell ${slow}`}
                  >{`${ms.toFixed(0)} ms`}</span>
                );
              },
            },
          ] as ColumnDef<EntryRow>[])
        : []),
      ...(tableLayout.visible.waterfall
        ? ([
            {
              id: "waterfall",
              header: t("waterfall"),
              cell: (info) => {
                const row = info.row.original;
                const ms = row.durationMs;
                if (ms === null) {
                  return (
                    <span className="wf-mini-track">
                      <span
                        className="wf-mini-bar is-pending"
                        style={{ width: "16%" }}
                      />
                    </span>
                  );
                }
                const pct = Math.max(
                  5,
                  Math.min(100, (ms / maxPageDuration) * 100),
                );
                const tone =
                  row.state === "failed" ||
                  (row.status !== null && row.status >= 500)
                    ? "is-error"
                    : ms >= 2500
                      ? "is-very-slow"
                      : ms >= 800
                        ? "is-slow"
                        : "is-fast";
                return (
                  <span className="wf-mini-track" title={`${ms.toFixed(1)} ms`}>
                    <span
                      className={`wf-mini-bar ${tone}`}
                      style={{ width: `${pct.toFixed(1)}%` }}
                    />
                  </span>
                );
              },
            },
          ] as ColumnDef<EntryRow>[])
        : []),
      ...(tableLayout.visible.responseBytes
        ? ([
            {
              id: "responseBytes",
              accessorKey: "responseBytes",
              header: t("size"),
              cell: (info) => (
                <span className="num-cell muted">
                  {formatBytes(info.row.original.responseBytes)}
                </span>
              ),
            },
          ] as ColumnDef<EntryRow>[])
        : []),
      ...(tableLayout.visible.startedAt
        ? ([
            {
              id: "startedAt",
              accessorKey: "startedAt",
              header: t("time"),
              cell: (info) => (
                <span
                  className="num-cell muted"
                  title={info.row.original.startedAt}
                >
                  {new Date(info.row.original.startedAt).toLocaleTimeString(
                    i18n.language,
                    { hour12: false },
                  )}
                </span>
              ),
            },
          ] as ColumnDef<EntryRow>[])
        : []),
      ...(tableLayout.visible.source
        ? ([
            {
              id: "source",
              accessorKey: "source",
              header: t("source"),
              cell: (info) => (
                <span
                  className="muted source-cell"
                  title={info.row.original.source}
                >
                  {info.row.original.source}
                </span>
              ),
            },
          ] as ColumnDef<EntryRow>[])
        : []),
    ];
    return all;
  }, [
    t,
    i18n.language,
    onPinToggle,
    compareAnchor?.id,
    tableLayout.visible,
    maxPageDuration,
  ]);

  const gridTemplateColumns = useMemo(
    () =>
      columns
        .map((col) => {
          const id = col.id ?? "";
          if (id === "url") return "minmax(120px, 1fr)";
          const w =
            tableLayout.widths[id] ?? DEFAULT_REQUEST_COLUMN_WIDTHS[id] ?? 70;
          return `${w}px`;
        })
        .join(" "),
    [columns, tableLayout.widths],
  );

  const table = useReactTable({
    data: page.rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  async function move(delta: number, absolute?: number) {
    if (page.total === 0) return;
    const localIndex = page.rows.findIndex((row) => row.id === selectedId);
    const next = Math.max(
      0,
      Math.min(
        page.total - 1,
        absolute ?? (localIndex < 0 ? start : page.offset + localIndex + delta),
      ),
    );
    const request = ++navRevision.current;
    virtualizer.scrollToIndex(next, { align: "auto" });
    try {
      const parsedRange = JSON.parse(rangeKey) as TimeRange;
      const parsedExcludes = JSON.parse(excludeKey) as string[];
      const hasExtra = !!(
        hostFilter ||
        parsedExcludes.length > 0 ||
        methodFilter ||
        statusFilter ||
        searchBody ||
        sortBy ||
        afterSeq != null
      );
      const result = hasExtra
        ? await api.query(
            sessionId,
            search,
            filter,
            next,
            0,
            1,
            parsedRange,
            hostFilter,
            parsedExcludes,
            sortBy,
            sortDir,
            afterSeq,
            methodFilter,
            statusFilter,
            searchBody,
          )
        : await api.query(sessionId, search, filter, next, 0, 1, parsedRange);
      if (request === navRevision.current && result.rows[0])
        onSelect(result.rows[0]);
    } catch (error) {
      onError(String(error));
    }
  }

  function handleToggleSort(field: RequestSortField, label: string) {
    if (!onSortChange) return;
    if (sortBy !== field) {
      onSortChange(field, "desc");
      setSortStatus(t("sortAnnounceDesc", { column: label }));
    } else if (sortDir === "desc") {
      onSortChange(field, "asc");
      setSortStatus(t("sortAnnounceAsc", { column: label }));
    } else {
      onSortChange(null, "desc");
      setSortStatus(t("sortAnnounceReset"));
    }
  }

  useEffect(
    () => () => {
      ++navRevision.current;
    },
    [],
  );

  const menuParts = menu ? splitUrl(menu.entry.url) : null;

  return (
    <div
      className="request-table"
      role="grid"
      aria-label={t("network")}
      aria-rowcount={page.total + 1}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          void move(event.key === "ArrowDown" ? 1 : -1);
        }
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          void move(0, event.key === "Home" ? 0 : page.total - 1);
        }
        if (event.key === "PageDown" || event.key === "PageUp") {
          event.preventDefault();
          const size = Math.max(
            1,
            Math.floor((scroll.current?.clientHeight ?? 300) / 34),
          );
          void move(event.key === "PageDown" ? size : -size);
        }
      }}
    >
      <div className="sr-only" role="status" aria-live="polite">
        {sortStatus}
      </div>
      <div className="table-header-wrap">
        <div
          className="table-header table-grid"
          style={{ gridTemplateColumns }}
          role="row"
        >
          {table.getHeaderGroups()[0].headers.map((header) => {
            const sortField = SORTABLE_COLUMN_MAP[header.id];
            const label = String(header.column.columnDef.header);
            const isSorted = !!sortField && sortBy === sortField;
            const ariaSort = isSorted
              ? sortDir === "asc"
                ? "ascending"
                : "descending"
              : undefined;
            const resizable = header.id !== "url";
            return (
              <div
                key={header.id}
                role="columnheader"
                aria-sort={ariaSort}
                className={`table-col-head${sortField && onSortChange ? " is-sortable-header" : ""}`}
              >
                {sortField && onSortChange ? (
                  <button
                    type="button"
                    className={`sort-header-btn${isSorted ? " is-sorted" : ""}`}
                    title={t("sortColumnHint", { column: label })}
                    onClick={() => handleToggleSort(sortField, label)}
                  >
                    <span>{label}</span>
                    <span className="sort-icon" aria-hidden="true">
                      {isSorted ? (
                        sortDir === "asc" ? (
                          <ArrowUp size={11} />
                        ) : (
                          <ArrowDown size={11} />
                        )
                      ) : (
                        <ArrowUpDown size={10} />
                      )}
                    </span>
                  </button>
                ) : (
                  <span className="col-head-label">
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
                  </span>
                )}
                {resizable && (
                  <span
                    className="col-resize-handle"
                    title={t("resizeColumnHint")}
                    aria-hidden="true"
                    onPointerDown={(event) =>
                      startColumnResize(header.id, event)
                    }
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      const fallback =
                        DEFAULT_REQUEST_COLUMN_WIDTHS[header.id] ?? 72;
                      updateLayout((prev) => ({
                        ...prev,
                        widths: { ...prev.widths, [header.id]: fallback },
                      }));
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="col-config-btn"
          title={t("tableColumns")}
          aria-label={t("tableColumns")}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            setColMenuPos((prev) =>
              prev
                ? null
                : {
                    x: Math.max(8, rect.right - 180),
                    y: Math.min(window.innerHeight - 230, rect.bottom + 4),
                  },
            );
          }}
        >
          <Columns3 size={12} />
        </button>
      </div>
      <div className="table-scroll" ref={scroll} aria-busy={loading}>
        {failure ? (
          <div className="table-empty">
            <p>{t("unexpected", { error: "query" })}</p>
            <button onClick={() => setRetry((value) => value + 1)}>
              {t("retry")}
            </button>
          </div>
        ) : page.total === 0 ? (
          <div className="table-empty">
            {afterSeq != null && !loading ? <Eraser /> : <SearchX />}
            <h2>
              {t(
                loading
                  ? "loading"
                  : afterSeq != null &&
                      !search &&
                      filter === "all" &&
                      !hostFilter &&
                      !methodFilter &&
                      !statusFilter &&
                      (excludePatterns?.length ?? 0) === 0
                    ? "networkClearedEmpty"
                    : search ||
                        filter !== "all" ||
                        hostFilter ||
                        methodFilter ||
                        statusFilter ||
                        (excludePatterns?.length ?? 0) > 0
                      ? "noMatches"
                      : "emptySession",
              )}
            </h2>
            {!loading && (
              <p>
                {afterSeq != null &&
                !search &&
                filter === "all" &&
                !hostFilter &&
                !methodFilter &&
                !statusFilter &&
                (excludePatterns?.length ?? 0) === 0
                  ? clearEvictedCount > 0 && (page.hiddenCount ?? 0) > 0
                    ? t("networkClearedWithEvictedHint", {
                        retained: page.hiddenCount ?? 0,
                        evicted: clearEvictedCount,
                      })
                    : clearEvictedCount > 0 && (page.hiddenCount ?? 0) === 0
                      ? t("networkClearedAllEvictedHint", {
                          evicted: clearEvictedCount,
                        })
                      : t("networkClearedHint")
                  : t(
                      search ||
                        filter !== "all" ||
                        hostFilter ||
                        methodFilter ||
                        statusFilter ||
                        (excludePatterns?.length ?? 0) > 0
                        ? "noMatchesHint"
                        : live
                          ? "liveEmptyHint"
                          : "emptySessionHint",
                    )}
              </p>
            )}
            {!loading &&
              afterSeq != null &&
              (page.hiddenCount ?? 0) > 0 &&
              onRestoreHistory && (
                <Button size="sm" onClick={onRestoreHistory}>
                  <RotateCcw size={12} />
                  {t("networkShowHistory", { count: page.hiddenCount ?? 0 })}
                </Button>
              )}
            {!loading &&
              afterSeq != null &&
              (page.hiddenCount ?? 0) === 0 &&
              clearEvictedCount > 0 &&
              onDismissClear && (
                <Button size="sm" variant="ghost" onClick={onDismissClear}>
                  {t("networkClearDismiss")}
                </Button>
              )}
          </div>
        ) : (
          <div
            className="virtual-space"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {items.map((item) => {
              const row = table.getRowModel().rows[item.index - page.offset];
              const isBeforeClear =
                afterSeq == null &&
                clearMarkSeq != null &&
                row != null &&
                row.original.seq != null &&
                row.original.seq <= clearMarkSeq;
              return row ? (
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={item.index + 2}
                  aria-selected={row.id === selectedId}
                  className={`table-row table-grid ${row.id === selectedId ? "selected" : ""}${row.original.pinned ? " is-pinned-row" : ""}${isBeforeClear ? " is-before-clear" : ""}`}
                  style={{
                    transform: `translateY(${item.start}px)`,
                    gridTemplateColumns,
                  }}
                  onClick={() => {
                    ++navRevision.current;
                    onSelect(row.original);
                    scroll.current?.parentElement?.focus();
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onSelect(row.original);
                    const x = Math.min(event.clientX, window.innerWidth - 210);
                    const y = Math.min(event.clientY, window.innerHeight - 310);
                    setMenu({
                      x: Math.max(8, x),
                      y: Math.max(8, y),
                      entry: row.original,
                    });
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <div role="gridcell" key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  key={`loading-${item.index}`}
                  className="table-row placeholder"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {t("loading")}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {menu &&
        menuParts &&
        createPortal(
          <div
            className="req-context-menu"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {onQuickRepeat && (
              <button
                type="button"
                onClick={() => {
                  onQuickRepeat(menu.entry);
                  setMenu(null);
                }}
              >
                <Zap size={13} />
                {t("repeatOnceInMenu")}
              </button>
            )}
            {onReplay && (
              <button
                type="button"
                onClick={() => {
                  onReplay(menu.entry);
                  setMenu(null);
                }}
              >
                <Play size={13} />
                {t("replayInMenu")}
              </button>
            )}
            {onRepeatBatch && (
              <button
                type="button"
                onClick={() => {
                  onRepeatBatch(menu.entry);
                  setMenu(null);
                }}
              >
                <Repeat size={13} />
                {t("repeatAdvancedInMenu")}
              </button>
            )}
            {onPinToggle && (
              <button
                type="button"
                onClick={() => {
                  onPinToggle(menu.entry);
                  setMenu(null);
                }}
              >
                <Pin size={13} />
                {t(menu.entry.pinned ? "unpinRequest" : "pinRequest")}
              </button>
            )}
            {onLocateInStream && (
              <button
                type="button"
                onClick={() => {
                  onLocateInStream(menu.entry);
                  setMenu(null);
                }}
              >
                <Terminal size={13} />
                {t("locateInConsole")}
              </button>
            )}
            <div className="req-menu-sep" />
            {onCopyAction && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    onCopyAction(menu.entry, "url");
                    setMenu(null);
                  }}
                >
                  <Copy size={13} />
                  {t("copyUrl")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onCopyAction(menu.entry, "curl");
                    setMenu(null);
                  }}
                >
                  <TerminalSquare size={13} />
                  {t("copyCurl")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onCopyAction(menu.entry, "dio");
                    setMenu(null);
                  }}
                >
                  <Code2 size={13} />
                  {t("copyDartDio")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onCopyAction(menu.entry, "body");
                    setMenu(null);
                  }}
                >
                  <Copy size={13} />
                  {t("copyResponseBody")}
                </button>
              </>
            )}
            <div className="req-menu-sep" />
            {onFilterHost && menuParts.host && (
              <button
                type="button"
                onClick={() => {
                  onFilterHost(menuParts.host);
                  setMenu(null);
                }}
              >
                <FilterIcon size={13} />
                {t("onlyThisHost")} ({menuParts.host})
              </button>
            )}
            {onExcludePath && menuParts.pathname && (
              <button
                type="button"
                onClick={() => {
                  onExcludePath(menuParts.pathname);
                  setMenu(null);
                }}
              >
                <EyeOff size={13} />
                {t("hideThisPath")}
              </button>
            )}
            {(onSetCompareAnchor || onCompareWithAnchor) && (
              <>
                <div className="req-menu-sep" />
                {onSetCompareAnchor && (
                  <button
                    type="button"
                    onClick={() => {
                      onSetCompareAnchor(menu.entry);
                      setMenu(null);
                    }}
                  >
                    <GitCompareArrows size={13} />
                    {t("setCompareBaseline")}
                  </button>
                )}
                {onCompareWithAnchor &&
                  compareAnchor &&
                  compareAnchor.id !== menu.entry.id && (
                    <button
                      type="button"
                      onClick={() => {
                        onCompareWithAnchor(menu.entry);
                        setMenu(null);
                      }}
                    >
                      <GitCompareArrows size={13} />
                      {t("compareWithBaseline")}
                    </button>
                  )}
              </>
            )}
          </div>,
          document.body,
        )}

      {colMenuPos &&
        createPortal(
          <div
            className="col-config-menu"
            style={{ left: colMenuPos.x, top: colMenuPos.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="col-config-title">{t("tableColumns")}</div>
            {OPTIONAL_COLUMN_LABELS.map((col) => (
              <label key={col.id} className="col-config-item">
                <input
                  type="checkbox"
                  checked={tableLayout.visible[col.id]}
                  onChange={(e) =>
                    updateLayout((prev) => ({
                      ...prev,
                      visible: { ...prev.visible, [col.id]: e.target.checked },
                    }))
                  }
                />
                <span>{t(col.labelKey)}</span>
              </label>
            ))}
            <div className="req-menu-sep" />
            <button
              type="button"
              className="col-config-reset"
              onClick={() => {
                updateLayout(() => ({
                  widths: { ...DEFAULT_REQUEST_COLUMN_WIDTHS },
                  visible: { ...DEFAULT_OPTIONAL_COLUMNS },
                }));
                setColMenuPos(null);
              }}
            >
              <RotateCcw size={11} />
              {t("resetTableColumns")}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
