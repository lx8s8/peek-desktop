import { useEffect, useState } from "react";
import { ArrowDownLeft, MousePointer2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../../components/ui/tabs";
import { api } from "../../lib/ipc/client";
import { Button } from "../../components/ui/button";
import type { BodyView, EntryRow } from "../../lib/ipc/types";
import { formatBytes } from "../../lib/preferences";
import { JsonViewer } from "./JsonViewer";
import { BodyPreview } from "./BodyPreview";

export function DetailPane({
  sessionId,
  entry: selected,
  version,
  theme,
}: {
  sessionId: string | null;
  entry: EntryRow | null;
  theme: string;
  version?: number;
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
  const stateLabel =
    entry.status ?? (entry.state === "pending" ? t("pending") : t("errors"));
  return (
    <aside className="detail-pane">
      <div className="detail-heading">
        <div>
          <span className={`method method-${entry.method.toLowerCase()}`}>
            {entry.method}
          </span>
          <span
            className={`status status-${entry.state} ${(entry.status ?? 0) >= 400 ? "status-failed" : ""}`}
          >
            {stateLabel}
          </span>
        </div>
        <p title={entry.url}>{entry.url}</p>
        <div className="detail-summary">
          <span>
            {t("duration")}{" "}
            {entry.durationMs === null
              ? "—"
              : `${entry.durationMs.toFixed(1)} ms`}
          </span>
          <span>{formatBytes(entry.responseBytes)}</span>
          <span>{entry.source}</span>
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
          <div className="section-label">{t("metadata")}</div>
          {metadata ? (
            <JsonViewer text={metadata} theme={theme} />
          ) : (
            <div className="loading">{t("loading")}</div>
          )}
        </TabsContent>
        {["request", "response"].map((side) => (
          <TabsContent key={side} value={side} className="tab-content body-tab">
            <details className="headers-section" open>
              <summary>
                {t("headers")} <span>{headers.length}</span>
              </summary>
              {headers.length ? (
                <dl>
                  {headers.map(([name, value], index) => (
                    <div key={index}>
                      <dt>{name}</dt>
                      <dd>{value}</dd>
                    </div>
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
    </aside>
  );
}
