import { expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import {
  MenuSynchronizer,
  menuItems,
  contextItems,
  routeNativeCommand,
  type BuiltMenu,
  type MenuSnapshot,
} from "./native";
import { commands } from "./dispatcher";
const snapshot = (language: string): MenuSnapshot => ({
  language,
  mac: true,
  enabled: { "session.open": true, "session.save": false },
  checked: {
    "language.en": language === "en",
    "language.zh-CN": language !== "en",
  },
});
type Node = {
  id?: string;
  text?: string;
  enabled?: boolean;
  checked?: boolean;
  action?: () => void;
  items?: Node[];
};
function flatten(items: unknown): Node[] {
  return (items as Node[]).flatMap((item) => [
    item,
    ...flatten(item.items ?? []),
  ]);
}
it("uses stable ids and shared translations and keeps unavailable actions disabled", () => {
  const zh = flatten(menuItems(snapshot("zh-CN"))),
    en = flatten(menuItems(snapshot("en")));
  expect(zh.find((item) => item.id === "menu.file")?.text).toBe("文件");
  expect(en.find((item) => item.id === "menu.file")?.text).toBe("File");
  expect(zh.find((item) => item.id === "session.open")?.text).toBe("打开文件");
  expect(en.find((item) => item.id === "session.open")?.text).toBe("Open file");
  expect(en.find((item) => item.id === "session.save")?.enabled).toBe(false);
  expect(en.find((item) => item.id === "language.en")?.checked).toBe(true);
  expect(zh.filter((item) => item.id).map((item) => item.id)).toEqual(
    en.filter((item) => item.id).map((item) => item.id),
  );
});
it("routes rebuilt app menus to current commands and isolates stale context actions", () => {
  const old = vi.fn(),
    current = vi.fn();
  const removeOld = commands.register("session.open", old);
  const context = contextItems(["session.open"], snapshot("en"));
  const removeNew = commands.register("session.open", current);
  routeNativeCommand(context.items[0].id);
  expect(old).not.toHaveBeenCalled();
  expect(current).not.toHaveBeenCalled();
  // No per-item JS channels can be removed by a previous menu's resource drop.
  expect(flatten(menuItems(snapshot("en"))).every((item) => !item.action)).toBe(
    true,
  );
  routeNativeCommand("session.open");
  expect(current).toHaveBeenCalledOnce();
  context.close();
  removeNew();
  routeNativeCommand(context.items[0].id);
  expect(old).not.toHaveBeenCalled();
  routeNativeCommand("unknown-command");
  removeOld();
});
it("installs only the latest language and closes superseded and disposed menu references", async () => {
  const resolves: ((menu: BuiltMenu) => void)[] = [];
  const build = vi.fn(
    () => new Promise<BuiltMenu>((resolve) => resolves.push(resolve)),
  );
  const ready = vi.fn(),
    error = vi.fn();
  const sync = new MenuSynchronizer(build, ready, error);
  const old = { install: vi.fn(async () => {}), close: vi.fn(async () => {}) },
    latest = { install: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  sync.request(snapshot("zh-CN"));
  sync.request(snapshot("en"));
  resolves[0](old);
  await waitFor(() => expect(build).toHaveBeenCalledTimes(2));
  expect(old.install).not.toHaveBeenCalled();
  expect(old.close).toHaveBeenCalledOnce();
  resolves[1](latest);
  await waitFor(() => expect(ready).toHaveBeenCalledOnce());
  expect(latest.install).toHaveBeenCalledOnce();
  expect(latest.close).toHaveBeenCalledOnce();
  sync.request(snapshot("zh-CN"));
  const disposed = {
    install: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  sync.dispose();
  resolves[2](disposed);
  await waitFor(() => expect(disposed.close).toHaveBeenCalledOnce());
  expect(disposed.install).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});
