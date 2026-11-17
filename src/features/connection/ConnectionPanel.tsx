import { commands } from "../../lib/commands/dispatcher";
import { useCommand, useModalCommands } from "../../lib/commands/react";
import { useEffect, useRef, useState } from "react";
import { Copy, Radio, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { api, desktop } from "../../lib/ipc/client";
import type { RemoteSnapshot } from "../../lib/ipc/types";
import { PairingQr } from "./PairingQr";

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
  const [host, setHost] = useState("0.0.0.0");
  const [port, setPort] = useState("9741");
  const [advertise, setAdvertise] = useState(true);
  const [diagnostics, setDiagnostics] = useState(true);
  const [expires, setExpires] = useState(0);
  const [lanIps, setLanIps] = useState<string[] | null>(null);
  const [addressLoading, setAddressLoading] = useState(false);
  const [addressError, setAddressError] = useState(false);
  const [addressRevision, setAddressRevision] = useState(0);
  const [copiedAddress, setCopiedAddress] = useState("");
  const selectedHost = remote.listening ? remote.host : host;
  const selectedPort = remote.listening ? String(remote.port) : port;
  const validPort =
    /^\d+$/.test(selectedPort) &&
    Number(selectedPort) >= 1 &&
    Number(selectedPort) <= 65535;
  const addresses =
    selectedHost === "127.0.0.1"
      ? validPort
        ? [`127.0.0.1:${selectedPort}`]
        : []
      : lanIps === null
        ? (remote.addresses ?? [])
        : validPort
          ? lanIps.map((ip) => `${ip}:${selectedPort}`)
          : [];
  useEffect(() => {
    if (!open || !desktop) return;
    let active = true;
    let revision = 0;
    setCopiedAddress("");
    const refresh = async () => {
      const current = ++revision;
      setAddressLoading(true);
      try {
        const values = await api.localAddresses();
        if (active && current === revision) {
          setLanIps(values);
          setAddressError(false);
        }
      } catch {
        if (active && current === revision) {
          setLanIps([]);
          setAddressError(true);
        }
      } finally {
        if (active && current === revision) setAddressLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [open, addressRevision]);
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
            <p className="connection-scope-hint">
              {t(
                (remote.listening ? remote.host : host) === "127.0.0.1"
                  ? "loopbackHint"
                  : "lanHint",
              )}
            </p>
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
            <div className="listener-addresses">
              <div className="address-heading">
                <strong>{t("computerAddress")}</strong>
                <Button
                  variant="ghost"
                  disabled={addressLoading}
                  onClick={() => setAddressRevision((value) => value + 1)}
                >
                  <RefreshCw />
                  {t("refreshAddresses")}
                </Button>
              </div>
              {addressLoading && lanIps === null && (
                <small role="status">{t("loading")}</small>
              )}
              {selectedHost === "0.0.0.0" && addressError && (
                <small role="alert">{t("localAddressesUnavailable")}</small>
              )}
              {addresses.map((address) => (
                <div className="address-row" key={address}>
                  <code>{address}</code>
                  <Button
                    variant="ghost"
                    size="icon"
                    title={t("copyAddress")}
                    aria-label={`${t("copyAddress")} ${address}`}
                    onClick={() =>
                      void api
                        .writeClipboard(address)
                        .then(() => setCopiedAddress(address))
                        .catch((error) => onError(String(error)))
                    }
                  >
                    <Copy />
                  </Button>
                  {copiedAddress === address && (
                    <small role="status">{t("copied")}</small>
                  )}
                </div>
              ))}
              {selectedHost === "0.0.0.0" &&
                !addressLoading &&
                !addressError &&
                lanIps?.length === 0 && <small>{t("noLanAddress")}</small>}
              <small>
                {remote.listening ? t("listening") : t("listenerNotStarted")}
              </small>
              {remote.listening && <small>{t(`mdns_${remote.mdns}`)}</small>}
            </div>
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
                  {remote.host === "0.0.0.0" && (
                    <PairingQr
                      key={remote.pairing.code}
                      addresses={addresses}
                      serverId={remote.pairing.serverId}
                      code={remote.pairing.code}
                      expires={expires}
                      onError={onError}
                    />
                  )}
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
