import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { GitCompareArrows, Maximize2, Minimize2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { api } from "../../lib/ipc/client";
import type { EntryRow } from "../../lib/ipc/types";
import { formatBytes } from "../../lib/preferences";
import { diffBodies, diffKeyValuePairs, type FieldDiffRow } from "./jsonDiff";

interface LoadedSide {
  reqHeaders: [string, string][];
  resHeaders: [string, string][];
  queryParams: [string, string][];
  reqBody: string;
  resBody: string;
}

function parseQuery(url: string): [string, string][] {
  try {
    const out: [string, string][] = [];
    new URL(url).searchParams.forEach((v, k) => out.push([k, v]));
    return out;
  } catch {
    return [];
  }
}

async function loadEntrySide(
  sessionId: string,
  entry: EntryRow,
): Promise<LoadedSide> {
  const [metaText, reqBodyView, resBodyView] = await Promise.all([
    api.metadata(sessionId, entry.id).catch(() => ""),
    api.body(sessionId, entry.id, "request").catch(() => null),
    api.body(sessionId, entry.id, "response").catch(() => null),
  ]);
  let reqHeaders: [string, string][] = [];
  let resHeaders: [string, string][] = [];
  if (metaText) {
    try {
      const parsed = JSON.parse(metaText);
      reqHeaders = parsed?.request?.headers ?? [];
      resHeaders = parsed?.response?.headers ?? [];
    } catch {
      /* 忽略元信息解析错误 */
    }
  }
  return {
    reqHeaders,
    resHeaders,
    queryParams: parseQuery(entry.url),
    reqBody: reqBodyView?.text ?? "",
    resBody: resBodyView?.text ?? "",
  };
}

function DiffTable({
  rows,
  onlyDiff,
}: {
  rows: FieldDiffRow[];
  onlyDiff: boolean;
}) {
  const { t } = useTranslation();
  const visible = useMemo(
    () => (onlyDiff ? rows.filter((r) => r.status !== "equal") : rows),
    [rows, onlyDiff],
  );
  if (visible.length === 0) {
    return (
      <div className="table-empty">
        <p>{t("diffNoChanges")}</p>
      </div>
    );
  }
  return (
    <div className="diff-table-wrap">
      <div className="diff-grid diff-head">
        <span>{t("diffField")}</span>
        <span>A ({t("diffBaseline")})</span>
        <span>B ({t("diffTarget")})</span>
      </div>
      <div className="diff-rows">
        {visible.map((row, index) => (
          <div
            key={`${row.path}-${index}`}
            className={`diff-grid diff-row diff-status-${row.status}`}
          >
            <span className="diff-path" title={row.path}>
              {row.path}
            </span>
            <span className="diff-val" title={row.left}>
              {row.left || "—"}
            </span>
            <span className="diff-val" title={row.right}>
              {row.right || "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 双请求并排 Diff 对比弹窗（支持 Query / Headers / Request Body / Response JSON 字段级差异）。 */
export function RequestDiffDialog({
  sessionId,
  left,
  right,
  onClose,
}: {
  sessionId: string;
  left: EntryRow;
  right: EntryRow;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"response" | "request" | "headers" | "query">(
    "response",
  );
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [loading, setLoading] = useState(true);
  const [leftData, setLeftData] = useState<LoadedSide | null>(null);
  const [rightData, setRightData] = useState<LoadedSide | null>(null);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([
      loadEntrySide(sessionId, left),
      loadEntrySide(sessionId, right),
    ]).then(([l, r]) => {
      if (!active) return;
      setLeftData(l);
      setRightData(r);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [sessionId, left, right]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const responseDiff = useMemo(
    () =>
      leftData && rightData
        ? diffBodies(leftData.resBody, rightData.resBody)
        : null,
    [leftData, rightData],
  );
  const requestDiff = useMemo(
    () =>
      leftData && rightData
        ? diffBodies(leftData.reqBody, rightData.reqBody)
        : null,
    [leftData, rightData],
  );
  const headerRows = useMemo(() => {
    if (!leftData || !rightData) return [];
    const req = diffKeyValuePairs(
      leftData.reqHeaders,
      rightData.reqHeaders,
      true,
    ).map((r) => ({ ...r, path: `Req · ${r.path}` }));
    const res = diffKeyValuePairs(
      leftData.resHeaders,
      rightData.resHeaders,
      true,
    ).map((r) => ({ ...r, path: `Res · ${r.path}` }));
    return [...req, ...res];
  }, [leftData, rightData]);
  const queryRows = useMemo(
    () =>
      leftData && rightData
        ? diffKeyValuePairs(leftData.queryParams, rightData.queryParams, false)
        : [],
    [leftData, rightData],
  );

  const activeRows =
    tab === "response"
      ? (responseDiff?.rows ?? [])
      : tab === "request"
        ? (requestDiff?.rows ?? [])
        : tab === "headers"
          ? headerRows
          : queryRows;

  const changedCount = activeRows.filter((r) => r.status !== "equal").length;

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`diff-dialog ${maximized ? "is-maximized" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("diffTitle")}
      >
        <header className="replay-header">
          <div className="diff-title-row">
            <GitCompareArrows size={16} />
            <h2>{t("diffTitle")}</h2>
          </div>
          <div className="replay-header-actions">
            <Button
              variant="ghost"
              size="icon"
              aria-label={maximized ? t("dialogRestore") : t("dialogMaximize")}
              title={maximized ? t("dialogRestore") : t("dialogMaximize")}
              onClick={() => setMaximized((value) => !value)}
            >
              {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("dismiss")}
              onClick={onClose}
            >
              <X />
            </Button>
          </div>
        </header>

        <div className="diff-summary-cards">
          <div className="diff-side-card">
            <span className="diff-badge">A</span>
            <span
              className={`method-pill method method-${left.method.toLowerCase()}`}
            >
              {left.method}
            </span>
            <span className="num-cell">{left.status ?? "—"}</span>
            <span className="num-cell muted">
              {left.durationMs === null
                ? "—"
                : `${left.durationMs.toFixed(0)}ms`}
            </span>
            <span className="num-cell muted">
              {formatBytes(left.responseBytes)}
            </span>
            <code title={left.url}>{left.url}</code>
          </div>
          <div className="diff-side-card">
            <span className="diff-badge">B</span>
            <span
              className={`method-pill method method-${right.method.toLowerCase()}`}
            >
              {right.method}
            </span>
            <span className="num-cell">{right.status ?? "—"}</span>
            <span className="num-cell muted">
              {right.durationMs === null
                ? "—"
                : `${right.durationMs.toFixed(0)}ms`}
            </span>
            <span className="num-cell muted">
              {formatBytes(right.responseBytes)}
            </span>
            <code title={right.url}>{right.url}</code>
          </div>
        </div>

        <div className="diff-toolbar">
          <div className="segmented">
            {(
              [
                ["response", "response"],
                ["request", "request"],
                ["headers", "headers"],
                ["query", "queryParams"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={tab === key ? "active" : ""}
                onClick={() => setTab(key)}
              >
                {t(label)}
              </button>
            ))}
          </div>
          <label className="stream-toggle">
            <input
              type="checkbox"
              checked={onlyDiff}
              onChange={(e) => setOnlyDiff(e.target.checked)}
            />
            <span>
              {t("diffOnlyChanges")} ({changedCount})
            </span>
          </label>
        </div>

        <div className="diff-body">
          {loading ? (
            <div className="loading">{t("loading")}</div>
          ) : (
            <DiffTable rows={activeRows} onlyDiff={onlyDiff} />
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
