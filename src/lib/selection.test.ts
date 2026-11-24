import { afterEach, describe, expect, it } from "vitest";
import {
  installSelectScopeTracker,
  performScopedSelectAll,
  resetSelectScopeTracker,
} from "./selection";

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
  resetSelectScopeTracker();
});

describe("scoped select-all guard", () => {
  it("selects only the focused JSON scope without leaking into menus or toolbars", () => {
    const cleanup = installSelectScopeTracker();
    document.body.innerHTML = `
      <header class="toolbar"><button id="menu-btn">打开文件</button></header>
      <aside class="detail-pane">
        <pre id="json-pre" data-select-scope="json-text" tabindex="0">{"ok":true}</pre>
      </aside>
    `;

    const pre = document.getElementById("json-pre")!;
    pre.focus();
    expect(performScopedSelectAll()).toBe(true);
    expect(window.getSelection()?.toString()).toBe('{"ok":true}');

    // 焦点移回顶部菜单按钮时，全选应被安全拦截而非全选整个应用
    window.getSelection()?.removeAllRanges();
    const menuBtn = document.getElementById("menu-btn")!;
    menuBtn.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    menuBtn.focus();
    expect(performScopedSelectAll()).toBe(false);
    expect(window.getSelection()?.toString()).toBe("");
    cleanup();
  });

  it("preserves native text selection inside inputs and textareas", () => {
    document.body.innerHTML = `
      <input id="search-input" type="search" value="hello world" />
      <pre id="json-pre" data-select-scope="json-text" tabindex="0">{"a":1}</pre>
    `;

    const input = document.getElementById("search-input") as HTMLInputElement;
    input.focus();
    expect(performScopedSelectAll()).toBe(true);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("hello world".length);
  });
});
