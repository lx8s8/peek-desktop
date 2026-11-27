import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  ExternalLink,
  Filter,
  Search,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { api } from "../../lib/ipc/client";
import type {
  BizErrorRule,
  EndpointStatRow,
  EndpointStatsReport,
  TimeRange,
} from "../../lib/ipc/types";
import { formatBytes } from "../../lib/preferences";

type StatSortKey = "count" | "p95Ms" | "errorCount" | "totalBytes";

export interface EndpointStatsDialogProps {
  sessionId: string;
  sessionLabel: string;
  range: TimeRange;
  afterSeq: number | null;
  bizErrorRule: BizErrorRule;
  onFilterEndpoint: (pathKeyword: string, host: string) => void;
  onInspectSample: (entryId: string) => void;
  onClose: () => void;
}

/** 当前会话的接口聚合统计面板：定位重复刷接口、慢接口与报错热点（原生 modal dialog）。 */
export function EndpointStatsDialog({
  sessionId,
  sessionLabel,
  range,
  afterSeq,
  bizErrorRule,
  onFilterEndpoint,
  onInspectSample,
  onClose,
}: EndpointStatsDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [report, setReport] = useState<EndpointStatsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<StatSortKey>("count");

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (typeof el.showModal === "function") {
      if (!el.open) el.showModal();
    } else {
      el.setAttribute("open", "");
    }
    const handleClose = () => {
      el.returnValue = "";
      onClose();
    };
    el.addEventListener("close", handleClose);

    let pressedOutside = false;
    const isOutside = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) {
        if (typeof el.close === "function") el.close();
        else onClose();
      }
      pressedOutside = false;
    };
    const supportsClosedBy =
      typeof HTMLDialogElement !== "undefined" &&
      "closedBy" in HTMLDialogElement.prototype;
    if (!supportsClosedBy) {
      el.addEventListener("pointerdown", onPointerDown);
      el.addEventListener("pointerup", onPointerUp);
    }

    return () => {
      el.removeEventListener("close", handleClose);
      if (!supportsClosedBy) {
        el.removeEventListener("pointerdown", onPointerDown);
        el.removeEventListener("pointerup", onPointerUp);
      }
    };
  }, [onClose]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api
      .endpointStats(sessionId, range, afterSeq, bizErrorRule)
      .then((res) => {
        if (!active) return;
        setReport(res);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setError(String(err));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId, range, afterSeq, bizErrorRule]);

  const rows = useMemo<EndpointStatRow[]>(() => {
    if (!report) return [];
    const needle = search.trim().toLowerCase();
    const list = needle
      ? report.endpoints.filter(
          (row) =>
            row.normalizedPath.toLowerCase().includes(needle) ||
            row.host.toLowerCase().includes(needle) ||
            row.method.toLowerCase().includes(needle),
        )
      : [...report.endpoints];
    list.sort((a, b) => {
      const diff = b[sortKey] - a[sortKey];
      if (diff !== 0) return diff;
      return b.count - a.count;
    });
    return list;
  }, [report, search, sortKey]);

  const closeDialog = () => {
    const el = dialogRef.current;
    if (el && typeof el.close === "function" && el.open) {
      el.close();
    } else {
      onClose();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="native-modal-dialog stats-dialog"
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, string>)}
    >
      <header className="native-modal-head">
        <div className="diff-title-row">
          <BarChart3 size={16} aria-hidden="true" />
          <h1 id={titleId}>{t("endpointStatsTitle")}</h1>
          <span className="muted stats-session-tag" title={sessionLabel}>
            {sessionLabel}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("dismiss")}
          onClick={closeDialog}
        >
          <X aria-hidden="true" />
        </Button>
      </header>

      {report && (
        <div className="stats-kpi-grid">
          <div className="stats-kpi-card">
            <span className="muted">{t("statsTotalRequests")}</span>
            <strong>{report.totalRequests.toLocaleString()}</strong>
          </div>
          <div className="stats-kpi-card is-error">
            <span className="muted">{t("statsErrors")}</span>
            <strong>
              {report.totalErrors.toLocaleString()}
              {report.totalRequests > 0 && (
                <small>
                  {" "}
                  (
                  {((report.totalErrors / report.totalRequests) * 100).toFixed(
                    1,
                  )}
                  %)
                </small>
              )}
            </strong>
          </div>
          <div className="stats-kpi-card is-warn">
            <span className="muted">{t("statsBizErrors")}</span>
            <strong>{report.totalBizErrors.toLocaleString()}</strong>
          </div>
          <div className="stats-kpi-card is-warn">
            <span className="muted">{t("statsSlowRequests")}</span>
            <strong>{report.totalSlow.toLocaleString()}</strong>
          </div>
          <div className="stats-kpi-card">
            <span className="muted">{t("statsTotalBytes")}</span>
            <strong>{formatBytes(report.totalBytes)}</strong>
          </div>
        </div>
      )}

      <div className="stats-toolbar">
        <label className="search-field stats-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="text"
            autoFocus
            value={search}
            placeholder={t("statsSearchPlaceholder")}
            aria-label={t("statsSearchPlaceholder")}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              aria-label={t("dismiss")}
              onClick={() => setSearch("")}
            >
              <X size={12} />
            </button>
          )}
        </label>
        <div className="segmented" role="group" aria-label={t("statsSortBy")}>
          {(
            [
              ["count", "statsSortCount"],
              ["p95Ms", "statsSortP95"],
              ["errorCount", "statsSortErrors"],
              ["totalBytes", "statsSortBytes"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={sortKey === key ? "active" : ""}
              onClick={() => setSortKey(key)}
            >
              {t(label)}
            </button>
          ))}
        </div>
      </div>

      <div className="stats-table-wrap">
        {loading ? (
          <div className="loading">{t("loading")}</div>
        ) : error ? (
          <div className="inline-note warning" role="alert">
            {t("unexpected", { error })}
          </div>
        ) : rows.length === 0 ? (
          <div className="table-empty">
            <p>{t("noMatches")}</p>
          </div>
        ) : (
          <table className="stats-table">
            <thead>
              <tr>
                <th scope="col">{t("statsColEndpoint")}</th>
                <th scope="col">{t("statsColCount")}</th>
                <th scope="col">{t("statsColErrors")}</th>
                <th scope="col">Avg / P95</th>
                <th scope="col">{t("size")}</th>
                <th scope="col">{t("statsColActions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const keyword = row.graphqlOperation
                  ? row.graphqlOperation
                  : row.normalizedPath.replace(/\/:id\b/g, "");
                return (
                  <tr key={row.key}>
                    <td>
                      <div className="stats-endpoint-cell">
                        <span
                          className={`method-pill method method-${row.method.toLowerCase()}`}
                        >
                          {row.method}
                        </span>
                        <span
                          className="stats-path-text"
                          title={`${row.host}${row.normalizedPath}`}
                        >
                          <strong>{row.normalizedPath}</strong>
                          <small className="muted">{row.host}</small>
                        </span>
                      </div>
                    </td>
                    <td className="num-cell">
                      <span
                        className={row.count >= 5 ? "stats-hot-count" : ""}
                        title={
                          row.count >= 5 ? t("statsFrequentHint") : undefined
                        }
                      >
                        {row.count}
                      </span>
                    </td>
                    <td className="num-cell">
                      {row.errorCount > 0 ? (
                        <span className="stats-err-pill">
                          <AlertTriangle size={10} aria-hidden="true" />
                          {row.errorCount}
                        </span>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                    <td className="num-cell">
                      <span>{row.avgMs.toFixed(0)}ms</span>
                      <span
                        className={`muted ${row.p95Ms >= 800 ? "is-slow" : ""}`}
                      >
                        {" "}
                        / {row.p95Ms.toFixed(0)}ms
                      </span>
                    </td>
                    <td className="num-cell muted">
                      {formatBytes(row.totalBytes)}
                    </td>
                    <td>
                      <div className="stats-row-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          title={t("statsFilterAction")}
                          onClick={() => {
                            onFilterEndpoint(keyword, row.host);
                            closeDialog();
                          }}
                        >
                          <Filter size={11} aria-hidden="true" />
                          {t("statsFilterShort")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          title={t("statsInspectSample")}
                          onClick={() => {
                            onInspectSample(row.sampleEntryId);
                            closeDialog();
                          }}
                        >
                          <ExternalLink size={11} aria-hidden="true" />
                          {t("statsInspectShort")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </dialog>
  );
}
