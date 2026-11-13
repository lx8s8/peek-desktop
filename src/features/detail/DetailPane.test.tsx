import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DetailPane } from "./DetailPane";
import { api } from "../../lib/ipc/client";
import type { BodyView, EntryRow } from "../../lib/ipc/types";

vi.mock("../../lib/ipc/client", () => ({
  api: { metadata: vi.fn(), body: vi.fn() },
}));
vi.mock("./JsonViewer", () => ({
  JsonViewer: ({ text }: { text: string }) => <pre>{text}</pre>,
}));
const entry: EntryRow = {
  id: "a",
  source: "test",
  method: "GET",
  url: "https://example.test/a",
  startedAt: "2026-11-13T00:00:00.000Z",
  durationMs: 20,
  status: 200,
  state: "completed",
  pinned: false,
  responseBytes: 12,
};
const body: BodyView = {
  kind: "text",
  mediaType: "text/plain",
  size: 12,
  capturedBytes: 12,
  truncated: false,
  previewTruncated: false,
  text: "new response",
  reason: null,
};
beforeEach(() => vi.clearAllMocks());

it("loads bodies only on the selected tab and ignores old bodies after switching records", async () => {
  vi.mocked(api.metadata).mockResolvedValue(
    '{"request":{"headers":[]},"response":{"headers":[]}}',
  );
  let resolveOld!: (value: BodyView) => void;
  vi.mocked(api.body)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue(body);
  const { rerender } = render(
    <DetailPane sessionId="one" entry={entry} theme="light" />,
  );
  await waitFor(() => expect(api.metadata).toHaveBeenCalled());
  expect(api.body).not.toHaveBeenCalled();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "响应" }), {
    button: 0,
    ctrlKey: false,
  });
  await waitFor(() =>
    expect(api.body).toHaveBeenCalledWith("one", "a", "response"),
  );
  rerender(
    <DetailPane sessionId="one" entry={{ ...entry, id: "b" }} theme="light" />,
  );
  await screen.findByText("new response");
  await act(async () => resolveOld({ ...body, text: "stale response" }));
  expect(screen.queryByText("stale response")).toBeNull();
  expect(screen.getByText("new response")).toBeTruthy();
});

it("does not write old metadata into a different session with the same entry id", async () => {
  let resolveOld!: (value: string) => void;
  vi.mocked(api.metadata)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue("new metadata");
  const { rerender } = render(
    <DetailPane sessionId="one" entry={entry} theme="light" />,
  );
  rerender(<DetailPane sessionId="two" entry={entry} theme="light" />);
  await screen.findByText("new metadata");
  await act(async () => resolveOld("stale metadata"));
  expect(screen.queryByText("stale metadata")).toBeNull();
});
