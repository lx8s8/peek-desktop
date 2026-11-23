import { useEffect, useMemo, useRef, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Code2,
  Copy,
  EyeOff,
  Filter as FilterIcon,
  GitCompareArrows,
  Pin,
  SearchX,
  Terminal,
  TerminalSquare,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/ipc/client";
import type {
  EntryRow,
  Filter,
  QueryPage,
  TimeRange,
} from "../../lib/ipc/types";
import { formatBytes } from "../../lib/preferences";

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
  selectedId,
  compareAnchor,
  onSelect,
  onCount,
  onHosts,
  onPinToggle,
  onFilterHost,
  onExcludePath,
  onLocateInStream,
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
  selectedId?: string;
  compareAnchor?: EntryRow | null;
  onSelect: (entry: EntryRow) => void;
  onCount: (count: number) => void;
  onHosts?: (hosts: string[]) => void;
  onPinToggle?: (entry: EntryRow) => void;
  onFilterHost?: (host: string) => void;
  onExcludePath?: (pattern: string) => void;
  onLocateInStream?: (entry: EntryRow) => void;
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
  const [failure, setFailure] = useState(false);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    entry: EntryRow;
  } | null>(null);

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
    setPage({ total: 0, offset: 0, rows: [], revision: 0 });
    setLoading(true);
    scroll.current?.scrollTo({ top: 0 });
    ++navRevision.current;
  }, [sessionId, search, filter, rangeKey, hostFilter, excludeKey]);

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
    setLoading(true);
    setFailure(false);
    const parsedRange = JSON.parse(rangeKey) as TimeRange;
    const parsedExcludes = JSON.parse(excludeKey) as string[];
    const hasExtra = !!(hostFilter || parsedExcludes.length > 0);
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
        setPage(result);
        onCount(result.total);
        if (result.hosts) onHosts?.(result.hosts);
        setLoading(false);
      })
      .catch((error) => {
        if (active) {
          setLoading(false);
          setFailure(true);
          onError(String(error));
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
    onCount,
    onHosts,
    onError,
  ]);

  const columns = useMemo<ColumnDef<EntryRow>[]>(
    () => [
      {
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
      {
        accessorKey: "durationMs",
        header: t("duration"),
        cell: (info) => {
          const ms = info.row.original.durationMs;
          if (ms === null) return <span className="num-cell muted">—</span>;
          const slow = ms >= 2500 ? "is-very-slow" : ms >= 800 ? "is-slow" : "";
          return (
            <span className={`num-cell ${slow}`}>{`${ms.toFixed(0)} ms`}</span>
          );
        },
      },
      {
        accessorKey: "responseBytes",
        header: t("size"),
        cell: (info) => (
          <span className="num-cell muted">
            {formatBytes(info.row.original.responseBytes)}
          </span>
        ),
      },
      {
        accessorKey: "startedAt",
        header: t("time"),
        cell: (info) => (
          <span className="num-cell muted" title={info.row.original.startedAt}>
            {new Date(info.row.original.startedAt).toLocaleTimeString(
              i18n.language,
              { hour12: false },
            )}
          </span>
        ),
      },
    ],
    [t, i18n.language, onPinToggle, compareAnchor?.id],
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
      const hasExtra = !!(hostFilter || parsedExcludes.length > 0);
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
          )
        : await api.query(sessionId, search, filter, next, 0, 1, parsedRange);
      if (request === navRevision.current && result.rows[0])
        onSelect(result.rows[0]);
    } catch (error) {
      onError(String(error));
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
      <div className="table-header table-grid" role="row">
        {table.getHeaderGroups()[0].headers.map((header) => (
          <div key={header.id} role="columnheader">
            {flexRender(header.column.columnDef.header, header.getContext())}
          </div>
        ))}
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
            <SearchX />
            <h2>
              {t(
                loading
                  ? "loading"
                  : search ||
                      filter !== "all" ||
                      hostFilter ||
                      (excludePatterns?.length ?? 0) > 0
                    ? "noMatches"
                    : "emptySession",
              )}
            </h2>
            {!loading && (
              <p>
                {t(
                  search ||
                    filter !== "all" ||
                    hostFilter ||
                    (excludePatterns?.length ?? 0) > 0
                    ? "noMatchesHint"
                    : live
                      ? "liveEmptyHint"
                      : "emptySessionHint",
                )}
              </p>
            )}
          </div>
        ) : (
          <div
            className="virtual-space"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {items.map((item) => {
              const row = table.getRowModel().rows[item.index - page.offset];
              return row ? (
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={item.index + 2}
                  aria-selected={row.id === selectedId}
                  className={`table-row table-grid ${row.id === selectedId ? "selected" : ""}${row.original.pinned ? " is-pinned-row" : ""}`}
                  style={{ transform: `translateY(${item.start}px)` }}
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

      {menu && menuParts && (
        <div
          className="req-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
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
        </div>
      )}
    </div>
  );
}
