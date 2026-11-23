import { useMemo } from "react";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { EntryRow } from "../../lib/ipc/types";
import { formatBytes } from "../../lib/preferences";
import { JsonViewer } from "./JsonViewer";

interface TimingPhase {
  key: string;
  labelKey: string;
  value: number;
  colorClass: string;
}

const PHASE_DEFS: { key: string; labelKey: string; colorClass: string }[] = [
  { key: "blocked", labelKey: "timingBlocked", colorClass: "t-blocked" },
  { key: "dns", labelKey: "timingDns", colorClass: "t-dns" },
  { key: "connect", labelKey: "timingConnect", colorClass: "t-connect" },
  { key: "ssl", labelKey: "timingSsl", colorClass: "t-ssl" },
  { key: "send", labelKey: "timingSend", colorClass: "t-send" },
  { key: "wait", labelKey: "timingWait", colorClass: "t-wait" },
  { key: "receive", labelKey: "timingReceive", colorClass: "t-receive" },
];

/**
 * 结构化「概览」面板：
 * - 激活后端已记录的 timings（分段耗时瀑布条）与 redirects（重定向链）；
 * - 保留完整原始 Metadata JSON 查看器（并在非对象文本时无缝回退）。
 */
export function OverviewSection({
  entry,
  metadata,
  theme,
}: {
  entry: EntryRow;
  metadata: string;
  theme: string;
}) {
  const { t, i18n } = useTranslation();

  const parsed = useMemo(() => {
    try {
      const value = JSON.parse(metadata);
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }, [metadata]);

  const timings = useMemo(() => {
    const raw = parsed?.timings as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return [] as TimingPhase[];
    const list: TimingPhase[] = [];
    for (const def of PHASE_DEFS) {
      const n = raw[def.key];
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) {
        list.push({ ...def, value: n });
      }
    }
    return list;
  }, [parsed]);

  const redirects = useMemo(() => {
    const resp = parsed?.response as Record<string, unknown> | undefined;
    const raw = resp?.redirects;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (item): item is { status: number; method: string; location: string } =>
        !!item &&
        typeof item === "object" &&
        typeof (item as { location?: unknown }).location === "string",
    );
  }, [parsed]);

  const failure = parsed?.failure as
    { kind?: string; message?: string } | undefined;
  const totalMeasured = timings.reduce((sum, p) => sum + p.value, 0);
  const scaleTotal = Math.max(totalMeasured, entry.durationMs ?? 0, 1);

  return (
    <div className="overview-container">
      {parsed && (
        <div className="overview-cards">
          <div className="overview-grid">
            <div>
              <span>{t("startedAt")}</span>
              <strong className="num-cell">
                {new Date(entry.startedAt).toLocaleString(i18n.language, {
                  hour12: false,
                })}
              </strong>
            </div>
            <div>
              <span>{t("duration")}</span>
              <strong className="num-cell">
                {entry.durationMs === null
                  ? "—"
                  : `${entry.durationMs.toFixed(1)} ms`}
              </strong>
            </div>
            <div>
              <span>{t("size")}</span>
              <strong className="num-cell">
                {formatBytes(entry.responseBytes)}
              </strong>
            </div>
            <div>
              <span>{t("source")}</span>
              <strong>{entry.source}</strong>
            </div>
          </div>

          {failure && (
            <div className="overview-failure">
              <strong>{failure.kind ?? t("errors")}</strong>
              <span>{failure.message ?? ""}</span>
            </div>
          )}

          {timings.length > 0 && (
            <div className="waterfall-card">
              <div className="waterfall-head">
                <strong>{t("timingWaterfall")}</strong>
                <span className="num-cell muted">
                  {totalMeasured.toFixed(1)} ms
                </span>
              </div>
              <div
                className="waterfall-bar"
                role="img"
                aria-label={t("timingWaterfall")}
              >
                {timings.map((phase) => (
                  <span
                    key={phase.key}
                    className={`wf-seg ${phase.colorClass}`}
                    style={{
                      width: `${Math.max(2, (phase.value / scaleTotal) * 100)}%`,
                    }}
                    title={`${t(phase.labelKey)}: ${phase.value.toFixed(1)} ms`}
                  />
                ))}
              </div>
              <div className="waterfall-legend">
                {timings.map((phase) => (
                  <span key={phase.key} className="wf-legend-item">
                    <i className={`wf-dot ${phase.colorClass}`} />
                    <span>{t(phase.labelKey)}</span>
                    <strong className="num-cell">
                      {phase.value.toFixed(1)}ms
                    </strong>
                  </span>
                ))}
              </div>
            </div>
          )}

          {redirects.length > 0 && (
            <div className="redirects-card">
              <strong>
                {t("redirectChain")} ({redirects.length})
              </strong>
              <ol>
                {redirects.map((hop, idx) => (
                  <li key={idx}>
                    <span className="status-pill status-3xx">{hop.status}</span>
                    <span className="method">{hop.method}</span>
                    <ArrowRight size={11} />
                    <code>{hop.location}</code>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      <div className="section-label">{t("metadata")}</div>
      <JsonViewer text={metadata} theme={theme} />
    </div>
  );
}
