import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Command, CornerDownLeft, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";

export interface PaletteAction {
  id: string;
  group: string;
  title: string;
  subtitle?: string;
  shortcut?: string;
  keywords?: string;
  disabled?: boolean;
  run: () => void;
}

/** 全局快捷命令面板（⌘/Ctrl+P）：快速切换设备/运行、视图、规则、统计与导出操作。 */
export function CommandPalette({
  actions,
  onClose,
}: {
  actions: PaletteAction[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const visible = useMemo(() => {
    const enabled = actions.filter((action) => !action.disabled);
    const needle = query.trim().toLowerCase();
    if (!needle) return enabled;
    const tokens = needle.split(/\s+/).filter(Boolean);
    return enabled.filter((action) => {
      const hay =
        `${action.group} ${action.title} ${action.subtitle ?? ""} ${action.keywords ?? ""}`.toLowerCase();
      return tokens.every((tok) => hay.includes(tok));
    });
  }, [actions, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (typeof el.showModal === "function") {
      if (!el.open) el.showModal();
    } else {
      el.setAttribute("open", "");
    }
    inputRef.current?.focus();
    const handleClose = () => {
      el.returnValue = "";
      onClose();
    };
    el.addEventListener("close", handleClose);

    let pressedOutside = false;
    const isOutside = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) {
        if (typeof el.close === "function") el.close();
        else onClose();
      }
      pressedOutside = false;
    };
    const supportsClosedBy =
      typeof HTMLDialogElement !== "undefined" &&
      "closedBy" in HTMLDialogElement.prototype;
    if (!supportsClosedBy) {
      el.addEventListener("pointerdown", onPointerDown);
      el.addEventListener("pointerup", onPointerUp);
    }

    return () => {
      el.removeEventListener("close", handleClose);
      if (!supportsClosedBy) {
        el.removeEventListener("pointerdown", onPointerDown);
        el.removeEventListener("pointerup", onPointerUp);
      }
    };
  }, [onClose]);

  const closeDialog = () => {
    const el = dialogRef.current;
    if (el && typeof el.close === "function" && el.open) {
      el.close();
    } else {
      onClose();
    }
  };

  const execute = (action: PaletteAction | undefined) => {
    if (!action) return;
    closeDialog();
    action.run();
  };

  return (
    <dialog
      ref={dialogRef}
      className="native-modal-dialog palette-dialog"
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, string>)}
    >
      <div className="palette-head">
        <Command size={14} className="muted" aria-hidden="true" />
        <h1 id={titleId} className="sr-only">
          {t("commandPaletteTitle")}
        </h1>
        <Search size={14} className="muted" aria-hidden="true" />
        <input
          ref={inputRef}
          autoFocus
          type="text"
          className="palette-input"
          value={query}
          placeholder={t("commandPalettePlaceholder")}
          aria-label={t("commandPalettePlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelectedIndex((i) =>
                visible.length ? (i + 1) % visible.length : 0,
              );
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelectedIndex((i) =>
                visible.length ? (i - 1 + visible.length) % visible.length : 0,
              );
            } else if (e.key === "Enter") {
              e.preventDefault();
              execute(visible[selectedIndex]);
            }
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("dismiss")}
          onClick={closeDialog}
        >
          <X size={14} aria-hidden="true" />
        </Button>
      </div>

      <ul className="palette-list" role="listbox">
        {visible.length === 0 ? (
          <li className="palette-empty muted">{t("commandPaletteEmpty")}</li>
        ) : (
          visible.map((action, idx) => (
            <li
              key={action.id}
              role="option"
              aria-selected={idx === selectedIndex}
              className={`palette-item ${idx === selectedIndex ? "is-selected" : ""}`}
              onMouseEnter={() => setSelectedIndex(idx)}
              onClick={() => execute(action)}
            >
              <span className="palette-item-group">{action.group}</span>
              <span className="palette-item-main">
                <strong>{action.title}</strong>
                {action.subtitle && (
                  <small className="muted">{action.subtitle}</small>
                )}
              </span>
              {action.shortcut ? (
                <kbd className="palette-kbd">{action.shortcut}</kbd>
              ) : idx === selectedIndex ? (
                <CornerDownLeft
                  size={12}
                  className="muted"
                  aria-hidden="true"
                />
              ) : null}
            </li>
          ))
        )}
      </ul>
    </dialog>
  );
}
