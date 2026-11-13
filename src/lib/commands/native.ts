import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  Menu,
  Submenu,
  type MenuOptions,
  type PredefinedMenuItemOptions,
} from "@tauri-apps/api/menu";
import { desktop } from "../ipc/client";
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
    action: commands.capture(id),
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
              native({ About: null }, "menuAbout"),
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
        native("SelectAll", "menuSelectAll"),
        separator(),
        item("edit.find"),
        item("edit.copyMessage"),
        item("edit.copyStack"),
        item("edit.copyRaw"),
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
        item("help.shortcuts"),
        item("help.retention"),
        ...(!snapshot.mac
          ? [separator(), native({ About: null }, "menuAbout")]
          : []),
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
    const sync = new MenuSynchronizer(
      buildMenu,
      () => setReady(true),
      (value) => report.current(value),
    );
    reference.current = sync;
    return () => {
      sync.dispose();
      reference.current = null;
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
  } | null>(null);
  const error = useRef(onError);
  error.current = onError;
  useEffect(() => {
    const state = { menu: null as Menu | null, revision: 0, disposed: false };
    reference.current = state;
    return () => {
      state.disposed = true;
      ++state.revision;
      void state.menu?.close().catch(() => {});
    };
  }, []);
  return (event: MouseEvent) => {
    if (!desktop) return;
    event.preventDefault();
    const state = reference.current;
    if (!state) return;
    const request = ++state.revision;
    // React commits a row's right-click selection before creating menu availability.
    setTimeout(
      () =>
        void (async () => {
          let menu: Menu | null = null;
          try {
            const snapshot: MenuSnapshot = {
              language: i18n.language,
              enabled: Object.fromEntries(
                ids.map((id) => [id, commands.enabled(id)]),
              ),
              checked: {},
              mac: /Mac/.test(navigator.platform),
            };
            menu = await Menu.new({
              items: ids.map((id) => commandItem(id, snapshot)),
            });
            if (state.disposed || request !== state.revision) {
              await menu.close();
              return;
            }
            const previous = state.menu;
            state.menu = menu;
            await previous?.close();
            await menu.popup();
          } catch (value) {
            if (menu !== state.menu) await menu?.close().catch(() => {});
            if (!state.disposed) error.current(String(value));
          }
        })(),
      0,
    );
  };
}
