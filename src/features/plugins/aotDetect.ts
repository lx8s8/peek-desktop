import type { AotStackInfo } from "../../lib/ipc/types";

/** 从异常事件属性中提取的非敏感构建定位提示。 */
export interface BuildHints {
  buildId: string | null;
  platform: string | null;
  arch: string | null;
  appVersion: string | null;
  buildNumber: string | null;
  flavor: string | null;
  brand: string | null;
  jobId: string | null;
}

/** 前端同步检测 Dart/Flutter AOT 混淆堆栈特征（与后端保持一致）。 */
export function detectAotStack(stackTrace: string): AotStackInfo {
  const info: AotStackInfo = {
    isAot: false,
    buildId: null,
    os: null,
    arch: null,
  };
  if (!stackTrace.trim()) return info;

  for (const raw of stackTrace.split("\n")) {
    const line = raw.trim();
    if (
      line.includes("isolate_instructions:") ||
      line.includes("_kDartIsolateSnapshotInstructions") ||
      line.includes("isolate_dso_base:") ||
      /^#\d+\s+(?:abs|virt)\s+[0-9a-fA-F]+/.test(line)
    ) {
      info.isAot = true;
    }
    if (!info.buildId) {
      const m = line.match(/build_id:\s*['"]?([0-9a-fA-F-]+)['"]?/);
      if (m?.[1]) {
        info.buildId = m[1].replace(/-/g, "").toLowerCase();
        info.isAot = true;
      }
    }
    if (
      (!info.os || !info.arch) &&
      line.includes("os:") &&
      line.includes("arch:")
    ) {
      const osMatch = line.match(/\bos:\s*['"]?([a-zA-Z0-9_-]+)['"]?/);
      const archMatch = line.match(/\barch:\s*['"]?([a-zA-Z0-9_-]+)['"]?/);
      if (!info.os && osMatch?.[1]) info.os = osMatch[1].toLowerCase();
      if (!info.arch && archMatch?.[1]) info.arch = archMatch[1].toLowerCase();
    }
  }

  return info;
}

function pickString(
  obj: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return null;
}

/** 从事件 attributes（支持 attributes.build 或顶层字段）提取构建元信息。 */
export function extractBuildHints(
  attributes: unknown,
  detected: AotStackInfo,
): BuildHints {
  const root =
    attributes && typeof attributes === "object" && !Array.isArray(attributes)
      ? (attributes as Record<string, unknown>)
      : null;
  const nested =
    root?.build && typeof root.build === "object" && !Array.isArray(root.build)
      ? (root.build as Record<string, unknown>)
      : null;

  const from = (keys: string[]) =>
    pickString(nested, keys) ?? pickString(root, keys);

  return {
    buildId: detected.buildId ?? from(["buildId", "build_id"]),
    platform: detected.os ?? from(["platform", "os", "target"]),
    arch: detected.arch ?? from(["arch", "abi"]),
    appVersion: from(["appVersion", "app_version", "version"]),
    buildNumber: from(["buildNumber", "build_number", "versionCode"]),
    flavor: from(["flavor", "env", "channel", "environment"]),
    brand: from(["brand", "appBrand"]),
    jobId: from(["jobId", "buildJobId", "build_job_id"]),
  };
}
