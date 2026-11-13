import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { api } from "../../lib/ipc/client";
import { DiagnosticDetail } from "./DiagnosticDetail";
vi.mock("../../lib/ipc/client", () => ({ api: { diagnostic: vi.fn() } }));
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
