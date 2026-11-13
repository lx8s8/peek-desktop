import { commands } from "../../lib/commands/dispatcher";
import { useCommand } from "../../lib/commands/react";
import { useContextMenu } from "../../lib/commands/native";
import { useDiagnosticActions } from "../diagnostics/actions";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { api, desktop } from "../../lib/ipc/client";
import type {
  Scope,
  TimelinePage,
  TimelineRow,
  TimeRange,
} from "../../lib/ipc/types";
export interface TimelineView {
  search: string;
  following: boolean;
}
const emptyPage: TimelinePage = { total: 0, offset: 0, revision: 0, rows: [] };
export function TimelineTable({
  scope,
  version,
  range,
  view,
  selected,
  networkOnly,
  onViewChange,
  onSelect,
  onError,
}: {
  scope: Scope;
  version: string;
  range: TimeRange;
  view: TimelineView;
  selected: TimelineRow | null;
  networkOnly?: boolean;
  onViewChange: (update: Partial<TimelineView>) => void;
  onSelect: (row: TimelineRow | null) => void;
  onError: (error: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState(view.search);
  const [page, setPage] = useState(emptyPage);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const selectedDiagnostics =
    selected?.runId && selected.eventId
      ? [{ runId: selected.runId, eventId: selected.eventId }]
      : [];
  useDiagnosticActions(selectedDiagnostics, setNotice, onError);
  useCommand("view.follow", () => onViewChange({ following: !view.following }));
  useCommand("edit.clearSelection", () => onSelect(null), !!selected);
  const contextMenu = useContextMenu(
    [
      "edit.copyMessage",
      "edit.copyStack",
      "edit.copyRaw",
      "diagnostics.export",
      "edit.clearSelection",
    ],
    onError,
  );
  const scroll = useRef<HTMLDivElement>(null),
    grid = useRef<HTMLDivElement>(null);
  const revision = useRef(0),
    navigation = useRef(0),
    ignoreScroll = useRef(false);
  const criteria = JSON.stringify({ scope, range, search });
  const previous = useRef(criteria);
  const select = useRef(onSelect);
  select.current = onSelect;
  const virtualizer = useVirtualizer({
    count: page.total,
    getScrollElement: () => scroll.current,
    estimateSize: () => 36,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const start = items[0]?.index ?? 0;
  useEffect(() => {
    const timer = setTimeout(() => setSearch(view.search), 180);
    return () => clearTimeout(timer);
  }, [view.search]);
  useEffect(() => {
    ++navigation.current;
    setOffset(0);
    setPage(emptyPage);
    scroll.current?.scrollTo({ top: 0 });
    if (previous.current !== criteria) select.current(null);
    previous.current = criteria;
  }, [criteria]);
  useEffect(
    () => setOffset(Math.max(0, Math.floor(start / 100) * 100 - 100)),
    [start],
  );
  useEffect(() => {
    const request = ++revision.current;
    let active = true;
    setLoading(true);
    setFailed(false);
    const { scope, range, search } = JSON.parse(criteria);
    void api
      .timeline(scope, { search, range, offset, limit: 300, revision: request })
      .then((page) => {
        if (
          active &&
          request === revision.current &&
          page.revision === request
        ) {
          setPage(page);
          setLoading(false);
        }
      })
      .catch((error) => {
        if (active) {
          setLoading(false);
          setFailed(true);
          onError(String(error));
        }
      });
    return () => {
      active = false;
    };
  }, [criteria, version, offset, retry, onError]);
  useLayoutEffect(() => {
    if (!view.following || !page.total) return;
    ignoreScroll.current = true;
    virtualizer.scrollToIndex(page.total - 1, { align: "end" });
    const timer = setTimeout(() => {
      ignoreScroll.current = false;
    }, 100);
    return () => clearTimeout(timer);
  }, [view.following, page.total, virtualizer]);
  useEffect(
    () => () => {
      ++navigation.current;
    },
    [],
  );
  async function move(delta: number, absolute?: number) {
    if (!page.total) return;
    onViewChange({ following: false });
    const local = page.rows.findIndex((row) => row.id === selected?.id);
    const next = Math.max(
      0,
      Math.min(
        page.total - 1,
        absolute ?? (local < 0 ? start : page.offset + local + delta),
      ),
    );
    const request = ++navigation.current;
    virtualizer.scrollToIndex(next, { align: "auto" });
    try {
      const { scope, range, search } = JSON.parse(criteria);
      const result = await api.timeline(scope, {
        search,
        range,
        offset: next,
        limit: 1,
        revision: 0,
      });
      if (request === navigation.current && result.rows[0])
        onSelect(result.rows[0]);
    } catch (error) {
      onError(String(error));
    }
  }
  return (
    <div className="timeline-console">
      <div className="diagnostic-filters">
        <div>
          <input
            data-search
            aria-label={t("timelineSearch")}
            placeholder={t("timelineSearch")}
            value={view.search}
            onChange={(event) => onViewChange({ search: event.target.value })}
          />
          <Button
            aria-pressed={view.following}
            onClick={() => commands.dispatch("view.follow")}
          >
            {t(view.following ? "pauseFollow" : "followLatest")}
          </Button>
          {desktop && (
            <Button aria-haspopup="menu" onClick={contextMenu}>
              {t("menuActions")}
            </Button>
          )}
        </div>
      </div>
      {notice && (
        <div role="status" className="inline-note">
          {notice}
        </div>
      )}
      <div className="inline-note">
        {t("wallClockHint")}
        {networkOnly && <> {t("timelineNetworkOnly")}</>}
      </div>
      <div
        className="diagnostic-table"
        role="grid"
        aria-label={t("timeline")}
        aria-rowcount={page.total + 1}
        ref={grid}
        onContextMenu={contextMenu}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            void move(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            void move(0, event.key === "Home" ? 0 : page.total - 1);
          } else if (event.key === "PageDown" || event.key === "PageUp") {
            event.preventDefault();
            void move(
              (event.key === "PageDown" ? 1 : -1) *
                Math.max(
                  1,
                  Math.floor((scroll.current?.clientHeight ?? 300) / 36),
                ),
            );
          } else if (event.key === "Escape" || event.key === "Delete") {
            event.preventDefault();
            commands.dispatch("edit.clearSelection");
          }
        }}
      >
        <div className="timeline-grid table-header" role="row">
          {["time", "eventKind", "message", "association"].map((key) => (
            <span role="columnheader" key={key}>
              {t(key)}
            </span>
          ))}
        </div>
        <div
          className="table-scroll"
          ref={scroll}
          aria-busy={loading}
          onWheel={(event) => {
            if (event.deltaY < 0) onViewChange({ following: false });
          }}
          onScroll={() => {
            const element = scroll.current;
            if (
              element &&
              view.following &&
              !ignoreScroll.current &&
              element.scrollHeight - element.scrollTop - element.clientHeight >
                72
            )
              onViewChange({ following: false });
          }}
        >
          {failed ? (
            <div className="table-empty">
              <Button onClick={() => setRetry((value) => value + 1)}>
                {t("retry")}
              </Button>
            </div>
          ) : !page.total ? (
            <div className="table-empty">
              <h2>{t(loading ? "loading" : "timelineEmpty")}</h2>
            </div>
          ) : (
            <div
              className="virtual-space"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {items.map((item) => {
                const row = page.rows[item.index - page.offset];
                return row ? (
                  <button
                    key={row.id}
                    role="row"
                    tabIndex={-1}
                    aria-rowindex={item.index + 2}
                    aria-selected={row.id === selected?.id}
                    className={`table-row timeline-grid ${row.id === selected?.id ? "selected" : ""}`}
                    style={{ transform: `translateY(${item.start}px)` }}
                    onContextMenu={() => {
                      if (row.id !== selected?.id) onSelect(row);
                    }}
                    onClick={() => {
                      ++navigation.current;
                      onViewChange({ following: false });
                      onSelect(row);
                      grid.current?.focus();
                    }}
                  >
                    <span role="gridcell" title={row.occurredAt}>
                      {new Date(row.occurredAt).toLocaleTimeString(
                        i18n.language,
                        { hour12: false },
                      )}
                    </span>
                    <span
                      role="gridcell"
                      className={`log-level level-${row.level}`}
                    >
                      {t(
                        row.kind === "network"
                          ? "network"
                          : row.kind === "exception"
                            ? "exceptions"
                            : "logs",
                      )}
                    </span>
                    <span
                      role="gridcell"
                      title={`${row.message}\n${row.source}`}
                    >
                      {row.message}
                    </span>
                    <span
                      role="gridcell"
                      className={`association-${row.association}`}
                      title={t("wallClockHint")}
                    >
                      {t(`association_${row.association}`)}
                    </span>
                  </button>
                ) : (
                  <div
                    key={item.index}
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
      <div className="diagnostic-stats">
        {page.total.toLocaleString()} {t("timelineEvents")} ·{" "}
        {t("retainedWindow")}
        {!view.following && <span>{t("pausedHint")}</span>}
      </div>
    </div>
  );
}
