import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { api, desktop } from "../../lib/ipc/client";
import type { UpdateInfo } from "../../lib/ipc/types";

export function UpdateCheck({
  request,
  onCheck,
}: {
  request: number;
  onCheck: () => void;
}) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!request) {
      setChecking(false);
      setResult(null);
      setError("");
      return;
    }
    if (!desktop) return;
    let active = true;
    setChecking(true);
    setResult(null);
    setError("");
    void api
      .checkUpdates()
      .then((value) => {
        if (active) setResult(value);
      })
      .catch((error) => {
        if (active)
          setError(
            ["updateRateLimited", "updateInvalidRelease"].includes(
              String(error),
            )
              ? String(error)
              : "updateCheckFailed",
          );
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [request]);
  async function open(url: string) {
    try {
      await api.openReleaseLink(url);
    } catch {
      setError("openLinkFailed");
    }
  }
  return (
    <div className="update-check">
      <Button disabled={!desktop || checking} onClick={onCheck}>
        <RefreshCw className={checking ? "spin" : ""} />
        {t(checking ? "checkingUpdates" : "checkUpdates")}
      </Button>
      {error && (
        <p role="alert" className="inline-note warning">
          {t(error)}
        </p>
      )}
      {result && (
        <div className="update-result" role="status">
          <p>
            {t(`update_${result.status}`, {
              version: result.latestVersion ?? result.currentVersion,
            })}
          </p>
          {result.status === "available" && (
            <>
              <div className="update-links">
                {result.downloadUrl && (
                  <Button
                    variant="primary"
                    onClick={() => void open(result.downloadUrl!)}
                  >
                    {t("downloadUpdate")}
                    <ExternalLink size={13} />
                  </Button>
                )}
                {result.releaseUrl && (
                  <Button onClick={() => void open(result.releaseUrl!)}>
                    {t("viewRelease")}
                    <ExternalLink size={13} />
                  </Button>
                )}
              </div>
              {result.notes && (
                <pre className="update-notes">{result.notes}</pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
