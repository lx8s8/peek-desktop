import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useWorkspace } from "./useWorkspace";
import { api, emptyRemote } from "../../lib/ipc/client";
import type { RemoteSnapshot } from "../../lib/ipc/types";

vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  emptyRemote: { listening: false, diagnosticRuns: [], sessions: [] },
  api: { sessions: vi.fn(), remote: vi.fn(), watch: vi.fn() },
}));
it("ignores an older refresh and stops its channel on unmount", async () => {
  let old!: (value: RemoteSnapshot) => void;
  const stop = vi.fn(async () => {}),
    onError = vi.fn();
  vi.mocked(api.watch).mockReturnValue({ ready: Promise.resolve(), stop });
  vi.mocked(api.sessions).mockResolvedValue([]);
  vi.mocked(api.remote)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockResolvedValue({ ...emptyRemote, listening: true });
  const { result, unmount } = renderHook(() => useWorkspace(onError));
  await act(() => result.current.refresh());
  expect(result.current.remote.listening).toBe(true);
  await act(async () => old(emptyRemote));
  expect(result.current.remote.listening).toBe(true);
  unmount();
  await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(onError).not.toHaveBeenCalled();
});
