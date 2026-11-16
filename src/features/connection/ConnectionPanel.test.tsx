import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionPanel } from "./ConnectionPanel";
import { api, emptyRemote } from "../../lib/ipc/client";
vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  emptyRemote: { listening: false, diagnosticRuns: [], sessions: [] },
  api: {
    start: vi.fn(),
    pair: vi.fn(),
    revoke: vi.fn(),
    writeClipboard: vi.fn(),
  },
}));
afterEach(() => vi.useRealTimers());
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

it("offers reachable LAN addresses and removes a consumed pairing QR", async () => {
  const snapshot = {
    ...emptyRemote,
    listening: true,
    host: "0.0.0.0",
    port: 9741,
    mdns: "active",
    addresses: ["192.168.1.8:9741", "10.1.1.9:9741"],
    pairing: {
      serverId: "synthetic-desktop",
      code: "1234",
      expiresInSeconds: 180,
      devices: [],
    },
  };
  const onError = vi.fn();
  vi.mocked(api.writeClipboard).mockResolvedValue();
  const { rerender } = render(
    <ConnectionPanel
      remote={snapshot}
      onChange={async () => {}}
      onError={onError}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "设备连接" }));
  expect(screen.getByRole("img", { name: "一次性配对二维码" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("扫码连接地址"), {
    target: { value: "10.1.1.9:9741" },
  });
  fireEvent.click(screen.getByRole("button", { name: "复制配对链接" }));
  await waitFor(() => expect(api.writeClipboard).toHaveBeenCalled());
  const link = new URL(
    vi.mocked(api.writeClipboard).mock.calls.slice(-1)[0][0],
  );
  expect(link.protocol).toBe("peek-desktop:");
  expect(Object.fromEntries(link.searchParams)).toMatchObject({
    v: "1",
    host: "10.1.1.9",
    port: "9741",
    serverId: "synthetic-desktop",
    code: "1234",
  });
  expect(Number(link.searchParams.get("expiresAt"))).toBeGreaterThan(
    Date.now() / 1000,
  );
  rerender(
    <ConnectionPanel
      remote={{
        ...snapshot,
        pairing: { ...snapshot.pairing, code: null, expiresInSeconds: 0 },
      }}
      onChange={async () => {}}
      onError={onError}
    />,
  );
  expect(screen.queryByRole("img")).toBeNull();
  expect(onError).not.toHaveBeenCalled();
});

it("keeps loopback local and removes a QR when its time expires", async () => {
  vi.useFakeTimers();
  const snapshot = {
    ...emptyRemote,
    listening: true,
    host: "127.0.0.1",
    port: 9741,
    mdns: "off",
    addresses: ["127.0.0.1:9741"],
    pairing: {
      serverId: "synthetic-desktop",
      code: "1234",
      expiresInSeconds: 1,
      devices: [],
    },
  };
  const props = { onChange: async () => {}, onError: vi.fn() };
  const { rerender } = render(<ConnectionPanel remote={snapshot} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "设备连接" }));
  expect(screen.getByText(/127.0.0.1 仅供本机/)).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  rerender(
    <ConnectionPanel
      remote={{ ...snapshot, host: "0.0.0.0", addresses: ["192.168.1.8:9741"] }}
      {...props}
    />,
  );
  expect(screen.getByRole("img")).toBeTruthy();
  const { act } = await import("@testing-library/react");
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByRole("img")).toBeNull();
});
