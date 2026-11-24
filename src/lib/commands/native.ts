import { useEffect, useRef, useState, type MouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import {
  Menu,
  Submenu,
  type MenuOptions,
  type PredefinedMenuItemOptions,
} from "@tauri-apps/api/menu";
import { api, desktop } from "../ipc/client";
import i18n from "../i18n";
import { commands, definitions, type CommandId } from "./dispatcher";
import { useCommandRevision } from "./react";
export interface MenuSnapshot {
  language: string;
  enabled: Partial<Record<CommandId, boolean>>;
  checked: Partial<Record<CommandId, boolean>>;
  mac: boolean;
}
type Items = NonNullable<MenuOptions["items"]>;
export function commandItem(id: CommandId, snapshot: MenuSnapshot) {
  const definition = definitions[id];
  return {
    id,
    text: String(i18n.getFixedT(snapshot.language)(definition.label)),
    enabled: !!snapshot.enabled[id],
    ...("accelerator" in definition
      ? { accelerator: definition.accelerator }
      : {}),
    ...(id in snapshot.checked ? { checked: snapshot.checked[id] } : {}),
  };
}
// Tauri's per-item JS channels are keyed by menu ID. Dropping an old menu with
// the same IDs can remove the new channels; use one Rust event bridge instead.
const contextActions = new Map<string, () => void>();
let contextSequence = 0;
export function routeNativeCommand(id: string) {
  if (Object.prototype.hasOwnProperty.call(definitions, id))
    commands.dispatch(id as CommandId);
  else contextActions.get(id)?.();
}
export function contextItems(ids: CommandId[], snapshot: MenuSnapshot) {
  const prefix = `context.${++contextSequence}.`;
  const items = ids.map((id) => {
    const { accelerator: _, ...item } = {
      accelerator: undefined,
      ...commandItem(id, snapshot),
    };
    const nativeId = prefix + id;
    contextActions.set(nativeId, commands.capture(id));
    return { ...item, id: nativeId };
  });
  return {
    items,
    close: () => items.forEach((item) => contextActions.delete(item.id)),
  };
}
export function menuItems(snapshot: MenuSnapshot): Items {
  const t = i18n.getFixedT(snapshot.language);
  const item = (id: CommandId) => commandItem(id, snapshot);
  const native = (kind: PredefinedMenuItemOptions["item"], label?: string) => ({
    item: kind,
    ...(label ? { text: String(t(label)) } : {}),
  });
  const separator = () => native("Separator");
  return [
    ...(snapshot.mac
      ? [
          {
            id: "menu.app",
            text: "Peek Desktop",
            items: [
              item("help.about"),
              item("help.checkUpdates"),
              separator(),
              native("Services", "menuServices"),
              separator(),
              native("Hide", "menuHide"),
              native("HideOthers", "menuHideOthers"),
              native("ShowAll", "menuShowAll"),
              separator(),
              native("Quit", "menuQuit"),
            ],
          },
        ]
      : []),
    {
      id: "menu.file",
      text: t("menuFile"),
      items: [
        item("session.open"),
        item("session.save"),
        item("session.archive"),
        item("files.open"),
        item("recovery.restore"),
        item("recovery.save"),
        item("export.har"),
        item("export.logs"),
        item("export.text"),
        item("session.close"),
        separator(),
        item("diagnostics.export"),
        ...(!snapshot.mac
          ? [
              separator(),
              native("CloseWindow", "menuCloseWindow"),
              native("Quit", "menuQuit"),
            ]
          : []),
      ],
    },
    {
      id: "menu.edit",
      text: t("menuEdit"),
      items: [
        ...(snapshot.mac
          ? [
              native("Undo", "menuUndo"),
              native("Redo", "menuRedo"),
              separator(),
            ]
          : []),
        native("Cut", "menuCut"),
        native("Copy", "menuCopy"),
        native("Paste", "menuPaste"),
        item("edit.selectAll"),
        separator(),
        item("edit.find"),
        item("edit.copyMessage"),
        item("edit.copyStack"),
        item("edit.copyRaw"),
        item("edit.copyCurl"),
        separator(),
        item("edit.selectWindow"),
        item("edit.clearSelection"),
      ],
    },
    {
      id: "menu.view",
      text: t("menuView"),
      items: [
        item("view.network"),
        item("view.logs"),
        item("view.exceptions"),
        item("view.timeline"),
        item("view.stream"),
        separator(),
        item("view.follow"),
        item("view.theme"),
        ...(snapshot.mac ? [native("Fullscreen", "menuFullscreen")] : []),
      ],
    },
    {
      id: "menu.connection",
      text: t("menuConnection"),
      items: [
        item("connection.open"),
        item("connection.stop"),
        item("connection.pair"),
      ],
    },
    {
      id: "menu.language",
      text: t("menuLanguage"),
      items: [
        item("language.zh-CN"),
        item("language.en"),
        separator(),
        item("view.language"),
      ],
    },
    {
      id: "menu.window",
      text: t("menuWindow"),
      items: [
        native("Minimize", "menuMinimize"),
        native("Maximize", "menuMaximize"),
        native("CloseWindow", "menuCloseWindow"),
        ...(snapshot.mac ? [native("BringAllToFront", "menuFront")] : []),
      ],
    },
    {
      id: "menu.help",
      text: t("menuHelp"),
      items: [
        ...(!snapshot.mac ? [item("help.checkUpdates"), separator()] : []),
        item("help.project"),
        item("help.issues"),
        separator(),
        item("help.shortcuts"),
        item("help.retention"),
        ...(!snapshot.mac ? [separator(), item("help.about")] : []),
      ],
    },
  ];
}
export interface BuiltMenu {
  install: () => Promise<void>;
  close: () => Promise<void>;
}
export class MenuSynchronizer {
  private pending: MenuSnapshot | null = null;
  private revision = 0;
  private running = false;
  private disposed = false;
  constructor(
    private build: (snapshot: MenuSnapshot) => Promise<BuiltMenu>,
    private ready: () => void,
    private error: (error: string) => void,
  ) {}
  request(snapshot: MenuSnapshot) {
    this.pending = snapshot;
    ++this.revision;
    if (!this.running) void this.drain();
  }
  dispose() {
    this.disposed = true;
    this.pending = null;
    ++this.revision;
  }
  private async drain() {
    this.running = true;
    try {
      while (this.pending && !this.disposed) {
        const snapshot = this.pending;
        this.pending = null;
        const request = this.revision;
        let menu: BuiltMenu | undefined;
        try {
          menu = await this.build(snapshot);
          if (this.disposed || request !== this.revision) continue;
          await menu.install();
          if (!this.disposed) this.ready();
        } catch (error) {
          if (!this.disposed) this.error(String(error));
        } finally {
          await menu?.close().catch((error) => this.error(String(error)));
        }
      }
    } finally {
      this.running = false;
    }
  }
}
async function buildMenu(snapshot: MenuSnapshot): Promise<BuiltMenu> {
  const menu = await Menu.new({ items: menuItems(snapshot) });
  return {
    close: () => menu.close(),
    install: async () => {
      const previous = await menu.setAsAppMenu();
      await previous?.close();
      if (snapshot.mac)
        for (const [id, role] of [
          ["menu.window", "window"],
          ["menu.help", "help"],
        ] as const) {
          const submenu = await menu.get(id);
          try {
            if (submenu instanceof Submenu) {
              if (role === "window") await submenu.setAsWindowsMenuForNSApp();
              else await submenu.setAsHelpMenuForNSApp();
            }
          } finally {
            await submenu?.close();
          }
        }
    },
  };
}
export function useNativeMenu(
  language: string,
  checked: MenuSnapshot["checked"],
  onError: (error: string) => void,
) {
  const revision = useCommandRevision();
  const checkedKey = JSON.stringify(checked);
  const reference = useRef<MenuSynchronizer | null>(null);
  const [ready, setReady] = useState(false);
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    if (!desktop) return;
    const subscription = listen<string>("peek-menu-command", (event) =>
      routeNativeCommand(event.payload),
    );
    const sync = new MenuSynchronizer(
      async (snapshot) => {
        await subscription;
        return buildMenu(snapshot);
      },
      () => setReady(true),
      (value) => report.current(value),
    );
    reference.current = sync;
    return () => {
      sync.dispose();
      reference.current = null;
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!desktop) return;
    const enabled = Object.fromEntries(
      (Object.keys(definitions) as CommandId[]).map((id) => [
        id,
        commands.enabled(id),
      ]),
    );
    reference.current?.request({
      language,
      enabled,
      checked: JSON.parse(checkedKey),
      mac: /Mac/.test(navigator.platform),
    });
  }, [language, checkedKey, revision]);
  return ready;
}
export function useContextMenu(
  ids: CommandId[],
  onError: (error: string) => void,
) {
  const reference = useRef<{
    menu: Menu | null;
    revision: number;
    disposed: boolean;
    closeActions: () => void;
  } | null>(null);
  const error = useRef(onError);
  error.current = onError;
  useEffect(() => {
    const state = {
      menu: null as Menu | null,
      revision: 0,
      disposed: false,
      closeActions: () => {},
    };
    reference.current = state;
    return () => {
      state.disposed = true;
      ++state.revision;
      state.closeActions();
      void state.menu?.close().catch(() => {});
    };
  }, []);
  return (event: MouseEvent) => {
    if (!desktop) return;
    event.preventDefault();
    const keyboard = event.clientX === 0 && event.clientY === 0;
    const rect = event.currentTarget.getBoundingClientRect();
    const position = new LogicalPosition(
      keyboard ? rect.left : event.clientX,
      keyboard ? rect.bottom : event.clientY,
    );
    const state = reference.current;
    if (!state) return;
    const request = ++state.revision;
    // React commits a row's right-click selection before creating menu availability.
    setTimeout(
      () =>
        void (async () => {
          if (state.disposed || request !== state.revision) return;
          let menu: Menu | null = null;
          let actions: ReturnType<typeof contextItems> | null = null;
          try {
            const snapshot: MenuSnapshot = {
              language: i18n.language,
              enabled: Object.fromEntries(
                ids.map((id) => [id, commands.enabled(id)]),
              ),
              checked: {},
              mac: /Mac/.test(navigator.platform),
            };
            actions = contextItems(ids, snapshot);
            menu = await Menu.new({ items: actions.items });
            if (state.disposed || request !== state.revision) {
              actions.close();
              await menu.close();
              return;
            }
            const previous = state.menu;
            state.closeActions();
            state.closeActions = actions.close;
            state.menu = menu;
            await previous?.close();
            await api.popupContextMenu(menu.rid, position.x, position.y);
          } catch (value) {
            if (menu !== state.menu) actions?.close();
            if (menu !== state.menu) await menu?.close().catch(() => {});
            if (!state.disposed) error.current(String(value));
          }
        })(),
      0,
    );
  };
}
