import { commands } from "./commands/dispatcher";

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
]);

let lastActiveScope: HTMLElement | null = null;

/** 判断元素是否为可进行文本全选的表单输入框。 */
export function isTextInputElement(
  el: EventTarget | null,
): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has((el.type || "text").toLowerCase());
  }
  return false;
}

/** 从任意事件目标或 DOM 节点向上查找最近的可局部全选作用域容器。 */
export function findSelectScope(
  target: Node | EventTarget | null,
): HTMLElement | null {
  if (!target) return null;
  if (target instanceof HTMLElement) {
    return target.closest<HTMLElement>("[data-select-scope]");
  }
  if (target instanceof Node) {
    return (
      target.parentElement?.closest<HTMLElement>("[data-select-scope]") ?? null
    );
  }
  return null;
}

/** 校验作用域元素仍挂载在文档中且未处于隐藏 Tab 面板内。 */
function isVisibleScope(el: HTMLElement | null): el is HTMLElement {
  if (!el || !el.isConnected) return false;
  if (el.closest('[data-state="inactive"], [hidden]')) return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

/** 将浏览器文本选区精确限定在指定元素内容内部。 */
export function selectElementContents(el: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * 安装全局交互作用域追踪器：
 * - 用户点击或聚焦某个 `[data-select-scope]`（如 JSON 预览区）时记录为当前活跃作用域；
 * - 用户点击其他 UI 控件（工具栏、侧边栏、菜单、输入框）时清空记录，避免跨区误选。
 */
export function installSelectScopeTracker(): () => void {
  const track = (event: Event) => {
    const target = event.target;
    if (isTextInputElement(target)) {
      lastActiveScope = null;
      return;
    }
    const scope = findSelectScope(target);
    lastActiveScope = scope;
  };
  document.addEventListener("pointerdown", track, true);
  document.addEventListener("focusin", track, true);
  return () => {
    document.removeEventListener("pointerdown", track, true);
    document.removeEventListener("focusin", track, true);
    lastActiveScope = null;
  };
}

/** 供测试清理模块级状态。 */
export function resetSelectScopeTracker(): void {
  lastActiveScope = null;
}

/**
 * 执行上下文感知的局部全选（响应 ⌘/Ctrl+A 与原生菜单「全选文本」）：
 * 1. 输入框 / 文本域 / contentEditable：仅全选该输入框自身文本；
 * 2. JSON 正文、JSON 树、堆栈、日志详情等 `[data-select-scope]` 容器：仅全选该容器内容；
 * 3. 日志多选表格：委托给 `edit.selectWindow`；
 * 4. 其他非文本 UI 区域（工具栏、侧边栏、菜单等）：安全拦截，绝不触发全文档选中。
 */
export function performScopedSelectAll(
  eventTarget?: EventTarget | null,
): boolean {
  const active = document.activeElement;
  if (isTextInputElement(active)) {
    active.select();
    return true;
  }
  if (active instanceof HTMLElement && active.isContentEditable) {
    return selectElementContents(active);
  }
  if (isTextInputElement(eventTarget ?? null)) {
    (eventTarget as HTMLInputElement | HTMLTextAreaElement).select();
    return true;
  }

  const directScope =
    findSelectScope(eventTarget ?? null) ??
    findSelectScope(active) ??
    findSelectScope(window.getSelection()?.anchorNode ?? null);
  if (isVisibleScope(directScope)) {
    return selectElementContents(directScope);
  }

  // 诊断列表多选区聚焦时走当前窗口多选
  if (
    active instanceof HTMLElement &&
    active.closest("[data-select-window-grid]")
  ) {
    return commands.dispatch("edit.selectWindow");
  }

  // 当焦点回落到 body 但用户刚刚交互的是某个可见阅读容器时，仍限定在该容器内全选
  if (
    (!active || active === document.body) &&
    isVisibleScope(lastActiveScope)
  ) {
    return selectElementContents(lastActiveScope);
  }

  return false;
}
