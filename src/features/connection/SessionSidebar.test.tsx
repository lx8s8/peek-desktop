import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../lib/i18n";
import type { RemoteSnapshot, SessionSummary } from "../../lib/ipc/types";
import { formatRunStartedAt, groupWorkspaceSessions } from "./sessionGroups";
import { SessionSidebar } from "./SessionSidebar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  const id = overrides.id ?? "live-1";
  return {
    id,
    deviceId: "dev-iphone",
    networkSessionId: `net-${id}`,
    online: false,
    syncing: false,
    generation: 1,
    version: 1,
    filename: "iPhone 16 Pro",
    header: {
      formatVersion: 1,
      peekVersion: "2.1.1",
      name: "iPhone 16 Pro",
      platform: "ios",
      startedAt: "2026-11-27T01:20:00.000Z",
    },
    entryCount: 12,
    skipped: 0,
    newerFormat: false,
    rawBytes: 1024,
    ...overrides,
  };
}

function makeRemote(overrides: Partial<RemoteSnapshot> = {}): RemoteSnapshot {
  return {
    listening: true,
    host: "0.0.0.0",
    port: 9741,
    addresses: ["192.168.1.10:9741"],
    mdns: "active",
    revision: 1,
    pairing: {
      serverId: "srv-1",
      code: null,
      expiresInSeconds: 0,
      devices: [
        { id: "dev-iphone", name: "iPhone 16 Pro", diagnostics: true },
        { id: "dev-pixel", name: "Pixel 9", diagnostics: false },
      ],
    },
    sessions: [],
    diagnosticRuns: [],
    ...overrides,
  };
}

describe("sessionGroups 纯函数分组与时间格式化", () => {
  it("按 deviceId 聚合实时会话，组内在线优先且按启动时间倒序，并分离离线文件", () => {
    const oldOffline = makeSession({
      id: "live-old",
      deviceId: "dev-iphone",
      online: false,
      header: {
        formatVersion: 1,
        peekVersion: "2.1.1",
        name: "iPhone 16 Pro",
        platform: "ios",
        startedAt: "2026-11-27T01:10:00.000Z",
      },
    });
    const newerOffline = makeSession({
      id: "live-mid",
      deviceId: "dev-iphone",
      online: false,
      header: {
        formatVersion: 1,
        peekVersion: "2.1.1",
        name: "iPhone 16 Pro",
        platform: "ios",
        startedAt: "2026-11-27T01:15:00.000Z",
      },
    });
    const activeOnline = makeSession({
      id: "live-new",
      deviceId: "dev-iphone",
      online: true,
      header: {
        formatVersion: 1,
        peekVersion: "2.1.1",
        name: "iPhone 16 Pro",
        platform: "ios",
        startedAt: "2026-11-27T01:20:00.000Z",
      },
    });
    const pixelOffline = makeSession({
      id: "live-pixel",
      deviceId: "dev-pixel",
      online: false,
      filename: "Pixel 9",
      header: {
        formatVersion: 1,
        peekVersion: "2.1.1",
        name: "Pixel 9",
        platform: "android",
        startedAt: "2026-11-27T01:25:00.000Z",
      },
    });
    const fileSession = makeSession({
      id: "file-1",
      deviceId: undefined,
      networkSessionId: undefined,
      online: undefined,
      filename: "capture.peek",
      header: {
        formatVersion: 1,
        peekVersion: "2.1.1",
        name: "capture.peek",
        platform: "macos",
        startedAt: "2026-11-26T10:00:00.000Z",
      },
    });

    const grouped = groupWorkspaceSessions([
      pixelOffline,
      oldOffline,
      fileSession,
      activeOnline,
      newerOffline,
    ]);

    expect(grouped.fileSessions.map((s) => s.id)).toEqual(["file-1"]);
    // 有在线运行的设备组排在纯离线设备组前面
    expect(grouped.deviceGroups.map((g) => g.deviceId)).toEqual([
      "dev-iphone",
      "dev-pixel",
    ]);
    // 同一设备内：在线运行优先，其次按启动时间由新到旧
    expect(grouped.deviceGroups[0].runs.map((r) => r.id)).toEqual([
      "live-new",
      "live-mid",
      "live-old",
    ]);
    expect(grouped.deviceGroups[0].onlineCount).toBe(1);
    expect(grouped.deviceGroups[0].offlineCount).toBe(2);
    expect(grouped.deviceGroups[0].hasDistinctRunNames).toBe(false);
    expect(grouped.orderedSessions.map((s) => s.id)).toEqual([
      "live-new",
      "live-mid",
      "live-old",
      "live-pixel",
      "file-1",
    ]);
  });

  it("按当天 / 同年跨天 / 跨年格式化启动时间，并对非法值返回空字符串", () => {
    const now = new Date(2026, 10, 27, 14, 0, 0);
    const todayIso = new Date(2026, 10, 27, 9, 25, 12).toISOString();
    const yesterdayIso = new Date(2026, 10, 26, 18, 5, 0).toISOString();
    const lastYearIso = new Date(2025, 4, 3, 8, 30, 0).toISOString();

    expect(formatRunStartedAt(todayIso, "zh-CN", now)).toBe("09:25:12");
    expect(formatRunStartedAt(yesterdayIso, "zh-CN", now)).toContain("26");
    expect(formatRunStartedAt(yesterdayIso, "zh-CN", now)).toContain("18:05");
    expect(formatRunStartedAt(lastYearIso, "zh-CN", now)).toContain("2025");
    expect(formatRunStartedAt("not-a-date", "zh-CN", now)).toBe("");
    expect(formatRunStartedAt(undefined, "zh-CN", now)).toBe("");
  });
});

describe("SessionSidebar 按设备聚合展示与交互", () => {
  it("将同一设备的多次运行整合在同一设备分组下，支持折叠展开、备注显示与一键清理离线运行", () => {
    const runOld = makeSession({
      id: "live-old",
      online: false,
      entryCount: 45,
      header: {
        formatVersion: 1,
        peekVersion: "2.1.1",
        name: "iPhone 16 Pro",
        platform: "ios",
        startedAt: "2026-11-27T01:10:00.000Z",
      },
    });
    const runOnline = makeSession({
      id: "live-new",
      online: true,
      entryCount: 8,
      header: {
        formatVersion: 1,
        peekVersion: "2.1.1",
        name: "iPhone 16 Pro",
        platform: "ios",
        startedAt: "2026-11-27T01:25:00.000Z",
      },
    });
    const fileSession = makeSession({
      id: "file-1",
      deviceId: undefined,
      online: undefined,
      filename: "qa-bug.peek",
      entryCount: 3,
      header: {
        formatVersion: 1,
        peekVersion: "2.1.1",
        name: "qa-bug.peek",
        platform: "ios",
        startedAt: "2026-11-26T00:00:00.000Z",
      },
    });

    const onSelectSession = vi.fn();
    const onCloseSession = vi.fn();
    const onCloseDeviceOfflineRuns = vi.fn();
    const onEditDeviceAlias = vi.fn();

    render(
      <SessionSidebar
        sessions={[runOld, runOnline, fileSession]}
        remote={makeRemote({ sessions: [runOld, runOnline] })}
        activeId="live-new"
        independentId={null}
        deviceAliases={{ "dev-iphone": "主测机 A" }}
        desktop
        busy={false}
        saving={false}
        onSelectSession={onSelectSession}
        onSelectIndependent={vi.fn()}
        onOpenFile={vi.fn()}
        onCloseSession={onCloseSession}
        onCloseDeviceOfflineRuns={onCloseDeviceOfflineRuns}
        onCloseDiagnostic={vi.fn()}
        onEditDeviceAlias={onEditDeviceAlias}
        onSessionContextMenu={vi.fn()}
        onIndependentContextMenu={vi.fn()}
      />,
    );

    // 同一设备只出现一个设备分组头，展示自定义备注、上报机型副标、运行计数与状态汇总
    expect(screen.getAllByText("主测机 A")).toHaveLength(1);
    expect(screen.getByText("iPhone 16 Pro")).toBeTruthy();
    expect(screen.getByText("2 次运行")).toBeTruthy();
    expect(screen.getByText("1 在线 · 1 离线")).toBeTruthy();
    expect(screen.getByText("1 台在线")).toBeTruthy();

    // 离线文件独立展示在离线文件分区
    expect(screen.getByText("离线文件")).toBeTruthy();
    expect(screen.getByText("qa-bug.peek")).toBeTruthy();

    // 默认展开，展示两条运行子项，点击旧离线运行触发选中
    const groupToggle = screen.getByRole("button", {
      name: /^主测机 A.*2 次运行/,
    });
    expect(groupToggle.getAttribute("aria-expanded")).toBe("true");
    const runsListId = groupToggle.getAttribute("aria-controls")!;
    const runsList = document.getElementById(runsListId)!;
    expect(runsList.hidden).toBe(false);

    fireEvent.click(screen.getByText(/45 条请求/));
    expect(onSelectSession).toHaveBeenCalledWith("live-old");

    // 点击一键清理离线运行按钮
    const clearOfflineBtn = screen.getByRole("button", {
      name: "清理 主测机 A 的 1 条离线运行",
    });
    fireEvent.click(clearOfflineBtn);
    expect(onCloseDeviceOfflineRuns).toHaveBeenCalledWith(
      "dev-iphone",
      "主测机 A",
    );

    // 点击折叠设备分组
    fireEvent.click(groupToggle);
    expect(groupToggle.getAttribute("aria-expanded")).toBe("false");
    expect(runsList.hidden).toBe(true);

    // 点击编辑设备备注
    fireEvent.click(
      screen.getByRole("button", { name: "设置设备名称 / 备注 主测机 A" }),
    );
    expect(onEditDeviceAlias).toHaveBeenCalledWith(
      "dev-iphone",
      "iPhone 16 Pro",
    );
  });

  it("当设备仅有 1 次运行时以紧凑单卡展示，不额外嵌套二级折叠列表", () => {
    const singleRun = makeSession({
      id: "live-only",
      online: true,
      entryCount: 5,
    });

    const { container } = render(
      <SessionSidebar
        sessions={[singleRun]}
        remote={makeRemote({ sessions: [singleRun] })}
        activeId="live-only"
        independentId={null}
        deviceAliases={{}}
        desktop
        busy={false}
        saving={false}
        onSelectSession={vi.fn()}
        onSelectIndependent={vi.fn()}
        onOpenFile={vi.fn()}
        onCloseSession={vi.fn()}
        onCloseDeviceOfflineRuns={vi.fn()}
        onCloseDiagnostic={vi.fn()}
        onEditDeviceAlias={vi.fn()}
        onSessionContextMenu={vi.fn()}
        onIndependentContextMenu={vi.fn()}
      />,
    );

    expect(container.querySelector(".device-group")).toBeNull();
    expect(screen.getByText("iPhone 16 Pro")).toBeTruthy();
    expect(screen.getByText(/在线.*5 条请求/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /清理.*离线运行/ })).toBeNull();
  });
});
