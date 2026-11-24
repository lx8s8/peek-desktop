import { Fragment, type ReactNode, type RefObject } from "react";
import type { TextMatch } from "./text-search";

/**
 * 超过此字节数（256 KiB）的整块文本自动降级为纯文本展示，
 * 确保 1 MiB 以上超大 JSON 在 300ms 内响应且不卡顿。
 */
export const MAX_HIGHLIGHT_BYTES = 256 * 1024;

export type JsonTokenType =
  "key" | "string" | "number" | "boolean" | "null" | "punct";

export interface StyledSpan {
  start: number;
  end: number;
  className: string;
}

/** 匹配标准 JSON 词法单元（字符串含转义、数字含大整数/科学计数、布尔、null、结构标点）。 */
const JSON_TOKEN_RE =
  /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false)\b|\bnull\b|[{}[\]:,]/g;

/**
 * 对完整 JSON 文本做一次性词法扫描，产出按位置严格递增的着色区间。
 * 必须在搜索切分之前基于完整文本执行，避免命中片段劈开引号导致后续整段配色错位。
 */
export function tokenizeJson(text: string, baseOffset = 0): StyledSpan[] {
  if (!text) return [];
  JSON_TOKEN_RE.lastIndex = 0;
  const spans: StyledSpan[] = [];
  let match: RegExpExecArray | null;

  while ((match = JSON_TOKEN_RE.exec(text)) !== null) {
    const start = match.index;
    const raw = match[0];
    let tokenType: JsonTokenType;
    const first = raw.charCodeAt(0);
    if (first === 34 /* " */) {
      // 检查字符串后首个非空白字符是否为 ':' 以区分对象键与普通字符串
      let probe = start + raw.length;
      while (probe < text.length && /\s/.test(text[probe])) probe++;
      tokenType = text[probe] === ":" ? "key" : "string";
    } else if (first === 116 /* t */ || first === 102 /* f */) {
      tokenType = "boolean";
    } else if (first === 110 /* n */) {
      tokenType = "null";
    } else if (
      first === 123 ||
      first === 125 ||
      first === 91 ||
      first === 93 ||
      first === 58 ||
      first === 44
    ) {
      tokenType = "punct";
    } else {
      tokenType = "number";
    }

    spans.push({
      start: baseOffset + start,
      end: baseOffset + start + raw.length,
      className: `json-tok-${tokenType}`,
    });
  }

  return spans;
}

/** 使用双指针游标渲染 `[from, to)` 内的已预计算词法区间，时间复杂度均摊 O(1)。 */
function renderRangeWithSpans(
  text: string,
  spans: StyledSpan[] | null,
  cursorRef: { idx: number },
  from: number,
  to: number,
  keyPrefix: string,
): ReactNode {
  if (from >= to) return null;
  if (!spans || spans.length === 0) {
    return text.slice(from, to);
  }

  let idx = cursorRef.idx;
  while (idx < spans.length && spans[idx].end <= from) {
    idx++;
  }

  const nodes: ReactNode[] = [];
  let pos = from;

  while (idx < spans.length && spans[idx].start < to) {
    const span = spans[idx];
    if (span.start > pos) {
      nodes.push(text.slice(pos, span.start));
    }
    const segStart = Math.max(pos, span.start);
    const segEnd = Math.min(to, span.end);
    if (segEnd > segStart) {
      nodes.push(
        <span key={`${keyPrefix}-${segStart}`} className={span.className}>
          {text.slice(segStart, segEnd)}
        </span>,
      );
      pos = segEnd;
    }
    // 只有该词法单元完全消费完毕才前进游标，跨过搜索命中点的词法单元需保留给后续分段继续着色
    if (span.end <= to) {
      idx++;
    } else {
      break;
    }
  }

  if (pos < to) {
    nodes.push(text.slice(pos, to));
  }
  cursorRef.idx = idx;
  return nodes.length === 1 ? nodes[0] : nodes;
}

/**
 * 渲染数据预览区文本：
 * - 先对完整合法 JSON 做词法扫描（自动受 256 KiB 性能阈值保护，支持外部传入缓存 tokens）；
 * - 搜索命中时以 `<mark>` 为原子片段与完整词法区间双指针归并，彻底避免命中引号内部导致下方全变色。
 */
export function renderFormattedText(
  text: string,
  highlightJson: boolean,
  matches: TextMatch[] | null,
  currentIndex: number,
  currentMatchRef: RefObject<HTMLElement | null>,
  precomputedSpans?: StyledSpan[] | null,
): ReactNode {
  const canHighlight = highlightJson && text.length <= MAX_HIGHLIGHT_BYTES;
  const spans = canHighlight ? (precomputedSpans ?? tokenizeJson(text)) : null;

  if (!matches || matches.length === 0) {
    if (!spans || spans.length === 0) return text;
    return renderRangeWithSpans(text, spans, { idx: 0 }, 0, text.length, "j");
  }

  const out: ReactNode[] = [];
  const spanCursor = { idx: 0 };
  let cursor = 0;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (match.start > cursor) {
      out.push(
        <Fragment key={`g-${i}`}>
          {renderRangeWithSpans(
            text,
            spans,
            spanCursor,
            cursor,
            match.start,
            `g${i}`,
          )}
        </Fragment>,
      );
    }
    out.push(
      <mark
        key={`m-${match.start}`}
        className={i === currentIndex ? "current-match" : ""}
        ref={i === currentIndex ? currentMatchRef : undefined}
      >
        {text.slice(match.start, match.end)}
      </mark>,
    );
    cursor = match.end;
  }

  if (cursor < text.length) {
    out.push(
      <Fragment key="tail">
        {renderRangeWithSpans(
          text,
          spans,
          spanCursor,
          cursor,
          text.length,
          "tail",
        )}
      </Fragment>,
    );
  }
  return out;
}

/** 为控制台日志流正文行构建完整单行词法着色区间。 */
function tokenizeStreamBodyLine(line: string): StyledSpan[] {
  const spans: StyledSpan[] = [];
  let prefixLen = 0;

  if (line.startsWith("│ ")) {
    spans.push({ start: 0, end: 2, className: "stream-bar-char" });
    prefixLen = 2;
  }

  const rest = line.slice(prefixLen);
  const labelMatch = /^(Headers:|Data:)\s*/.exec(rest);
  if (labelMatch) {
    const labelEnd = prefixLen + labelMatch[0].length;
    spans.push({
      start: prefixLen,
      end: labelEnd,
      className: "stream-field-label",
    });
    const bodyRest = rest.slice(labelMatch[0].length);
    spans.push(...tokenizeJson(bodyRest, labelEnd));
    return spans;
  }

  // 仅当该行看起来像 JSON 结构行（含引号/花括号/方括号/数值/布尔/null）时才着色
  if (/[{}[\]":]|\b(?:true|false|null)\b|^\s*-?\d/.test(rest)) {
    spans.push(...tokenizeJson(rest, prefixLen));
  }
  return spans;
}

/**
 * 渲染控制台日志流单行文本：
 * - 先对整行构建竖线 `│ `、`Headers:`/`Data:` 标签及 JSON 词法区间；
 * - 再与搜索关键字 `<mark className="stream-mark">` 双指针无损归并，避免命中后半行配色错乱。
 */
export function renderStreamLineText(
  text: string,
  isBodyLine: boolean,
  needle: string,
): ReactNode {
  const spans = isBodyLine ? tokenizeStreamBodyLine(text) : null;

  if (!needle) {
    if (!spans || spans.length === 0) return text;
    return renderRangeWithSpans(text, spans, { idx: 0 }, 0, text.length, "s");
  }

  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const matches: TextMatch[] = [];
  let searchCursor = 0;

  while (searchCursor < text.length && matches.length < 24) {
    const idx = lowerText.indexOf(lowerNeedle, searchCursor);
    if (idx < 0) break;
    matches.push({ start: idx, end: idx + needle.length });
    searchCursor = idx + needle.length;
  }

  if (matches.length === 0) {
    if (!spans || spans.length === 0) return text;
    return renderRangeWithSpans(text, spans, { idx: 0 }, 0, text.length, "s");
  }

  const parts: ReactNode[] = [];
  const spanCursor = { idx: 0 };
  let cursor = 0;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (match.start > cursor) {
      parts.push(
        <Fragment key={`s-${cursor}`}>
          {renderRangeWithSpans(
            text,
            spans,
            spanCursor,
            cursor,
            match.start,
            `sl${i}`,
          )}
        </Fragment>,
      );
    }
    parts.push(
      <mark key={`m-${match.start}`} className="stream-mark">
        {text.slice(match.start, match.end)}
      </mark>,
    );
    cursor = match.end;
  }

  if (cursor < text.length) {
    parts.push(
      <Fragment key="st">
        {renderRangeWithSpans(
          text,
          spans,
          spanCursor,
          cursor,
          text.length,
          "slt",
        )}
      </Fragment>,
    );
  }
  return parts;
}
