import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ConnectionPanel } from "./ConnectionPanel";
import { api, emptyRemote } from "../../lib/ipc/client";
vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  emptyRemote: { listening: false, diagnosticRuns: [], sessions: [] },
  api: { start: vi.fn(), pair: vi.fn(), revoke: vi.fn() },
}));
it("starts only explicitly and sends an independent diagnostic grant for pairing", async () => {
  const change = vi.fn(async () => {}),
    error = vi.fn();
  vi.mocked(api.start).mockResolvedValue(emptyRemote);
  vi.mocked(api.pair).mockResolvedValue(emptyRemote);
  const { rerender } = render(
    <ConnectionPanel remote={emptyRemote} onChange={change} onError={error} />,
  );
  expect(api.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "设备连接" }));
  fireEvent.change(screen.getByLabelText("监听范围"), {
    target: { value: "0.0.0.0" },
  });
  fireEvent.click(screen.getByRole("button", { name: "启动监听" }));
  await waitFor(() =>
    expect(api.start).toHaveBeenCalledWith("0.0.0.0", 9741, true),
  );
  await waitFor(() => expect(change).toHaveBeenCalled());
  rerender(
    <ConnectionPanel
      remote={{
        ...emptyRemote,
        listening: true,
        addresses: [],
        host: "0.0.0.0",
        port: 9741,
        mdns: "off",
      }}
      onChange={change}
      onError={error}
    />,
  );
  fireEvent.click(screen.getByLabelText("允许此次配对同步日志与异常"));
  fireEvent.click(screen.getByRole("button", { name: "生成配对码" }));
  await waitFor(() => expect(api.pair).toHaveBeenCalledWith(false));
  expect(error).not.toHaveBeenCalled();
});
