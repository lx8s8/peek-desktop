import { useMemo, useState } from "react";
import { Check, Copy, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { writeClipboard } from "../../lib/clipboard";

export interface SseEventItem {
  index: number;
  event: string;
  id: string | null;
  retry: string | null;
  data: string;
  formattedJson: string | null;
}

/** 判断响应正文是否为 Server-Sent Events (SSE) 事件流。 */
export function isSsePayload(
  mediaType: string | null | undefined,
  text: string,
): boolean {
  if (/text\/event-stream/i.test(mediaType ?? "")) return true;
  if (!text || text.length < 6) return false;
  const head = text.slice(0, 2048);
  const dataLines = head.match(/^data:/gm);
  return (dataLines?.length ?? 0) >= 2;
}

/** 按 WHATWG SSE 规范将原始事件流文本拆分为结构化事件列表。 */
export function parseSseEvents(text: string): SseEventItem[] {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\n+/);
  const out: SseEventItem[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let eventName = "message";
    let id: string | null = null;
    let retry: string | null = null;
    const dataParts: string[] = [];

    for (const rawLine of block.split("\n")) {
      if (!rawLine || rawLine.startsWith(":")) continue;
      const sep = rawLine.indexOf(":");
      const field = sep === -1 ? rawLine : rawLine.slice(0, sep);
      const rawVal = sep === -1 ? "" : rawLine.slice(sep + 1);
      const value = rawVal.startsWith(" ") ? rawVal.slice(1) : rawVal;
      if (field === "event") eventName = value || "message";
      else if (field === "id") id = value;
      else if (field === "retry") retry = value;
      else if (field === "data") dataParts.push(value);
    }

    if (dataParts.length === 0 && id === null && eventName === "message") {
      continue;
    }

    const data = dataParts.join("\n");
    let formattedJson: string | null = null;
    const trimmedData = data.trim();
    if (trimmedData.startsWith("{") || trimmedData.startsWith("[")) {
      try {
        formattedJson = JSON.stringify(JSON.parse(trimmedData), null, 2);
      } catch {
        /* 保留普通文本 */
      }
    }

    out.push({
      index: out.length + 1,
      event: eventName,
      id,
      retry,
      data,
      formattedJson,
    });
  }
  return out;
}

/** SSE (Server-Sent Events) 可读事件流视图：支持逐条拆块、JSON 格式化、搜索过滤与单条复制。 */
export function SseViewer({ text }: { text: string }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const events = useMemo(() => parseSseEvents(text), [text]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return events;
    return events.filter(
      (item) =>
        item.event.toLowerCase().includes(needle) ||
        (item.id?.toLowerCase().includes(needle) ?? false) ||
        item.data.toLowerCase().includes(needle),
    );
  }, [events, search]);

  return (
    <div className="sse-viewer">
      <div className="sse-toolbar">
        <label className="search-field sse-search">
          <Search size={12} aria-hidden="true" />
          <input
            type="text"
            value={search}
            placeholder={t("sseSearchPlaceholder")}
            aria-label={t("sseSearchPlaceholder")}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              aria-label={t("dismiss")}
              onClick={() => setSearch("")}
            >
              <X size={12} />
            </button>
          )}
        </label>
        <span className="muted sse-count">
          {t("sseEventCount", { count: filtered.length, total: events.length })}
        </span>
      </div>
      <div className="sse-list" data-select-scope="sse-list">
        {filtered.length === 0 ? (
          <div className="body-empty">{t("noMatches")}</div>
        ) : (
          filtered.map((item) => (
            <article
              className="sse-card"
              key={`${item.index}-${item.id ?? ""}`}
            >
              <header className="sse-card-head">
                <span className="sse-idx">#{item.index}</span>
                <span className="sse-event-pill">{item.event}</span>
                {item.id && <code className="sse-id">id: {item.id}</code>}
                {item.retry && (
                  <span className="muted">retry: {item.retry}ms</span>
                )}
                <button
                  type="button"
                  className="sse-copy-btn"
                  title={t("copy")}
                  aria-label={`${t("copy")} #${item.index}`}
                  onClick={() => {
                    void writeClipboard(item.data).then(() =>
                      setCopiedIdx(item.index),
                    );
                  }}
                >
                  {copiedIdx === item.index ? (
                    <Check size={11} />
                  ) : (
                    <Copy size={11} />
                  )}
                </button>
              </header>
              <pre className="sse-data">{item.formattedJson ?? item.data}</pre>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
