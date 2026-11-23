/**
 * 智能值解码器：自动识别抓包 Header / Query / JSON 中常见的
 * JWT、Unix 秒/毫秒时间戳、URL 编码与 Base64 文本并提供可读预览。
 */

export type SmartDecodeKind = "jwt" | "timestamp" | "url" | "base64";

export interface SmartDecodeResult {
  kind: SmartDecodeKind;
  badge: string;
  summary: string;
  detail: string;
  isJson?: boolean;
  expired?: boolean;
}

function decodeBase64UrlToUtf8(input: string): string | null {
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function tryDecodeJwt(raw: string): SmartDecodeResult | null {
  const token = raw.trim().replace(/^Bearer\s+/i, "");
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  if (!segments.every((s) => /^[A-Za-z0-9_-]{4,}$/.test(s))) return null;

  const headerText = decodeBase64UrlToUtf8(segments[0]);
  const payloadText = decodeBase64UrlToUtf8(segments[1]);
  if (!headerText || !payloadText) return null;

  try {
    const header = JSON.parse(headerText) as Record<string, unknown>;
    const payload = JSON.parse(payloadText) as Record<string, unknown>;
    if (
      !header ||
      typeof header !== "object" ||
      !payload ||
      typeof payload !== "object"
    ) {
      return null;
    }

    let expired: boolean | undefined;
    let expNote = "";
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
      const expMs = payload.exp * 1000;
      expired = expMs < Date.now();
      const local = new Date(expMs).toLocaleString();
      expNote = expired ? `已过期 (${local})` : `有效期至 ${local}`;
    }

    const combined = JSON.stringify({ header, payload }, null, 2);
    return {
      kind: "jwt",
      badge: expired ? "JWT · 已过期" : "JWT",
      summary: expNote || `alg=${String(header.alg ?? "?")}`,
      detail: combined,
      isJson: true,
      expired,
    };
  } catch {
    return null;
  }
}

function tryDecodeTimestamp(raw: string): SmartDecodeResult | null {
  const trimmed = raw.trim();
  if (!/^\d{10}$/.test(trimmed) && !/^\d{13}$/.test(trimmed)) return null;
  const num = Number(trimmed);
  const isMs = trimmed.length === 13;
  const ms = isMs ? num : num * 1000;
  // 限制在 2000-01-01 至 2100-01-01，避免把普通业务 ID 误识别为时间戳
  if (ms < 946_684_800_000 || ms > 4_102_444_800_000) return null;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  const local = date.toLocaleString(undefined, { hour12: false });
  return {
    kind: "timestamp",
    badge: isMs ? "时间戳(ms)" : "时间戳(s)",
    summary: local,
    detail: `本地时间: ${local}\nUTC 时间: ${date.toISOString()}\n原始数值: ${trimmed}`,
  };
}

function tryDecodeUrl(raw: string): SmartDecodeResult | null {
  if (!/%[0-9A-Fa-f]{2}/.test(raw) || raw.length > 8192) return null;
  try {
    const decoded = decodeURIComponent(raw.replace(/\+/g, " "));
    if (decoded === raw) return null;
    return {
      kind: "url",
      badge: "URL 解码",
      summary: decoded.slice(0, 64),
      detail: decoded,
    };
  } catch {
    return null;
  }
}

function tryDecodeBase64(raw: string): SmartDecodeResult | null {
  const trimmed = raw.trim();
  if (
    trimmed.length < 16 ||
    trimmed.length > 16384 ||
    trimmed.length % 4 !== 0
  ) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  const decoded = decodeBase64UrlToUtf8(trimmed);
  if (!decoded || decoded.length < 4) return null;
  // 校验大部分字符为可打印文本，避免误判随机 hash/token
  let printable = 0;
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    if (
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 32 && code !== 127)
    ) {
      printable++;
    }
  }
  if (printable / decoded.length < 0.92) return null;

  const trimmedDecoded = decoded.trim();
  if (trimmedDecoded.startsWith("{") || trimmedDecoded.startsWith("[")) {
    try {
      const pretty = JSON.stringify(JSON.parse(trimmedDecoded), null, 2);
      return {
        kind: "base64",
        badge: "Base64 JSON",
        summary: `${decoded.length} 字符`,
        detail: pretty,
        isJson: true,
      };
    } catch {
      /* 按普通文本处理 */
    }
  }
  return {
    kind: "base64",
    badge: "Base64",
    summary: decoded.slice(0, 64),
    detail: decoded,
  };
}

/** 识别并返回最匹配的智能解码结果（优先级：JWT > 时间戳 > URL 编码 > Base64）。 */
export function inspectSmartValue(raw: string): SmartDecodeResult | null {
  if (!raw || raw.length < 4) return null;
  return (
    tryDecodeJwt(raw) ??
    tryDecodeTimestamp(raw) ??
    tryDecodeUrl(raw) ??
    tryDecodeBase64(raw)
  );
}
