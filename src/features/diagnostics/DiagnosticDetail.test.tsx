import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { api } from "../../lib/ipc/client";
import { DiagnosticDetail } from "./DiagnosticDetail";
vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  api: { diagnostic: vi.fn(), exportDiagnostics: vi.fn() },
}));
vi.mock("../detail/JsonViewer", () => ({
  JsonViewer: ({ text }: { text: string }) => (
    <pre data-testid="raw">{text}</pre>
  ),
}));
it("keeps original stack and numeric text while ignoring a previous run's detail", async () => {
  let old!: (value: string) => void;
  const raw =
    '{"message":"current","level":"error","source":"test","attributes":{"id":900719925474099312345},"exception":{"stackTrace":"#0 original.dart:42\\n#1 caller.dart:7"}}';
  vi.mocked(api.diagnostic)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockResolvedValue(raw);
  const { rerender } = render(
    <DiagnosticDetail
      selected={{ runId: "old", eventId: "same" }}
      theme="light"
    />,
  );
  rerender(
    <DiagnosticDetail
      selected={{ runId: "new", eventId: "same" }}
      theme="light"
    />,
  );
  await screen.findByText("current");
  expect(
    screen.getByText(/#0 original.dart:42/, { selector: ".stack-section pre" }),
  ).toBeTruthy();
  expect(screen.getByTestId("raw").textContent).toBe(raw);
  await act(async () => old(raw.replace("current", "stale")));
  expect(screen.queryByText("stale")).toBeNull();
});

it("shows uint64 metadata, truncation and empty stacks, and opens only an explicit request reference", async () => {
  const open = vi.fn();
  vi.mocked(api.diagnostic).mockResolvedValue(
    JSON.stringify({
      message: "truncated event",
      kind: "exception",
      level: "error",
      source: "app",
      sequence: "18446744073709551615",
      truncated: true,
      truncatedFields: ["attributes.longValue"],
      relatedNetworkEntryId: "request-one",
      exception: { type: "StateError", stackTrace: "" },
    }),
  );
  render(
    <DiagnosticDetail
      selected={{ runId: "run", eventId: "event" }}
      theme="light"
      networkSessionId="live-one"
      onNetwork={open}
    />,
  );
  await screen.findByText("18446744073709551615");
  expect(screen.getByText("此异常没有记录堆栈。")).toBeTruthy();
  expect(
    screen.getByText(/attributes.longValue/, { selector: '[role="status"]' }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "打开关联请求" }));
  expect(open).toHaveBeenCalledWith("live-one", "request-one");
});

it("removes old raw content when the selected event is evicted", async () => {
  vi.mocked(api.diagnostic)
    .mockResolvedValueOnce(
      '{"message":"retained event","level":"info","source":"app"}',
    )
    .mockRejectedValue("diagnosticEvicted");
  const { rerender } = render(
    <DiagnosticDetail
      selected={{ runId: "run", eventId: "one" }}
      evictionVersion={0}
      theme="light"
    />,
  );
  await screen.findByText("retained event");
  rerender(
    <DiagnosticDetail
      selected={{ runId: "run", eventId: "one" }}
      evictionVersion={1}
      theme="light"
    />,
  );
  await screen.findByText("日志已被淘汰或运行已关闭。");
  expect(screen.queryByTestId("raw")).toBeNull();
});
