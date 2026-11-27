import type { BodyView } from "../../lib/ipc/types";

export interface BodyNotice {
  key: string;
  warning: boolean;
  params?: Record<string, string>;
}

/**
 * 将后端返回的 `BodyView` 还原为可直接重放的请求正文文本：
 * - `form` 类型从内部 JSON 结构还原为标准 `application/x-www-form-urlencoded` 编码，避免误发内部包装 JSON；
 * - 截断、远端未拉取或二进制请求体给出明确提示，防止静默发出空正文。
 */
export function extractReplayBody(view: BodyView | null): {
  text: string;
  notice: BodyNotice | null;
} {
  if (!view || view.kind === "empty") {
    return { text: "", notice: null };
  }
  if (view.kind === "text") {
    return {
      text: view.text,
      notice:
        view.truncated || view.previewTruncated
          ? { key: "replayBodyTruncatedHint", warning: true }
          : null,
    };
  }
  if (view.kind === "form") {
    try {
      const parsed = JSON.parse(view.text) as {
        fields?: unknown;
        files?: unknown;
      };
      const params = new URLSearchParams();
      if (Array.isArray(parsed.fields)) {
        for (const pair of parsed.fields) {
          if (
            Array.isArray(pair) &&
            typeof pair[0] === "string" &&
            typeof pair[1] === "string"
          ) {
            params.append(pair[0], pair[1]);
          }
        }
      }
      const fileNames = Array.isArray(parsed.files)
        ? parsed.files
            .map((item) =>
              item &&
              typeof item === "object" &&
              typeof (item as { name?: unknown }).name === "string"
                ? (item as { name: string }).name
                : null,
            )
            .filter((name): name is string => !!name)
        : [];
      return {
        text: params.toString(),
        notice:
          fileNames.length > 0
            ? {
                key: "replayMultipartFilesHint",
                warning: true,
                params: { files: fileNames.join(", ") },
              }
            : { key: "replayFormEncodedHint", warning: false },
      };
    } catch {
      return { text: view.text, notice: null };
    }
  }
  return {
    text: "",
    notice: {
      key: "replayBodyUnavailableHint",
      warning: true,
      params: { reason: view.reason ?? view.kind },
    },
  };
}

/** 从请求元信息 JSON 中解析原始请求头列表。 */
export function parseRequestHeaders(metadata: string): [string, string][] {
  if (!metadata) return [];
  try {
    const parsed = JSON.parse(metadata);
    return Array.isArray(parsed?.request?.headers)
      ? parsed.request.headers
      : [];
  } catch {
    return [];
  }
}
