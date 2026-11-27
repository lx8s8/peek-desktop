import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { RecoveryStatus } from "../../lib/ipc/types";
import { FileTools } from "./FileTools";
import { api } from "../../lib/ipc/client";
vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  api: {
    recoveryStatus: vi.fn(async () => ({
      enabled: false,
      pending: false,
      available: false,
    })),
    setRecoveryEnabled: vi.fn(),
    saveRecovery: vi.fn(),
    restoreRecovery: vi.fn(),
    startNewRecovery: vi.fn(),
    exportScope: vi.fn(),
    prefetchBodies: vi.fn(),
    copyCurl: vi.fn(),
    writeClipboard: vi.fn(),
  },
}));
const emptyRecovery: RecoveryStatus = {
  enabled: false,
  pending: false,
  available: false,
  restored: false,
  usedBackup: false,
  updatedAt: null,
  bytes: 0,
  error: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.recoveryStatus).mockResolvedValue(emptyRecovery);
});
it("exports the entire captured scope and copies only the explicit request target", async () => {
  const scope = { kind: "network" as const, id: "file-archive-one" };
  vi.mocked(api.exportScope).mockResolvedValue(true);
  vi.mocked(api.copyCurl).mockResolvedValue("curl 'synthetic'");
  vi.mocked(api.writeClipboard).mockResolvedValue();
  const notice = vi.fn(),
    error = vi.fn();
  render(
    <FileTools
      scope={scope}
      networkId={scope.id}
      entryId="chosen"
      hasLogs
      onError={error}
      onNotice={notice}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "导出与恢复" }));
  fireEvent.click(
    screen.getByRole("button", { name: "导出当前全部日志 JSONL…" }),
  );
  await waitFor(() =>
    expect(api.exportScope).toHaveBeenCalledWith(scope, "jsonl"),
  );
  await waitFor(() => expect(notice).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "复制当前请求 cURL" }));
  await waitFor(() =>
    expect(api.copyCurl).toHaveBeenCalledWith(scope.id, "chosen"),
  );
  await waitFor(() =>
    expect(api.writeClipboard).toHaveBeenCalledWith("curl 'synthetic'"),
  );
  expect(error).not.toHaveBeenCalled();
});

it("protects pending recovery until explicitly restored and surfaces backup fallback", async () => {
  const pending = { ...emptyRecovery, available: true, pending: true };
  vi.mocked(api.recoveryStatus)
    .mockResolvedValueOnce(pending)
    .mockResolvedValue({
      ...pending,
      pending: false,
      restored: true,
      usedBackup: true,
    });
  vi.mocked(api.restoreRecovery).mockResolvedValue({
    sessionId: "restored-file",
    runId: null,
  });
  const restored = vi.fn(async () => {});
  render(
    <FileTools
      scope={{ kind: "network", id: "existing" }}
      networkId="existing"
      hasLogs={false}
      onError={vi.fn()}
      onNotice={vi.fn()}
      onRestored={restored}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /^导出与恢复 · 工作区恢复/ }),
  );
  expect(api.restoreRecovery).not.toHaveBeenCalled();
  expect(
    (
      screen.getByRole("button", {
        name: "立即保存工作区快照",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "恢复上次工作区" }));
  await waitFor(() =>
    expect(restored).toHaveBeenCalledWith({
      sessionId: "restored-file",
      runId: null,
    }),
  );
  await screen.findByText("最新快照损坏，已使用上一份有效快照。");
  expect(
    (
      screen.getByRole("button", {
        name: "恢复上次工作区",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("surfaces spill merge notice and prefetches remote bodies for online live sessions", async () => {
  vi.mocked(api.prefetchBodies).mockResolvedValue({
    totalCandidates: 5,
    fetched: 4,
    failed: 1,
  });
  const notice = vi.fn();
  const error = vi.fn();
  render(
    <FileTools
      scope={{ kind: "network", id: "live-session-1" }}
      networkId="live-session-1"
      liveOnline
      spilledCount={18}
      hasLogs={false}
      onError={error}
      onNotice={notice}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "导出与恢复" }));
  expect(
    screen.getByText(
      /包含 18 条磁盘冷存历史，保存 \.peek 或完整归档时将自动合并导出/,
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "补拉未加载正文…" }));
  await waitFor(() =>
    expect(api.prefetchBodies).toHaveBeenCalledWith("live-session-1"),
  );
  await waitFor(() =>
    expect(notice).toHaveBeenCalledWith("已补拉 4/5 条远端正文（失败 1）"),
  );
  expect(error).not.toHaveBeenCalled();
});
