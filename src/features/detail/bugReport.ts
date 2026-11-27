import type { BodyView, EntryRow } from "../../lib/ipc/types";
import { formatBytes } from "../../lib/preferences";

const SENSITIVE_HEADER_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token|x-secret|token)$/i;

/** 对敏感请求头/响应头的值进行脱敏打码，避免排查报告外发泄露凭据。 */
export function maskSensitiveHeaderValue(name: string, value: string): string {
  if (!SENSITIVE_HEADER_RE.test(name.trim())) {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^bearer\s+/i.test(trimmed)) {
    const rest = trimmed.replace(/^bearer\s+/i, "");
    if (rest.length <= 10) return "Bearer ***";
    return `Bearer ${rest.slice(0, 4)}…${rest.slice(-4)}`;
  }
  if (trimmed.length <= 8) return "***";
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-3)}`;
}

function clipText(text: string, maxChars = 1500): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}\n… (已截断，共 ${normalized.length} 字符)`;
}

function formatBodyBlock(body: BodyView | null | undefined): string {
  if (!body || body.kind === "empty" || !body.text.trim()) {
    return "_(无正文或未采集)_";
  }
  let text = body.text.trim();
  if (/json/i.test(body.mediaType ?? "") || /^[\[{]/.test(text)) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
      return `\`\`\`json\n${clipText(text)}\n\`\`\``;
    } catch {
      /* 非合法 JSON 保留原文 */
    }
  }
  return `\`\`\`text\n${clipText(text)}\n\`\`\``;
}

/** 生成脱敏后的网络请求 Markdown 排查报告，适合直接贴入飞书 / Jira / GitHub Issue。 */
export function buildRequestBugReport({
  entry,
  deviceLabel,
  metadata,
  requestBody,
  responseBody,
}: {
  entry: EntryRow;
  deviceLabel?: string;
  metadata?: string;
  requestBody?: BodyView | null;
  responseBody?: BodyView | null;
}): string {
  let reqHeaders: [string, string][] = [];
  let resHeaders: [string, string][] = [];
  let failureMessage = "";
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata);
      reqHeaders = Array.isArray(parsed?.request?.headers)
        ? parsed.request.headers
        : [];
      resHeaders = Array.isArray(parsed?.response?.headers)
        ? parsed.response.headers
        : [];
      if (parsed?.failure?.message) {
        failureMessage = `${parsed.failure.kind ?? "Error"}: ${parsed.failure.message}`;
      }
    } catch {
      /* 忽略无效元数据 */
    }
  }

  const statusText = entry.bizError
    ? `HTTP ${entry.status ?? "—"} (业务异常: ${entry.bizError})`
    : entry.state === "failed"
      ? `FAILED${failureMessage ? ` (${failureMessage})` : ""}`
      : `HTTP ${entry.status ?? "Pending"}`;

  const lines: string[] = [
    `### 接口异常排查报告`,
    ``,
    `- **设备 / 会话**: ${deviceLabel || entry.source}`,
    `- **时间**: ${entry.startedAt}`,
    `- **请求**: \`${entry.method.toUpperCase()} ${entry.url}\``,
    ...(entry.graphqlOperation
      ? [`- **GraphQL Operation**: \`${entry.graphqlOperation}\``]
      : []),
    `- **结果**: ${statusText}`,
    `- **耗时 / 大小**: ${entry.durationMs === null ? "—" : `${entry.durationMs.toFixed(1)} ms`} · ${formatBytes(entry.responseBytes)}`,
  ];

  if (reqHeaders.length > 0) {
    lines.push(``, `#### 请求头（已脱敏）`, `\`\`\`text`);
    for (const [k, v] of reqHeaders.slice(0, 24)) {
      lines.push(`${k}: ${maskSensitiveHeaderValue(k, v)}`);
    }
    lines.push(`\`\`\``);
  }

  if (requestBody && requestBody.text.trim()) {
    lines.push(``, `#### 请求正文`, formatBodyBlock(requestBody));
  }

  if (resHeaders.length > 0) {
    const interesting = resHeaders.filter(([k]) =>
      /^(content-type|x-request-id|x-trace-id|traceparent|date|server|cache-control)/i.test(
        k,
      ),
    );
    const chosen =
      interesting.length > 0 ? interesting : resHeaders.slice(0, 10);
    lines.push(``, `#### 关键响应头`, `\`\`\`text`);
    for (const [k, v] of chosen) {
      lines.push(`${k}: ${maskSensitiveHeaderValue(k, v)}`);
    }
    lines.push(`\`\`\``);
  }

  lines.push(``, `#### 响应正文`, formatBodyBlock(responseBody));
  return lines.join("\n");
}

/** 生成诊断日志/异常的 Markdown 排查报告。 */
export function buildDiagnosticBugReport({
  event,
  deviceLabel,
  symbolizedStack,
}: {
  event: Record<string, unknown>;
  deviceLabel?: string;
  symbolizedStack?: string | null;
}): string {
  const level = String(event.level ?? "error").toUpperCase();
  const source = String(event.source ?? "");
  const message = String(event.message ?? "");
  const occurredAt = String(event.occurredAt ?? "");
  const tag = event.tag ? String(event.tag) : null;
  const related = event.relatedNetworkEntryId
    ? String(event.relatedNetworkEntryId)
    : null;
  const exception =
    event.exception && typeof event.exception === "object"
      ? (event.exception as Record<string, unknown>)
      : null;
  const exType = exception?.type ? String(exception.type) : null;
  const rawStack = exception?.stackTrace ? String(exception.stackTrace) : "";
  const effectiveStack = symbolizedStack?.trim() || rawStack.trim();

  const lines: string[] = [
    `### 异常 / 日志排查报告`,
    ``,
    ...(deviceLabel ? [`- **设备 / 会话**: ${deviceLabel}`] : []),
    `- **级别 / 来源**: \`${level}\` · \`${source}\`${tag ? ` · tag=\`${tag}\`` : ""}`,
    `- **时间**: ${occurredAt}`,
    ...(exType ? [`- **异常类型**: \`${exType}\``] : []),
    ...(related ? [`- **关联请求 ID**: \`${related}\``] : []),
    ``,
    `#### 消息摘要`,
    `\`\`\`text`,
    clipText(message, 2000),
    `\`\`\``,
  ];

  if (effectiveStack) {
    lines.push(
      ``,
      `#### ${symbolizedStack?.trim() ? "已还原堆栈" : "原始堆栈"}`,
      `\`\`\`text`,
      clipText(effectiveStack, 3000),
      `\`\`\``,
    );
  }

  return lines.join("\n");
}
