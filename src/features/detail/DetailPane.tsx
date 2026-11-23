import { useEffect, useState } from "react";
import {
  ArrowDownLeft,
  Check,
  Code2,
  Copy,
  MousePointer2,
  Play,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../../components/ui/tabs";
import { writeClipboard } from "../../lib/clipboard";
import { api, desktop } from "../../lib/ipc/client";
import { Button } from "../../components/ui/button";
import type { BodyView, EntryRow, SnippetFormat } from "../../lib/ipc/types";
import { formatBytes } from "../../lib/preferences";
import { BodyPreview } from "./BodyPreview";
import { OverviewSection } from "./OverviewSection";
import { ReplayDialog } from "./ReplayDialog";
import { inspectSmartValue } from "./smartDecode";

function KeyValueRow({
  name,
  value,
  copyKey,
  copiedAction,
  onCopy,
}: {
  name: string;
  value: string;
  copyKey: string;
  copiedAction: string | null;
  onCopy: (key: string, value: string) => void;
}) {
  const { t } = useTranslation();
  const [decodeOpen, setDecodeOpen] = useState(false);
  const smart = inspectSmartValue(value);

  return (
    <div className="kv-row-wrap">
      <div className="kv-row">
        <dt>{name}</dt>
        <dd>
          <span className="kv-val-text">
            {value}
            {smart && (
              <button
                type="button"
                className={`smart-badge ${smart.expired ? "is-expired" : ""}`}
                onClick={() => setDecodeOpen((v) => !v)}
                title={smart.summary}
              >
                <Sparkles size={10} />
                <span>{smart.badge}</span>
              </button>
            )}
          </span>
          <button
            type="button"
            className="kv-copy-btn"
            title={t("clickToCopyValue")}
            aria-label={`${t("copy")} ${name}`}
            onClick={() => onCopy(copyKey, value)}
          >
            {copiedAction === copyKey ? (
              <Check size={11} />
            ) : (
              <Copy size={11} />
            )}
          </button>
        </dd>
      </div>
      {smart && decodeOpen && (
        <div className="smart-decode-card">
          <div className="smart-decode-head">
            <strong>{smart.badge}</strong>
            <span className="muted">{smart.summary}</span>
          </div>
          <pre>{smart.detail}</pre>
        </div>
      )}
    </div>
  );
}

export function DetailPane({
  sessionId,
  entry: selected,
  version,
  theme,
  onReplay,
}: {
  sessionId: string | null;
  entry: EntryRow | null;
  theme: string;
  version?: number;
  onReplay?: (entry: EntryRow, metadata: string) => void;
}) {
  const { t } = useTranslation();
  const [liveEntry, setLiveEntry] = useState<{
    sessionId: string;
    row: EntryRow;
  } | null>(null);
  const [missing, setMissing] = useState(false);
  const [retry, setRetry] = useState(0);
  const entry =
    sessionId?.startsWith("live-") &&
    liveEntry?.sessionId === sessionId &&
    liveEntry?.row.id === selected?.id
      ? liveEntry.row
      : selected;
  useEffect(() => setMissing(false), [sessionId, selected?.id]);
  useEffect(() => {
    let active = true;
    if (sessionId?.startsWith("live-") && selected)
      void api
        .entryInfo(sessionId, selected.id)
        .then((value) => {
          if (active) {
            setLiveEntry({ sessionId, row: value });
            setMissing(false);
          }
        })
        .catch((error) => {
          if (active) {
            setError(String(error));
            if (["entryNotFound", "sessionNotFound"].includes(String(error)))
              setMissing(true);
          }
        });
    return () => {
      active = false;
    };
  }, [sessionId, selected?.id, version, retry]);

  const [tab, setTab] = useState("overview");
  const [metadata, setMetadata] = useState("");
  const [body, setBody] = useState<BodyView | null>(null);
  const [error, setError] = useState("");
  const [copiedAction, setCopiedAction] = useState<string | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);

  useEffect(() => {
    setCopiedAction(null);
    setReplayOpen(false);
  }, [sessionId, entry?.id]);

  useEffect(() => {
    let active = true;
    setMetadata("");
    setError("");
    if (sessionId && entry)
      void api
        .metadata(sessionId, entry.id)
        .then((value) => {
          if (active) setMetadata(value);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    return () => {
      active = false;
    };
  }, [sessionId, entry?.id, entry?.contentRevision, retry]);

  useEffect(() => {
    let active = true;
    setBody(null);
    setError("");
    if (sessionId && entry && (tab === "request" || tab === "response"))
      void api
        .body(sessionId, entry.id, tab)
        .then((value) => {
          if (active) setBody(value);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    return () => {
      active = false;
    };
  }, [sessionId, entry?.id, entry?.contentRevision, tab, retry]);

  if (missing)
    return (
      <aside className="detail-empty" role="status">
        {t("entryNotFound")}
      </aside>
    );
  if (!entry)
    return (
      <aside className="detail-empty">
        <MousePointer2 />
        <h2>{t("select")}</h2>
        <p>{t("selectHint")}</p>
      </aside>
    );

  let headers: [string, string][] = [];
  if (metadata && tab !== "overview") {
    try {
      headers = JSON.parse(metadata)[tab]?.headers ?? [];
    } catch {
      /* Show the raw metadata on parse failure. */
    }
  }

  // 在「请求」标签页自动解析 URL Query 参数，方便直接查阅、智能解码与一键复制
  const queryParams: [string, string][] = [];
  if (tab === "request") {
    try {
      const parsed = new URL(entry.url);
      parsed.searchParams.forEach((value, key) => {
        queryParams.push([key, value]);
      });
    } catch {
      /* 非标准 URL 跳过 Query 解析 */
    }
  }

  const stateLabel =
    entry.status ?? (entry.state === "pending" ? t("pending") : t("errors"));
  const statusClass =
    entry.state === "failed"
      ? "status-failed"
      : entry.state === "pending" || entry.status === null
        ? "status-pending"
        : entry.status >= 500
          ? "status-5xx"
          : entry.status >= 400
            ? "status-4xx"
            : entry.status >= 300
              ? "status-3xx"
              : "status-2xx";

  async function handleCopyUrl() {
    if (!entry) return;
    try {
      await writeClipboard(entry.url);
      setCopiedAction("url");
    } catch {
      setError("copyFailed");
    }
  }

  async function handleCopySnippet(format: SnippetFormat) {
    if (!sessionId || !entry || !desktop) return;
    try {
      const text =
        format === "curl"
          ? await api.copyCurl(sessionId, entry.id)
          : await api.copySnippet(sessionId, entry.id, format);
      await writeClipboard(text);
      setCopiedAction(format);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleCopyField(key: string, value: string) {
    try {
      await writeClipboard(value);
      setCopiedAction(key);
    } catch {
      setError("copyFailed");
    }
  }

  return (
    <aside className="detail-pane">
      <div className="detail-heading">
        <div className="detail-heading-top">
          <div className="detail-badges">
            <span
              className={`method-pill method method-${entry.method.toLowerCase()}`}
            >
              {entry.method}
            </span>
            <span className={`status-pill ${statusClass}`}>{stateLabel}</span>
          </div>
          <div className="detail-quick-actions">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleCopyUrl()}
              title={t("copyUrl")}
            >
              {copiedAction === "url" ? (
                <Check size={12} />
              ) : (
                <Copy size={12} />
              )}
              {copiedAction === "url" ? t("copied") : t("copyUrl")}
            </Button>
            {desktop && sessionId && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleCopySnippet("curl")}
                  title={t("copyCurl")}
                >
                  {copiedAction === "curl" ? (
                    <Check size={12} />
                  ) : (
                    <TerminalSquare size={12} />
                  )}
                  {copiedAction === "curl" ? t("copied") : "cURL"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleCopySnippet("dio")}
                  title={t("copyDartDio")}
                >
                  {copiedAction === "dio" ? (
                    <Check size={12} />
                  ) : (
                    <Code2 size={12} />
                  )}
                  {copiedAction === "dio" ? t("copied") : "Dio"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleCopySnippet("fetch")}
                  title={t("copyFetch")}
                >
                  {copiedAction === "fetch" ? (
                    <Check size={12} />
                  ) : (
                    <Code2 size={12} />
                  )}
                  {copiedAction === "fetch" ? t("copied") : "Fetch"}
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => {
                    if (onReplay) {
                      onReplay(entry, metadata);
                    } else {
                      setReplayOpen(true);
                    }
                  }}
                  title={t("replayRequest")}
                >
                  <Play size={11} />
                  {t("replayShort")}
                </Button>
              </>
            )}
          </div>
        </div>
        <p className="detail-url" title={entry.url}>
          {entry.url}
        </p>
        <div className="detail-summary">
          <span>
            {t("duration")}{" "}
            <strong className="num-cell">
              {entry.durationMs === null
                ? "—"
                : `${entry.durationMs.toFixed(1)} ms`}
            </strong>
          </span>
          <span className="num-cell">{formatBytes(entry.responseBytes)}</span>
          <span className="detail-source-tag">{entry.source}</span>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="detail-tabs">
        <TabsList className="tabs-list" aria-label={t("metadata")}>
          {["overview", "request", "response"].map((value) => (
            <TabsTrigger className="tab-trigger" key={value} value={value}>
              {t(value)}
            </TabsTrigger>
          ))}
        </TabsList>
        {error && (
          <div className="inline-note warning" role="alert">
            {t("unexpected", { error })}
            <Button onClick={() => setRetry((value) => value + 1)}>
              {t("retry")}
            </Button>
          </div>
        )}
        <TabsContent value="overview" className="tab-content">
          {metadata ? (
            <OverviewSection entry={entry} metadata={metadata} theme={theme} />
          ) : (
            <div className="loading">{t("loading")}</div>
          )}
        </TabsContent>
        {["request", "response"].map((side) => (
          <TabsContent key={side} value={side} className="tab-content body-tab">
            {side === "request" && queryParams.length > 0 && (
              <details className="headers-section query-section" open>
                <summary>
                  {t("queryParams")} <span>{queryParams.length}</span>
                </summary>
                <dl>
                  {queryParams.map(([name, value], index) => (
                    <KeyValueRow
                      key={`q-${index}`}
                      name={name}
                      value={value}
                      copyKey={`q-${index}`}
                      copiedAction={copiedAction}
                      onCopy={(k, v) => void handleCopyField(k, v)}
                    />
                  ))}
                </dl>
              </details>
            )}
            <details className="headers-section" open>
              <summary>
                {t("headers")} <span>{headers.length}</span>
              </summary>
              {headers.length ? (
                <dl>
                  {headers.map(([name, value], index) => (
                    <KeyValueRow
                      key={`h-${side}-${index}`}
                      name={name}
                      value={value}
                      copyKey={`h-${side}-${index}`}
                      copiedAction={copiedAction}
                      onCopy={(k, v) => void handleCopyField(k, v)}
                    />
                  ))}
                </dl>
              ) : (
                <p>{t("noHeaders")}</p>
              )}
            </details>
            <div className="section-label">
              <ArrowDownLeft size={13} />
              {t("body")}
              <span>{body?.mediaType ?? ""}</span>
            </div>
            {!body ? (
              <div className="loading">{t("loading")}</div>
            ) : (
              <>
                {(body.truncated || (body.previewTruncated && !body.image)) && (
                  <div className="inline-note warning">
                    {body.truncated && t("truncated")}{" "}
                    {body.previewTruncated && t("previewTruncated")}{" "}
                    {t("captured")}: {formatBytes(body.capturedBytes)} /{" "}
                    {formatBytes(body.size)}
                  </div>
                )}
                {body.kind === "empty" || body.reason ? (
                  <div className="body-empty">
                    {t(body.reason ?? "emptyBody")}
                  </div>
                ) : (
                  <BodyPreview
                    key={`${entry.id}-${side}`}
                    body={body}
                    theme={theme}
                  />
                )}
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>

      {replayOpen && sessionId && (
        <ReplayDialog
          sessionId={sessionId}
          entry={entry}
          metadata={metadata}
          theme={theme}
          onClose={() => setReplayOpen(false)}
        />
      )}
    </aside>
  );
}
