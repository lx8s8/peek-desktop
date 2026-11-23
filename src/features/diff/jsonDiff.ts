import { isLosslessNumber, parse } from "lossless-json";

export type DiffStatus = "equal" | "added" | "removed" | "changed";

export interface FieldDiffRow {
  path: string;
  status: DiffStatus;
  left: string;
  right: string;
}

function formatLeaf(value: unknown): string {
  if (value === undefined) return "";
  if (isLosslessNumber(value)) return value.value;
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value !== "object") return String(value);
  return JSON.stringify(value, (_k, v) =>
    isLosslessNumber(v) ? Number(v.value) : v,
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !isLosslessNumber(v)
  );
}

function walkJsonDiff(
  left: unknown,
  right: unknown,
  path: string,
  out: FieldDiffRow[],
  limit: number,
): void {
  if (out.length >= limit) return;

  if (left === undefined && right === undefined) return;
  if (left === undefined) {
    out.push({ path, status: "added", left: "", right: formatLeaf(right) });
    return;
  }
  if (right === undefined) {
    out.push({ path, status: "removed", left: formatLeaf(left), right: "" });
    return;
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Array.from(
      new Set([...Object.keys(left), ...Object.keys(right)]),
    );
    if (keys.length === 0) {
      out.push({ path, status: "equal", left: "{}", right: "{}" });
      return;
    }
    for (const key of keys) {
      if (out.length >= limit) break;
      const nextPath = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
        ? `${path}.${key}`
        : `${path}[${JSON.stringify(key)}]`;
      walkJsonDiff(left[key], right[key], nextPath, out, limit);
    }
    return;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    const maxLen = Math.max(left.length, right.length);
    if (maxLen === 0) {
      out.push({ path, status: "equal", left: "[]", right: "[]" });
      return;
    }
    for (let i = 0; i < maxLen; i++) {
      if (out.length >= limit) break;
      walkJsonDiff(
        i < left.length ? left[i] : undefined,
        i < right.length ? right[i] : undefined,
        `${path}[${i}]`,
        out,
        limit,
      );
    }
    return;
  }

  const ls = formatLeaf(left);
  const rs = formatLeaf(right);
  out.push({
    path,
    status: ls === rs ? "equal" : "changed",
    left: ls,
    right: rs,
  });
}

/**
 * 对比两段正文：若双方均为合法 JSON 则执行无损字段级结构化 Diff；
 * 否则退化为按行逐行对比。
 */
export function diffBodies(
  leftText: string,
  rightText: string,
  limit = 2000,
): { mode: "json" | "lines"; rows: FieldDiffRow[] } {
  const lt = leftText.trim();
  const rt = rightText.trim();
  if (
    (lt.startsWith("{") || lt.startsWith("[")) &&
    (rt.startsWith("{") || rt.startsWith("["))
  ) {
    try {
      const lObj = parse(lt);
      const rObj = parse(rt);
      const rows: FieldDiffRow[] = [];
      walkJsonDiff(lObj, rObj, "$", rows, limit);
      return { mode: "json", rows };
    } catch {
      /* 任一方不是合法 JSON 时按行对比 */
    }
  }

  const lLines = leftText ? leftText.split("\n") : [];
  const rLines = rightText ? rightText.split("\n") : [];
  const maxLen = Math.min(Math.max(lLines.length, rLines.length), limit);
  const rows: FieldDiffRow[] = [];
  for (let i = 0; i < maxLen; i++) {
    const l = lLines[i];
    const r = rLines[i];
    const status: DiffStatus =
      l === undefined
        ? "added"
        : r === undefined
          ? "removed"
          : l === r
            ? "equal"
            : "changed";
    rows.push({
      path: `L${i + 1}`,
      status,
      left: l ?? "",
      right: r ?? "",
    });
  }
  return { mode: "lines", rows };
}

/** 对比键值对数组（Headers / Query 参数），忽略 Header 大小写差异。 */
export function diffKeyValuePairs(
  leftPairs: [string, string][],
  rightPairs: [string, string][],
  caseInsensitive = false,
): FieldDiffRow[] {
  const mapPairs = (pairs: [string, string][]) => {
    const map = new Map<string, { display: string; values: string[] }>();
    for (const [k, v] of pairs) {
      const norm = caseInsensitive ? k.toLowerCase() : k;
      const existing = map.get(norm);
      if (existing) existing.values.push(v);
      else map.set(norm, { display: k, values: [v] });
    }
    return map;
  };
  const lm = mapPairs(leftPairs);
  const rm = mapPairs(rightPairs);
  const allKeys = Array.from(new Set([...lm.keys(), ...rm.keys()]));
  return allKeys.map((norm) => {
    const l = lm.get(norm);
    const r = rm.get(norm);
    const display = l?.display ?? r?.display ?? norm;
    const lv = l ? l.values.join(", ") : "";
    const rv = r ? r.values.join(", ") : "";
    const status: DiffStatus = !l
      ? "added"
      : !r
        ? "removed"
        : lv === rv
          ? "equal"
          : "changed";
    return { path: display, status, left: lv, right: rv };
  });
}
