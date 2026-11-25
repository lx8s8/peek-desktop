import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { UpdateCheck } from "./UpdateCheck";
import { api } from "../../lib/ipc/client";
import type { UpdateInfo, UpdateProgress } from "../../lib/ipc/types";

vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  api: {
    checkUpdates: vi.fn(),
    installUpdate: vi.fn(),
    cancelUpdate: vi.fn(),
    openReleaseLink: vi.fn(),
  },
}));

const release: UpdateInfo = {
  status: "available",
  currentVersion: "0.1.0",
  latestVersion: "0.2.0",
  releaseUrl: "https://github.com/lx8s8/peek-desktop/releases/tag/v0.2.0",
  downloadUrl:
    "https://github.com/lx8s8/peek-desktop/releases/download/v0.2.0/Peek-Desktop_0.2.0_macos-arm64-unsigned.dmg",
  canInstall: false,
  notes: "更新说明 <img src=x onerror=alert(1)>",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.checkUpdates).mockResolvedValue(release);
  vi.mocked(api.installUpdate).mockResolvedValue(undefined);
  vi.mocked(api.cancelUpdate).mockResolvedValue(true);
  vi.mocked(api.openReleaseLink).mockResolvedValue(undefined);
});

it("checks only when requested and offers the matching release download without rendering captured markup", async () => {
  const check = vi.fn();
  const { rerender, container } = render(
    <UpdateCheck request={0} onCheck={check} />,
  );
  expect(api.checkUpdates).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "检查更新…" }));
  expect(check).toHaveBeenCalledOnce();
  rerender(<UpdateCheck request={1} onCheck={check} />);
  await screen.findByText("发现新版本 0.2.0");
  expect(container.querySelector("img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "下载新版" }));
  expect(api.openReleaseLink).toHaveBeenCalledWith(release.downloadUrl);
});

it("downloads, reports progress, allows cancellation and hides cancel button while installing", async () => {
  vi.mocked(api.checkUpdates).mockResolvedValue({
    ...release,
    canInstall: true,
  });
  let emitProgress!: (next: UpdateProgress) => void;
  let resolveInstall!: () => void;
  vi.mocked(api.installUpdate).mockImplementationOnce((onProgress) => {
    emitProgress = onProgress;
    return new Promise((resolve) => {
      resolveInstall = resolve;
    });
  });

  const busy = vi.fn();
  render(<UpdateCheck request={1} onCheck={vi.fn()} onBusyChange={busy} />);
  const installBtn = await screen.findByRole("button", {
    name: "下载并安装，完成后重启",
  });
  fireEvent.click(installBtn);

  expect(busy).toHaveBeenCalledWith(true);
  expect(screen.getByText("正在下载更新…")).toBeTruthy();

  act(() => {
    emitProgress({
      phase: "download",
      downloaded: 5 * 1024 * 1024,
      total: 10 * 1024 * 1024,
    });
  });
  expect(screen.getByText("50% · 5.0 MB / 10.0 MB")).toBeTruthy();

  const cancelBtn = screen.getByRole("button", { name: "取消下载" });
  fireEvent.click(cancelBtn);
  expect(api.cancelUpdate).toHaveBeenCalledOnce();

  act(() => {
    emitProgress({
      phase: "install",
      downloaded: 10 * 1024 * 1024,
      total: 10 * 1024 * 1024,
    });
  });
  expect(screen.getByText("正在安装更新，完成后将自动重启…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /取消/ })).toBeNull();

  await act(async () => resolveInstall());
  expect(busy).toHaveBeenLastCalledWith(false);
});

it("falls back to manual download after an in-app install failure or cancellation", async () => {
  vi.mocked(api.checkUpdates).mockResolvedValue({
    ...release,
    canInstall: true,
  });
  vi.mocked(api.installUpdate).mockRejectedValueOnce("updateCancelled");

  render(<UpdateCheck request={1} onCheck={vi.fn()} />);
  const installBtn = await screen.findByRole("button", {
    name: "下载并安装，完成后重启",
  });
  fireEvent.click(installBtn);

  await screen.findByRole("alert");
  expect(screen.getByText("已取消下载更新。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "下载新版" })).toBeTruthy();
});

it("ignores late checks and displays retryable failures", async () => {
  let resolveOld!: (value: UpdateInfo) => void;
  vi.mocked(api.checkUpdates)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockRejectedValue("updateRateLimited");
  const { rerender } = render(<UpdateCheck request={1} onCheck={vi.fn()} />);
  rerender(<UpdateCheck request={2} onCheck={vi.fn()} />);
  await screen.findByRole("alert");
  expect(screen.getByText(/GitHub 请求过于频繁/)).toBeTruthy();
  await act(async () => resolveOld(release));
  expect(screen.queryByText("发现新版本 0.2.0")).toBeNull();
});

it("reports current versions and missing releases without offering a downgrade", async () => {
  vi.mocked(api.checkUpdates).mockResolvedValue({
    ...release,
    status: "current",
  });
  const { rerender } = render(<UpdateCheck request={1} onCheck={vi.fn()} />);
  await screen.findByText("当前已是最新版本 0.2.0");
  expect(screen.queryByRole("button", { name: "下载新版" })).toBeNull();
  vi.mocked(api.checkUpdates).mockResolvedValue({
    ...release,
    status: "notPublished",
  });
  rerender(<UpdateCheck request={2} onCheck={vi.fn()} />);
  await screen.findByText(/尚未发布正式版本/);
});

it("clears pending state when the about menu resets the check", async () => {
  let resolve!: (value: UpdateInfo) => void;
  vi.mocked(api.checkUpdates).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { rerender } = render(<UpdateCheck request={1} onCheck={vi.fn()} />);
  expect(
    (screen.getByRole("button", { name: "正在检查…" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  rerender(<UpdateCheck request={0} onCheck={vi.fn()} />);
  expect(
    (screen.getByRole("button", { name: "检查更新…" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  await act(async () => resolve(release));
  expect(screen.queryByText("发现新版本 0.2.0")).toBeNull();
});
