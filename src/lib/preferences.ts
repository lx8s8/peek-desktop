import type { BizErrorRule, Filter, RequestStatusFilter } from "./ipc/types";

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

export interface ListenerPrefs {
  host: "127.0.0.1" | "0.0.0.0";
  port: string;
  advertise: boolean;
  diagnostics: boolean;
  autoStart: boolean;
}

export const DEFAULT_LISTENER_PREFS: ListenerPrefs = {
  host: "0.0.0.0",
  port: "9741",
  advertise: true,
  diagnostics: true,
  autoStart: false,
};

const LISTENER_PREFS_KEY = "listenerPrefs";

/** 读取桌面端持久化保存的监听地址、端口与自动启动配置。 */
export function readListenerPrefs(): ListenerPrefs {
  try {
    const raw = readPreference(LISTENER_PREFS_KEY, "");
    if (!raw) return { ...DEFAULT_LISTENER_PREFS };
    const parsed = JSON.parse(raw) as Partial<ListenerPrefs>;
    const host = parsed.host === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0";
    const portStr =
      typeof parsed.port === "string" &&
      /^\d+$/.test(parsed.port) &&
      Number(parsed.port) >= 1 &&
      Number(parsed.port) <= 65535
        ? parsed.port
        : DEFAULT_LISTENER_PREFS.port;
    return {
      host,
      port: portStr,
      advertise:
        typeof parsed.advertise === "boolean"
          ? parsed.advertise
          : DEFAULT_LISTENER_PREFS.advertise,
      diagnostics:
        typeof parsed.diagnostics === "boolean"
          ? parsed.diagnostics
          : DEFAULT_LISTENER_PREFS.diagnostics,
      autoStart:
        typeof parsed.autoStart === "boolean"
          ? parsed.autoStart
          : DEFAULT_LISTENER_PREFS.autoStart,
    };
  } catch {
    return { ...DEFAULT_LISTENER_PREFS };
  }
}

/** 持久化保存监听配置。 */
export function writeListenerPrefs(prefs: ListenerPrefs) {
  writePreference(LISTENER_PREFS_KEY, JSON.stringify(prefs));
}

export interface GlobalNoiseConfig {
  enabled: boolean;
  globalExcludes: string[];
  deviceExcludes: Record<string, string[]>;
}

const NOISE_RULES_KEY = "globalNoiseRules";

function cleanPatterns(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 200) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out.slice(0, 60);
}

/** 读取持久化的全局与按设备降噪屏蔽规则。 */
export function readGlobalNoiseConfig(): GlobalNoiseConfig {
  try {
    const raw = readPreference(NOISE_RULES_KEY, "");
    if (!raw) {
      return { enabled: true, globalExcludes: [], deviceExcludes: {} };
    }
    const parsed = JSON.parse(raw) as Partial<GlobalNoiseConfig>;
    const deviceExcludes: Record<string, string[]> = {};
    if (parsed.deviceExcludes && typeof parsed.deviceExcludes === "object") {
      for (const [deviceId, list] of Object.entries(parsed.deviceExcludes)) {
        const cleaned = cleanPatterns(list);
        if (cleaned.length > 0) {
          deviceExcludes[deviceId] = cleaned;
        }
      }
    }
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
      globalExcludes: cleanPatterns(parsed.globalExcludes),
      deviceExcludes,
    };
  } catch {
    return { enabled: true, globalExcludes: [], deviceExcludes: {} };
  }
}

/** 持久化保存全局与按设备降噪屏蔽规则。 */
export function writeGlobalNoiseConfig(config: GlobalNoiseConfig) {
  writePreference(NOISE_RULES_KEY, JSON.stringify(config));
}

export interface NetworkFilterPreset {
  id: string;
  name: string;
  filter: Filter;
  methodFilter: string | null;
  statusFilter: RequestStatusFilter | null;
  minDurationMs: number | null;
  search: string;
  searchBody: boolean;
  hostFilter: string | null;
}

const FILTER_PRESETS_KEY = "networkFilterPresets";

/** 读取用户自定义的快捷筛选预设列表。 */
export function readFilterPresets(): NetworkFilterPreset[] {
  try {
    const raw = readPreference(FILTER_PRESETS_KEY, "");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is NetworkFilterPreset =>
          !!item &&
          typeof item === "object" &&
          typeof item.id === "string" &&
          typeof item.name === "string" &&
          item.name.trim().length > 0,
      )
      .slice(0, 20);
  } catch {
    return [];
  }
}

/** 持久化保存用户自定义的快捷筛选预设列表。 */
export function writeFilterPresets(presets: NetworkFilterPreset[]) {
  writePreference(FILTER_PRESETS_KEY, JSON.stringify(presets.slice(0, 20)));
}

export const DEFAULT_BIZ_ERROR_RULE: BizErrorRule = {
  enabled: false,
  codeField: "code,errCode,errno",
  okValues: ["0", "200", "OK"],
  successField: "success",
  messageField: "msg,message,error",
};

const BIZ_ERROR_RULE_KEY = "bizErrorRule";

/** 读取 HTTP 200 业务错误码识别规则。 */
export function readBizErrorRule(): BizErrorRule {
  try {
    const raw = readPreference(BIZ_ERROR_RULE_KEY, "");
    if (!raw) return { ...DEFAULT_BIZ_ERROR_RULE };
    const parsed = JSON.parse(raw) as Partial<BizErrorRule>;
    return {
      enabled:
        typeof parsed.enabled === "boolean"
          ? parsed.enabled
          : DEFAULT_BIZ_ERROR_RULE.enabled,
      codeField:
        typeof parsed.codeField === "string" && parsed.codeField.trim()
          ? parsed.codeField.trim()
          : DEFAULT_BIZ_ERROR_RULE.codeField,
      okValues: Array.isArray(parsed.okValues)
        ? parsed.okValues
            .filter((v): v is string => typeof v === "string" && !!v.trim())
            .map((v) => v.trim())
        : [...DEFAULT_BIZ_ERROR_RULE.okValues],
      successField:
        typeof parsed.successField === "string"
          ? parsed.successField.trim() || null
          : DEFAULT_BIZ_ERROR_RULE.successField,
      messageField:
        typeof parsed.messageField === "string"
          ? parsed.messageField.trim() || null
          : DEFAULT_BIZ_ERROR_RULE.messageField,
    };
  } catch {
    return { ...DEFAULT_BIZ_ERROR_RULE };
  }
}

/** 持久化保存 HTTP 200 业务错误码识别规则。 */
export function writeBizErrorRule(rule: BizErrorRule) {
  writePreference(BIZ_ERROR_RULE_KEY, JSON.stringify(rule));
}
