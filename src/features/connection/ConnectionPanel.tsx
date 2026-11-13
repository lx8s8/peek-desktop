import { commands } from "../../lib/commands/dispatcher";
import { useCommand, useModalCommands } from "../../lib/commands/react";
import { useEffect, useRef, useState } from "react";
import { Radio, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { api, desktop } from "../../lib/ipc/client";
import type { RemoteSnapshot } from "../../lib/ipc/types";

export function ConnectionPanel({
  remote,
  onChange,
  onError,
}: {
  remote: RemoteSnapshot;
  onChange: () => Promise<void>;
  onError: (error: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const actionBusy = useRef(false);
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("9741");
  const [advertise, setAdvertise] = useState(true);
  const [diagnostics, setDiagnostics] = useState(true);
  const [expires, setExpires] = useState(0);
  const dialog = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setExpires(remote.pairing?.expiresInSeconds ?? 0);
  }, [remote.pairing?.code, remote.pairing?.expiresInSeconds]);
  useEffect(() => {
    if (!open) return;
    const tick = setInterval(
      () => setExpires((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => clearInterval(tick);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key === "Tab") {
        const nodes = dialog.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
        );
        if (nodes?.length) {
          const first = nodes[0],
            last = nodes[nodes.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      trigger.current?.focus();
    };
  }, [open]);
  async function act(action: () => Promise<unknown>) {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setBusy(true);
    try {
      await action();
      await onChange();
    } catch (error) {
      onError(String(error));
    } finally {
      actionBusy.current = false;
      setBusy(false);
    }
  }
  useCommand("connection.open", () => setOpen(true), desktop);
  useCommand(
    "connection.stop",
    () => act(() => api.stop()),
    remote.listening && !busy,
  );
  useCommand(
    "connection.pair",
    () => {
      setOpen(true);
      return act(() => api.pair(diagnostics));
    },
    remote.listening && !busy,
  );
  useModalCommands(open);
  return (
    <>
      <Button
        ref={trigger}
        disabled={!desktop}
        onClick={() => commands.dispatch("connection.open")}
      >
        <Radio />
        {t("connection")}
      </Button>
      {open && (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-label={t("connection")}
            className="connection-dialog"
          >
            <header>
              <h2>{t("connection")}</h2>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setOpen(false)}
                aria-label={t("dismiss")}
                autoFocus
              >
                <X />
              </Button>
            </header>
            <p className="muted">{t("connectionDescription")}</p>
            <div className="connection-fields">
              <label>
                {t("listenAddress")}
                <select
                  value={remote.listening ? remote.host : host}
                  disabled={remote.listening || busy}
                  onChange={(e) => setHost(e.target.value)}
                >
                  <option value="127.0.0.1">{t("loopback")}</option>
                  <option value="0.0.0.0">{t("lan")}</option>
                </select>
              </label>
              <label>
                {t("port")}
                <input
                  value={remote.listening ? remote.port : port}
                  disabled={remote.listening || busy}
                  type="number"
                  min={1}
                  max={65535}
                  onChange={(e) => setPort(e.target.value)}
                />
              </label>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={advertise}
                disabled={remote.listening || busy}
                onChange={(e) => setAdvertise(e.target.checked)}
              />
              {t("advertise")}
            </label>
            <Button
              variant="primary"
              disabled={
                busy ||
                (!remote.listening &&
                  (!/^\d+$/.test(port) ||
                    Number(port) < 1 ||
                    Number(port) > 65535))
              }
              onClick={() =>
                remote.listening
                  ? commands.dispatch("connection.stop")
                  : void act(() => api.start(host, Number(port), advertise))
              }
            >
              {t(remote.listening ? "stopListening" : "startListening")}
            </Button>
            {remote.listening && (
              <div className="listener-addresses">
                <strong>{t("listening")}</strong>
                {remote.addresses.map((address) => (
                  <code key={address}>ws://{address}/</code>
                ))}
                <small>{t(`mdns_${remote.mdns}`)}</small>
              </div>
            )}
            <div className="pairing-block">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={diagnostics}
                  onChange={(e) => setDiagnostics(e.target.checked)}
                />
                {t("allowDiagnostics")}
              </label>
              <Button
                disabled={!remote.listening || busy}
                onClick={() => commands.dispatch("connection.pair")}
              >
                {t("newPairingCode")}
              </Button>
              {remote.listening && remote.pairing?.code && expires > 0 ? (
                <>
                  <strong className="pairing-code">
                    {remote.pairing.code}
                  </strong>
                  <span className="muted">
                    {t("codeExpires", { count: expires })}
                  </span>
                </>
              ) : (
                <p className="muted">{t("pairingHint")}</p>
              )}
            </div>
            <h3>{t("pairedDevices")}</h3>
            <div className="paired-devices">
              {remote.pairing?.devices.map((device) => (
                <div key={device.id}>
                  <span>
                    <strong>{device.name}</strong>
                    <small>
                      {t(
                        device.diagnostics
                          ? "diagnosticsAllowed"
                          : "diagnosticsDisabled",
                      )}
                    </small>
                  </span>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void act(() => api.revoke(device.id, !device.diagnostics))
                    }
                  >
                    {t(
                      device.diagnostics
                        ? "disableDiagnostics"
                        : "enableDiagnostics",
                    )}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => void act(() => api.revoke(device.id))}
                  >
                    {t("forgetDevice")}
                  </Button>
                </div>
              ))}
              {!remote.pairing?.devices.length && (
                <p className="muted">
                  {t(
                    remote.pairing ? "noPairedDevices" : "pairingsLoadOnStart",
                  )}
                </p>
              )}
            </div>
            <p className="muted small">{t("pairingBoundary")}</p>
          </section>
        </div>
      )}
    </>
  );
}
