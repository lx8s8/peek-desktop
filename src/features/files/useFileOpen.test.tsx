import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../lib/ipc/client";
import { useFileOpen } from "./useFileOpen";
vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  api: { watchFiles: vi.fn() },
}));
beforeEach(() => vi.clearAllMocks());
it("checks cold-start intents after subscribing and defers warm intents while importing", async () => {
  let notify = () => {};
  const stop = vi.fn();
  vi.mocked(api.watchFiles).mockImplementation(async (callback) => {
    notify = callback;
    return stop;
  });
  const open = vi.fn(async () => true);
  const error = vi.fn();
  const { rerender, unmount } = renderHook(
    ({ blocked }) => useFileOpen(blocked, open, error),
    { initialProps: { blocked: false } },
  );
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  rerender({ blocked: true });
  act(() => {
    notify();
    notify();
  });
  expect(open).toHaveBeenCalledTimes(1);
  rerender({ blocked: false });
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  rerender({ blocked: false });
  expect(open).toHaveBeenCalledTimes(2);
  unmount();
  expect(stop).toHaveBeenCalledOnce();
});
it("unsubscribes a late registration after unmount without draining files", async () => {
  let finish!: (stop: () => void) => void;
  vi.mocked(api.watchFiles).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const open = vi.fn(async () => true),
    stop = vi.fn();
  const { unmount } = renderHook(() => useFileOpen(false, open, vi.fn()));
  unmount();
  await act(async () => finish(stop));
  expect(stop).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
});
