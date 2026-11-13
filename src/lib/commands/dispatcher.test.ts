import { expect, it, vi } from "vitest";
import { CommandDispatcher, commandForKey } from "./dispatcher";
it("guards disabled and replaced contexts, restores the previous owner and releases modal blockers", () => {
  const commands = new CommandDispatcher(),
    old = vi.fn(),
    current = vi.fn();
  const removeOld = commands.register("edit.copyMessage", old);
  const stale = commands.capture("edit.copyMessage");
  const removeNew = commands.register("edit.copyMessage", current, () => false);
  expect(commands.dispatch("edit.copyMessage")).toBe(false);
  stale();
  expect(old).not.toHaveBeenCalled();
  removeNew();
  expect(commands.dispatch("edit.copyMessage")).toBe(true);
  expect(old).toHaveBeenCalledOnce();
  const unblock = commands.block((id) => id === "edit.copyMessage");
  expect(commands.enabled("edit.copyMessage")).toBe(false);
  unblock();
  expect(commands.enabled("edit.copyMessage")).toBe(true);
  removeOld();
  expect(commands.enabled("edit.copyMessage")).toBe(false);
});
it("uses one command for platform modifiers while leaving native text copy alone", () => {
  const key = {
    key: "s",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  };
  expect(commandForKey(key)).toBe("session.save");
  expect(commandForKey({ ...key, shiftKey: true })).toBe("diagnostics.export");
  expect(commandForKey({ ...key, key: "c" })).toBeUndefined();
  expect(
    commandForKey({
      ...key,
      key: "c",
      ctrlKey: false,
      metaKey: true,
      altKey: true,
    }),
  ).toBe("edit.copyStack");
});
