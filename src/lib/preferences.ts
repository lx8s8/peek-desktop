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
