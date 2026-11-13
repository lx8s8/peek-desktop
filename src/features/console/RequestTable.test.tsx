import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RequestTable } from "./RequestTable";
import { api } from "../../lib/ipc/client";
import type { QueryPage } from "../../lib/ipc/types";
import type { EntryRow } from "../../lib/ipc/types";

vi.mock("../../lib/ipc/client", () => ({ api: { query: vi.fn() } }));

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
  expect(api.query).toHaveBeenCalledWith("large", "", "all", 99999, 0, 1);
});
