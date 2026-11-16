import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { api } from "../../lib/ipc/client";

// This link carries a short-lived pairing code, never a persistent device token.
export function pairingLink(
  address: string,
  serverId: string,
  code: string,
  expiresAt: number,
) {
  const endpoint = new URL(`ws://${address}/`);
  const query = new URLSearchParams({
    v: "1",
    host: endpoint.hostname,
    port: endpoint.port || "80",
    serverId,
    code,
    expiresAt: String(expiresAt),
  });
  return `peek-desktop://pair?${query}`;
}

export function PairingQr({
  addresses,
  serverId,
  code,
  expires,
  onError,
}: {
  addresses: string[];
  serverId: string;
  code: string;
  expires: number;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(addresses[0] ?? "");
  const [expiresAt] = useState(() => Math.floor(Date.now() / 1000) + expires);
  const [copied, setCopied] = useState(false);
  const address = addresses.includes(selected) ? selected : addresses[0];
  if (!address) return <p className="muted">{t("noLanAddress")}</p>;
  const link = pairingLink(address, serverId, code, expiresAt);
  return (
    <div className="pairing-qr">
      <label>
        {t("pairingAddress")}
        <select
          value={address}
          onChange={(event) => {
            setSelected(event.target.value);
            setCopied(false);
          }}
        >
          {addresses.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
        </select>
      </label>
      <QRCodeSVG
        role="img"
        aria-label={t("pairingQr")}
        value={link}
        size={200}
        marginSize={4}
        bgColor="#ffffff"
        fgColor="#000000"
      />
      <Button
        onClick={() => {
          void api
            .writeClipboard(link)
            .then(() => setCopied(true))
            .catch((error: unknown) => onError(String(error)));
        }}
      >
        {t(copied ? "pairingLinkCopied" : "copyPairingLink")}
      </Button>
      <small className="muted">{t("pairingQrHint")}</small>
    </div>
  );
}
