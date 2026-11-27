import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AboutPanel } from "./AboutPanel";
import { useAutoUpdateCheck } from "./useAutoUpdateCheck";
import { api } from "../../lib/ipc/client";
import type { UpdateInfo } from "../../lib/ipc/types";
import { readUpdatePrefs, writeUpdatePrefs } from "../../lib/preferences";

vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  api: {
    appInfo: vi.fn(),
    legalText: vi.fn(),
    openProjectLink: vi.fn(),
    checkUpdates: vi.fn(),
    installUpdate: vi.fn(),
    cancelUpdate: vi.fn(),
    openReleaseLink: vi.fn(),
  },
}));

const updateV051: UpdateInfo = {
  status: "available",
  currentVersion: "0.5.0",
  latestVersion: "0.5.1",
  releaseUrl: "https://github.com/lx8s8/peek-desktop/releases/tag/v0.5.1",
  downloadUrl:
    "https://github.com/lx8s8/peek-desktop/releases/download/v0.5.1/Peek-Desktop_0.5.1_macos-arm64-unsigned.dmg",
  canInstall: true,
  notes: "自动检测更新提示已就绪",
};

function Harness() {
  const [openUpdateNonce, setOpenUpdateNonce] = useState(0);
  const {
    availableUpdate,
    bannerVisible,
    autoCheck,
    setAutoCheck,
    dismissBanner,
    skipVersion,
    syncResult,
  } = useAutoUpdateCheck({ delayMs: 100, intervalMs: 0 });

  return (
    <div>
      <AboutPanel
        availableUpdate={availableUpdate}
        autoCheck={autoCheck}
        onAutoCheckChange={setAutoCheck}
        onUpdateResult={syncResult}
        openUpdateNonce={openUpdateNonce}
      />
      {bannerVisible && availableUpdate?.latestVersion && (
        <div role="status" data-testid="update-banner">
          <span>发现新版本 {availableUpdate.latestVersion}</span>
          <button
            type="button"
            onClick={() => {
              dismissBanner();
              setOpenUpdateNonce((v) => v + 1);
            }}
          >
            查看并更新
          </button>
          <button
            type="button"
            onClick={() => skipVersion(availableUpdate.latestVersion)}
          >
            忽略此版本
          </button>
        </div>
      )}
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.useFakeTimers();
  vi.mocked(api.appInfo).mockResolvedValue({
    version: "0.5.0",
    platform: "macos",
    architecture: "aarch64",
  });
  vi.mocked(api.checkUpdates).mockResolvedValue(updateV051);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAutoUpdateCheck 自动检测更新提示", () => {
  it("启动延迟后静默检测并展示横幅与角标，点击查看后直接呈现一键安装", async () => {
    render(<Harness />);
    expect(api.checkUpdates).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });

    expect(api.checkUpdates).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("update-banner")).toBeTruthy();
    expect(document.querySelector(".about-update-dot")).toBeTruthy();

    // 点击「查看并更新」直接打开关于弹窗并复用已获取结果，不重复调用 checkUpdates
    fireEvent.click(screen.getByRole("button", { name: "查看并更新" }));
    expect(screen.queryByTestId("update-banner")).toBeNull();
    expect(screen.getByText("发现新版本 0.5.1")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "下载并安装，完成后重启" }),
    ).toBeTruthy();
    expect(api.checkUpdates).toHaveBeenCalledTimes(1);
  });

  it("忽略指定版本后不再重复提示同一版本，但遇到更高版本自动恢复提示", async () => {
    const { unmount } = render(<Harness />);
    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });
    expect(screen.getByTestId("update-banner")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "忽略此版本" }));
    expect(screen.queryByTestId("update-banner")).toBeNull();
    expect(document.querySelector(".about-update-dot")).toBeNull();
    expect(readUpdatePrefs().dismissedVersion).toBe("0.5.1");
    unmount();

    // 重新挂载检测到同一版本 0.5.1，应保持静默
    const second = render(<Harness />);
    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });
    expect(screen.queryByTestId("update-banner")).toBeNull();
    second.unmount();

    // 发布更高版本 0.6.0，应自动重新提示
    vi.mocked(api.checkUpdates).mockResolvedValue({
      ...updateV051,
      latestVersion: "0.6.0",
    });
    render(<Harness />);
    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });
    expect(screen.getByTestId("update-banner").textContent).toContain("0.6.0");
  });

  it("后台网络异常保持完全静默，且关闭自动检测开关后不再自动请求", async () => {
    vi.mocked(api.checkUpdates).mockRejectedValueOnce("updateCheckFailed");
    const first = render(<Harness />);
    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });
    expect(screen.queryByTestId("update-banner")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    first.unmount();

    vi.mocked(api.checkUpdates).mockClear();
    writeUpdatePrefs({ autoCheck: false, dismissedVersion: null });
    render(<Harness />);
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(api.checkUpdates).not.toHaveBeenCalled();
  });
});
