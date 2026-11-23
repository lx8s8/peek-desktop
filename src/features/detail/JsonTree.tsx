import { useMemo, useState } from "react";
import { isLosslessNumber, parse } from "lossless-json";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Route,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { writeClipboard } from "../../lib/clipboard";
import { inspectSmartValue, type SmartDecodeResult } from "./smartDecode";

const INITIAL_ARRAY_WINDOW = 100;

function formatJsonPath(segments: (string | number)[]): string {
  let path = "$";
  for (const seg of segments) {
    if (typeof seg === "number") {
      path += `[${seg}]`;
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) {
      path += `.${seg}`;
    } else {
      path += `[${JSON.stringify(seg)}]`;
    }
  }
  return path;
}

function serializeCopyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (isLosslessNumber(value)) return value.value;
  if (value === null || typeof value !== "object") return String(value);
  return JSON.stringify(
    value,
    (_k, v) => (isLosslessNumber(v) ? Number(v.value) : v),
    2,
  );
}

/**
 * 自研零依赖无损彩色 JSON 树（替代 1 MiB 的 vanilla-jsoneditor）：
 * - 基于 lossless-json 无损解析长整数；
 * - 支持层级折叠/全部展开、一键复制纯值与 JSONPath；
 * - 内置 JWT / Unix 时间戳 / Base64 / URL 智能解码浮层。
 */
export default function JsonTree({ text }: { text: string; theme: string }) {
  const { t } = useTranslation();
  const [defaultDepth, setDefaultDepth] = useState(2);
  const [treeEpoch, setTreeEpoch] = useState(0);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: parse(text) };
    } catch (error) {
      return { ok: false as const, error: String(error) };
    }
  }, [text]);

  async function copyText(key: string, value: string) {
    try {
      await writeClipboard(value);
      setCopiedPath(key);
    } catch {
      /* 静默失败由系统处理 */
    }
  }

  if (!parsed.ok) {
    return <div className="inline-note warning">{parsed.error}</div>;
  }

  return (
    <div className="custom-json-tree">
      <div className="json-tree-bar">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDefaultDepth(64);
            setTreeEpoch((v) => v + 1);
          }}
        >
          {t("expandAll")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDefaultDepth(2);
            setTreeEpoch((v) => v + 1);
          }}
        >
          {t("collapseDepth2")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDefaultDepth(0);
            setTreeEpoch((v) => v + 1);
          }}
        >
          {t("collapseAll")}
        </Button>
      </div>
      <div className="json-tree-scroll" key={treeEpoch}>
        <TreeNode
          value={parsed.value}
          path={[]}
          depth={0}
          defaultDepth={defaultDepth}
          copiedPath={copiedPath}
          onCopy={(key, val) => void copyText(key, val)}
        />
      </div>
    </div>
  );
}

function TreeNode({
  name,
  value,
  path,
  depth,
  defaultDepth,
  copiedPath,
  onCopy,
}: {
  name?: string | number;
  value: unknown;
  path: (string | number)[];
  depth: number;
  defaultDepth: number;
  copiedPath: string | null;
  onCopy: (key: string, value: string) => void;
}) {
  const { t } = useTranslation();
  const isArray = Array.isArray(value);
  const isLossless = isLosslessNumber(value);
  const isObj = value !== null && typeof value === "object" && !isLossless;
  const [expanded, setExpanded] = useState(depth < defaultDepth);
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_ARRAY_WINDOW);
  const [decodedOpen, setDecodedOpen] = useState(false);

  const jsonPath = useMemo(() => formatJsonPath(path), [path]);
  const copyValKey = `val:${jsonPath}`;
  const copyPathKey = `path:${jsonPath}`;

  const smart: SmartDecodeResult | null = useMemo(() => {
    if (typeof value === "string") return inspectSmartValue(value);
    if (isLossless) return inspectSmartValue(value.value);
    if (typeof value === "number") return inspectSmartValue(String(value));
    return null;
  }, [value, isLossless]);

  const keyLabel =
    name === undefined ? null : typeof name === "number" ? (
      <span className="json-tree-index">{name}:</span>
    ) : (
      <span className="json-tok-key">{JSON.stringify(name)}</span>
    );

  if (!isObj) {
    let rendered: React.ReactNode;
    if (value === null) {
      rendered = <span className="json-tok-null">null</span>;
    } else if (typeof value === "boolean") {
      rendered = <span className="json-tok-boolean">{String(value)}</span>;
    } else if (isLossless) {
      rendered = <span className="json-tok-number">{value.value}</span>;
    } else if (typeof value === "number") {
      rendered = <span className="json-tok-number">{String(value)}</span>;
    } else {
      const str = String(value);
      const display = str.length > 2048 ? `${str.slice(0, 2048)}…` : str;
      rendered = (
        <span className="json-tok-string">{JSON.stringify(display)}</span>
      );
    }

    return (
      <div className="json-tree-item">
        <div className="json-tree-row">
          <span className="json-tree-spacer" />
          {keyLabel && (
            <>
              {keyLabel}
              <span className="json-tok-punct">{": "}</span>
            </>
          )}
          <span className="json-tree-val">{rendered}</span>
          {smart && (
            <button
              type="button"
              className={`smart-badge ${smart.expired ? "is-expired" : ""}`}
              onClick={() => setDecodedOpen((v) => !v)}
              title={smart.summary}
            >
              <Sparkles size={10} />
              <span>{smart.badge}</span>
            </button>
          )}
          <span className="json-tree-actions">
            <button
              type="button"
              className="tree-act-btn"
              title={t("copyValue")}
              aria-label={`${t("copyValue")} ${jsonPath}`}
              onClick={() => onCopy(copyValKey, serializeCopyValue(value))}
            >
              {copiedPath === copyValKey ? (
                <Check size={11} />
              ) : (
                <Copy size={11} />
              )}
            </button>
            <button
              type="button"
              className="tree-act-btn"
              title={`${t("copyPath")}: ${jsonPath}`}
              aria-label={`${t("copyPath")} ${jsonPath}`}
              onClick={() => onCopy(copyPathKey, jsonPath)}
            >
              {copiedPath === copyPathKey ? (
                <Check size={11} />
              ) : (
                <Route size={11} />
              )}
            </button>
          </span>
        </div>
        {smart && decodedOpen && (
          <div className="smart-decode-card">
            <div className="smart-decode-head">
              <strong>{smart.badge}</strong>
              <span className="muted">{smart.summary}</span>
            </div>
            <pre>{smart.detail}</pre>
          </div>
        )}
      </div>
    );
  }

  const entries: [string | number, unknown][] = isArray
    ? (value as unknown[]).map((item, index) => [index, item])
    : Object.entries(value as Record<string, unknown>);
  const count = entries.length;
  const openBrace = isArray ? "[" : "{";
  const closeBrace = isArray ? "]" : "}";
  const summary = isArray ? `${count} items` : `${count} keys`;

  return (
    <div className="json-tree-item">
      <div className="json-tree-row">
        <button
          type="button"
          className="json-tree-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? t("collapseNode") : t("expandNode")}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {keyLabel && (
          <>
            {keyLabel}
            <span className="json-tok-punct">{": "}</span>
          </>
        )}
        <button
          type="button"
          className="json-tree-brace-btn"
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="json-tok-punct">{openBrace}</span>
          {!expanded && (
            <>
              <span className="json-tree-summary"> {summary} </span>
              <span className="json-tok-punct">{closeBrace}</span>
            </>
          )}
          {expanded && count === 0 && (
            <span className="json-tok-punct">{closeBrace}</span>
          )}
        </button>
        <span className="json-tree-actions">
          <button
            type="button"
            className="tree-act-btn"
            title={t("copyValue")}
            aria-label={`${t("copyValue")} ${jsonPath}`}
            onClick={() => onCopy(copyValKey, serializeCopyValue(value))}
          >
            {copiedPath === copyValKey ? (
              <Check size={11} />
            ) : (
              <Copy size={11} />
            )}
          </button>
          <button
            type="button"
            className="tree-act-btn"
            title={`${t("copyPath")}: ${jsonPath}`}
            aria-label={`${t("copyPath")} ${jsonPath}`}
            onClick={() => onCopy(copyPathKey, jsonPath)}
          >
            {copiedPath === copyPathKey ? (
              <Check size={11} />
            ) : (
              <Route size={11} />
            )}
          </button>
        </span>
      </div>
      {expanded && count > 0 && (
        <div className="json-tree-children">
          {entries.slice(0, visibleLimit).map(([k, child]) => (
            <TreeNode
              key={String(k)}
              name={k}
              value={child}
              path={[...path, k]}
              depth={depth + 1}
              defaultDepth={defaultDepth}
              copiedPath={copiedPath}
              onCopy={onCopy}
            />
          ))}
          {count > visibleLimit && (
            <button
              type="button"
              className="json-tree-more"
              onClick={() => setVisibleLimit((n) => n + INITIAL_ARRAY_WINDOW)}
            >
              … 展开剩余 {count - visibleLimit} 项
            </button>
          )}
          <div className="json-tree-close">
            <span className="json-tok-punct">{closeBrace}</span>
          </div>
        </div>
      )}
    </div>
  );
}
