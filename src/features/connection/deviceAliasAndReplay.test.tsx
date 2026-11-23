import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../lib/i18n";
import {
  readDeviceAliases,
  resolveDeviceDisplay,
  writeDeviceAlias,
} from "../../lib/preferences";
import { DeviceAliasDialog } from "./DeviceAliasDialog";
import { ReplayDialog } from "../detail/ReplayDialog";
import { api } from "../../lib/ipc/client";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("设备备注持久化与弹窗顶层 Portal 渲染", () => {
  it("支持按 deviceId 保存/清空桌面端设备备注并保留上报机型副标", () => {
    let aliases = readDeviceAliases();
    expect(aliases).toEqual({});

    aliases = writeDeviceAlias(aliases, "dev-1", "测试机 03 · 联调账号");
    expect(readDeviceAliases()).toEqual({ "dev-1": "测试机 03 · 联调账号" });
    expect(resolveDeviceDisplay("dev-1", "iPhone 16 Pro", aliases)).toEqual({
      title: "测试机 03 · 联调账号",
      subtitle: "iPhone 16 Pro",
      alias: "测试机 03 · 联调账号",
    });

    aliases = writeDeviceAlias(aliases, "dev-1", "   ");
    expect(readDeviceAliases()).toEqual({});
    expect(resolveDeviceDisplay("dev-1", "iPhone 16 Pro", aliases)).toEqual({
      title: "iPhone 16 Pro",
      subtitle: null,
      alias: "",
    });
  });

  it("DeviceAliasDialog 通过 Portal 挂载到 document.body 并提交自定义备注", () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <DeviceAliasDialog
        deviceId="dev-1"
        reportedName="iPhone 16 Pro"
        initialAlias=""
        onSave={onSave}
        onClose={onClose}
      />,
    );
    // 确认通过 Portal 挂载在 document.body 而非受限父容器内
    expect(container.querySelector(".dialog-backdrop")).toBeNull();
    expect(document.body.querySelector(".alias-dialog")).not.toBeNull();
    expect(screen.getByText("iPhone 16 Pro")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "QA-主测机" },
    });
    fireEvent.submit(document.body.querySelector(".alias-form")!);
    expect(onSave).toHaveBeenCalledWith("dev-1", "QA-主测机");
    expect(onClose).toHaveBeenCalled();
  });

  it("ReplayDialog 通过 Portal 独立弹出、支持自动补拉 Headers 与全屏切换", async () => {
    vi.spyOn(api, "metadata").mockResolvedValue(
      JSON.stringify({
        request: { headers: [["X-Env", "staging"]] },
      }),
    );
    vi.spyOn(api, "body").mockResolvedValue({
      kind: "text",
      mediaType: "application/json",
      size: 10,
      capturedBytes: 10,
      truncated: false,
      previewTruncated: false,
      text: '{"a":1}',
      reason: null,
    });

    const { container } = render(
      <ReplayDialog
        sessionId="live-1"
        entry={{
          id: "req-1",
          source: "dio",
          method: "POST",
          url: "https://api.example.test/v1/order",
          startedAt: "2026-11-23T01:00:00Z",
          durationMs: 120,
          status: 200,
          state: "completed",
          pinned: false,
          responseBytes: 64,
        }}
        theme="light"
        onClose={vi.fn()}
      />,
    );

    // Portal 直接挂到 document.body，摆脱 DetailPane content-visibility 限制
    expect(container.querySelector(".replay-dialog")).toBeNull();
    const dialog = document.body.querySelector(".replay-dialog");
    expect(dialog).not.toBeNull();

    await waitFor(() => expect(screen.getByDisplayValue("X-Env")).toBeTruthy());
    expect(screen.getByDisplayValue('{"a":1}')).toBeTruthy();

    const maxBtn = screen.getByRole("button", {
      name: /全屏展开|Maximize/i,
    });
    fireEvent.click(maxBtn);
    expect(dialog?.classList.contains("is-maximized")).toBe(true);
  });
});
