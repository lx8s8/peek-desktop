import { useEffect, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { api, desktop } from "../../lib/ipc/client";
import { commands } from "../../lib/commands/dispatcher";
import { useCommand } from "../../lib/commands/react";
import type { Imported, RecoveryStatus, Scope } from "../../lib/ipc/types";
import { formatBytes } from "../../lib/preferences";

export function FileTools({
  scope,
  hasLogs,
  networkId,
  entryId,
  onError,
  onNotice,
  onRestored,
  hasData = !!scope,
}: {
  scope: Scope | null;
  hasLogs: boolean;
  networkId?: string;
  entryId?: string;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onRestored?: (result: Imported) => Promise<void>;
  hasData?: boolean;
}) {
  const { t, i18n } = useTranslation();
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
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(null);
  const recoveryRevision = useRef(0);
  const publishRecovery = (value: RecoveryStatus) => {
    ++recoveryRevision.current;
    setRecovery(value);
  };
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const load = async () => {
      const request = ++recoveryRevision.current;
      try {
        const value = await api.recoveryStatus();
        if (active && request === recoveryRevision.current) setRecovery(value);
      } catch (error) {
        if (active) setFeedback({ text: String(error), error: true });
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      active = false;
      ++recoveryRevision.current;
      clearInterval(timer);
    };
  }, []);
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
  useCommand(
    "recovery.save",
    () =>
      act(async () => {
        publishRecovery(await api.saveRecovery());
        notify(t("saved"));
      }),
    desktop && hasData && !!recovery && !recovery.pending && !busy,
  );
  useCommand(
    "recovery.restore",
    () =>
      act(async () => {
        const result = await api.restoreRecovery();
        await onRestored?.(result);
        const status = await api.recoveryStatus();
        publishRecovery(status);
        notify(t(status.usedBackup ? "recoveryBackup" : "recoveryRestored"));
      }),
    desktop && !!recovery?.pending && !busy,
  );
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
        {recovery?.pending ? ` · ${t("recoveryTitle")}` : ""}
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
            <h3>{t("recoveryTitle")}</h3>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={recovery?.enabled ?? false}
                disabled={busy || !recovery}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  void act(async () =>
                    publishRecovery(await api.setRecoveryEnabled(enabled)),
                  );
                }}
              />
              {t("enableRecovery")}
            </label>
            <p className="muted">{t("recoveryHint")}</p>
            {recovery?.pending && <p role="status">{t("pendingRecovery")}</p>}
            {recovery?.error && <p role="alert">{t(recovery.error)}</p>}
            <p className="muted">
              {recovery?.updatedAt
                ? t("recoveryInfo", {
                    size: formatBytes(recovery.bytes),
                    time: new Date(recovery.updatedAt * 1000).toLocaleString(
                      i18n.language,
                    ),
                  })
                : t("recoveryNotSaved")}
            </p>
            <div className="file-actions">
              <Button
                disabled={!recovery?.pending || busy}
                onClick={() => commands.dispatch("recovery.restore")}
              >
                {t("restoreWorkspace")}
              </Button>
              <Button
                disabled={!hasData || !recovery || recovery.pending || busy}
                onClick={() => commands.dispatch("recovery.save")}
              >
                {t("saveRecovery")}
              </Button>
              {recovery?.pending && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(async () =>
                      publishRecovery(await api.startNewRecovery()),
                    )
                  }
                >
                  {t("startNewRecovery")}
                </Button>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
