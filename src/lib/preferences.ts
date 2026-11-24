export function readPreference(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`peek.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writePreference(key: string, value: string) {
  try {
    localStorage.setItem(`peek.${key}`, value);
  } catch {
    /* Read-only storage keeps defaults. */
  }
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const DEVICE_ALIASES_KEY = "deviceAliases";

/** 读取桌面端本地保存的设备自定义备注映射（deviceId -> 备注名）。 */
export function readDeviceAliases(): Record<string, string> {
  try {
    const raw = readPreference(DEVICE_ALIASES_KEY, "");
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) {
        result[key] = value.trim();
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** 更新或清空单台设备的桌面端自定义备注并持久化到 localStorage。 */
export function writeDeviceAlias(
  current: Record<string, string>,
  deviceId: string,
  rawAlias: string,
): Record<string, string> {
  const cleaned = rawAlias
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 60);
  const next = { ...current };
  if (cleaned) {
    next[deviceId] = cleaned;
  } else {
    delete next[deviceId];
  }
  writePreference(DEVICE_ALIASES_KEY, JSON.stringify(next));
  return next;
}

/** 解析设备展示标题与原始上报机型副标：存在自定义备注时优先展示备注并保留机型提示。 */
export function resolveDeviceDisplay(
  deviceId: string | undefined,
  reportedName: string,
  aliases: Record<string, string>,
): { title: string; subtitle: string | null; alias: string } {
  const alias = deviceId ? (aliases[deviceId] ?? "") : "";
  if (alias && alias !== reportedName) {
    return { title: alias, subtitle: reportedName, alias };
  }
  return { title: alias || reportedName, subtitle: null, alias };
}

export type OptionalRequestColumn =
  "durationMs" | "waterfall" | "responseBytes" | "startedAt" | "source";

export interface RequestTableLayoutPrefs {
  widths: Record<string, number>;
  visible: Record<OptionalRequestColumn, boolean>;
}

export const DEFAULT_REQUEST_COLUMN_WIDTHS: Record<string, number> = {
  method: 72,
  status: 52,
  durationMs: 68,
  waterfall: 76,
  responseBytes: 68,
  startedAt: 72,
  source: 76,
};

export const DEFAULT_OPTIONAL_COLUMNS: Record<OptionalRequestColumn, boolean> =
  {
    durationMs: true,
    waterfall: true,
    responseBytes: true,
    startedAt: true,
    source: false,
  };

const TABLE_LAYOUT_KEY = "requestTableLayout";

/** 读取持久化保存的网络请求列表列宽与可选列显隐配置。 */
export function readRequestTableLayout(): RequestTableLayoutPrefs {
  try {
    const raw = readPreference(TABLE_LAYOUT_KEY, "");
    if (!raw) {
      return {
        widths: { ...DEFAULT_REQUEST_COLUMN_WIDTHS },
        visible: { ...DEFAULT_OPTIONAL_COLUMNS },
      };
    }
    const parsed = JSON.parse(raw) as Partial<RequestTableLayoutPrefs>;
    const widths: Record<string, number> = { ...DEFAULT_REQUEST_COLUMN_WIDTHS };
    if (parsed.widths && typeof parsed.widths === "object") {
      for (const [k, v] of Object.entries(parsed.widths)) {
        if (
          typeof v === "number" &&
          Number.isFinite(v) &&
          v >= 40 &&
          v <= 260
        ) {
          widths[k] = Math.round(v);
        }
      }
    }
    const visible: Record<OptionalRequestColumn, boolean> = {
      ...DEFAULT_OPTIONAL_COLUMNS,
    };
    if (parsed.visible && typeof parsed.visible === "object") {
      for (const key of Object.keys(
        DEFAULT_OPTIONAL_COLUMNS,
      ) as OptionalRequestColumn[]) {
        if (typeof parsed.visible[key] === "boolean") {
          visible[key] = parsed.visible[key];
        }
      }
    }
    return { widths, visible };
  } catch {
    return {
      widths: { ...DEFAULT_REQUEST_COLUMN_WIDTHS },
      visible: { ...DEFAULT_OPTIONAL_COLUMNS },
    };
  }
}

/** 持久化保存网络列表列宽与显隐偏好。 */
export function writeRequestTableLayout(prefs: RequestTableLayoutPrefs) {
  writePreference(TABLE_LAYOUT_KEY, JSON.stringify(prefs));
}
