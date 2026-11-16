import { useEffect, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { api, desktop } from "../../lib/ipc/client";
import { commands } from "../../lib/commands/dispatcher";
import { useCommand } from "../../lib/commands/react";
import type { Scope } from "../../lib/ipc/types";

export function FileTools({
  scope,
  hasLogs,
  networkId,
  entryId,
  onError,
  onNotice,
}: {
  scope: Scope | null;
  hasLogs: boolean;
  networkId?: string;
  entryId?: string;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const notify = (text: string) => {
    setFeedback({ text, error: false });
    onNotice(text);
  };
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  async function act(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      await action();
    } catch (error) {
      setFeedback({
        text: t(String(error), {
          defaultValue: t("unexpected", { error: String(error) }),
        }),
        error: true,
      });
      onError(String(error));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  function save(kind: "har" | "jsonl" | "text") {
    if (!scope) return;
    return act(async () => {
      if (await api.exportScope(scope, kind)) notify(t("saved"));
    });
  }
  useCommand("files.open", () => setOpen(true), desktop);
  useCommand("export.har", () => save("har"), desktop && !!networkId && !busy);
  useCommand("export.logs", () => save("jsonl"), desktop && hasLogs && !busy);
  useCommand("export.text", () => save("text"), desktop && hasLogs && !busy);
  useCommand(
    "edit.copyCurl",
    () =>
      act(async () => {
        if (networkId && entryId) {
          const text = await api.copyCurl(networkId, entryId);
          await api.writeClipboard(text);
          notify(t("curlCopied"));
        }
      }),
    desktop && !!networkId && !!entryId && !busy,
  );
  useEffect(() => {
    if (!open) return;
    const unblock = commands.block(
      (id) =>
        !id.startsWith("export.") &&
        !id.startsWith("recovery.") &&
        id !== "edit.copyCurl" &&
        !id.startsWith("language.") &&
        id !== "view.language" &&
        id !== "view.theme",
    );
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key === "Tab") {
        const items = dialog.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled)",
        );
        if (!items?.length) return;
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items[items.length - 1].focus();
        } else if (
          !event.shiftKey &&
          document.activeElement === items[items.length - 1]
        ) {
          event.preventDefault();
          items[0].focus();
        }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      unblock();
      window.removeEventListener("keydown", keydown);
      trigger.current?.focus();
    };
  }, [open]);
  return (
    <>
      <Button
        ref={trigger}
        disabled={!desktop}
        onClick={() => commands.dispatch("files.open")}
      >
        <Download />
        {t("fileTools")}
      </Button>
      {open && (
        <div
          className="dialog-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <section
            className="connection-dialog file-tools"
            role="dialog"
            aria-modal="true"
            aria-label={t("fileTools")}
            ref={dialog}
          >
            <header>
              <h2>{t("fileTools")}</h2>
              <Button
                autoFocus
                variant="ghost"
                size="icon"
                aria-label={t("dismiss")}
                onClick={() => setOpen(false)}
              >
                <X />
              </Button>
            </header>
            <p className="muted">{t("exportBounds")}</p>
            {feedback && (
              <p role={feedback.error ? "alert" : "status"}>{feedback.text}</p>
            )}
            <div className="file-actions">
              <Button
                disabled={!networkId || busy}
                onClick={() => commands.dispatch("export.har")}
              >
                {t("exportHar")}
              </Button>
              <Button
                disabled={!hasLogs || busy}
                onClick={() => commands.dispatch("export.logs")}
              >
                {t("exportAllLogs")}
              </Button>
              <Button
                disabled={!hasLogs || busy}
                onClick={() => commands.dispatch("export.text")}
              >
                {t("exportLogText")}
              </Button>
              <Button
                disabled={!entryId || busy}
                onClick={() => commands.dispatch("edit.copyCurl")}
              >
                {t("copyCurl")}
              </Button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
