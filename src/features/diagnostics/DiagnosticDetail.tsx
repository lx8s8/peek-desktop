import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/ipc/client";
import { Button } from "../../components/ui/button";
import { JsonViewer } from "../detail/JsonViewer";
import type { LogSelection } from "./DiagnosticsTable";

export function DiagnosticDetail({
  selected,
  theme,
}: {
  selected: LogSelection | null;
  theme: string;
}) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    let active = true;
    setRaw("");
    setError("");
    setCopied("");
    if (selected)
      void api
        .diagnostic(selected.runId, selected.eventId)
        .then((value) => {
          if (active) setRaw(value);
        })
        .catch((error) => {
          if (active) setError(String(error));
        });
    return () => {
      active = false;
    };
  }, [selected?.runId, selected?.eventId]);
  if (!selected)
    return (
      <aside className="detail-empty">
        <h2>{t("selectLog")}</h2>
        <p>{t("selectLogHint")}</p>
      </aside>
    );
  let message = "",
    stack = "",
    level = "",
    source = "";
  // Only display string fields here. The JSON viewer retains the original numeric text.
  if (raw) {
    const event = JSON.parse(raw);
    message = event.message;
    stack = event.exception?.stackTrace ?? "";
    level = event.level;
    source = event.source;
  }
  return (
    <aside className="diagnostic-detail">
      <div className="detail-heading">
        <strong className={`log-level level-${level}`}>
          {level.toUpperCase()}
        </strong>{" "}
        · {source}
      </div>
      {error ? (
        <div role="alert" className="inline-note warning">
          {t("unexpected", { error })}
        </div>
      ) : !raw ? (
        <div className="loading">{t("loading")}</div>
      ) : (
        <>
          <pre className="log-message">{message}</pre>
          {stack && (
            <section className="stack-section">
              <div className="section-label">
                {t("originalStack")}
                <Button
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(stack)
                      .then(() => setCopied(t("copied")))
                      .catch(() => setCopied(t("copyFailed")));
                  }}
                >
                  {t("copyStack")}
                </Button>
              </div>
              <pre>{stack}</pre>
              {copied && <p role="status">{copied}</p>}
            </section>
          )}
          <div className="section-label">{t("diagnosticRaw")}</div>
          <div className="diagnostic-json">
            <JsonViewer text={raw} theme={theme} />
          </div>
        </>
      )}
    </aside>
  );
}
