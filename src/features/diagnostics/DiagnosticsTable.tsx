import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/ipc/client";
import type { DiagnosticPage, DiagnosticRun } from "../../lib/ipc/types";

export interface LogSelection {
  runId: string;
  eventId: string;
}
export function DiagnosticsTable({
  runs,
  exceptions,
  selected,
  onSelect,
  onError,
}: {
  runs: DiagnosticRun[];
  exceptions: boolean;
  selected: LogSelection | null;
  onSelect: (selection: LogSelection) => void;
  onError: (error: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [runId, setRunId] = useState(runs[0]?.id ?? "");
  const run = runs.find((item) => item.id === runId) ?? runs[0];
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("all");
  const [page, setPage] = useState<DiagnosticPage>({
    total: 0,
    offset: 0,
    rows: [],
    revision: 0,
  });
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const revision = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: page.total,
    getScrollElement: () => scroll.current,
    estimateSize: () => 36,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const start = items[0]?.index ?? 0;
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 180);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    setOffset(0);
    setPage({ total: 0, offset: 0, rows: [], revision: 0 });
    scroll.current?.scrollTo({ top: 0 });
  }, [run?.id, query, level, exceptions]);
  useEffect(
    () => setOffset(Math.max(0, Math.floor(start / 100) * 100 - 100)),
    [start],
  );
  useEffect(() => {
    if (!run) return;
    const request = ++revision.current;
    let active = true;
    setLoading(true);
    setFailed(false);
    void api
      .diagnostics(run.id, query, level, exceptions, offset, request)
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
  }, [run?.id, run?.version, query, level, exceptions, offset, retry, onError]);
  if (!run)
    return (
      <div className="table-empty diagnostic-empty">
        <h2>{t("noDiagnosticSdk")}</h2>
        <p>{t("noDiagnosticSdkHint")}</p>
      </div>
    );
  return (
    <div className="diagnostics-console">
      <div className="diagnostic-filters">
        <select
          aria-label={t("diagnosticRun")}
          value={run.id}
          onChange={(e) => setRunId(e.target.value)}
        >
          {runs.map((item) => (
            <option key={item.id} value={item.id}>
              {item.runId} · {t(item.online ? "connected" : "disconnected")}
            </option>
          ))}
        </select>
        <div>
          <input
            aria-label={t("diagnosticSearch")}
            placeholder={t("diagnosticSearch")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            aria-label={t("level")}
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          >
            {[
              "all",
              "verbose",
              "debug",
              "info",
              "warning",
              "error",
              "critical",
            ].map((value) => (
              <option key={value} value={value}>
                {value === "all" ? t("all") : value.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div
        className="diagnostic-table"
        role="grid"
        aria-label={t(exceptions ? "exceptions" : "logs")}
        aria-rowcount={page.total + 1}
      >
        <div className="diagnostic-grid table-header" role="row">
          {["time", "level", "message", "source"].map((key) => (
            <div role="columnheader" key={key}>
              {t(key)}
            </div>
          ))}
        </div>
        <div className="table-scroll" ref={scroll} aria-busy={loading}>
          {failed ? (
            <div className="table-empty">
              <button onClick={() => setRetry((value) => value + 1)}>
                {t("retry")}
              </button>
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
                const row = page.rows[item.index - page.offset];
                return row ? (
                  <button
                    key={row.eventId}
                    role="row"
                    aria-rowindex={item.index + 2}
                    aria-selected={
                      selected?.runId === run.id &&
                      selected.eventId === row.eventId
                    }
                    className={`table-row diagnostic-grid ${selected?.runId === run.id && selected.eventId === row.eventId ? "selected" : ""}`}
                    style={{ transform: `translateY(${item.start}px)` }}
                    onClick={() =>
                      onSelect({ runId: run.id, eventId: row.eventId })
                    }
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
                      {row.level.toUpperCase()}
                    </span>
                    <span role="gridcell" title={row.message}>
                      {row.message}
                    </span>
                    <span role="gridcell">
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
      </div>
      <div className="diagnostic-stats">
        <span>
          {t("retainedLogs", { count: run.count })} ·{" "}
          {t(run.online ? "connected" : "disconnected")}
        </span>
        <span>
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
