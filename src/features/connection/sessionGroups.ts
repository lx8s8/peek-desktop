import type { SessionSummary } from "../../lib/ipc/types";

/** 同一物理/配对设备下的实时运行分组。 */
export interface DeviceSessionGroup {
  deviceId: string;
  /** 该设备对外展示的原始上报名称（优先取最新一次运行的名称，兜底使用配对记录名称）。 */
  reportedName: string;
  /** 已排序的运行记录：在线优先，其次按启动时间由新到旧。 */
  runs: SessionSummary[];
  /** 组内各次运行是否存在不同的上报名称（如同一设备先后调试不同 App）。 */
  hasDistinctRunNames: boolean;
  onlineCount: number;
  offlineCount: number;
  hasOnline: boolean;
  latestStartedAt: number;
}

export interface WorkspaceSessionGroups {
  deviceGroups: DeviceSessionGroup[];
  fileSessions: SessionSummary[];
  /** 按设备组顺序展开后的优先候选会话列表，用于初始或关闭后的智能选中。 */
  orderedSessions: SessionSummary[];
}

export interface PairedDeviceMeta {
  id: string;
  name: string;
}

/** 将 RFC 3339 启动时间解析为毫秒时间戳，无效格式返回 0。 */
export function parseStartedAtMs(startedAt: string | undefined): number {
  if (!startedAt) return 0;
  const ms = Date.parse(startedAt);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 将工作区内的会话拆分为「按 deviceId 聚合的实时设备组」与「离线文件会话」。
 * 排序规则保证每次刷新顺序稳定，不会因后端 HashMap 迭代顺序变化而跳动。
 */
export function groupWorkspaceSessions(
  sessions: SessionSummary[],
  pairedDevices: readonly PairedDeviceMeta[] = [],
): WorkspaceSessionGroups {
  const pairedNameById = new Map<string, string>();
  for (const device of pairedDevices) {
    if (device.name.trim()) {
      pairedNameById.set(device.id, device.name);
    }
  }

  const deviceBuckets = new Map<
    string,
    { firstIndex: number; items: { session: SessionSummary; index: number }[] }
  >();
  const fileSessions: SessionSummary[] = [];

  sessions.forEach((session, index) => {
    if (!session.deviceId) {
      fileSessions.push(session);
      return;
    }
    let bucket = deviceBuckets.get(session.deviceId);
    if (!bucket) {
      bucket = { firstIndex: index, items: [] };
      deviceBuckets.set(session.deviceId, bucket);
    }
    bucket.items.push({ session, index });
  });

  const groupsWithOrder: { group: DeviceSessionGroup; firstIndex: number }[] =
    [];

  for (const [deviceId, bucket] of deviceBuckets.entries()) {
    const sorted = [...bucket.items].sort((a, b) => {
      const onlineDiff =
        Number(!!b.session.online) - Number(!!a.session.online);
      if (onlineDiff !== 0) return onlineDiff;
      const timeDiff =
        parseStartedAtMs(b.session.header.startedAt) -
        parseStartedAtMs(a.session.header.startedAt);
      if (timeDiff !== 0) return timeDiff;
      const genDiff = (b.session.generation ?? 0) - (a.session.generation ?? 0);
      if (genDiff !== 0) return genDiff;
      return a.index - b.index;
    });

    const runs = sorted.map((item) => item.session);
    const onlineCount = runs.filter((run) => !!run.online).length;
    const offlineCount = runs.length - onlineCount;
    const latestStartedAt = runs.reduce(
      (max, run) => Math.max(max, parseStartedAtMs(run.header.startedAt)),
      0,
    );

    const distinctNames = new Set(
      runs
        .map((run) => (run.header.name || run.filename || "").trim())
        .filter(Boolean),
    );
    const primaryRun = runs[0];
    const reportedName =
      primaryRun?.header.name ||
      primaryRun?.filename ||
      pairedNameById.get(deviceId) ||
      deviceId;

    groupsWithOrder.push({
      firstIndex: bucket.firstIndex,
      group: {
        deviceId,
        reportedName,
        runs,
        hasDistinctRunNames: distinctNames.size > 1,
        onlineCount,
        offlineCount,
        hasOnline: onlineCount > 0,
        latestStartedAt,
      },
    });
  }

  groupsWithOrder.sort((a, b) => {
    const onlineDiff = Number(b.group.hasOnline) - Number(a.group.hasOnline);
    if (onlineDiff !== 0) return onlineDiff;
    const timeDiff = b.group.latestStartedAt - a.group.latestStartedAt;
    if (timeDiff !== 0) return timeDiff;
    return a.firstIndex - b.firstIndex;
  });

  const deviceGroups = groupsWithOrder.map((entry) => entry.group);
  const orderedSessions = [
    ...deviceGroups.flatMap((group) => group.runs),
    ...fileSessions,
  ];

  return { deviceGroups, fileSessions, orderedSessions };
}

/**
 * 格式化单次运行的紧凑本地启动时间：
 * - 当天展示 HH:mm:ss，方便区分短时间内连续热重启的多次运行；
 * - 同年跨天展示 MM/DD HH:mm；
 * - 跨年展示 YYYY/MM/DD HH:mm。
 */
export function formatRunStartedAt(
  startedAt: string | undefined,
  locale: string,
  now: Date = new Date(),
): string {
  const ms = parseStartedAtMs(startedAt);
  if (!ms) return "";
  const date = new Date(ms);
  const sameYear = date.getFullYear() === now.getFullYear();
  const sameDay =
    sameYear &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  try {
    if (sameDay) {
      return new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(date);
    }
    if (sameYear) {
      return new Intl.DateTimeFormat(locale, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date);
    }
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    const pad = (n: number) => String(n).padStart(2, "0");
    if (sameDay) {
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }
    return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

/** 格式化单次运行的完整本地日期时间，用于悬停提示。 */
export function formatRunStartedAtFull(
  startedAt: string | undefined,
  locale: string,
): string {
  const ms = parseStartedAtMs(startedAt);
  if (!ms) return "";
  const date = new Date(ms);
  try {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}
