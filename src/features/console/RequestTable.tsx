import { useEffect, useMemo, useRef, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SearchX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/ipc/client";
import type {
  EntryRow,
  Filter,
  QueryPage,
  TimeRange,
} from "../../lib/ipc/types";
import { formatBytes } from "../../lib/preferences";

export function RequestTable({
  sessionId,
  version,
  live,
  search,
  filter,
  range,
  selectedId,
  onSelect,
  onCount,
  onError,
}: {
  sessionId: string;
  version?: number;
  live?: boolean;
  search: string;
  filter: Filter;
  range?: TimeRange;
  selectedId?: string;
  onSelect: (entry: EntryRow) => void;
  onCount: (count: number) => void;
  onError: (error: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const rangeKey = JSON.stringify(range ?? {});
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
  const virtualizer = useVirtualizer({
    count: page.total,
    getScrollElement: () => scroll.current,
    estimateSize: () => 30,
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
  }, [sessionId, search, filter, rangeKey]);
  useEffect(() => {
    setOffset(Math.max(0, Math.floor(start / 100) * 100 - 100));
  }, [start]);
  useEffect(() => {
    const request = ++revision.current;
    let active = true;
    setLoading(true);
    setFailure(false);
    void api
      .query(
        sessionId,
        search,
        filter,
        offset,
        request,
        300,
        JSON.parse(rangeKey),
      )
      .then((result) => {
        if (
          !active ||
          request !== revision.current ||
          result.revision !== request
        )
          return;
        setPage(result);
        onCount(result.total);
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
    onCount,
    onError,
  ]);

  const columns = useMemo<ColumnDef<EntryRow>[]>(
    () => [
      {
        accessorKey: "method",
        header: t("method"),
        cell: (info) => (
          <span
            className={`method method-${info.row.original.method.toLowerCase()}`}
          >
            {String(info.getValue())}
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: t("status"),
        cell: (info) => (
          <span
            className={`status status-${info.row.original.state} ${Number(info.getValue()) >= 400 ? "status-failed" : ""}`}
          >
            {info.row.original.status ??
              (info.row.original.state === "pending" ? "…" : "ERR")}
          </span>
        ),
      },
      {
        accessorKey: "url",
        header: t("url"),
        cell: (info) => (
          <span className="url-text" title={info.row.original.url}>
            {info.row.original.url}
          </span>
        ),
      },
      {
        accessorKey: "durationMs",
        header: t("duration"),
        cell: (info) =>
          info.row.original.durationMs === null
            ? "—"
            : `${info.row.original.durationMs.toFixed(0)} ms`,
      },
      {
        accessorKey: "responseBytes",
        header: t("size"),
        cell: (info) => formatBytes(info.row.original.responseBytes),
      },
      {
        accessorKey: "startedAt",
        header: t("time"),
        cell: (info) => (
          <span title={info.row.original.startedAt}>
            {new Date(info.row.original.startedAt).toLocaleTimeString(
              i18n.language,
              { hour12: false },
            )}
          </span>
        ),
      },
    ],
    [t, i18n.language],
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
      const result = await api.query(
        sessionId,
        search,
        filter,
        next,
        0,
        1,
        JSON.parse(rangeKey),
      );
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
            Math.floor((scroll.current?.clientHeight ?? 300) / 30),
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
                  : search || filter !== "all"
                    ? "noMatches"
                    : "emptySession",
              )}
            </h2>
            {!loading && (
              <p>
                {t(
                  search || filter !== "all"
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
                  className={`table-row table-grid ${row.id === selectedId ? "selected" : ""}`}
                  style={{ transform: `translateY(${item.start}px)` }}
                  onClick={() => {
                    ++navRevision.current;
                    onSelect(row.original);
                    scroll.current?.parentElement?.focus();
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
    </div>
  );
}
