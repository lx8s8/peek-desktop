import { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RequestTable, type RequestTableMeta } from "./RequestTable";
import { api } from "../../lib/ipc/client";
import type { QueryPage } from "../../lib/ipc/types";
import type { EntryRow } from "../../lib/ipc/types";

vi.mock("../../lib/ipc/client", () => ({ api: { query: vi.fn() } }));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 10) }, (_, index) => ({
        index,
        start: index * 34,
      })),
    getTotalSize: () => count * 34,
    scrollToIndex: vi.fn(),
  }),
}));

it("ignores an old search result when the new query has already completed", async () => {
  let resolveOld!: (value: QueryPage) => void;
  let oldRevision = 0;
  const count = vi.fn();
  const error = vi.fn();
  const select = vi.fn();
  vi.mocked(api.query)
    .mockImplementationOnce((_id, _search, _filter, _offset, revision) => {
      oldRevision = revision;
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    })
    .mockImplementation(async (_id, _search, _filter, offset, revision) => ({
      total: 7,
      offset,
      rows: [],
      revision,
    }));
  const { rerender } = render(
    <RequestTable
      sessionId="one"
      search="old"
      filter="all"
      onCount={count}
      onError={error}
      onSelect={select}
    />,
  );
  rerender(
    <RequestTable
      sessionId="one"
      search="new"
      filter="all"
      onCount={count}
      onError={error}
      onSelect={select}
    />,
  );
  await waitFor(() => expect(count).toHaveBeenLastCalledWith(7));
  await act(async () =>
    resolveOld({ total: 999, offset: 0, rows: [], revision: oldRevision }),
  );
  expect(count).toHaveBeenLastCalledWith(7);
  expect(error).not.toHaveBeenCalled();
});

it("can jump directly to the last record of a large query using the keyboard", async () => {
  const count = vi.fn();
  const select = vi.fn();
  const error = vi.fn();
  const entry: EntryRow = {
    id: "last",
    source: "test",
    method: "GET",
    url: "https://example.test/last",
    startedAt: "2026-11-13T00:00:00.000Z",
    durationMs: null,
    status: null,
    state: "pending",
    pinned: false,
    responseBytes: null,
  };
  vi.mocked(api.query)
    .mockReset()
    .mockImplementation(
      async (_id, _search, _filter, offset, revision, limit) => ({
        total: 100000,
        offset,
        revision,
        rows: limit === 1 ? [entry] : [],
      }),
    );
  render(
    <RequestTable
      sessionId="large"
      search=""
      filter="all"
      onCount={count}
      onError={error}
      onSelect={select}
    />,
  );
  await waitFor(() => expect(count).toHaveBeenCalledWith(100000));
  fireEvent.keyDown(screen.getByRole("grid"), { key: "End" });
  await waitFor(() => expect(select).toHaveBeenCalledWith(entry));
  expect(api.query).toHaveBeenCalledWith("large", "", "all", 99999, 0, 1, {});
});

it("supports tri-state sorting on duration, size, and time headers with aria-sort", async () => {
  const count = vi.fn();
  const select = vi.fn();
  const error = vi.fn();
  const onSortChange = vi.fn();

  vi.mocked(api.query)
    .mockReset()
    .mockImplementation(async (_id, _search, _filter, offset, revision) => ({
      total: 0,
      offset,
      revision,
      rows: [],
      latestSeq: 5,
      hiddenCount: 0,
      totalBytes: 1024,
      maxBytes: null,
    }));

  const { rerender } = render(
    <RequestTable
      sessionId="sortable"
      search=""
      filter="all"
      sortBy={null}
      sortDir="desc"
      onSortChange={onSortChange}
      onCount={count}
      onError={error}
      onSelect={select}
    />,
  );
  await waitFor(() => expect(count).toHaveBeenCalledWith(0));

  const durationBtn = screen.getByRole("button", { name: "耗时" });
  const durationHeader = durationBtn.closest('[role="columnheader"]');
  expect(durationHeader?.getAttribute("aria-sort")).toBeNull();

  // 第 1 次点击：降序（最慢优先）
  fireEvent.click(durationBtn);
  expect(onSortChange).toHaveBeenLastCalledWith("duration", "desc");

  rerender(
    <RequestTable
      sessionId="sortable"
      search=""
      filter="all"
      sortBy="duration"
      sortDir="desc"
      onSortChange={onSortChange}
      onCount={count}
      onError={error}
      onSelect={select}
    />,
  );
  expect(durationHeader?.getAttribute("aria-sort")).toBe("descending");
  await waitFor(() =>
    expect(api.query).toHaveBeenLastCalledWith(
      "sortable",
      "",
      "all",
      0,
      expect.any(Number),
      300,
      {},
      undefined,
      [],
      "duration",
      "desc",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      null,
    ),
  );

  // 第 2 次点击：升序
  fireEvent.click(durationBtn);
  expect(onSortChange).toHaveBeenLastCalledWith("duration", "asc");

  rerender(
    <RequestTable
      sessionId="sortable"
      search=""
      filter="all"
      sortBy="duration"
      sortDir="asc"
      onSortChange={onSortChange}
      onCount={count}
      onError={error}
      onSelect={select}
    />,
  );
  expect(durationHeader?.getAttribute("aria-sort")).toBe("ascending");

  // 第 3 次点击：恢复默认顺序
  fireEvent.click(durationBtn);
  expect(onSortChange).toHaveBeenLastCalledWith(null, "desc");
});

it("shows retained history restore button and eviction details when cleared", async () => {
  const count = vi.fn();
  const select = vi.fn();
  const error = vi.fn();
  const onRestoreHistory = vi.fn();

  vi.mocked(api.query)
    .mockReset()
    .mockImplementation(async (_id, _search, _filter, offset, revision) => ({
      total: 0,
      offset,
      revision,
      rows: [],
      latestSeq: 120,
      hiddenCount: 95,
      totalBytes: 7 * 1024 * 1024,
      maxBytes: 8 * 1024 * 1024,
    }));

  render(
    <RequestTable
      sessionId="live-1"
      live
      search=""
      filter="all"
      afterSeq={120}
      clearMarkSeq={120}
      clearEvictedCount={25}
      onRestoreHistory={onRestoreHistory}
      onCount={count}
      onError={error}
      onSelect={select}
    />,
  );

  await screen.findByText("已清屏，等待新请求");
  expect(
    screen.getByText(
      /清屏前尚保留 95 条历史可切回查看，另有 25 条因超出容量上限已自动淘汰/,
    ),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /查看历史 \(95\)/ }));
  expect(onRestoreHistory).toHaveBeenCalledOnce();
});

it("forwards method, status, and body search filters and toggles optional columns", async () => {
  localStorage.clear();
  const count = vi.fn();
  const select = vi.fn();
  const error = vi.fn();
  const onMeta = vi.fn();

  vi.mocked(api.query)
    .mockReset()
    .mockImplementation(async (_id, _search, _filter, offset, revision) => ({
      total: 0,
      offset,
      revision,
      rows: [],
      latestSeq: 20,
      hiddenCount: 0,
      totalBytes: 2048,
      maxBytes: 8 * 1024 * 1024,
      spilledCount: 15,
      spilledBytes: 120 * 1024,
    }));

  render(
    <RequestTable
      sessionId="cold-1"
      search="token-xyz"
      searchBody
      filter="all"
      methodFilter="POST"
      statusFilter="5xx"
      onCount={count}
      onMeta={onMeta}
      onError={error}
      onSelect={select}
    />,
  );

  await waitFor(() =>
    expect(api.query).toHaveBeenLastCalledWith(
      "cold-1",
      "token-xyz",
      "all",
      0,
      expect.any(Number),
      300,
      {},
      undefined,
      [],
      undefined,
      "desc",
      undefined,
      "POST",
      "5xx",
      true,
      undefined,
      null,
    ),
  );
  expect(onMeta).toHaveBeenCalledWith(
    expect.objectContaining({
      spilledCount: 15,
      spilledBytes: 120 * 1024,
    }),
  );

  // 打开列配置菜单，开启「来源」列并验证表头即时显示
  expect(screen.queryByRole("columnheader", { name: "来源" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "显示列配置" }));
  fireEvent.click(screen.getByLabelText("来源"));
  expect(screen.getByRole("columnheader", { name: "来源" })).toBeTruthy();

  // 点击恢复默认列宽与列
  fireEvent.click(screen.getByRole("button", { name: "恢复默认列宽与列" }));
  expect(screen.queryByRole("columnheader", { name: "来源" })).toBeNull();
  localStorage.clear();
});

it("exposes quick repeat and batch repeat actions in row context menu", async () => {
  const count = vi.fn();
  const select = vi.fn();
  const error = vi.fn();
  const onQuickRepeat = vi.fn();
  const onRepeatBatch = vi.fn();
  const entry: EntryRow = {
    id: "req-post-1",
    seq: 1,
    source: "dio",
    method: "POST",
    url: "https://api.example.test/v1/submit",
    startedAt: "2026-11-24T08:00:00.000Z",
    durationMs: 145,
    status: 200,
    state: "completed",
    pinned: false,
    responseBytes: 512,
  };

  vi.mocked(api.query)
    .mockReset()
    .mockImplementation(async (_id, _search, _filter, offset, revision) => ({
      total: 1,
      offset,
      revision,
      rows: [entry],
    }));

  render(
    <RequestTable
      sessionId="menu-1"
      search=""
      filter="all"
      onQuickRepeat={onQuickRepeat}
      onRepeatBatch={onRepeatBatch}
      onCount={count}
      onError={error}
      onSelect={select}
    />,
  );

  const row = await screen.findByText("/v1/submit");
  fireEvent.contextMenu(row);
  fireEvent.click(screen.getByRole("button", { name: "原样重发一次" }));
  expect(onQuickRepeat).toHaveBeenCalledWith(entry);

  fireEvent.contextMenu(row);
  fireEvent.click(screen.getByRole("button", { name: "批量重复重发…" }));
  expect(onRepeatBatch).toHaveBeenCalledWith(entry);
  vi.restoreAllMocks();
});

it("does not loop or flicker loading when parent passes inline onMeta/onHosts callbacks after clear", async () => {
  vi.mocked(api.query)
    .mockReset()
    .mockImplementation(async (_id, _search, _filter, offset, revision) => ({
      total: 0,
      offset,
      revision,
      rows: [],
      hosts: ["api.example.test"],
      latestSeq: 40,
      hiddenCount: 40,
      totalBytes: 4096,
      maxBytes: 8 * 1024 * 1024,
    }));

  function ParentHarness() {
    const [, setMeta] = useState<RequestTableMeta | null>(null);
    const [, setHosts] = useState<string[]>([]);
    const [, setTotal] = useState(0);
    return (
      <RequestTable
        sessionId="live-clear"
        live
        search=""
        filter="all"
        afterSeq={40}
        clearMarkSeq={40}
        onCount={(n) => setTotal(n)}
        onMeta={(meta) => setMeta({ ...meta })}
        onHosts={(hosts) => setHosts([...hosts])}
        onError={vi.fn()}
        onSelect={vi.fn()}
      />
    );
  }

  render(<ParentHarness />);
  await screen.findByText("已清屏，等待新请求");
  // 等待多轮微任务确认不会因父组件重渲染新建回调而循环重查
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
  expect(api.query).toHaveBeenCalledTimes(1);
  expect(screen.getByText("已清屏，等待新请求")).toBeTruthy();
});
