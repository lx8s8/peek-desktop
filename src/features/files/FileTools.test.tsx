import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { FileTools } from "./FileTools";
import { api } from "../../lib/ipc/client";
vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  api: { exportScope: vi.fn(), copyCurl: vi.fn(), writeClipboard: vi.fn() },
}));
it("exports the entire captured scope and copies only the explicit request target", async () => {
  const scope = { kind: "network" as const, id: "file-archive-one" };
  vi.mocked(api.exportScope).mockResolvedValue(true);
  vi.mocked(api.copyCurl).mockResolvedValue("curl 'synthetic'");
  vi.mocked(api.writeClipboard).mockResolvedValue();
  const notice = vi.fn(),
    error = vi.fn();
  render(
    <FileTools
      scope={scope}
      networkId={scope.id}
      entryId="chosen"
      hasLogs
      onError={error}
      onNotice={notice}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "导出与恢复" }));
  fireEvent.click(
    screen.getByRole("button", { name: "导出当前全部日志 JSONL…" }),
  );
  await waitFor(() =>
    expect(api.exportScope).toHaveBeenCalledWith(scope, "jsonl"),
  );
  await waitFor(() => expect(notice).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "复制当前请求 cURL" }));
  await waitFor(() =>
    expect(api.copyCurl).toHaveBeenCalledWith(scope.id, "chosen"),
  );
  await waitFor(() =>
    expect(api.writeClipboard).toHaveBeenCalledWith("curl 'synthetic'"),
  );
  expect(error).not.toHaveBeenCalled();
});
