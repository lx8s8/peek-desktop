import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { TimelineTable } from "./TimelineTable";
import { api } from "../../lib/ipc/client";
import type { TimelinePage, TimelineRow } from "../../lib/ipc/types";
vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  api: { timeline: vi.fn() },
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 3) }, (_, index) => ({
        index,
        start: index * 36,
      })),
    getTotalSize: () => count * 36,
    scrollToIndex: vi.fn(),
  }),
}));
const row: TimelineRow = {
  id: "log",
  kind: "log",
  occurredAt: "2026-11-13T00:00:00.000001Z",
  level: "info",
  source: "app",
  message: "explicit log",
  runId: "run",
  eventId: "event",
  sessionId: "live-one",
  entryId: null,
  relatedNetworkEntryId: "request",
  association: "explicit",
};
const change = vi.fn(),
  select = vi.fn(),
  error = vi.fn();
const props = {
  scope: { kind: "network", id: "live-one" } as const,
  version: "1",
  view: { search: "", following: false },
  range: { from: "2026-11-13T00:00:00Z" },
  selected: null,
  onViewChange: change,
  onSelect: select,
  onError: error,
};
beforeEach(() => vi.clearAllMocks());
it("renders association semantics and navigates with the shared range without exposing payloads", async () => {
  vi.mocked(api.timeline).mockImplementation(async (_scope, query) => ({
    total: 1,
    offset: query.offset,
    revision: query.revision,
    rows: [row],
  }));
  render(<TimelineTable {...props} />);
  fireEvent.click(await screen.findByText("explicit log"));
  expect(screen.getByText("显式请求引用")).toBeTruthy();
  expect(screen.getByText(/按设备墙钟时间近似排序/)).toBeTruthy();
  expect(select).toHaveBeenCalledWith(row);
  fireEvent.keyDown(screen.getByRole("grid"), { key: "End" });
  await waitFor(() =>
    expect(api.timeline).toHaveBeenLastCalledWith(
      props.scope,
      expect.objectContaining({ offset: 0, limit: 1, range: props.range }),
    ),
  );
});
it("ignores a delayed timeline from another scope and cancels a pending keyboard jump on unmount", async () => {
  let old!: (page: TimelinePage) => void;
  let oldRevision = 0;
  vi.mocked(api.timeline)
    .mockImplementationOnce((_scope, query) => {
      oldRevision = query.revision;
      return new Promise((resolve) => {
        old = resolve;
      });
    })
    .mockImplementation(async (_scope, query) => ({
      total: 1,
      offset: 0,
      revision: query.revision,
      rows: [{ ...row, id: "new", message: "new scope" }],
    }));
  const { rerender, unmount } = render(<TimelineTable {...props} />);
  rerender(
    <TimelineTable
      {...props}
      scope={{ kind: "diagnostic", id: "other-run" }}
    />,
  );
  await screen.findByText("new scope");
  await act(async () =>
    old({ total: 1, offset: 0, revision: oldRevision, rows: [row] }),
  );
  expect(screen.queryByText("explicit log")).toBeNull();
  let jump!: (page: TimelinePage) => void;
  vi.mocked(api.timeline).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        jump = resolve;
      }),
  );
  fireEvent.keyDown(screen.getByRole("grid"), { key: "End" });
  unmount();
  select.mockClear();
  await act(async () =>
    jump({ total: 1, offset: 0, revision: 0, rows: [row] }),
  );
  expect(select).not.toHaveBeenCalled();
});
