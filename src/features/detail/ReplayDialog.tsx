import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, Play, Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { api } from "../../lib/ipc/client";
import type { EntryRow, ReplayResponse } from "../../lib/ipc/types";
import { formatBytes } from "../../lib/preferences";
import { JsonViewer } from "./JsonViewer";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function parseRequestHeaders(metadata: string): [string, string][] {
  if (!metadata) return [];
  try {
    const parsed = JSON.parse(metadata);
    return Array.isArray(parsed?.request?.headers)
      ? parsed.request.headers
      : [];
  } catch {
    return [];
  }
}

/**
 * 桌面端请求重放独立居中弹窗：
 * - 通过 React Portal 挂载到 document.body，避免被详情侧栏的 content-visibility 裁切；
 * - 支持一键全屏展开与笔记本窄屏「请求编辑 / 响应结果」切换，确保小屏完整可用。
 */
export function ReplayDialog({
  sessionId,
  entry,
  metadata = "",
  theme,
  onClose,
}: {
  sessionId: string;
  entry: EntryRow;
  metadata?: string;
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
  const [loadingBody, setLoadingBody] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [response, setResponse] = useState<ReplayResponse | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [compactTab, setCompactTab] = useState<"request" | "response">(
    "request",
  );

  // 初始化时拉取原始请求体；若调用方未预传 metadata（例如从列表右键打开），同时拉取请求头
  useEffect(() => {
    let active = true;
    setLoadingBody(true);
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
        if (view && (view.kind === "text" || view.kind === "form")) {
          setBody(view.text);
        }
      })
      .finally(() => {
        if (active) setLoadingBody(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId, entry.id, metadata]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSend() {
    if (sending) return;
    setSending(true);
    setError("");
    try {
      const result = await api.replay({
        method,
        url,
        headers: headers.filter(([k]) => k.trim().length > 0),
        body: body.length > 0 ? body : null,
      });
      setResponse(result);
      setCompactTab("response");
    } catch (e) {
      setError(String(e));
      setCompactTab("response");
    } finally {
      setSending(false);
    }
  }

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
            <Play size={13} />
            {sending ? t("replaySending") : t("replaySend")}
          </Button>
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
              {response ? ` · ${response.status}` : ""}
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
              {loadingBody && <span className="muted">{t("loading")}</span>}
            </div>
            <textarea
              className="replay-body-input"
              value={body}
              placeholder={t("replayBodyPlaceholder")}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>

          <div className="replay-result">
            <div className="replay-subhead">
              <strong>{t("response")}</strong>
              {response && (
                <div className="replay-meta-pills">
                  <span
                    className={`status-pill ${response.status >= 500 ? "status-5xx" : response.status >= 400 ? "status-4xx" : response.status >= 300 ? "status-3xx" : "status-2xx"}`}
                  >
                    {response.status} {response.statusText}
                  </span>
                  <span className="num-cell muted">
                    {response.durationMs.toFixed(0)} ms
                  </span>
                  <span className="num-cell muted">
                    {formatBytes(response.bytes)}
                  </span>
                </div>
              )}
            </div>
            {error && (
              <div className="inline-note warning" role="alert">
                {error}
              </div>
            )}
            {response ? (
              <div className="replay-response-body">
                {response.truncated && (
                  <div className="inline-note warning">
                    {t("previewTruncated")}
                  </div>
                )}
                <JsonViewer
                  text={response.body}
                  theme={theme}
                  json={
                    /json/i.test(response.mediaType ?? "") ||
                    /^[\s]*[{[]/.test(response.body)
                  }
                />
              </div>
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
