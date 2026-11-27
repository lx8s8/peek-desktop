import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Braces,
  Check,
  Copy,
  Maximize2,
  Minimize2,
  Play,
  Plus,
  Repeat,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { writeClipboard } from "../../lib/clipboard";
import { api } from "../../lib/ipc/client";
import type {
  EntryRow,
  ReplayBatchReport,
  ReplayResponse,
} from "../../lib/ipc/types";
import { formatBytes } from "../../lib/preferences";
import { diffBodies } from "../diff/jsonDiff";
import { losslessParser } from "./json";
import { JsonViewer } from "./JsonViewer";
import {
  extractReplayBody,
  parseRequestHeaders,
  type BodyNotice,
} from "./replayHelpers";

export { extractReplayBody, parseRequestHeaders };

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function statusPillClass(status: number): string {
  if (status >= 500) return "status-5xx";
  if (status >= 400) return "status-4xx";
  if (status >= 300) return "status-3xx";
  return "status-2xx";
}

function statusCodeLabelClass(code: string): string {
  if (code === "ERR") return "status-failed";
  const num = Number(code);
  if (Number.isFinite(num)) return statusPillClass(num);
  return "status-pending";
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * 桌面端请求重放独立居中弹窗：
 * - 通过 React Portal 挂载到 document.body，避免被详情侧栏的 content-visibility 裁切；
 * - 支持 GET/POST/PUT/PATCH/DELETE 全方法编辑、Form 表单正确还原、JSON 一键格式化、测试环境自签名证书开关；
 * - 支持单次发送与可控次数/并发的批量重复重发（输出状态分布、分位耗时与逐次响应明细）；
 * - 支持查看最新响应正文、响应头以及与原抓包响应的一键字段级 Diff 对比。
 */
export function ReplayDialog({
  sessionId,
  entry,
  metadata = "",
  initialBatchMode = false,
  initialResponse = null,
  theme,
  onClose,
}: {
  sessionId: string;
  entry: EntryRow;
  metadata?: string;
  initialBatchMode?: boolean;
  initialResponse?: ReplayResponse | null;
  theme: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [method, setMethod] = useState(entry.method.toUpperCase());
  const [url, setUrl] = useState(entry.url);
  const [headers, setHeaders] = useState<[string, string][]>(() =>
    parseRequestHeaders(metadata),
  );
  const [body, setBody] = useState("");
  const [bodyNotice, setBodyNotice] = useState<BodyNotice | null>(null);
  const [loadingBody, setLoadingBody] = useState(true);
  const [acceptInvalidCerts, setAcceptInvalidCerts] = useState(false);
  const [repeatCount, setRepeatCount] = useState(initialBatchMode ? 5 : 1);
  const [concurrency, setConcurrency] = useState(2);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [response, setResponse] = useState<ReplayResponse | null>(
    initialResponse,
  );
  const [batchReport, setBatchReport] = useState<ReplayBatchReport | null>(
    null,
  );
  const [selectedBatchIdx, setSelectedBatchIdx] = useState<number | null>(null);
  const [responseTab, setResponseTab] = useState<"body" | "headers" | "diff">(
    "body",
  );
  const [originalResponse, setOriginalResponse] = useState<{
    loaded: boolean;
    text: string;
  }>({ loaded: false, text: "" });
  const [diffOnlyChanges, setDiffOnlyChanges] = useState(true);
  const [copiedHeaderIdx, setCopiedHeaderIdx] = useState<number | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [compactTab, setCompactTab] = useState<"request" | "response">(
    initialResponse ? "response" : "request",
  );

  // 初始化时拉取原始请求体；若调用方未预传 metadata（例如从列表右键打开），同时拉取请求头
  useEffect(() => {
    let active = true;
    setLoadingBody(true);
    setBodyNotice(null);
    const metaTask = metadata
      ? Promise.resolve(metadata)
      : api.metadata(sessionId, entry.id).catch(() => "");
    void Promise.all([
      metaTask,
      api.body(sessionId, entry.id, "request").catch(() => null),
    ])
      .then(([loadedMeta, view]) => {
        if (!active) return;
        if (!metadata && loadedMeta) {
          setHeaders(parseRequestHeaders(loadedMeta));
        }
        const extracted = extractReplayBody(view);
        setBody(extracted.text);
        setBodyNotice(extracted.notice);
      })
      .finally(() => {
        if (active) setLoadingBody(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId, entry.id, metadata]);

  // 当用户切换到「与原响应对比」时按需加载原抓包响应正文
  useEffect(() => {
    if (responseTab !== "diff" || originalResponse.loaded) return;
    let active = true;
    void api
      .body(sessionId, entry.id, "response")
      .then((view) => {
        if (active) {
          setOriginalResponse({
            loaded: true,
            text: view.kind === "text" || view.kind === "form" ? view.text : "",
          });
        }
      })
      .catch(() => {
        if (active) setOriginalResponse({ loaded: true, text: "" });
      });
    return () => {
      active = false;
    };
  }, [responseTab, originalResponse.loaded, sessionId, entry.id]);

  const clampedRepeat = clampInt(repeatCount, 1, 50);
  const clampedConcurrency = clampInt(concurrency, 1, 10);
  const isBatchRequest = clampedRepeat > 1;

  const selectedBatchItem = useMemo(() => {
    if (!batchReport || batchReport.items.length === 0) return null;
    if (selectedBatchIdx !== null) {
      const found = batchReport.items.find(
        (item) => item.index === selectedBatchIdx,
      );
      if (found) return found;
    }
    return batchReport.items[0];
  }, [batchReport, selectedBatchIdx]);

  const activeResponse = batchReport
    ? (selectedBatchItem?.response ?? null)
    : response;

  const handleSend = useCallback(async () => {
    if (sending || !url.trim()) return;
    setSending(true);
    setError("");
    const payload = {
      method,
      url,
      headers: headers.filter(([k]) => k.trim().length > 0),
      body: body.length > 0 ? body : null,
      acceptInvalidCerts,
    };
    try {
      if (clampedRepeat > 1) {
        const report = await api.replayBatch({
          ...payload,
          count: clampedRepeat,
          concurrency: clampedConcurrency,
        });
        setBatchReport(report);
        setResponse(null);
        setSelectedBatchIdx(report.items[0]?.index ?? null);
      } else {
        const result = await api.replay(payload);
        setBatchReport(null);
        setSelectedBatchIdx(null);
        setResponse(result);
      }
      setCopiedHeaderIdx(null);
      setCompactTab("response");
    } catch (e) {
      setError(String(e));
      setCompactTab("response");
    } finally {
      setSending(false);
    }
  }, [
    sending,
    url,
    method,
    headers,
    body,
    acceptInvalidCerts,
    clampedRepeat,
    clampedConcurrency,
  ]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void handleSend();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, handleSend]);

  function handleFormatBodyJson() {
    if (!body.trim()) return;
    try {
      const parsed = losslessParser.parse(body);
      setBody(losslessParser.stringify(parsed, null, 2));
      setBodyNotice(null);
    } catch {
      setBodyNotice({ key: "replayInvalidJsonBody", warning: true });
    }
  }

  const responseDiff = useMemo(() => {
    if (responseTab !== "diff" || !activeResponse || !originalResponse.loaded) {
      return null;
    }
    if (!originalResponse.text) return null;
    const result = diffBodies(originalResponse.text, activeResponse.body);
    const rows = diffOnlyChanges
      ? result.rows.filter((row) => row.status !== "equal")
      : result.rows;
    return { mode: result.mode, rows };
  }, [responseTab, activeResponse, originalResponse, diffOnlyChanges]);

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`replay-dialog ${maximized ? "is-maximized" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("replayRequest")}
      >
        <header className="replay-header">
          <div className="diff-title-row">
            <h2>{t("replayRequest")}</h2>
            <span
              className={`method-pill method method-${method.toLowerCase()}`}
            >
              {method}
            </span>
          </div>
          <div className="replay-header-actions">
            <span className="replay-shortcut-hint muted">
              {t("replayShortcutHint")}
            </span>
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

        <div className="replay-url-row">
          <select
            aria-label={t("method")}
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            aria-label={t("url")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button
            variant="primary"
            disabled={sending || !url.trim()}
            onClick={() => void handleSend()}
          >
            {isBatchRequest ? <Repeat size={13} /> : <Play size={13} />}
            {sending
              ? t("replaySending")
              : isBatchRequest
                ? t("replayRunBatch", { count: clampedRepeat })
                : t("replaySend")}
          </Button>
        </div>

        <div className="replay-options-bar">
          <label className="replay-cert-toggle">
            <input
              type="checkbox"
              checked={acceptInvalidCerts}
              onChange={(e) => setAcceptInvalidCerts(e.target.checked)}
            />
            <span>{t("replayAcceptInvalidCerts")}</span>
          </label>
          <div className="replay-batch-controls">
            <label className="replay-batch-field">
              <span>{t("replayRepeatCount")}</span>
              <input
                type="number"
                min={1}
                max={50}
                aria-label={t("replayRepeatCount")}
                value={repeatCount}
                onChange={(e) =>
                  setRepeatCount(clampInt(Number(e.target.value) || 1, 1, 50))
                }
              />
            </label>
            <label
              className={`replay-batch-field${!isBatchRequest ? " is-disabled" : ""}`}
            >
              <span>{t("replayConcurrency")}</span>
              <input
                type="number"
                min={1}
                max={10}
                disabled={!isBatchRequest}
                aria-label={t("replayConcurrency")}
                value={concurrency}
                onChange={(e) =>
                  setConcurrency(clampInt(Number(e.target.value) || 1, 1, 10))
                }
              />
            </label>
          </div>
        </div>

        {/* 笔记本或较窄窗口下提供清晰的双 Tab 切换，避免左右并排过窄 */}
        <div className="replay-compact-tabs">
          <div className="segmented" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={compactTab === "request"}
              className={compactTab === "request" ? "active" : ""}
              onClick={() => setCompactTab("request")}
            >
              {t("replayTabRequest")} ({headers.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={compactTab === "response"}
              className={compactTab === "response" ? "active" : ""}
              onClick={() => setCompactTab("response")}
            >
              {t("replayTabResponse")}
              {batchReport
                ? ` · ${batchReport.succeeded}/${batchReport.total}`
                : activeResponse
                  ? ` · ${activeResponse.status}`
                  : ""}
            </button>
          </div>
        </div>

        <div className={`replay-split compact-${compactTab}`}>
          <div className="replay-editor">
            <div className="replay-subhead">
              <strong>
                {t("headers")} ({headers.length})
              </strong>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setHeaders((prev) => [...prev, ["", ""]])}
              >
                <Plus size={12} />
                {t("addHeader")}
              </Button>
            </div>
            <div className="replay-headers-list">
              {headers.map(([k, v], idx) => (
                <div key={idx} className="replay-header-row">
                  <input
                    placeholder="Header Name"
                    value={k}
                    onChange={(e) =>
                      setHeaders((prev) =>
                        prev.map((row, i) =>
                          i === idx ? [e.target.value, row[1]] : row,
                        ),
                      )
                    }
                  />
                  <input
                    placeholder="Value"
                    value={v}
                    onChange={(e) =>
                      setHeaders((prev) =>
                        prev.map((row, i) =>
                          i === idx ? [row[0], e.target.value] : row,
                        ),
                      )
                    }
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("removeHeader")}
                    onClick={() =>
                      setHeaders((prev) => prev.filter((_, i) => i !== idx))
                    }
                  >
                    <Trash2 size={12} />
                  </Button>
                </div>
              ))}
            </div>

            <div className="replay-subhead">
              <strong>{t("body")}</strong>
              <div className="replay-body-tools">
                {loadingBody && <span className="muted">{t("loading")}</span>}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!body.trim()}
                  onClick={handleFormatBodyJson}
                  title={t("replayFormatJson")}
                >
                  <Braces size={12} />
                  {t("replayFormatJson")}
                </Button>
              </div>
            </div>
            {bodyNotice && (
              <div
                className={`inline-note replay-body-note${bodyNotice.warning ? " warning" : ""}`}
                role={bodyNotice.warning ? "alert" : "status"}
              >
                {bodyNotice.params
                  ? t(bodyNotice.key, bodyNotice.params)
                  : t(bodyNotice.key)}
              </div>
            )}
            <textarea
              className="replay-body-input"
              value={body}
              placeholder={t("replayBodyPlaceholder")}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>

          <div className="replay-result">
            <div className="replay-subhead">
              <strong>
                {t("response")}
                {batchReport && selectedBatchItem
                  ? ` · #${selectedBatchItem.index}`
                  : ""}
              </strong>
              {activeResponse && (
                <div className="replay-meta-pills">
                  <span
                    className={`status-pill ${statusPillClass(activeResponse.status)}`}
                  >
                    {activeResponse.status} {activeResponse.statusText}
                  </span>
                  <span className="num-cell muted">
                    {activeResponse.durationMs.toFixed(0)} ms
                  </span>
                  <span className="num-cell muted">
                    {formatBytes(activeResponse.bytes)}
                  </span>
                </div>
              )}
            </div>
            {error && (
              <div className="inline-note warning" role="alert">
                {error}
              </div>
            )}
            {batchReport && (
              <div className="replay-batch-panel">
                <div className="replay-batch-summary">
                  <div className="replay-batch-summary-top">
                    <strong>
                      {t("replayBatchSummary", {
                        ok: batchReport.succeeded,
                        total: batchReport.total,
                        fail: batchReport.failed,
                      })}
                    </strong>
                    <div className="replay-batch-statuses">
                      {batchReport.statusCounts.map(([code, cnt]) => (
                        <span
                          key={code}
                          className={`status-pill ${statusCodeLabelClass(code)}`}
                        >
                          {code} ×{cnt}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="replay-batch-latency num-cell muted">
                    {t("replayBatchLatency", {
                      total: Math.round(batchReport.totalDurationMs),
                      min: Math.round(batchReport.minMs),
                      p50: Math.round(batchReport.p50Ms),
                      p95: Math.round(batchReport.p95Ms),
                      max: Math.round(batchReport.maxMs),
                    })}
                  </div>
                </div>
                <div
                  className="replay-batch-list"
                  role="listbox"
                  aria-label={t("replayBatchIndex")}
                >
                  {batchReport.items.map((item) => {
                    const isSelected = selectedBatchItem?.index === item.index;
                    return (
                      <button
                        key={item.index}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={`replay-batch-row${isSelected ? " active" : ""}${item.ok ? "" : " is-failed"}`}
                        onClick={() => {
                          setSelectedBatchIdx(item.index);
                          setCopiedHeaderIdx(null);
                        }}
                      >
                        <span className="num-cell muted">#{item.index}</span>
                        {item.response ? (
                          <span
                            className={`status-pill ${statusPillClass(item.response.status)}`}
                          >
                            {item.response.status}
                          </span>
                        ) : (
                          <span className="status-pill status-failed">ERR</span>
                        )}
                        <span className="num-cell">
                          {item.durationMs.toFixed(0)} ms
                        </span>
                        <span className="num-cell muted">
                          {item.response
                            ? formatBytes(item.response.bytes)
                            : item.error || "—"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {batchReport && selectedBatchItem && !selectedBatchItem.response ? (
              <div className="inline-note warning" role="alert">
                #{selectedBatchItem.index}:{" "}
                {selectedBatchItem.error || t("unexpected", { error: "" })}
              </div>
            ) : activeResponse ? (
              <>
                <div className="replay-response-tabs">
                  <div className="segmented" role="tablist">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={responseTab === "body"}
                      className={responseTab === "body" ? "active" : ""}
                      onClick={() => setResponseTab("body")}
                    >
                      {t("replayResponseBody")}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={responseTab === "headers"}
                      className={responseTab === "headers" ? "active" : ""}
                      onClick={() => setResponseTab("headers")}
                    >
                      {t("replayResponseHeaders")} (
                      {activeResponse.headers.length})
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={responseTab === "diff"}
                      className={responseTab === "diff" ? "active" : ""}
                      onClick={() => setResponseTab("diff")}
                    >
                      {t("replayResponseDiff")}
                    </button>
                  </div>
                  {responseTab === "diff" && (
                    <label className="replay-cert-toggle">
                      <input
                        type="checkbox"
                        checked={diffOnlyChanges}
                        onChange={(e) => setDiffOnlyChanges(e.target.checked)}
                      />
                      <span>{t("diffOnlyChanges")}</span>
                    </label>
                  )}
                </div>
                <div className="replay-response-body">
                  {responseTab === "body" ? (
                    <>
                      {activeResponse.truncated && (
                        <div className="inline-note warning">
                          {t("previewTruncated")}
                        </div>
                      )}
                      <JsonViewer
                        text={activeResponse.body}
                        theme={theme}
                        json={
                          /json/i.test(activeResponse.mediaType ?? "") ||
                          /^[\s]*[{[]/.test(activeResponse.body)
                        }
                      />
                    </>
                  ) : responseTab === "headers" ? (
                    <div
                      className="replay-response-headers"
                      data-select-scope="replay-headers"
                      tabIndex={0}
                    >
                      {activeResponse.headers.length > 0 ? (
                        <dl className="headers-section replay-headers-dl">
                          {activeResponse.headers.map(([name, val], idx) => (
                            <div key={`${name}-${idx}`} className="kv-row">
                              <dt>{name}</dt>
                              <dd>
                                <span>{val}</span>
                                <button
                                  type="button"
                                  className="kv-copy-btn"
                                  title={t("clickToCopyValue")}
                                  aria-label={`${t("copy")} ${name}`}
                                  onClick={() =>
                                    void writeClipboard(val).then(() =>
                                      setCopiedHeaderIdx(idx),
                                    )
                                  }
                                >
                                  {copiedHeaderIdx === idx ? (
                                    <Check size={11} />
                                  ) : (
                                    <Copy size={11} />
                                  )}
                                </button>
                              </dd>
                            </div>
                          ))}
                        </dl>
                      ) : (
                        <div className="body-empty">{t("noHeaders")}</div>
                      )}
                    </div>
                  ) : !originalResponse.loaded ? (
                    <div className="loading">{t("loading")}</div>
                  ) : !originalResponse.text ? (
                    <div className="body-empty">{t("replayOriginalEmpty")}</div>
                  ) : responseDiff && responseDiff.rows.length > 0 ? (
                    <div className="diff-table-wrap">
                      <div className="diff-grid diff-head">
                        <span>{t("diffField")}</span>
                        <span>{t("replayDiffBaseline")}</span>
                        <span>{t("replayDiffLatest")}</span>
                      </div>
                      <div className="diff-rows">
                        {responseDiff.rows.map((row, idx) => (
                          <div
                            key={`${row.path}-${idx}`}
                            className={`diff-grid diff-row diff-status-${row.status}`}
                          >
                            <span className="diff-path">{row.path}</span>
                            <span className="diff-val">{row.left || "—"}</span>
                            <span className="diff-val">{row.right || "—"}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="body-empty">{t("diffNoChanges")}</div>
                  )}
                </div>
              </>
            ) : (
              <div className="table-empty">
                <p>{t("replayEmptyHint")}</p>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
