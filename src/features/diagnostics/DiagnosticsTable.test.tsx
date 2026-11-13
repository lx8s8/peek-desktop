import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { DiagnosticsTable, type LogSelection } from "./DiagnosticsTable";
import { emptyDiagnosticView, type DiagnosticView } from "./view";
import { api } from "../../lib/ipc/client";
import type {
  DiagnosticRun,
  ReviewPage,
  DiagnosticRow,
} from "../../lib/ipc/types";
vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  api: {
    review: vi.fn(),
    copyDiagnostics: vi.fn(),
    writeClipboard: vi.fn(async () => {}),
    exportDiagnostics: vi.fn(),
  },
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
const run: DiagnosticRun = {
  id: "run",
  runId: "app-run",
  deviceId: "device",
  networkSessionKey: null,
  online: true,
  count: 3,
  received: 3,
  duplicates: 0,
  evicted: 0,
  gapCount: 0,
  version: 1,
  gaps: [],
};
const error = vi.fn();
function rows(): DiagnosticRow[] {
  return ["first", "second", "third"].map((eventId) => ({
    eventId,
    sequence: "1",
    occurredAt: "2026-11-13T00:00:00.000001Z",
    kind: "log",
    level: "info",
    source: "app",
    tag: null,
    message: eventId,
    emitterId: "main",
    truncated: false,
  }));
}
function page(revision: number): ReviewPage {
  return {
    rows: rows(),
    total: 3,
    offset: 0,
    revision,
    groups: [],
    facets: { sources: ["app"], tags: [], emitters: ["main"], limited: false },
  };
}
function Harness({
  initial = emptyDiagnosticView,
  exceptions = false,
}: {
  initial?: DiagnosticView;
  exceptions?: boolean;
}) {
  const [view, setView] = useState(initial);
  const [selected, setSelected] = useState<LogSelection | null>(null);
  const [selection, setSelection] = useState<LogSelection[]>([]);
  return (
    <DiagnosticsTable
      runs={[run]}
      exceptions={exceptions}
      selected={selected}
      selection={selection}
      view={view}
      range={{}}
      onViewChange={(update) =>
        setView((previous) => ({ ...previous, ...update }))
      }
      onSelect={(selected, all) => {
        setSelected(selected);
        setSelection(all);
      }}
      onError={error}
    />
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.review).mockImplementation(async (_id, query) =>
    page(query.revision),
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
});
it("supports modifier selection, copies exact selected ids and clears selection without removing events", async () => {
  vi.mocked(api.copyDiagnostics).mockResolvedValue("first\n\nsecond");
  render(<Harness />);
  fireEvent.click(await screen.findByText("first"));
  fireEvent.click(screen.getByText("second"), { ctrlKey: true });
  expect(screen.getByText("已选 2 条")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
  await waitFor(() =>
    expect(api.copyDiagnostics).toHaveBeenCalledWith(
      [
        { runId: "run", eventId: "first" },
        { runId: "run", eventId: "second" },
      ],
      "message",
    ),
  );
  expect(
    screen.getByText("已暂停自动滚动，数据仍在接收和按容量淘汰。"),
  ).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("grid"), { key: "Delete" });
  expect(screen.getByText("已选 0 条")).toBeTruthy();
  expect(screen.getByText("first")).toBeTruthy();
  expect(error).not.toHaveBeenCalled();
});
it("ignores a previous filter response after the tag changes", async () => {
  let old!: (page: ReviewPage) => void;
  let oldRevision = 0;
  vi.mocked(api.review)
    .mockImplementationOnce((_id, query) => {
      oldRevision = query.revision;
      return new Promise((resolve) => {
        old = resolve;
      });
    })
    .mockImplementation(async (_id, query) => ({
      ...page(query.revision),
      rows: [{ ...rows()[0], message: "new tag event" }],
      total: 1,
    }));
  const change = vi.fn(),
    select = vi.fn();
  const props = {
    runs: [run],
    exceptions: false,
    selected: null,
    selection: [],
    range: {},
    onViewChange: change,
    onSelect: select,
    onError: error,
  };
  const { rerender } = render(
    <DiagnosticsTable
      {...props}
      view={{ ...emptyDiagnosticView, tag: "old" }}
    />,
  );
  rerender(
    <DiagnosticsTable
      {...props}
      view={{ ...emptyDiagnosticView, tag: "new" }}
    />,
  );
  await screen.findByText("new tag event");
  await act(async () => old(page(oldRevision)));
  expect(screen.queryByText("first")).toBeNull();
  expect(screen.getByText("new tag event")).toBeTruthy();
});
it("keeps a restored view selection on mount and passes all filters to keyboard navigation", async () => {
  const select = vi.fn(),
    change = vi.fn();
  const selected = { runId: "run", eventId: "first" };
  render(
    <DiagnosticsTable
      runs={[run]}
      exceptions={false}
      selected={selected}
      selection={[selected]}
      view={{
        ...emptyDiagnosticView,
        source: "app",
        tag: "payments",
        emitter: "main",
        following: false,
      }}
      range={{ from: "2026-11-13T00:00:00Z" }}
      onViewChange={change}
      onSelect={select}
      onError={error}
    />,
  );
  await screen.findByText("first");
  expect(select).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("grid"), { key: "End" });
  await waitFor(() =>
    expect(api.review).toHaveBeenLastCalledWith(
      "run",
      expect.objectContaining({
        offset: 2,
        limit: 1,
        source: "app",
        tag: "payments",
        emitter: "main",
        range: { from: "2026-11-13T00:00:00Z" },
      }),
    ),
  );
});

it("opens a fingerprint group as original members and can return to the retained group list", async () => {
  vi.mocked(api.review).mockImplementation(async (_id, query) =>
    query.grouped
      ? {
          ...page(query.revision),
          total: 1,
          rows: [],
          groups: [
            {
              fingerprint: "group-one",
              exceptionType: "StateError",
              message: "repeated exception",
              count: 2,
              firstAt: "2026-11-13T00:00:00Z",
              lastAt: "2026-11-13T00:00:01Z",
              latestEventId: "second",
            },
          ],
        }
      : page(query.revision),
  );
  render(
    <Harness exceptions initial={{ ...emptyDiagnosticView, grouped: true }} />,
  );
  fireEvent.click(await screen.findByText("repeated exception"));
  await screen.findByText("first");
  expect(api.review).toHaveBeenLastCalledWith(
    "run",
    expect.objectContaining({
      grouped: false,
      fingerprint: "group-one",
      exceptions: true,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "返回分组" }));
  await screen.findByText("repeated exception");
});
