import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type {
  DiagnosticRun,
  EntryRow,
  SessionSummary,
  TimelineRow,
} from "./lib/ipc/types";
import { api } from "./lib/ipc/client";
import App from "./App";
const data = vi.hoisted(() => ({
  sessions: [] as SessionSummary[],
  remote: {
    diagnosticRuns: [] as DiagnosticRun[],
    sessions: [],
    listening: false,
  },
}));
vi.mock("./lib/commands/native", () => ({
  useNativeMenu: () => false,
  useContextMenu: () => () => {},
}));
vi.mock("./features/connection/useWorkspace", () => ({
  useWorkspace: () => ({ ...data, refresh: vi.fn(async () => {}) }),
}));
vi.mock("./features/connection/ConnectionPanel", () => ({
  ConnectionPanel: () => null,
}));
vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Separator: () => null,
}));
vi.mock("./features/console/RequestTable", () => ({
  RequestTable: () => <span>request table</span>,
}));
vi.mock("./features/detail/DetailPane", () => ({
  DetailPane: ({ entry }: { entry: EntryRow | null }) => (
    <div data-testid="network-detail">
      {entry?.id ?? "no network selection"}
    </div>
  ),
}));
vi.mock("./features/diagnostics/DiagnosticsTable", () => ({
  DiagnosticsTable: () => <span>diagnostic table</span>,
}));
vi.mock("./features/diagnostics/DiagnosticDetail", () => ({
  DiagnosticDetail: () => <span>diagnostic detail</span>,
}));
vi.mock("./features/timeline/TimelineTable", () => ({
  TimelineTable: ({ onSelect }: { onSelect: (row: TimelineRow) => void }) => (
    <button
      onClick={() =>
        onSelect({
          id: "network:chosen",
          kind: "network",
          occurredAt: "2026-11-13T00:00:00Z",
          level: "completed",
          source: "test",
          message: "chosen",
          sessionId: "live-one",
          entryId: "chosen",
          runId: null,
          eventId: null,
          association: "time",
          relatedNetworkEntryId: null,
        })
      }
    >
      choose timeline request
    </button>
  ),
}));
vi.mock("./features/stream/ConsoleStream", () => ({
  emptyStreamView: {
    search: "",
    searchMode: "filter",
    kindFilter: "all",
    following: true,
    autoLoadBody: true,
    minTimestampMicros: null,
    compactAll: false,
    collapsedBlocks: [],
  },
  ConsoleStream: ({
    onSelect,
  }: {
    onSelect: (selection: {
      blockId: string;
      kind: string;
      sessionId: string | null;
      entryId: string | null;
      runId: string | null;
      eventId: string | null;
    }) => void;
  }) => (
    <button
      onClick={() =>
        onSelect({
          blockId: "res:live-one:chosen",
          kind: "http-response",
          sessionId: "live-one",
          entryId: "chosen",
          runId: null,
          eventId: null,
        })
      }
    >
      choose stream request
    </button>
  ),
}));
vi.mock("./lib/ipc/client", () => ({
  desktop: true,
  api: {
    entryInfo: vi.fn(),
    close: vi.fn(async () => {}),
    watchFiles: vi.fn(async () => () => {}),
    openPending: vi.fn(async () => null),
    hasPendingFiles: vi.fn(async () => false),
    archive: vi.fn(),
    listPlugins: vi.fn(async () => ({
      defaultPluginId: null,
      discoveryDir: null,
      plugins: [],
    })),
    parsePluginFilePath: vi.fn(),
    recoveryStatus: vi.fn(async () => ({
      enabled: false,
      pending: false,
      available: false,
    })),
  },
}));
const session = (id: string, generation = 1): SessionSummary => ({
  id,
  deviceId: "device",
  networkSessionId: id,
  online: true,
  generation,
  version: 1,
  filename: id,
  header: {
    formatVersion: 1,
    peekVersion: "2.1.1",
    name: id,
    platform: "macos",
    startedAt: "2026-11-13T00:00:00Z",
  },
  entryCount: 1,
  skipped: 0,
  newerFormat: false,
  rawBytes: 100,
});
const entry: EntryRow = {
  id: "chosen",
  source: "test",
  method: "GET",
  url: "https://synthetic.example.test",
  startedAt: "2026-11-13T00:00:00Z",
  durationMs: 1,
  status: 200,
  state: "completed",
  pinned: false,
  responseBytes: 0,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.hasPendingFiles).mockResolvedValue(false);
  vi.mocked(api.openPending).mockReset().mockResolvedValue(null);
  data.remote.diagnosticRuns = [];
  data.sessions = [session("live-one"), session("live-two")];
  vi.mocked(api.entryInfo).mockResolvedValue(entry);
});
it("keeps a timeline selection across sessions and invalidates it only when that session generation changes", async () => {
  const { rerender } = render(<App />);
  await screen.findByRole("button", { name: "时间线" });
  fireEvent.click(screen.getByRole("button", { name: "时间线" }));
  fireEvent.click(screen.getByText("choose timeline request"));
  await screen.findByText("chosen");
  fireEvent.click(screen.getByRole("button", { name: /^live-two\s*在线/ }));
  fireEvent.click(screen.getByRole("button", { name: /^live-one\s*在线/ }));
  await screen.findByText("chosen");
  data.sessions = [session("live-one", 2), session("live-two")];
  rerender(<App />);
  await screen.findByText("选择一条时间线事件");
  expect(screen.queryByText("chosen")).toBeNull();
});
it("does not publish a delayed timeline entry after changing tabs", async () => {
  let resolve!: (entry: EntryRow) => void;
  vi.mocked(api.entryInfo).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "时间线" }));
  fireEvent.click(screen.getByText("choose timeline request"));
  fireEvent.click(screen.getByRole("button", { name: /^日志/ }));
  await act(async () => resolve(entry));
  fireEvent.click(screen.getByRole("button", { name: "时间线" }));
  await waitFor(() =>
    expect(screen.getByTestId("network-detail").textContent).toBe(
      "no network selection",
    ),
  );
});

it("uses the same dispatcher for platform shortcuts, search focus and view buttons", async () => {
  render(<App />);
  await screen.findByRole("button", { name: "时间线" });
  fireEvent.keyDown(window, { key: "f", ctrlKey: true });
  expect(document.activeElement).toBe(
    screen.getByLabelText("搜索地址、方法、状态或来源…"),
  );
  fireEvent.keyDown(window, { key: "3", metaKey: true });
  expect(
    screen.getByRole("button", { name: "异常" }).getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "时间线" }));
  expect(
    screen.getByRole("button", { name: "时间线" }).getAttribute("aria-pressed"),
  ).toBe("true");
});

it("shows archived bound diagnostics and archives their network scope without a live device", async () => {
  data.sessions = [
    {
      ...session("file-archive-one"),
      deviceId: undefined,
      online: false,
      archive: { recovered: false, dropped: 2, evicted: 3, syncing: false },
    },
  ];
  data.remote.diagnosticRuns = [
    {
      id: "archive-run",
      runId: "original",
      deviceId: "archive",
      networkSessionKey: "file-archive-one",
      online: false,
      count: 1,
      received: 1,
      duplicates: 0,
      evicted: 0,
      gapCount: 0,
      version: 1,
      gaps: [],
    },
  ];
  vi.mocked(api.archive).mockResolvedValue(true);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /^日志/ }));
  expect(screen.getByText("diagnostic table")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存完整归档…" }));
  await waitFor(() =>
    expect(api.archive).toHaveBeenCalledWith({
      kind: "network",
      id: "file-archive-one",
    }),
  );
  data.remote.diagnosticRuns = [];
});

it("continues queued file imports after a bad file and releases the workspace", async () => {
  vi.mocked(api.hasPendingFiles).mockResolvedValue(true);
  vi.mocked(api.openPending)
    .mockRejectedValueOnce("unsupportedFile")
    .mockResolvedValueOnce({ sessionId: "live-two", runId: null })
    .mockResolvedValueOnce(null);
  render(<App />);
  await waitFor(() => expect(api.openPending).toHaveBeenCalledTimes(3));
  await screen.findByText("请选择 .peek、.peekbundle 或诊断 JSONL 文件。");
  await waitFor(() =>
    expect(
      (
        screen.getAllByRole("button", {
          name: "打开文件",
        })[0] as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
});

it("provides an independent console stream tab that links network entries without affecting network view", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "控制台" }));
  fireEvent.click(screen.getByText("choose stream request"));
  await screen.findByText("chosen");
  fireEvent.click(screen.getByRole("button", { name: "网络" }));
  expect(screen.getByText("request table")).toBeTruthy();
  expect(screen.getByTestId("network-detail").textContent).toBe(
    "no network selection",
  );
  fireEvent.click(screen.getByRole("button", { name: "控制台" }));
  await screen.findByText("chosen");
});

it("auto-switches to a newly reconnected online run for the same device and supports clearing offline runs", async () => {
  const oldOffline: SessionSummary = {
    ...session("live-old"),
    deviceId: "dev-same",
    online: false,
    filename: "iPhone 16 Pro",
    header: {
      formatVersion: 1,
      peekVersion: "2.1.1",
      name: "iPhone 16 Pro",
      platform: "ios",
      startedAt: "2026-11-27T01:00:00Z",
    },
  };
  const newOnline: SessionSummary = {
    ...session("live-new"),
    deviceId: "dev-same",
    online: true,
    filename: "iPhone 16 Pro",
    header: {
      formatVersion: 1,
      peekVersion: "2.1.1",
      name: "iPhone 16 Pro",
      platform: "ios",
      startedAt: "2026-11-27T01:10:00Z",
    },
  };

  data.sessions = [oldOffline];
  const { rerender } = render(<App />);
  await screen.findByRole("button", { name: /^iPhone 16 Pro/ });

  // 同一设备重启后以新 sessionId 重新连上，应自动从旧离线运行切换到新在线运行
  data.sessions = [oldOffline, newOnline];
  rerender(<App />);

  await waitFor(() => {
    const activeRunBtn = document.querySelector(
      ".device-run-item.active .device-run-select",
    );
    expect(activeRunBtn?.textContent).toContain("在线");
  });

  // 一键清理该设备的离线运行，仅关闭旧离线运行并提示结果
  fireEvent.click(
    screen.getByRole("button", { name: "清理 iPhone 16 Pro 的 1 条离线运行" }),
  );
  await waitFor(() => expect(api.close).toHaveBeenCalledWith("live-old"));
  expect(api.close).toHaveBeenCalledTimes(1);
  await screen.findByText("已清理 iPhone 16 Pro 的 1 条离线运行");
});
