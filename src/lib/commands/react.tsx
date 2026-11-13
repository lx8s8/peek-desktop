import { useEffect, useRef, useSyncExternalStore } from "react";
import { commands, type CommandId } from "./dispatcher";
export function useCommand(id: CommandId, run: () => unknown, enabled = true) {
  const latest = useRef({ run, enabled });
  latest.current = { run, enabled };
  useEffect(
    () =>
      commands.register(
        id,
        () => latest.current.run(),
        () => latest.current.enabled,
      ),
    [id],
  );
  useEffect(() => commands.notify(), [enabled]);
}
export function useCommandRevision() {
  return useSyncExternalStore(
    commands.subscribe,
    commands.snapshot,
    commands.snapshot,
  );
}
export function useModalCommands(active: boolean) {
  useEffect(() => {
    if (active)
      return commands.block(
        (id) =>
          !id.startsWith("connection.") &&
          !id.startsWith("language.") &&
          id !== "view.language" &&
          id !== "view.theme",
      );
  }, [active]);
}
