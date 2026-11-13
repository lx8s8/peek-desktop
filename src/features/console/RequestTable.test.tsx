import { act, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RequestTable } from "./RequestTable";
import { api } from "../../lib/ipc/client";
import type { QueryPage } from "../../lib/ipc/types";

vi.mock("../../lib/ipc/client", () => ({ api: { query: vi.fn() } }));

it("ignores an old search result when the new query has already completed", async () => {
  let resolveOld!: (value: QueryPage) => void;
  let oldRevision = 0;
  const count = vi.fn(); const error = vi.fn(); const select = vi.fn();
  vi.mocked(api.query).mockImplementationOnce((_id, _search, _filter, _offset, revision) => {
    oldRevision = revision; return new Promise(resolve => { resolveOld = resolve; });
  }).mockImplementation(async (_id, _search, _filter, offset, revision) => ({ total: 7, offset, rows: [], revision }));
  const { rerender } = render(<RequestTable sessionId="one" search="old" filter="all" onCount={count} onError={error} onSelect={select} />);
  rerender(<RequestTable sessionId="one" search="new" filter="all" onCount={count} onError={error} onSelect={select} />);
  await waitFor(() => expect(count).toHaveBeenLastCalledWith(7));
  await act(async () => resolveOld({ total: 999, offset: 0, rows: [], revision: oldRevision }));
  expect(count).toHaveBeenLastCalledWith(7);
  expect(error).not.toHaveBeenCalled();
});
