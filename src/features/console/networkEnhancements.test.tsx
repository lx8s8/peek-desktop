import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDiagnosticBugReport,
  buildRequestBugReport,
  maskSensitiveHeaderValue,
} from "../detail/bugReport";
import { isSsePayload, parseSseEvents, SseViewer } from "../detail/SseViewer";
import {
  DEFAULT_BIZ_ERROR_RULE,
  readBizErrorRule,
  readFilterPresets,
  readGlobalNoiseConfig,
  readListenerPrefs,
  writeBizErrorRule,
  writeFilterPresets,
  writeGlobalNoiseConfig,
  writeListenerPrefs,
} from "../../lib/preferences";
import { NetworkRulesDialog } from "./NetworkRulesDialog";
import { EndpointStatsDialog } from "./EndpointStatsDialog";
import { CommandPalette } from "../command/CommandPalette";
import { RequestDiffDialog } from "../diff/RequestDiffDialog";
import { api } from "../../lib/ipc/client";
import type { BodyView, EntryRow } from "../../lib/ipc/types";

vi.mock("../../lib/ipc/client", () => ({
  desktop: true,
  api: {
    endpointStats: vi.fn(),
    metadata: vi.fn(),
    body: vi.fn(),
    writeClipboard: vi.fn(),
  },
}));

function makeEntry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: "req-1",
    seq: 1,
    method: "POST",
    url: "https://api.example.com/v1/orders/123?page=1",
    state: "completed",
    status: 200,
    durationMs: 125.4,
    startedAt: "2026-11-27T10:00:00Z",
    pinned: false,
    responseBytes: 512,
    source: "dio",
    graphqlOperation: "GetOrderDetail",
    bizError: "50001: 库存不足",
    ...overrides,
  };
}

function makeBody(
  text: string,
  mediaType: string | null = "application/json",
): BodyView {
  return {
    kind: text ? "text" : "empty",
    mediaType,
    size: text.length,
    capturedBytes: text.length,
    truncated: false,
    previewTruncated: false,
    text,
    reason: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("bugReport 脱敏与 Markdown 生成", () => {
  it("正确脱敏敏感请求头并保留非敏感请求头", () => {
    expect(
      maskSensitiveHeaderValue("Authorization", "Bearer abcdefghijklmnop"),
    ).toBe("Bearer abcd…mnop");
    expect(maskSensitiveHeaderValue("X-Api-Key", "short")).toBe("***");
    expect(maskSensitiveHeaderValue("Cookie", "session_id=1234567890")).toBe(
      "ses…890",
    );
    expect(maskSensitiveHeaderValue("Content-Type", "application/json")).toBe(
      "application/json",
    );
  });

  it("生成包含脱敏请求头、GraphQL 标识与业务异常的排查报告", () => {
    const md = buildRequestBugReport({
      entry: makeEntry(),
      deviceLabel: "测试机 A · 10:00",
      metadata: JSON.stringify({
        request: {
          headers: [
            ["Authorization", "Bearer secret_token_value_9999"],
            ["Content-Type", "application/json"],
          ],
        },
        response: {
          headers: [["X-Request-Id", "req-trace-42"]],
        },
      }),
      requestBody: makeBody('{"orderId":123}'),
      responseBody: makeBody('{"code":50001,"msg":"库存不足"}'),
    });
    expect(md).toContain("测试机 A · 10:00");
    expect(md).toContain("`GetOrderDetail`");
    expect(md).toContain("业务异常: 50001: 库存不足");
    expect(md).toContain("Authorization: Bearer secr…9999");
    expect(md).not.toContain("secret_token_value_9999");
    expect(md).toContain("X-Request-Id: req-trace-42");
    expect(md).toContain('"code": 50001');
  });

  it("诊断报告优先展示已还原堆栈并附带关联请求 ID", () => {
    const md = buildDiagnosticBugReport({
      deviceLabel: "测试机 A",
      event: {
        level: "error",
        source: "flutter",
        tag: "checkout",
        occurredAt: "2026-11-27T10:00:01Z",
        message: "Null check operator used on a null value",
        relatedNetworkEntryId: "req-99",
        exception: {
          type: "StateError",
          stackTrace: "#0 raw_frame",
        },
      },
      symbolizedStack: "#0 CheckoutPage.submit (package:app/checkout.dart:42)",
    });
    expect(md).toContain("已还原堆栈");
    expect(md).toContain("CheckoutPage.submit");
    expect(md).toContain("req-99");
    expect(md).not.toContain("#0 raw_frame");
  });
});

describe("SseViewer 事件流识别与解析", () => {
  const sampleStream = [
    ": heartbeat",
    "id: 1",
    "event: chunk",
    'data: {"delta":"你好"}',
    "",
    "id: 2",
    "event: done",
    "retry: 3000",
    "data: [DONE]",
  ].join("\n");

  it("识别 text/event-stream 与多段 data 行并正确拆分格式化", () => {
    expect(isSsePayload("text/event-stream; charset=utf-8", "")).toBe(true);
    expect(isSsePayload("text/plain", sampleStream)).toBe(true);
    expect(isSsePayload("application/json", '{"a":1}')).toBe(false);

    const parsed = parseSseEvents(sampleStream);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      index: 1,
      event: "chunk",
      id: "1",
      data: '{"delta":"你好"}',
    });
    expect(parsed[0].formattedJson).toContain('"delta": "你好"');
    expect(parsed[1]).toMatchObject({
      index: 2,
      event: "done",
      id: "2",
      retry: "3000",
      data: "[DONE]",
    });
  });

  it("支持在 SseViewer 中按关键词实时过滤事件", () => {
    render(<SseViewer text={sampleStream} />);
    expect(screen.getByText("2 / 2 条事件")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("过滤 SSE 事件类型或内容…"), {
      target: { value: "done" },
    });
    expect(screen.getByText("1 / 2 条事件")).toBeTruthy();
    expect(screen.getByText("[DONE]")).toBeTruthy();
  });
});

describe("preferences 新增持久化配置", () => {
  it("持久化监听偏好、降噪规则、筛选预设与业务错误码规则", () => {
    writeListenerPrefs({
      host: "127.0.0.1",
      port: "9888",
      advertise: false,
      diagnostics: false,
      autoStart: true,
    });
    expect(readListenerPrefs()).toEqual({
      host: "127.0.0.1",
      port: "9888",
      advertise: false,
      diagnostics: false,
      autoStart: true,
    });

    writeGlobalNoiseConfig({
      enabled: true,
      globalExcludes: ["/heartbeat", "/HEARTBEAT", "  /metrics  "],
      deviceExcludes: { "dev-1": ["/poll", ""] },
    });
    expect(readGlobalNoiseConfig()).toEqual({
      enabled: true,
      globalExcludes: ["/heartbeat", "/metrics"],
      deviceExcludes: { "dev-1": ["/poll"] },
    });

    writeFilterPresets([
      {
        id: "p1",
        name: "慢接口",
        filter: "all",
        methodFilter: "POST",
        statusFilter: "bizError",
        minDurationMs: 1000,
        search: "/orders",
        searchBody: true,
        hostFilter: "api.example.com",
      },
    ]);
    expect(readFilterPresets()).toHaveLength(1);
    expect(readFilterPresets()[0].name).toBe("慢接口");

    writeBizErrorRule({
      ...DEFAULT_BIZ_ERROR_RULE,
      enabled: true,
      codeField: "errNo",
      okValues: ["0", "200"],
    });
    expect(readBizErrorRule()).toMatchObject({
      enabled: true,
      codeField: "errNo",
      okValues: ["0", "200"],
    });
  });
});

describe("NetworkRulesDialog 业务错误、降噪与预设交互", () => {
  it("保存业务错误规则、增删降噪路径并管理筛选预设", () => {
    const onSaveBiz = vi.fn();
    const onSaveNoise = vi.fn();
    const onApplyPreset = vi.fn();
    const onSavePreset = vi.fn();
    const onDeletePreset = vi.fn();
    const onClose = vi.fn();

    render(
      <NetworkRulesDialog
        bizErrorRule={DEFAULT_BIZ_ERROR_RULE}
        noiseConfig={{
          enabled: true,
          globalExcludes: ["/ping"],
          deviceExcludes: {},
        }}
        currentDeviceId="dev-1"
        currentDeviceLabel="iPhone 16"
        presets={[
          {
            id: "preset-1",
            name: "仅看订单报错",
            filter: "errors",
            methodFilter: "POST",
            statusFilter: null,
            minDurationMs: null,
            search: "/orders",
            searchBody: false,
            hostFilter: null,
          },
        ]}
        onSaveBizErrorRule={onSaveBiz}
        onSaveNoiseConfig={onSaveNoise}
        onApplyPreset={onApplyPreset}
        onSaveCurrentAsPreset={onSavePreset}
        onDeletePreset={onDeletePreset}
        onClose={onClose}
      />,
    );

    fireEvent.click(
      screen.getByLabelText("启用 HTTP 200 响应 JSON 业务错误识别"),
    );
    expect(onSaveBiz).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );

    // 切到持久化降噪 Tab
    fireEvent.click(screen.getByRole("tab", { name: /持久化降噪/ }));
    fireEvent.change(screen.getByLabelText("全局屏蔽路径 / 关键词"), {
      target: { value: "/telemetry" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "添加" })[0]);
    expect(onSaveNoise).toHaveBeenCalledWith(
      expect.objectContaining({
        globalExcludes: ["/ping", "/telemetry"],
      }),
    );

    // 切到筛选预设 Tab
    fireEvent.click(screen.getByRole("tab", { name: /筛选预设/ }));
    fireEvent.change(
      screen.getByPlaceholderText("输入预设名称（例如：仅看订单慢接口）"),
      { target: { value: "支付慢请求" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "保存当前筛选" }));
    expect(onSavePreset).toHaveBeenCalledWith("支付慢请求");

    fireEvent.click(screen.getByRole("button", { name: /^仅看订单报错/ }));
    expect(onApplyPreset).toHaveBeenCalledWith(
      expect.objectContaining({ id: "preset-1" }),
    );
  });
});

describe("EndpointStatsDialog 接口聚合统计弹窗", () => {
  it("拉取统计报告、切换排序维度并触发筛选与样本跳转", async () => {
    vi.mocked(api.endpointStats).mockResolvedValue({
      totalRequests: 12,
      totalErrors: 2,
      totalBizErrors: 1,
      totalSlow: 3,
      totalBytes: 4096,
      endpoints: [
        {
          key: "GET|api.example.com|/v1/users/:id",
          method: "GET",
          host: "api.example.com",
          normalizedPath: "/v1/users/:id",
          graphqlOperation: null,
          count: 8,
          errorCount: 0,
          bizErrorCount: 0,
          pendingCount: 0,
          slowCount: 0,
          avgMs: 45,
          p50Ms: 40,
          p95Ms: 90,
          maxMs: 110,
          totalBytes: 2048,
          sampleEntryId: "e-fast",
          sampleUrl: "https://api.example.com/v1/users/1",
        },
        {
          key: "POST|api.example.com|/v1/orders",
          method: "POST",
          host: "api.example.com",
          normalizedPath: "/v1/orders",
          graphqlOperation: null,
          count: 4,
          errorCount: 2,
          bizErrorCount: 1,
          pendingCount: 0,
          slowCount: 3,
          avgMs: 900,
          p50Ms: 850,
          p95Ms: 1500,
          maxMs: 1800,
          totalBytes: 2048,
          sampleEntryId: "e-slow",
          sampleUrl: "https://api.example.com/v1/orders",
        },
      ],
    });
    const onFilterEndpoint = vi.fn();
    const onInspectSample = vi.fn();
    const onClose = vi.fn();

    render(
      <EndpointStatsDialog
        sessionId="sess-1"
        sessionLabel="iPhone 16 · 10:00"
        range={{}}
        afterSeq={null}
        bizErrorRule={DEFAULT_BIZ_ERROR_RULE}
        onFilterEndpoint={onFilterEndpoint}
        onInspectSample={onInspectSample}
        onClose={onClose}
      />,
    );

    await screen.findByText("/v1/users/:id");
    expect(screen.getByText("/v1/orders")).toBeTruthy();

    // 按 P95 耗时排序，慢接口排到第一行
    fireEvent.click(screen.getByRole("button", { name: "按 P95 耗时" }));
    const filterButtons = screen.getAllByRole("button", { name: "筛选" });
    fireEvent.click(filterButtons[0]);
    expect(onFilterEndpoint).toHaveBeenCalledWith(
      "/v1/orders",
      "api.example.com",
    );

    const sampleButtons = screen.getAllByRole("button", { name: "样本" });
    fireEvent.click(sampleButtons[0]);
    expect(onInspectSample).toHaveBeenCalledWith("e-slow");
  });
});

describe("CommandPalette 全局命令面板", () => {
  it("隐藏禁用命令、支持多关键词过滤与键盘回车执行", () => {
    const runStats = vi.fn();
    const runRules = vi.fn();
    const runDisabled = vi.fn();
    const onClose = vi.fn();

    render(
      <CommandPalette
        actions={[
          {
            id: "stats",
            group: "视图与分析",
            title: "接口聚合统计",
            keywords: "stats analytics",
            run: runStats,
          },
          {
            id: "rules",
            group: "视图与分析",
            title: "降噪与业务规则",
            keywords: "noise biz",
            run: runRules,
          },
          {
            id: "disabled",
            group: "操作",
            title: "不可用项",
            disabled: true,
            run: runDisabled,
          },
        ]}
        onClose={onClose}
      />,
    );

    expect(screen.queryByText("不可用项")).toBeNull();
    const input =
      screen.getByPlaceholderText("搜索设备、运行、视图或快捷命令…");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(runRules).toHaveBeenCalledTimes(1);
    expect(runStats).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("RequestDiffDialog 跨会话对比", () => {
  it("分别按 leftSessionId 与 rightSessionId 拉取数据并展示来源标签和 JSON 差异", async () => {
    vi.mocked(api.metadata).mockResolvedValue("{}");
    vi.mocked(api.body).mockImplementation(
      async (sessionId, _entryId, side) => {
        if (side === "response" && sessionId === "sess-a") {
          return makeBody('{"price":100,"currency":"CNY"}');
        }
        if (side === "response" && sessionId === "sess-b") {
          return makeBody('{"price":120,"currency":"CNY"}');
        }
        return makeBody("", null);
      },
    );

    render(
      <RequestDiffDialog
        leftSessionId="sess-a"
        leftLabel="设备 A · 09:00"
        left={makeEntry({ id: "entry-a" })}
        rightSessionId="sess-b"
        rightLabel="设备 B · 10:00"
        right={makeEntry({ id: "entry-b" })}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(api.body).toHaveBeenCalledWith("sess-a", "entry-a", "response");
      expect(api.body).toHaveBeenCalledWith("sess-b", "entry-b", "response");
    });
    expect(screen.getByText("设备 A · 09:00")).toBeTruthy();
    expect(screen.getByText("设备 B · 10:00")).toBeTruthy();
    await screen.findByText("$.price");
    expect(screen.getByText("100")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
  });
});
