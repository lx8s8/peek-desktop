import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { UpdateCheck } from "./UpdateCheck";
import { api } from "../../lib/ipc/client";
import type { UpdateInfo } from "../../lib/ipc/types";
vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  api: { checkUpdates: vi.fn(), openReleaseLink: vi.fn() },
}));
const release: UpdateInfo = {
  status: "available",
  currentVersion: "0.1.0",
  latestVersion: "0.2.0",
  releaseUrl: "https://github.com/lx8s8/peek-desktop/releases/tag/v0.2.0",
  downloadUrl:
    "https://github.com/lx8s8/peek-desktop/releases/download/v0.2.0/Peek-Desktop_0.2.0_macos-arm64-unsigned.dmg",
  notes: "更新说明 <img src=x onerror=alert(1)>",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.checkUpdates).mockResolvedValue(release);
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
