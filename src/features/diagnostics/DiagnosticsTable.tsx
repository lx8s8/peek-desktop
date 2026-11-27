import { commands } from "../../lib/commands/dispatcher";
import { useCommand } from "../../lib/commands/react";
import { useContextMenu } from "../../lib/commands/native";
import { useDiagnosticActions } from "./actions";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  Copy,
  Download,
  MoreHorizontal,
  Pause,
  Play,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { api, desktop } from "../../lib/ipc/client";
import type {
  DiagnosticRef,
  DiagnosticRow,
  DiagnosticRun,
  ExceptionGroup,
  ReviewPage,
  TimeRange,
} from "../../lib/ipc/types";
import type { DiagnosticView } from "./view";
export type LogSelection = DiagnosticRef;
const emptyPage: ReviewPage = {
  total: 0,
  offset: 0,
  rows: [],
  groups: [],
  revision: 0,
  facets: { sources: [], tags: [], emitters: [], limited: false },
};

export function DiagnosticsTable({
  runs,
  exceptions,
  selected,
  selection,
  view,
  range,
  onViewChange,
  onSelect,
  onError,
}: {
  runs: DiagnosticRun[];
  exceptions: boolean;
  selected: LogSelection | null;
  selection: LogSelection[];
  view: DiagnosticView;
  range: TimeRange;
  onViewChange: (update: Partial<DiagnosticView>) => void;
  onSelect: (selection: LogSelection | null, all: LogSelection[]) => void;
  onError: (error: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const run = runs.find((item) => item.id === view.runId) ?? runs[0];
  const [search, setSearch] = useState(view.search);
  const [page, setPage] = useState(emptyPage);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const [focusedGroup, setFocusedGroup] = useState<ExceptionGroup | null>(null);
  const activeFacetCount = [view.source, view.tag, view.emitter].filter(
    Boolean,
  ).length;
  const [facetsOpen, setFacetsOpen] = useState(activeFacetCount > 0);
  const scroll = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const revision = useRef(0);
  const navigation = useRef(0);
  const anchor = useRef(0);
  const ignoreScroll = useRef(false);
  const pauseMark = useRef(run?.received ?? 0);
  const callbacks = useRef({ onViewChange, onSelect });
  callbacks.current = { onViewChange, onSelect };
  const grouped = exceptions && view.grouped && !view.fingerprint;
  const queryKey = JSON.stringify({
    search,
    level: view.level,
    source: view.source,
    tag: view.tag,
    emitter: view.emitter,
    exceptions,
    grouped,
    fingerprint: view.fingerprint,
    range,
  });
  const query = JSON.parse(queryKey);
  const previousCriteria = useRef(`${run?.id}:${queryKey}`);
  const virtualizer = useVirtualizer({
    count: page.total,
    getScrollElement: () => scroll.current,
    estimateSize: () => 36,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const start = items[0]?.index ?? 0;
  const selectedIds = new Set(
    selection
      .filter((item) => item.runId === run?.id)
      .map((item) => item.eventId),
  );
  useEffect(() => {
    const timer = setTimeout(() => setSearch(view.search), 180);
    return () => clearTimeout(timer);
  }, [view.search]);
  useEffect(() => {
    ++navigation.current;
    setOffset(0);
    setPage(emptyPage);
    setFocusedGroup(null);
    setNotice("");
    const criteria = `${run?.id}:${queryKey}`;
    if (
      previousCriteria.current !== criteria ||
      (selected?.runId && selected.runId !== run?.id)
    )
      callbacks.current.onSelect(null, []);
    previousCriteria.current = criteria;
    scroll.current?.scrollTo({ top: 0 });
  }, [run?.id, queryKey]);
  useEffect(
    () => setOffset(Math.max(0, Math.floor(start / 100) * 100 - 100)),
    [start],
  );
  useEffect(() => {
    if (!run) {
      setLoading(false);
      setPage(emptyPage);
      return;
    }
    const request = ++revision.current;
    let active = true;
    setLoading(true);
    setFailed(false);
    void api
      .review(run.id, {
        ...JSON.parse(queryKey),
        offset,
        limit: 300,
        revision: request,
      })
      .then((result) => {
        if (
          active &&
          request === revision.current &&
          result.revision === request
        ) {
          setPage(result);
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
  }, [run?.id, run?.version, queryKey, offset, retry, onError]);
  useLayoutEffect(() => {
    if (!view.following || grouped || !page.total) return;
    ignoreScroll.current = true;
    virtualizer.scrollToIndex(page.total - 1, { align: "end" });
    const timer = setTimeout(() => {
      ignoreScroll.current = false;
    }, 100);
    return () => clearTimeout(timer);
  }, [page.total, view.following, grouped, virtualizer]);
  useEffect(() => {
    if (view.following) pauseMark.current = run?.received ?? 0;
  }, [view.following, run?.received, run?.id]);
  useEffect(
    () => () => {
      ++navigation.current;
    },
    [],
  );
  function pause() {
    if (view.following && !grouped) {
      pauseMark.current = run?.received ?? 0;
      onViewChange({ following: false });
    }
  }
  useDiagnosticActions(selection, setNotice, onError, !grouped);
  useCommand(
    "view.follow",
    () => {
      pauseMark.current = run?.received ?? 0;
      onViewChange({ following: !view.following });
    },
    !!run && !grouped,
  );
  useCommand(
    "edit.selectWindow",
    selectWindow,
    !!run && !grouped && page.rows.length > 0,
  );
  useCommand(
    "edit.clearSelection",
    () => {
      onSelect(null, []);
      setFocusedGroup(null);
    },
    selection.length > 0 || !!focusedGroup,
  );
  const contextMenu = useContextMenu(
    [
      "edit.copyMessage",
      "edit.copyStack",
      "edit.copyRaw",
      "diagnostics.export",
      "edit.selectWindow",
      "edit.clearSelection",
    ],
    onError,
  );
  function select(row: DiagnosticRow, index: number, toggle = false) {
    const item = { runId: run!.id, eventId: row.eventId };
    anchor.current = index;
    const all = toggle
      ? selectedIds.has(row.eventId)
        ? selection.filter(
            (value) => value.eventId !== row.eventId || value.runId !== run!.id,
          )
        : [...selection, item]
      : [item];
    if (all.length > 300) {
      onError("invalidSelection");
      return;
    }
    onSelect(
      all.some((value) => value.eventId === row.eventId)
        ? item
        : (all[all.length - 1] ?? null),
      all,
    );
    grid.current?.focus();
  }
  async function selectRange(index: number) {
    const first = Math.min(anchor.current, index),
      count = Math.abs(anchor.current - index) + 1;
    if (count > 300) {
      onError("invalidSelection");
      return;
    }
    const request = ++navigation.current;
    try {
      const result = await api.review(run!.id, {
        ...query,
        offset: first,
        limit: count,
        revision: 0,
      });
      if (request !== navigation.current) return;
      const all = result.rows.map((row) => ({
        runId: run!.id,
        eventId: row.eventId,
      }));
      onSelect(all[index - first] ?? null, all);
    } catch (error) {
      onError(String(error));
    }
  }
  async function move(delta: number, absolute?: number, extend = false) {
    if (!run || !page.total) return;
    pause();
    const local = grouped
      ? page.groups.findIndex(
          (group) => group.fingerprint === focusedGroup?.fingerprint,
        )
      : page.rows.findIndex((row) => row.eventId === selected?.eventId);
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
      const result = await api.review(run.id, {
        ...query,
        offset: next,
        limit: 1,
        revision: 0,
      });
      if (request !== navigation.current) return;
      if (grouped) {
        setFocusedGroup(result.groups[0] ?? null);
      } else if (result.rows[0]) {
        if (extend) await selectRange(next);
        else select(result.rows[0], next);
      }
    } catch (error) {
      onError(String(error));
    }
  }
  function selectWindow() {
    const all = page.rows.map((row) => ({
      runId: run!.id,
      eventId: row.eventId,
    }));
    onSelect(all[0] ?? null, all);
  }
  if (!run)
    return (
      <div className="table-empty diagnostic-empty">
        <h2>{t("noDiagnosticSdk")}</h2>
        <p>{t("noDiagnosticSdkHint")}</p>
      </div>
    );
  const newEventsCount =
    !view.following && run.received > pauseMark.current
      ? run.received - pauseMark.current
      : 0;
  return (
    <div className="diagnostics-console">
      <div className="diagnostic-filters">
        <div className="diagnostic-search-row">
          {runs.length > 1 && (
            <select
              className="filter-select diagnostic-run-select"
              aria-label={t("diagnosticRun")}
              value={run.id}
              onChange={(event) =>
                onViewChange({ runId: event.target.value, fingerprint: null })
              }
            >
              {runs.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.runId} · {t(item.online ? "connected" : "disconnected")}
                </option>
              ))}
            </select>
          )}
          <label className="search-field diagnostic-search-field">
            <Search size={13} aria-hidden="true" />
            <input
              data-search
              aria-label={t("diagnosticSearch")}
              placeholder={t("diagnosticSearch")}
              value={view.search}
              onChange={(event) => onViewChange({ search: event.target.value })}
            />
            {view.search && (
              <button
                type="button"
                aria-label={t("dismiss")}
                onClick={() => onViewChange({ search: "" })}
              >
                <X size={12} />
              </button>
            )}
          </label>
          <select
            className={`filter-select${view.level !== "all" ? " is-active" : ""}`}
            aria-label={t("level")}
            value={view.level}
            onChange={(event) => onViewChange({ level: event.target.value })}
          >
            {[
              "all",
              "verbose",
              "debug",
              "info",
              "warning",
              "error",
              "critical",
            ].map((level) => (
              <option key={level} value={level}>
                {t(level === "all" ? "all" : `level_${level}`)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`filter-pill-btn${facetsOpen || activeFacetCount > 0 ? " is-active" : ""}`}
            aria-expanded={facetsOpen}
            onClick={() => setFacetsOpen((value) => !value)}
          >
            <SlidersHorizontal size={11} aria-hidden="true" />
            <span>{t("advancedFilters")}</span>
            {activeFacetCount > 0 && (
              <span className="filter-pill-badge">{activeFacetCount}</span>
            )}
          </button>
        </div>

        {facetsOpen && (
          <div className="diagnostic-facets-row">
            <div className="facet-filters">
              {(
                [
                  ["source", "sources", "allSources"],
                  ["tag", "tags", "allTags"],
                  ["emitter", "emitters", "allEmitters"],
                ] as const
              ).map(([field, facet, label]) => (
                <select
                  key={field}
                  className={`filter-select${view[field] ? " is-active" : ""}`}
                  aria-label={t(field)}
                  value={view[field]}
                  onChange={(event) =>
                    onViewChange({ [field]: event.target.value })
                  }
                >
                  <option value="">{t(label)}</option>
                  {view[field] && !page.facets[facet].includes(view[field]) && (
                    <option value={view[field]}>{view[field]}</option>
                  )}
                  {page.facets[facet].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              ))}
            </div>
            {page.facets.limited && (
              <small className="muted">{t("facetLimit")}</small>
            )}
          </div>
        )}

        <div className="diagnostic-controls-row">
          <div className="diagnostic-controls-left">
            {exceptions && (
              <label className="stream-toggle" title={t("groupWindow")}>
                <input
                  type="checkbox"
                  checked={view.grouped}
                  onChange={(event) =>
                    onViewChange({
                      grouped: event.target.checked,
                      fingerprint: null,
                    })
                  }
                />
                <span>{t("groupedExceptions")}</span>
              </label>
            )}
            {view.fingerprint && (
              <Button
                size="sm"
                onClick={() => onViewChange({ fingerprint: null })}
              >
                {t("backToGroups")}
              </Button>
            )}
            {!grouped && (
              <div className="diagnostic-selection-bar">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => commands.dispatch("edit.copyMessage")}
                  disabled={!selection.length}
                >
                  <Copy size={11} aria-hidden="true" />
                  {t("copyMessage")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => commands.dispatch("diagnostics.export")}
                  disabled={!desktop || !selection.length}
                >
                  <Download size={11} aria-hidden="true" />
                  {t("exportSelected")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => commands.dispatch("edit.selectWindow")}
                  disabled={!page.rows.length}
                >
                  {t("selectWindow")}
                </Button>
                <span className="diagnostic-selected-count">
                  {t("selectedCount", { count: selection.length })}
                </span>
                {desktop && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-haspopup="menu"
                    onClick={contextMenu}
                  >
                    <MoreHorizontal size={12} aria-hidden="true" />
                    {t("menuActions")}
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="diagnostic-controls-right">
            {!grouped && (
              <Button
                size="sm"
                aria-pressed={view.following}
                className={view.following ? "is-following" : ""}
                onClick={() => commands.dispatch("view.follow")}
              >
                {view.following ? <Pause size={12} /> : <Play size={12} />}
                {t(view.following ? "pauseFollow" : "followLatest")}
                {newEventsCount > 0
                  ? ` · ${t("newEvents", { count: newEventsCount })}`
                  : ""}
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
      <div
        className="diagnostic-table"
        data-select-window-grid
        ref={grid}
        role="grid"
        aria-label={t(exceptions ? "exceptions" : "logs")}
        aria-multiselectable={!grouped}
        aria-rowcount={page.total + 1}
        tabIndex={0}
        onContextMenu={contextMenu}
        onKeyDown={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "a" &&
            !grouped
          ) {
            event.preventDefault();
            commands.dispatch("edit.selectWindow");
          } else if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "c" &&
            !grouped &&
            selection.length
          ) {
            event.preventDefault();
            commands.dispatch("edit.copyMessage");
          } else if (
            event.key === "Escape" ||
            event.key === "Delete" ||
            event.key === "Backspace"
          ) {
            event.preventDefault();
            onSelect(null, []);
            setFocusedGroup(null);
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            void move(
              event.key === "ArrowDown" ? 1 : -1,
              undefined,
              event.shiftKey,
            );
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            void move(
              0,
              event.key === "Home" ? 0 : page.total - 1,
              event.shiftKey,
            );
          } else if (event.key === "PageDown" || event.key === "PageUp") {
            event.preventDefault();
            void move(
              (event.key === "PageDown" ? 1 : -1) *
                Math.max(
                  1,
                  Math.floor((scroll.current?.clientHeight ?? 300) / 36),
                ),
              undefined,
              event.shiftKey,
            );
          } else if (event.key === "Enter" && grouped && focusedGroup) {
            onViewChange({ fingerprint: focusedGroup.fingerprint });
          }
        }}
      >
        <div
          className={`diagnostic-grid ${grouped ? "group-grid" : ""} table-header`}
          role="row"
        >
          {(grouped
            ? [
                "exceptionType",
                "message",
                "retainedOccurrences",
                "firstOccurrence",
                "lastOccurrence",
              ]
            : ["time", "level", "message", "source"]
          ).map((key) => (
            <div role="columnheader" key={key}>
              {t(key)}
            </div>
          ))}
        </div>
        <div className="diagnostic-viewport-wrap">
          <div
            className="table-scroll"
            ref={scroll}
            aria-busy={loading}
            onWheel={(event) => {
              if (event.deltaY < 0) pause();
            }}
            onScroll={() => {
              const element = scroll.current;
              if (
                element &&
                view.following &&
                !ignoreScroll.current &&
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight >
                  72
              )
                pause();
            }}
          >
            {failed ? (
              <div className="table-empty">
                <Button onClick={() => setRetry((value) => value + 1)}>
                  {t("retry")}
                </Button>
              </div>
            ) : page.total === 0 ? (
              <div className="table-empty">
                <h2>{t(loading ? "loading" : "noLogs")}</h2>
                <p>{!loading && t("noLogsHint")}</p>
              </div>
            ) : (
              <div
                className="virtual-space"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {items.map((item) => {
                  if (grouped) {
                    const group = page.groups[item.index - page.offset];
                    return group ? (
                      <button
                        role="row"
                        tabIndex={-1}
                        key={group.fingerprint}
                        className={`table-row diagnostic-grid group-grid ${group.fingerprint === focusedGroup?.fingerprint ? "selected" : ""}`}
                        aria-selected={
                          group.fingerprint === focusedGroup?.fingerprint
                        }
                        style={{ transform: `translateY(${item.start}px)` }}
                        onClick={() =>
                          onViewChange({ fingerprint: group.fingerprint })
                        }
                      >
                        <span role="gridcell">{group.exceptionType}</span>
                        <span role="gridcell" title={group.message}>
                          {group.message}
                        </span>
                        <span role="gridcell">{group.count}</span>
                        <span role="gridcell" title={group.firstAt}>
                          {new Date(group.firstAt).toLocaleTimeString(
                            i18n.language,
                            { hour12: false },
                          )}
                        </span>
                        <span
                          role="gridcell"
                          title={`${t("firstOccurrence")}: ${group.firstAt}\n${t("lastOccurrence")}: ${group.lastAt}`}
                        >
                          {new Date(group.lastAt).toLocaleTimeString(
                            i18n.language,
                            { hour12: false },
                          )}
                        </span>
                      </button>
                    ) : null;
                  }
                  const row = page.rows[item.index - page.offset];
                  return row ? (
                    <button
                      key={row.eventId}
                      role="row"
                      tabIndex={-1}
                      aria-rowindex={item.index + 2}
                      aria-selected={selectedIds.has(row.eventId)}
                      className={`table-row diagnostic-grid ${selectedIds.has(row.eventId) ? "selected" : ""}`}
                      style={{ transform: `translateY(${item.start}px)` }}
                      onContextMenu={() => {
                        if (!selectedIds.has(row.eventId))
                          select(row, item.index);
                      }}
                      onClick={(event) => {
                        ++navigation.current;
                        pause();
                        if (event.shiftKey) void selectRange(item.index);
                        else
                          select(
                            row,
                            item.index,
                            event.metaKey || event.ctrlKey,
                          );
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
                        title={t(`level_${row.level}`)}
                      >
                        {row.level.toUpperCase()}
                      </span>
                      <span role="gridcell" title={row.message}>
                        {row.truncated && (
                          <span title={t("truncatedEvent")}>† </span>
                        )}
                        {row.message}
                      </span>
                      <span
                        role="gridcell"
                        title={[row.source, row.tag, row.emitterId]
                          .filter(Boolean)
                          .join(" · ")}
                      >
                        {[row.source, row.tag].filter(Boolean).join(" · ")}
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
          {!view.following && !grouped && page.total > 0 && (
            <button
              type="button"
              className="stream-jump-fab"
              onClick={() => commands.dispatch("view.follow")}
            >
              <ArrowDown size={13} aria-hidden="true" />
              <span>
                {newEventsCount > 0
                  ? `${t("streamJumpLatest")} (+${newEventsCount})`
                  : t("streamJumpLatest")}
              </span>
            </button>
          )}
        </div>
      </div>
      <div className="diagnostic-stats diagnostic-footer">
        <span>
          {t("retainedLogs", { count: run.count })} ·{" "}
          {t(run.online ? "connected" : "disconnected")} · {page.total}{" "}
          {t("matches")}
        </span>
        {!view.following && !grouped && (
          <span className="diagnostic-paused-note">{t("pausedHint")}</span>
        )}
        <span className="diagnostic-stats-right">
          {t("diagnosticStats", {
            received: run.received,
            duplicates: run.duplicates,
            evicted: run.evicted,
            gaps: run.gapCount,
          })}
        </span>
        {run.gaps.length > 0 && (
          <details>
            <summary>{t("recentGaps")}</summary>
            {run.gaps.map((gap, index) => (
              <code key={index}>
                {gap.emitterId}: {gap.fromSequence}–{gap.toSequence} (
                {gap.reason})
              </code>
            ))}
          </details>
        )}
      </div>
    </div>
  );
}
