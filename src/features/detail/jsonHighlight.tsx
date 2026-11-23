import { Fragment, type ReactNode, type RefObject } from "react";
import type { TextMatch } from "./text-search";

/**
 * 超过此字节数（256 KiB）的整块文本自动降级为纯文本展示，
 * 确保 1 MiB 以上超大 JSON 在 300ms 内响应且不卡顿。
 */
export const MAX_HIGHLIGHT_BYTES = 256 * 1024;

type JsonTokenType = "key" | "string" | "number" | "boolean" | "null" | "punct";

/** 匹配标准 JSON 词法单元（字符串含转义、数字含大整数/科学计数、布尔、null、结构标点）。 */
const JSON_TOKEN_RE =
  /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false)\b|\bnull\b|[{}[\]:,]/g;

/** 对纯片段做 JSON 语法高亮（保留原始每个字符，textContent 100% 一致）。 */
function highlightJsonFragment(fragment: string, keyPrefix: string): ReactNode {
  if (!fragment) return null;
  JSON_TOKEN_RE.lastIndex = 0;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = JSON_TOKEN_RE.exec(fragment)) !== null) {
    const start = match.index;
    const raw = match[0];
    if (start > cursor) {
      nodes.push(fragment.slice(cursor, start));
    }

    let tokenType: JsonTokenType;
    const first = raw.charCodeAt(0);
    if (first === 34 /* " */) {
      // 正则前瞻已区分键名与普通字符串：再检查后续非空字符是否为 ':'
      let probe = start + raw.length;
      while (probe < fragment.length && /\s/.test(fragment[probe])) probe++;
      tokenType = fragment[probe] === ":" ? "key" : "string";
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

    nodes.push(
      <span key={`${keyPrefix}-${idx++}`} className={`json-tok-${tokenType}`}>
        {raw}
      </span>,
    );
    cursor = start + raw.length;
  }

  if (nodes.length === 0) return fragment;
  if (cursor < fragment.length) nodes.push(fragment.slice(cursor));
  return nodes;
}

/**
 * 渲染数据预览区文本：
 * - 支持合法 JSON 语法着色（自动受 256 KiB 性能阈值保护）；
 * - 搜索命中时保留完整 `<mark>` 元素结构与 `current-match` 定位，且外围仍保留 JSON 语法色。
 */
export function renderFormattedText(
  text: string,
  highlightJson: boolean,
  matches: TextMatch[] | null,
  currentIndex: number,
  currentMatchRef: RefObject<HTMLElement | null>,
): ReactNode {
  const canHighlight = highlightJson && text.length <= MAX_HIGHLIGHT_BYTES;

  if (!matches || matches.length === 0) {
    return canHighlight ? highlightJsonFragment(text, "j") : text;
  }

  const out: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (match.start > cursor) {
      const gap = text.slice(cursor, match.start);
      out.push(
        <Fragment key={`g-${i}`}>
          {canHighlight ? highlightJsonFragment(gap, `g${i}`) : gap}
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
    const tail = text.slice(cursor);
    out.push(
      <Fragment key="tail">
        {canHighlight ? highlightJsonFragment(tail, "tail") : tail}
      </Fragment>,
    );
  }
  return out;
}

/**
 * 渲染控制台日志流单行文本：
 * - 先识别并淡化左侧竖线 `│ ` 及 `Headers: ` / `Data: ` 标签前缀；
 * - 对 JSON 正文行进行极速单行语法着色；
 * - 同时与搜索关键字 `<mark className="stream-mark">` 高亮无冲突融合。
 */
export function renderStreamLineText(
  text: string,
  isBodyLine: boolean,
  needle: string,
): ReactNode {
  if (!needle) {
    return isBodyLine ? highlightStreamBodyLine(text) : text;
  }

  // 有搜索词时以命中片段切分，避免拆断 `<mark>`，非命中区仍保留单行着色
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let hits = 0;

  while (cursor < text.length && hits < 24) {
    const idx = lowerText.indexOf(lowerNeedle, cursor);
    if (idx < 0) break;
    if (idx > cursor) {
      const seg = text.slice(cursor, idx);
      parts.push(
        <Fragment key={`s-${cursor}`}>
          {isBodyLine ? highlightJsonFragment(seg, `sl${cursor}`) : seg}
        </Fragment>,
      );
    }
    parts.push(
      <mark key={`m-${idx}`} className="stream-mark">
        {text.slice(idx, idx + needle.length)}
      </mark>,
    );
    cursor = idx + needle.length;
    hits++;
  }

  if (parts.length === 0) {
    return isBodyLine ? highlightStreamBodyLine(text) : text;
  }
  if (cursor < text.length) {
    const tail = text.slice(cursor);
    parts.push(
      <Fragment key="st">
        {isBodyLine ? highlightJsonFragment(tail, "slt") : tail}
      </Fragment>,
    );
  }
  return parts;
}

function highlightStreamBodyLine(line: string): ReactNode {
  let prefixLen = 0;
  const parts: ReactNode[] = [];

  if (line.startsWith("│ ")) {
    parts.push(
      <span key="bar" className="stream-bar-char">
        {"│ "}
      </span>,
    );
    prefixLen = 2;
  }

  const rest = line.slice(prefixLen);
  const labelMatch = /^(Headers:|Data:)\s*/.exec(rest);
  if (labelMatch) {
    parts.push(
      <span key="lbl" className="stream-field-label">
        {labelMatch[0]}
      </span>,
    );
    const bodyRest = rest.slice(labelMatch[0].length);
    parts.push(
      <Fragment key="val">{highlightJsonFragment(bodyRest, "sv")}</Fragment>,
    );
    return parts;
  }

  // 仅当该行看起来像 JSON 结构行（含引号/花括号/方括号/数值/布尔/null）时才着色
  if (/[{}[\]":]|\b(?:true|false|null)\b|^\s*-?\d/.test(rest)) {
    parts.push(
      <Fragment key="body">{highlightJsonFragment(rest, "sb")}</Fragment>,
    );
    return parts;
  }

  parts.push(rest);
  return parts;
}
