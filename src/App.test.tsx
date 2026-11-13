import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { EntryRow, SessionSummary, TimelineRow } from "./lib/ipc/types";
import { api } from "./lib/ipc/client";
import App from "./App";
const data = vi.hoisted(() => ({
  sessions: [] as SessionSummary[],
  remote: { diagnosticRuns: [], sessions: [], listening: false },
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
vi.mock("./lib/ipc/client", () => ({
  desktop: true,
  api: { entryInfo: vi.fn() },
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
