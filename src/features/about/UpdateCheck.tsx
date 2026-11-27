import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { api, desktop } from "../../lib/ipc/client";
import type { UpdateInfo, UpdateProgress } from "../../lib/ipc/types";

const KNOWN_ERRORS = new Set([
  "updateRateLimited",
  "updateInvalidRelease",
  "updateBusy",
  "updateManifestFailed",
  "updateManifestMismatch",
  "updateNotChecked",
  "updateExpired",
  "updateCancelled",
  "updateDownloadFailed",
  "updateInstallFailed",
  "updateUnavailable",
]);

function mapUpdateError(error: unknown, fallback: string): string {
  const code = String(error);
  return KNOWN_ERRORS.has(code) ? code : fallback;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateCheck({
  request,
  onCheck,
  onBusyChange,
  initialResult = null,
  autoCheck,
  onAutoCheckChange,
  onResultChange,
}: {
  request: number;
  onCheck: () => void;
  onBusyChange?: (busy: boolean) => void;
  initialResult?: UpdateInfo | null;
  autoCheck?: boolean;
  onAutoCheckChange?: (enabled: boolean) => void;
  onResultChange?: (info: UpdateInfo) => void;
}) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [result, setResult] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState("");
  const installingRef = useRef(false);
  const onResultChangeRef = useRef(onResultChange);
  onResultChangeRef.current = onResultChange;

  useEffect(() => {
    installingRef.current = installing;
    onBusyChange?.(installing);
  }, [installing, onBusyChange]);

  useEffect(() => {
    return () => {
      // 卸载时如果仍在下载，通知后端取消以避免后台孤儿下载任务。
      if (installingRef.current && desktop) {
        void api.cancelUpdate().catch(() => {});
      }
      onBusyChange?.(false);
    };
  }, [onBusyChange]);

  useEffect(() => {
    if (installingRef.current) return;
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
        if (active) {
          setResult(value);
          onResultChangeRef.current?.(value);
        }
      })
      .catch((err) => {
        if (active) setError(mapUpdateError(err, "updateCheckFailed"));
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

  async function install() {
    if (checking || installing) return;
    setInstalling(true);
    setCancelling(false);
    setError("");
    setProgress({ phase: "download", downloaded: 0, total: null });
    try {
      await api.installUpdate((next) => setProgress(next));
    } catch (err) {
      setError(mapUpdateError(err, "updateDownloadFailed"));
      // 后端消费了本次待安装更新对象，保留手动下载入口并要求重新检查后再应用内安装。
      setResult((prev) => {
        const base = prev ?? initialResult;
        return base ? { ...base, canInstall: false } : null;
      });
    } finally {
      setInstalling(false);
      setCancelling(false);
      setProgress(null);
    }
  }

  async function cancel() {
    if (cancelling) return;
    setCancelling(true);
    try {
      const accepted = await api.cancelUpdate();
      if (!accepted) setCancelling(false);
    } catch (err) {
      setError(mapUpdateError(err, "updateUnavailable"));
      setCancelling(false);
    }
  }

  const busy = checking || installing;
  const displayedResult =
    result ?? (request === 0 && !checking && !error ? initialResult : null);
  const knownTotal = progress?.total != null && progress.total > 0;
  const percent =
    progress && knownTotal
      ? Math.min(100, Math.round((progress.downloaded / progress.total!) * 100))
      : null;

  return (
    <div className="update-check">
      <div className="update-check-bar">
        <Button disabled={!desktop || busy} onClick={onCheck}>
          <RefreshCw className={checking ? "spin" : ""} />
          {t(checking ? "checkingUpdates" : "checkUpdates")}
        </Button>
        {onAutoCheckChange && (
          <label className="checkbox-label update-auto-toggle">
            <input
              type="checkbox"
              checked={autoCheck ?? true}
              disabled={!desktop || busy}
              onChange={(event) => onAutoCheckChange(event.target.checked)}
            />
            {t("autoCheckUpdates")}
          </label>
        )}
      </div>
      {progress && (
        <div className="update-progress" role="status">
          <div className="update-progress-header">
            <span>
              {t(
                progress.phase === "install"
                  ? "installingUpdate"
                  : "downloadingUpdate",
              )}
            </span>
            {progress.phase === "download" && percent !== null && (
              <span className="muted">
                {percent}% · {formatBytes(progress.downloaded)} /{" "}
                {formatBytes(progress.total!)}
              </span>
            )}
          </div>
          <div className="update-progress-bar">
            <progress
              aria-label={t("downloadProgress")}
              max={knownTotal ? progress.total! : undefined}
              value={
                knownTotal
                  ? Math.min(progress.downloaded, progress.total!)
                  : undefined
              }
            />
            {progress.phase === "download" && (
              <Button
                size="sm"
                disabled={cancelling}
                onClick={() => void cancel()}
              >
                {t(cancelling ? "cancellingDownload" : "cancelDownload")}
              </Button>
            )}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="inline-note warning">
          {t(error)}
        </p>
      )}
      {displayedResult && (
        <div className="update-result" role="status">
          <p>
            {t(`update_${displayedResult.status}`, {
              version:
                displayedResult.latestVersion ?? displayedResult.currentVersion,
            })}
          </p>
          {displayedResult.status === "available" && (
            <>
              <div className="update-links">
                {displayedResult.canInstall ? (
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => void install()}
                  >
                    <Download size={13} />
                    {t("installAndRestart")}
                  </Button>
                ) : (
                  displayedResult.downloadUrl && (
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => void open(displayedResult.downloadUrl!)}
                    >
                      {t("downloadUpdate")}
                      <ExternalLink size={13} />
                    </Button>
                  )
                )}
                {displayedResult.releaseUrl && (
                  <Button
                    disabled={busy}
                    onClick={() => void open(displayedResult.releaseUrl!)}
                  >
                    {t("viewRelease")}
                    <ExternalLink size={13} />
                  </Button>
                )}
              </div>
              {displayedResult.notes && (
                <pre className="update-notes">{displayedResult.notes}</pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
