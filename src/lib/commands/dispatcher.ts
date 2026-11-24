export const definitions = {
  "files.open": { label: "fileTools" },
  "recovery.restore": { label: "restoreWorkspace" },
  "recovery.save": { label: "saveRecovery" },
  "export.har": { label: "exportHar" },
  "export.logs": { label: "exportAllLogs" },
  "export.text": { label: "exportLogText" },
  "edit.copyCurl": { label: "copyCurl" },
  "session.open": { label: "open", accelerator: "CmdOrCtrl+O" },
  "session.archive": {
    label: "archiveSession",
    accelerator: "CmdOrCtrl+Alt+S",
  },
  "session.save": { label: "menuSaveNetwork", accelerator: "CmdOrCtrl+S" },
  "session.close": { label: "close", accelerator: "CmdOrCtrl+Shift+W" },
  "connection.open": { label: "connection", accelerator: "CmdOrCtrl+K" },
  "connection.stop": { label: "stopListening" },
  "connection.pair": { label: "newPairingCode" },
  "edit.selectAll": { label: "menuSelectAll", accelerator: "CmdOrCtrl+A" },
  "edit.find": { label: "menuFind", accelerator: "CmdOrCtrl+F" },
  "edit.copyMessage": {
    label: "menuCopyMessages",
    accelerator: "CmdOrCtrl+Shift+C",
  },
  "edit.copyStack": { label: "menuCopyStacks", accelerator: "CmdOrCtrl+Alt+C" },
  "edit.copyRaw": { label: "menuCopyEvents" },
  "edit.selectWindow": { label: "selectWindow" },
  "edit.clearSelection": { label: "clearSelection" },
  "diagnostics.export": {
    label: "exportSelected",
    accelerator: "CmdOrCtrl+Shift+S",
  },
  "view.network": { label: "network", accelerator: "CmdOrCtrl+1" },
  "view.logs": { label: "logs", accelerator: "CmdOrCtrl+2" },
  "view.exceptions": { label: "exceptions", accelerator: "CmdOrCtrl+3" },
  "view.timeline": { label: "timeline", accelerator: "CmdOrCtrl+4" },
  "view.stream": { label: "stream", accelerator: "CmdOrCtrl+5" },
  "view.follow": { label: "followLatest", accelerator: "CmdOrCtrl+Shift+F" },
  "view.theme": { label: "menuDark", accelerator: "CmdOrCtrl+Shift+D" },
  "view.language": { label: "language", accelerator: "CmdOrCtrl+Shift+L" },
  "language.zh-CN": { label: "menuChinese" },
  "language.en": { label: "menuEnglish" },
  "help.checkUpdates": { label: "checkUpdates" },
  "help.about": { label: "menuAbout" },
  "help.project": { label: "projectRepository" },
  "help.issues": { label: "reportIssue" },
  "help.shortcuts": { label: "menuShortcuts" },
  "help.retention": { label: "menuDataBounds" },
} as const;
export type CommandId = keyof typeof definitions;
type Entry = { token: symbol; run: () => unknown; enabled: () => boolean };
export class CommandDispatcher {
  private entries = new Map<CommandId, Entry[]>();
  private blockers = new Set<(id: CommandId) => boolean>();
  private listeners = new Set<() => void>();
  private revision = 0;
  onError: (error: string) => void = () => {};
  snapshot = () => this.revision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  notify = () => {
    ++this.revision;
    for (const listener of this.listeners) listener();
  };
  register(
    id: CommandId,
    run: () => unknown,
    enabled: () => boolean = () => true,
  ) {
    const entry = { token: Symbol(id), run, enabled };
    this.entries.set(id, [...(this.entries.get(id) ?? []), entry]);
    this.notify();
    return () => {
      const next =
        this.entries.get(id)?.filter((value) => value.token !== entry.token) ??
        [];
      if (next.length) this.entries.set(id, next);
      else this.entries.delete(id);
      this.notify();
    };
  }
  block(predicate: (id: CommandId) => boolean) {
    this.blockers.add(predicate);
    this.notify();
    return () => {
      this.blockers.delete(predicate);
      this.notify();
    };
  }
  private current(id: CommandId) {
    const entries = this.entries.get(id);
    return entries?.[entries.length - 1];
  }
  enabled(id: CommandId) {
    return (
      !Array.from(this.blockers).some((block) => block(id)) &&
      !!this.current(id)?.enabled()
    );
  }
  dispatch = (id: CommandId) => {
    const entry = this.current(id);
    if (!entry || !this.enabled(id)) return false;
    try {
      Promise.resolve(entry.run()).catch((error) =>
        this.onError(String(error)),
      );
    } catch (error) {
      this.onError(String(error));
    }
    return true;
  };
  capture(id: CommandId) {
    const token = this.current(id)?.token;
    return () => {
      if (this.current(id)?.token === token) this.dispatch(id);
    };
  }
}
export const commands = new CommandDispatcher();
export function commandForKey(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
): CommandId | undefined {
  if (!(event.metaKey || event.ctrlKey)) return;
  return (Object.keys(definitions) as CommandId[]).find((id) => {
    const definition = definitions[id];
    if (!("accelerator" in definition)) return false;
    const keys = definition.accelerator.toLowerCase().split("+");
    return (
      keys[keys.length - 1] === event.key.toLowerCase() &&
      keys.includes("shift") === event.shiftKey &&
      keys.includes("alt") === event.altKey
    );
  });
}
