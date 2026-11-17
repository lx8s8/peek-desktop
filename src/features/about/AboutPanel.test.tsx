import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AboutPanel } from "./AboutPanel";
import { api } from "../../lib/ipc/client";
import { commands } from "../../lib/commands/dispatcher";
vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  api: { appInfo: vi.fn(), legalText: vi.fn(), openProjectLink: vi.fn() },
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.appInfo).mockResolvedValue({
    version: "0.1.0",
    platform: "macos",
    architecture: "aarch64",
  });
  vi.mocked(api.legalText).mockResolvedValue(
    "MIT License\n<script>inert text</script>",
  );
  vi.mocked(api.openProjectLink).mockResolvedValue(undefined);
});
it("uses the same about command for the menu and toolbar and loads legal text on demand", async () => {
  const { container } = render(<AboutPanel />);
  act(() => {
    commands.dispatch("help.about");
  });
  await screen.findByText("0.1.0");
  expect(screen.getByText("macos · aarch64")).toBeTruthy();
  expect(screen.getByText("kasen")).toBeTruthy();
  expect(api.legalText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "项目地址" }));
  await waitFor(() =>
    expect(api.openProjectLink).toHaveBeenCalledWith("project"),
  );
  fireEvent.click(screen.getByRole("button", { name: "开源许可" }));
  await screen.findByText(/MIT License/);
  expect(api.legalText).toHaveBeenCalledWith("license");
  expect(container.querySelector("script")).toBeNull();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(commands.enabled("help.project")).toBe(true);
});
it("does not replace the selected legal document with an older response", async () => {
  let old!: (value: string) => void;
  vi.mocked(api.legalText)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockResolvedValue("third-party notices");
  render(<AboutPanel />);
  fireEvent.click(screen.getByRole("button", { name: "关于 Peek Desktop" }));
  fireEvent.click(screen.getByRole("button", { name: "开源许可" }));
  fireEvent.click(screen.getByRole("button", { name: "第三方声明" }));
  await screen.findByText("third-party notices");
  await act(async () => old("stale license"));
  expect(screen.queryByText("stale license")).toBeNull();
});
