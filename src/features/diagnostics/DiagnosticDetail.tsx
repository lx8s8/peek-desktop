import { writeClipboard } from "../../lib/clipboard";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, desktop } from "../../lib/ipc/client";
import { Button } from "../../components/ui/button";
import { JsonViewer } from "../detail/JsonViewer";
import { StackSymbolicator } from "../plugins/StackSymbolicator";
import type { PluginView } from "../../lib/ipc/types";
import type { LogSelection } from "./DiagnosticsTable";
export function DiagnosticDetail({
  selected,
  theme,
  evictionVersion,
  networkSessionId,
  networkVersion,
  onNetwork,
  plugins,
  defaultPluginId,
  autoSymbolicateNonce,
  onOpenPlugins,
}: {
  selected: LogSelection | null;
  theme: string;
  evictionVersion?: number;
  networkSessionId?: string | null;
  networkVersion?: string;
  onNetwork?: (sessionId: string, entryId: string) => void;
  plugins?: PluginView[];
  defaultPluginId?: string | null;
  autoSymbolicateNonce?: number;
  onOpenPlugins?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const detailKey = JSON.stringify([selected?.runId, selected?.eventId]);
  const [result, setResult] = useState({ key: detailKey, raw: "", error: "" });
  const { raw, error } =
    result.key === detailKey ? result : { raw: "", error: "" };
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    let active = true;
    setResult({ key: detailKey, raw: "", error: "" });
    setNotice("");
    if (selected)
      void api
        .diagnostic(selected.runId, selected.eventId)
        .then((value) => {
          if (active && request === generation.current)
            setResult({ key: detailKey, raw: value, error: "" });
        })
        .catch((error) => {
          if (active)
            setResult({ key: detailKey, raw: "", error: String(error) });
        });
    return () => {
      active = false;
    };
  }, [selected?.runId, selected?.eventId, evictionVersion, retry]);
  if (!selected)
    return (
      <aside className="detail-empty">
        <h2>{t("selectLog")}</h2>
        <p>{t("selectLogHint")}</p>
      </aside>
    );
  const event = raw ? JSON.parse(raw) : null;
  const message: string = event?.message ?? "",
    stack: string = event?.exception?.stackTrace ?? "",
    level: string = event?.level ?? "";
  async function copy(text: string) {
    const request = generation.current;
    try {
      await writeClipboard(text);
      if (request === generation.current) setNotice(t("copied"));
    } catch {
      if (request === generation.current) setNotice(t("copyFailed"));
    }
  }
  async function save() {
    const request = generation.current;
    try {
      if (
        (await api.exportDiagnostics([selected!])) &&
        request === generation.current
      )
        setNotice(t("exportSaved"));
    } catch (error) {
      if (request === generation.current)
        setNotice(t("unexpected", { error: String(error) }));
    }
  }
  return (
    <aside className="diagnostic-detail">
      <div className="detail-heading">
        <strong className={`log-level level-${level}`}>
          {level.toUpperCase()}
        </strong>{" "}
        · {event?.source ?? ""}
        {event?.exception?.type && <span> · {event.exception.type}</span>}
      </div>
      {error ? (
        <div role="alert" className="inline-note warning">
          {i18n.exists(error) ? t(error) : t("unexpected", { error })}
          <Button onClick={() => setRetry((value) => value + 1)}>
            {t("retryDetail")}
          </Button>
        </div>
      ) : !event ? (
        <div className="loading">{t("loading")}</div>
      ) : (
        <>
          <div className="review-actions detail-actions">
            <Button onClick={() => void copy(message)}>
              {t("copyMessage")}
            </Button>
            <Button disabled={!desktop} onClick={() => void save()}>
              {t("exportSelected")}
            </Button>
          </div>
          {notice && (
            <p className="inline-note" role="status">
              {notice}
            </p>
          )}
          {event.truncated && (
            <div className="inline-note warning" role="status">
              {t("truncatedEvent")}
              {Array.isArray(event.truncatedFields) &&
                event.truncatedFields.length > 0 && (
                  <>
                    {" "}
                    · {t("truncatedFields")}:{" "}
                    {event.truncatedFields
                      .filter((value: unknown) => typeof value === "string")
                      .join(", ")}
                  </>
                )}
            </div>
          )}
          <dl className="event-meta">
            {[
              ["time", event.occurredAt],
              ["sequence", event.sequence],
              ["emitter", event.emitterId],
              ["tag", event.tag],
              ["runId", event.runId],
              ["eventId", event.eventId],
            ]
              .filter(([, value]) => value != null)
              .map(([key, value]) => (
                <div key={key}>
                  <dt>{t(key)}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
          </dl>
          <pre
            className="log-message"
            data-select-scope="log-message"
            tabIndex={0}
          >
            {message}
          </pre>
          {event.relatedNetworkEntryId && (
            <RelatedRequest
              key={JSON.stringify([
                detailKey,
                networkSessionId,
                networkVersion,
                event.relatedNetworkEntryId,
              ])}
              entryId={event.relatedNetworkEntryId}
              sessionId={networkSessionId}
              onOpen={onNetwork}
            />
          )}
          {event.kind === "exception" || event.exception ? (
            <StackSymbolicator
              stack={stack}
              stackFormat={event.exception?.stackFormat}
              attributes={event.attributes}
              exceptionMessage={event.exception?.message}
              plugins={plugins}
              defaultPluginId={defaultPluginId}
              autoTriggerNonce={autoSymbolicateNonce}
              onOpenPlugins={onOpenPlugins}
              onCopySuccess={(msg) => setNotice(msg)}
            />
          ) : null}
          <div className="section-label">{t("diagnosticRaw")}</div>
          <div className="diagnostic-json">
            <JsonViewer text={raw} theme={theme} />
          </div>
        </>
      )}
    </aside>
  );
}

function RelatedRequest({
  entryId,
  sessionId,
  onOpen,
}: {
  entryId: string;
  sessionId?: string | null;
  onOpen?: (sessionId: string, entryId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<
    "loading" | "available" | "unavailable" | "failed"
  >("loading");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const connected = !!(sessionId && onOpen);
  useEffect(() => {
    let active = true;
    setState("loading");
    if (sessionId && connected)
      void api
        .entryInfo(sessionId, entryId)
        .then(() => {
          if (active) setState("available");
        })
        .catch((error) => {
          if (!active) return;
          const message = String(error);
          setError(message);
          setState(
            ["entryNotFound", "sessionNotFound"].includes(message)
              ? "unavailable"
              : "failed",
          );
        });
    return () => {
      active = false;
    };
  }, [sessionId, entryId, connected, retry]);
  return (
    <section className="inline-note">
      <strong>{t("relatedRequest")}</strong>
      <code className="event-reference">{entryId}</code>
      {!connected || state === "unavailable" ? (
        <span>{t("relationUnavailable")}</span>
      ) : state === "loading" ? (
        <span>{t("loading")}</span>
      ) : state === "available" ? (
        <Button onClick={() => onOpen?.(sessionId!, entryId)}>
          {t("openRelatedRequest")}
        </Button>
      ) : (
        <span role="alert">
          {i18n.exists(error) ? t(error) : t("unexpected", { error })}{" "}
          <Button onClick={() => setRetry((value) => value + 1)}>
            {t("retryDetail")}
          </Button>
        </span>
      )}
    </section>
  );
}
