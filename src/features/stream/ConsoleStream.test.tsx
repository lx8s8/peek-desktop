import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  MAX_CACHED_CHUNKS,
  STREAM_CHUNK_SIZE,
  StreamChunkCache,
  planPrefetchChunks,
} from "./chunkCache";
import { ConsoleStream, emptyStreamView } from "./ConsoleStream";
import { api } from "../../lib/ipc/client";
import type { StreamLine, StreamPage } from "../../lib/ipc/types";

vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  api: {
    stream: vi.fn(),
    copyStreamBlock: vi.fn(),
    exportStreamText: vi.fn(),
    body: vi.fn(),
    writeClipboard: vi.fn(async () => {}),
  },
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 10) }, (_, index) => ({
        index,
        start: index * 20,
      })),
    getTotalSize: () => count * 20,
    scrollToIndex: vi.fn(),
  }),
}));

function makeLine(
  lineIndex: number,
  overrides: Partial<StreamLine> = {},
): StreamLine {
  return {
    lineIndex,
    blockId: "res:live-1:req-1",
    blockStartLine: 0,
    blockLineCount: 4,
    kind: "http-response",
    level: "response",
    role: "body",
    text: `│ line ${lineIndex}`,
    occurredAt: "2026-11-23T01:30:11.000Z",
    sessionId: "live-1",
    entryId: "req-1",
    runId: null,
    eventId: null,
    remoteBody: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
});

it("plans bidirectional prefetch chunks prioritizing scroll direction and enforces LRU cache bounds", () => {
  const down = planPrefetchChunks(420, 460, 2000, 1);
  // 视口在 chunk 2，向下滚动优先预取 3、4，再反向缓冲 1
  expect(down).toEqual([2, 3, 4, 1]);

  const up = planPrefetchChunks(620, 650, 2000, -1);
  // 视口在 chunk 3，向上滚动优先预取 2、1，再反向缓冲 4
  expect(up).toEqual([3, 2, 1, 4]);

  const cache = new StreamChunkCache();
  for (let i = 0; i < MAX_CACHED_CHUNKS + 5; i++) {
    const start = i * STREAM_CHUNK_SIZE;
    const page: StreamPage = {
      totalLines: (MAX_CACHED_CHUNKS + 5) * STREAM_CHUNK_SIZE,
      totalBlocks: 100,
      lineOffset: start,
      revision: 1,
      lines: [makeLine(start)],
    };
    cache.setPage(i, "v1", page);
  }
  expect(cache.size).toBe(MAX_CACHED_CHUNKS);
  // 最早的分片已被 LRU 淘汰，最新分片保留
  expect(cache.getLine(0)).toBeUndefined();
  expect(
    cache.getLine((MAX_CACHED_CHUNKS + 4) * STREAM_CHUNK_SIZE),
  ).toBeTruthy();
});

it("renders full stream lines, copies a block without flutter prefix, and auto-loads only small remote bodies", async () => {
  const lines: StreamLine[] = [
    makeLine(0, {
      role: "top",
      text: "┌──────────",
    }),
    makeLine(1, {
      role: "header",
      text: "│ [http-response] | 09:30:11 279ms | [GET] https://web.example.test/api/apps/version",
    }),
    makeLine(2, {
      role: "remote",
      text: "│ Data: [远端正文未拉取 · 2.0 KB · application/json · 点击加载完整内容]",
      remoteBody: {
        sessionId: "live-1",
        entryId: "req-1",
        side: "response",
        size: 2048,
        mediaType: "application/json",
      },
    }),
    makeLine(3, {
      blockId: "res:live-1:req-big",
      entryId: "req-big",
      role: "remote",
      text: "│ Data: [远端正文未拉取 · 512.0 KB · application/json · 点击加载完整内容]",
      remoteBody: {
        sessionId: "live-1",
        entryId: "req-big",
        side: "response",
        size: 512 * 1024,
        mediaType: "application/json",
      },
    }),
  ];

  vi.mocked(api.stream).mockImplementation(async (_scope, query) => ({
    totalLines: lines.length,
    totalBlocks: 2,
    lineOffset: query.lineOffset,
    revision: query.revision,
    lines: query.lineOffset === 0 ? lines : [],
  }));
  vi.mocked(api.body).mockResolvedValue({
    kind: "text",
    mediaType: "application/json",
    size: 2048,
    capturedBytes: 2048,
    truncated: false,
    previewTruncated: false,
    text: '{"ok":true}',
    reason: null,
  });
  vi.mocked(api.copyStreamBlock).mockResolvedValue(
    "┌──────────\n│ [http-response]\n└──────────",
  );

  const onSelect = vi.fn();
  const onViewChange = vi.fn();
  const onError = vi.fn();

  render(
    <ConsoleStream
      scope={{ kind: "network", id: "live-1" }}
      version="1:0"
      range={{}}
      live
      view={{ ...emptyStreamView, following: false }}
      selected={{
        blockId: "res:live-1:req-1",
        kind: "http-response",
        sessionId: "live-1",
        entryId: "req-1",
        runId: null,
        eventId: null,
      }}
      onViewChange={onViewChange}
      onSelect={onSelect}
      onError={onError}
    />,
  );

  await screen.findByText(/\[http-response\]/);
  // 自动拉取 <= 128 KB 的小正文，跳过 512 KB 的大正文
  await waitFor(() =>
    expect(api.body).toHaveBeenCalledWith("live-1", "req-1", "response"),
  );
  expect(api.body).not.toHaveBeenCalledWith("live-1", "req-big", "response");

  // 点击 512 KB 远端正文行可手动触发按需加载
  fireEvent.click(screen.getByText(/512\.0 KB/));
  await waitFor(() =>
    expect(api.body).toHaveBeenCalledWith("live-1", "req-big", "response"),
  );
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({
      blockId: "res:live-1:req-big",
      entryId: "req-big",
    }),
  );

  // 点击复制本条
  fireEvent.click(screen.getByRole("button", { name: "复制本条" }));
  await waitFor(() =>
    expect(api.copyStreamBlock).toHaveBeenCalledWith(
      { kind: "network", id: "live-1" },
      expect.anything(),
      "res:live-1:req-1",
    ),
  );
  await waitFor(() =>
    expect(api.writeClipboard).toHaveBeenCalledWith(
      "┌──────────\n│ [http-response]\n└──────────",
    ),
  );
  expect(onError).not.toHaveBeenCalled();
});
