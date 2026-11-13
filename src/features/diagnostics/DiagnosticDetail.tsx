import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, desktop } from "../../lib/ipc/client";
import { Button } from "../../components/ui/button";
import { JsonViewer } from "../detail/JsonViewer";
import type { LogSelection } from "./DiagnosticsTable";
export function DiagnosticDetail({
  selected,
  theme,
  evictionVersion,
  networkSessionId,
  onNetwork,
}: {
  selected: LogSelection | null;
  theme: string;
  evictionVersion?: number;
  networkSessionId?: string | null;
  onNetwork?: (sessionId: string, entryId: string) => void;
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
      await navigator.clipboard.writeText(text);
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
          <pre className="log-message">{message}</pre>
          {event.relatedNetworkEntryId && (
            <section className="inline-note">
              <strong>{t("relatedRequest")}</strong>
              <code className="event-reference">
                {event.relatedNetworkEntryId}
              </code>
              {networkSessionId && onNetwork ? (
                <Button
                  onClick={() =>
                    onNetwork(networkSessionId, event.relatedNetworkEntryId)
                  }
                >
                  {t("openRelatedRequest")}
                </Button>
              ) : (
                <span>{t("relationUnavailable")}</span>
              )}
            </section>
          )}
          {event.kind === "exception" || event.exception ? (
            <section className="stack-section">
              <div className="section-label">
                {t("originalStack")}
                <Button disabled={!stack} onClick={() => void copy(stack)}>
                  {t("copyStack")}
                </Button>
              </div>
              {event.exception?.message && <p>{event.exception.message}</p>}
              {stack ? <pre>{stack}</pre> : <p>{t("noStack")}</p>}
            </section>
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
