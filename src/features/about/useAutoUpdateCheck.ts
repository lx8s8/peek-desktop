import { useCallback, useEffect, useRef, useState } from "react";
import { api, desktop } from "../../lib/ipc/client";
import type { UpdateInfo } from "../../lib/ipc/types";
import { readUpdatePrefs, writeUpdatePrefs } from "../../lib/preferences";

export const AUTO_CHECK_DELAY_MS = 3_000;
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 桌面端启动后静默自动检测更新，并管理顶部更新提示横幅与「忽略此版本」偏好。 */
export function useAutoUpdateCheck({
  delayMs = AUTO_CHECK_DELAY_MS,
  intervalMs = AUTO_CHECK_INTERVAL_MS,
}: {
  delayMs?: number;
  intervalMs?: number;
} = {}) {
  const initialPrefs = useRef(readUpdatePrefs());
  const [autoCheck, setAutoCheckState] = useState(
    initialPrefs.current.autoCheck,
  );
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(
    initialPrefs.current.dismissedVersion,
  );
  const dismissedRef = useRef<string | null>(dismissedVersion);
  dismissedRef.current = dismissedVersion;

  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(
    null,
  );
  const [bannerVisible, setBannerVisible] = useState(false);

  const setAutoCheck = useCallback((next: boolean) => {
    setAutoCheckState(next);
    writeUpdatePrefs({
      autoCheck: next,
      dismissedVersion: dismissedRef.current,
    });
  }, []);

  const dismissBanner = useCallback(() => {
    setBannerVisible(false);
  }, []);

  const skipVersion = useCallback(
    (version?: string | null) => {
      const target = version ?? availableUpdate?.latestVersion ?? null;
      if (!target) {
        setBannerVisible(false);
        return;
      }
      dismissedRef.current = target;
      setDismissedVersion(target);
      setBannerVisible(false);
      setAvailableUpdate(null);
      writeUpdatePrefs({
        autoCheck,
        dismissedVersion: target,
      });
    },
    [autoCheck, availableUpdate?.latestVersion],
  );

  // 同步手动检查更新结果：若已最新则清除提示；若发现可用新版则同步角标
  const syncResult = useCallback(
    (info: UpdateInfo) => {
      if (info.status === "available" && info.latestVersion) {
        setAvailableUpdate(info);
        if (dismissedRef.current === info.latestVersion) {
          dismissedRef.current = null;
          setDismissedVersion(null);
          writeUpdatePrefs({ autoCheck, dismissedVersion: null });
        }
      } else {
        setAvailableUpdate(null);
        setBannerVisible(false);
      }
    },
    [autoCheck],
  );

  useEffect(() => {
    if (!desktop || !autoCheck || typeof api.checkUpdates !== "function") {
      return;
    }
    let active = true;
    let intervalId: number | null = null;

    const runCheck = () => {
      void api
        .checkUpdates()
        .then((info) => {
          if (!active) return;
          if (info.status === "available" && info.latestVersion) {
            if (dismissedRef.current === info.latestVersion) {
              return;
            }
            setAvailableUpdate(info);
            setBannerVisible(true);
          } else {
            setAvailableUpdate(null);
            setBannerVisible(false);
          }
        })
        .catch(() => {
          // 后台自动检测失败（断网、限流等）保持静默，不弹出错误条打扰用户
        });
    };

    const timerId = window.setTimeout(() => {
      runCheck();
      if (intervalMs > 0) {
        intervalId = window.setInterval(runCheck, intervalMs);
      }
    }, delayMs);

    return () => {
      active = false;
      window.clearTimeout(timerId);
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, [autoCheck, delayMs, intervalMs]);

  return {
    availableUpdate,
    bannerVisible,
    autoCheck,
    setAutoCheck,
    dismissBanner,
    skipVersion,
    syncResult,
  };
}
