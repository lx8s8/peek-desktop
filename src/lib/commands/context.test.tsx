import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Menu } from "@tauri-apps/api/menu";
import { api } from "../ipc/client";
import { commands } from "./dispatcher";
import { routeNativeCommand, useContextMenu } from "./native";

vi.mock("../ipc/client", () => ({
  desktop: true,
  api: { popupContextMenu: vi.fn(async () => {}) },
}));
vi.mock("@tauri-apps/api/menu", () => ({
  Menu: { new: vi.fn() },
  Submenu: class {},
}));
function Actions({ error }: { error: (value: string) => void }) {
  const open = useContextMenu(["edit.copyMessage"], error);
  return (
    <button onClick={open} onContextMenu={open}>
      Actions
    </button>
  );
}
it("opens the same native commands at the mouse position or keyboard anchor", async () => {
  const popup = vi.fn(async () => {}),
    close = vi.fn(async () => {});
  vi.mocked(Menu.new).mockResolvedValue({
    rid: 132,
    popup,
    close,
  } as unknown as Menu);
  const copy = vi.fn(),
    error = vi.fn();
  const remove = commands.register("edit.copyMessage", copy);
  const view = render(<Actions error={error} />);
  const button = screen.getByRole("button");
  fireEvent.contextMenu(button, { clientX: 27, clientY: 41 });
  await waitFor(() =>
    expect(api.popupContextMenu).toHaveBeenCalledWith(132, 27, 41),
  );
  const first = vi.mocked(Menu.new).mock.calls[0][0]!.items![0] as {
    id: string;
  };
  routeNativeCommand(first.id);
  expect(copy).toHaveBeenCalledOnce();
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
    left: 12,
    bottom: 64,
  } as DOMRect);
  fireEvent.click(button, { clientX: 0, clientY: 0 });
  await waitFor(() =>
    expect(api.popupContextMenu).toHaveBeenCalledWith(132, 12, 64),
  );
  routeNativeCommand(first.id);
  expect(copy).toHaveBeenCalledOnce();
  view.unmount();
  expect(close).toHaveBeenCalledTimes(2);
  expect(error).not.toHaveBeenCalled();
  expect(popup).not.toHaveBeenCalled();
  remove();
});
it("closes a menu created after its view unmounts without opening it", async () => {
  let resolve!: (menu: Menu) => void;
  vi.mocked(Menu.new).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const popup = vi.fn(async () => {}),
    close = vi.fn(async () => {});
  const view = render(<Actions error={vi.fn()} />);
  fireEvent.contextMenu(screen.getByRole("button"));
  await waitFor(() => expect(resolve).toBeDefined());
  view.unmount();
  await act(async () => resolve({ rid: 133, popup, close } as unknown as Menu));
  expect(close).toHaveBeenCalledOnce();
  expect(popup).not.toHaveBeenCalled();
});
