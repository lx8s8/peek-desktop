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
import { extractReplayBody, ReplayDialog } from "../detail/ReplayDialog";
import { analyzeJson } from "../detail/json";
import { api } from "../../lib/ipc/client";

class StubWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(input: unknown) {
    if (typeof input === "string") {
      queueMicrotask(() => this.onmessage?.({ data: analyzeJson(input) }));
    }
  }
  terminate() {}
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it("自动将 POST Form 请求体还原为 URL 编码并支持响应头查看与原响应 Diff 对比", async () => {
    vi.stubGlobal("Worker", StubWorker);
    const formExtracted = extractReplayBody({
      kind: "form",
      mediaType: "application/x-www-form-urlencoded",
      size: 64,
      capturedBytes: 64,
      truncated: false,
      previewTruncated: false,
      text: JSON.stringify({
        kind: "form",
        type: "application/x-www-form-urlencoded",
        fields: [
          ["username", "alice"],
          ["role", "qa tester"],
        ],
      }),
      reason: null,
    });
    expect(formExtracted.text).toBe("username=alice&role=qa+tester");
    expect(formExtracted.notice?.key).toBe("replayFormEncodedHint");

    vi.spyOn(api, "metadata").mockResolvedValue(
      JSON.stringify({
        request: {
          headers: [["Content-Type", "application/json"]],
        },
      }),
    );
    vi.spyOn(api, "body").mockImplementation(async (_sid, _eid, side) =>
      side === "request"
        ? {
            kind: "text",
            mediaType: "application/json",
            size: 16,
            capturedBytes: 16,
            truncated: false,
            previewTruncated: false,
            text: '{"orderId":1001}',
            reason: null,
          }
        : {
            kind: "text",
            mediaType: "application/json",
            size: 28,
            capturedBytes: 28,
            truncated: false,
            previewTruncated: false,
            text: '{"ok":true,"status":"old"}',
            reason: null,
          },
    );
    const replaySpy = vi.spyOn(api, "replay").mockResolvedValue({
      status: 201,
      statusText: "Created",
      durationMs: 45,
      headers: [["x-trace-id", "trace-999"]],
      mediaType: "application/json",
      body: '{"ok":true,"status":"new"}',
      bytes: 26,
      truncated: false,
    });

    render(
      <ReplayDialog
        sessionId="live-1"
        entry={{
          id: "post-1",
          source: "dio",
          method: "POST",
          url: "https://api.example.test/v1/order",
          startedAt: "2026-11-24T01:00:00Z",
          durationMs: 120,
          status: 200,
          state: "completed",
          pinned: false,
          responseBytes: 28,
        }}
        theme="light"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByDisplayValue('{"orderId":1001}')).toBeTruthy(),
    );

    // 格式化请求体 JSON
    fireEvent.click(screen.getByRole("button", { name: "格式化 JSON" }));
    expect(
      (document.body.querySelector(".replay-body-input") as HTMLTextAreaElement)
        .value,
    ).toContain('\n  "orderId": 1001\n');

    // 勾选忽略自签名证书并发送 POST 重放
    fireEvent.click(screen.getByLabelText(/忽略自签名证书/));
    fireEvent.click(screen.getByRole("button", { name: "发送请求" }));

    await waitFor(() => expect(replaySpy).toHaveBeenCalledOnce());
    expect(replaySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        acceptInvalidCerts: true,
      }),
    );

    // 切换查看响应头
    await screen.findByText(/201 Created/);
    fireEvent.click(screen.getByRole("tab", { name: /响应头 \(1\)/ }));
    expect(screen.getByText("trace-999")).toBeTruthy();

    // 切换与原抓包响应 Diff 对比
    fireEvent.click(screen.getByRole("tab", { name: "与原响应对比" }));
    await screen.findByText("$.status");
    expect(screen.getByText('"old"')).toBeTruthy();
    expect(screen.getByText('"new"')).toBeTruthy();
  });

  it("支持批量重复重发：展示状态分布与逐次明细，并支持点击任意次查看响应正文", async () => {
    vi.stubGlobal("Worker", StubWorker);
    vi.spyOn(api, "metadata").mockResolvedValue(
      JSON.stringify({ request: { headers: [] } }),
    );
    vi.spyOn(api, "body").mockResolvedValue({
      kind: "text",
      mediaType: "application/json",
      size: 12,
      capturedBytes: 12,
      truncated: false,
      previewTruncated: false,
      text: '{"ping":1}',
      reason: null,
    });
    const batchSpy = vi.spyOn(api, "replayBatch").mockResolvedValue({
      total: 3,
      succeeded: 2,
      failed: 1,
      totalDurationMs: 180,
      minMs: 32,
      avgMs: 55,
      p50Ms: 48,
      p95Ms: 85,
      maxMs: 85,
      statusCounts: [
        ["200", 2],
        ["ERR", 1],
      ],
      items: [
        {
          index: 1,
          ok: true,
          durationMs: 32,
          error: null,
          response: {
            status: 200,
            statusText: "OK",
            durationMs: 32,
            headers: [["x-run", "1"]],
            mediaType: "application/json",
            body: '{"run":1}',
            bytes: 9,
            truncated: false,
          },
        },
        {
          index: 2,
          ok: true,
          durationMs: 48,
          error: null,
          response: {
            status: 200,
            statusText: "OK",
            durationMs: 48,
            headers: [["x-run", "2"]],
            mediaType: "application/json",
            body: '{"run":2,"picked":true}',
            bytes: 23,
            truncated: false,
          },
        },
        {
          index: 3,
          ok: false,
          durationMs: 85,
          error: "connection reset",
          response: null,
        },
      ],
    });

    render(
      <ReplayDialog
        sessionId="live-1"
        initialBatchMode
        entry={{
          id: "post-batch-1",
          source: "dio",
          method: "POST",
          url: "https://api.example.test/v1/batch",
          startedAt: "2026-11-24T02:00:00Z",
          durationMs: 90,
          status: 200,
          state: "completed",
          pinned: false,
          responseBytes: 32,
        }}
        theme="light"
        onClose={vi.fn()}
      />,
    );

    // 批量模式默认次数为 5，改为 3 并点击批量发送
    const repeatInput = screen.getByLabelText("重复次数") as HTMLInputElement;
    expect(repeatInput.value).toBe("5");
    fireEvent.change(repeatInput, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "批量重发 (3 次)" }));

    await waitFor(() => expect(batchSpy).toHaveBeenCalledOnce());
    expect(batchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 3,
        concurrency: 2,
        method: "POST",
      }),
    );

    // 核对汇总与状态码分布
    await screen.findByText("成功 2/3 · 失败 1");
    expect(screen.getByText("200 ×2")).toBeTruthy();
    expect(screen.getByText("ERR ×1")).toBeTruthy();

    // 点击第 2 次记录并验证响应正文切到第 2 次
    fireEvent.click(screen.getByRole("option", { name: /#2/ }));
    await waitFor(() => expect(document.body.textContent).toContain("picked"));

    // 点击失败的第 3 次记录展示错误原因
    fireEvent.click(screen.getByRole("option", { name: /#3/ }));
    await screen.findByText(/#3: connection reset/);
  });
});
