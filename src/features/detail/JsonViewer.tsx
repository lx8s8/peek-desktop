import { writeClipboard } from "../../lib/clipboard";
import { Fragment, lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  CaseSensitive,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Search,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";

import type { TextSearchResult } from "./text-search";

const JsonTree = lazy(() => import("./JsonTree"));
type Analysis = { formatted: string; error: string; treeSafe: boolean };

export function JsonViewer({
  text,
  theme,
  json = true,
}: {
  text: string;
  theme: string;
  json?: boolean;
}) {
  const { t } = useTranslation();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [mode, setMode] = useState("raw");
  const manualMode = useRef(false);
  const [copyState, setCopyState] = useState("");
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [found, setFound] = useState<{
    text: string;
    query: string;
    caseSensitive: boolean;
    result: TextSearchResult | null;
  } | null>(null);
  const [current, setCurrent] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const currentMatch = useRef<HTMLElement>(null);
  const displayedMode =
    query && mode === "tree"
      ? analysis && !analysis.error
        ? "formatted"
        : "raw"
      : mode;
  const displayedText =
    displayedMode === "formatted" ? (analysis?.formatted ?? text) : text;
  const searchDone =
    found?.text === displayedText &&
    found.query === query &&
    found.caseSensitive === caseSensitive;
  const result = searchDone ? found.result : null;
  useEffect(() => {
    setCurrent(0);
    if (!query) return;
    let active = true;
    let worker: Worker | undefined;
    const timer = setTimeout(() => {
      worker = new Worker(new URL("./text-search.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<TextSearchResult>) => {
        if (active)
          setFound({
            text: displayedText,
            query,
            caseSensitive,
            result: event.data,
          });
      };
      worker.onerror = () => {
        if (active)
          setFound({ text: displayedText, query, caseSensitive, result: null });
      };
      worker.postMessage({ text: displayedText, query, caseSensitive });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [displayedText, query, caseSensitive]);
  useEffect(() => {
    currentMatch.current?.scrollIntoView?.({
      block: "center",
      inline: "nearest",
    });
  }, [current, result]);
  function move(direction: number) {
    const count = result?.matches.length ?? 0;
    if (count) setCurrent((value) => (value + direction + count) % count);
  }
  useEffect(() => {
    let active = true;
    setQuery("");
    setFound(null);
    setAnalysis(null);
    manualMode.current = false;
    setMode("raw");
    setCopyState("");
    if (!json) return;
    const worker = new Worker(new URL("./json.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<Analysis>) => {
      if (!active) return;
      setAnalysis(event.data);
      if (!event.data.error && !manualMode.current) setMode("formatted");
    };
    worker.onerror = () => {
      if (active)
        setAnalysis({
          formatted: "",
          error: "JSON worker failed",
          treeSafe: false,
        });
    };
    worker.postMessage(text);
    return () => {
      active = false;
      worker.terminate();
    };
  }, [text, json]);
  async function copy() {
    try {
      await writeClipboard(text);
      setCopyState("copied");
    } catch {
      setCopyState("copyFailed");
    }
  }
  return (
    <div
      className="json-viewer"
      onKeyDownCapture={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          event.stopPropagation();
          searchInput.current?.focus();
          searchInput.current?.select();
        }
      }}
    >
      <div className="viewer-toolbar">
        <div className="segmented" role="group" aria-label={t("body")}>
          <button
            className={displayedMode === "raw" ? "active" : ""}
            onClick={() => {
              manualMode.current = true;
              setMode("raw");
            }}
          >
            {t("raw")}
          </button>
          {json && (
            <>
              <button
                disabled={
                  !!query || !analysis || !!analysis.error || !analysis.treeSafe
                }
                className={displayedMode === "tree" ? "active" : ""}
                onClick={() => {
                  manualMode.current = true;
                  setMode("tree");
                }}
              >
                {t("tree")}
              </button>
              <button
                disabled={!analysis || !!analysis.error}
                className={displayedMode === "formatted" ? "active" : ""}
                onClick={() => {
                  manualMode.current = true;
                  setMode("formatted");
                }}
              >
                {t("formatted")}
              </button>
            </>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void copy()}
          title={t("copy")}
          aria-label={t("copy")}
        >
          {copyState === "copied" ? <Check /> : <Copy />}
        </Button>
      </div>
      <div className="body-search" role="search" aria-label={t("bodySearch")}>
        <Search size={14} />
        <input
          ref={searchInput}
          type="search"
          value={query}
          maxLength={256}
          aria-label={t("bodySearch")}
          placeholder={t("bodySearchPlaceholder")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            }
            if (event.key === "Escape") {
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("matchCase")}
          title={t("matchCase")}
          aria-pressed={caseSensitive}
          onClick={() => setCaseSensitive((value) => !value)}
        >
          <CaseSensitive />
        </Button>
        {query && (
          <>
            <output aria-live="polite">
              {result
                ? `${result.matches.length ? current + 1 : 0}/${result.matches.length}${result.limited ? "+" : ""}`
                : t(searchDone ? "bodySearchFailed" : "bodySearching")}
            </output>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("previousMatch")}
              title={t("previousMatch")}
              disabled={!result?.matches.length}
              onClick={() => move(-1)}
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("nextMatch")}
              title={t("nextMatch")}
              disabled={!result?.matches.length}
              onClick={() => move(1)}
            >
              <ChevronDown />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("clearBodySearch")}
              title={t("clearBodySearch")}
              onClick={() => {
                setQuery("");
                searchInput.current?.focus();
              }}
            >
              <X />
            </Button>
          </>
        )}
      </div>
      {result?.limited && (
        <div className="inline-note">{t("bodySearchLimited")}</div>
      )}
      {copyState && (
        <div className="inline-note" role="status">
          {t(copyState)}
        </div>
      )}
      {analysis?.error && (
        <div className="inline-note warning">
          {t("invalidJson")} {analysis.error}
        </div>
      )}
      <div className="viewer-content">
        {displayedMode === "tree" && analysis?.treeSafe ? (
          <Suspense fallback={<div className="loading">{t("loading")}</div>}>
            <JsonTree text={text} theme={theme} />
          </Suspense>
        ) : (
          <pre className="raw-text" tabIndex={0}>
            {result?.matches.length ? (
              <>
                {result.matches.map((match, index) => (
                  <Fragment key={match.start}>
                    {displayedText.slice(
                      index ? result.matches[index - 1].end : 0,
                      match.start,
                    )}
                    <mark
                      className={index === current ? "current-match" : ""}
                      ref={index === current ? currentMatch : undefined}
                    >
                      {displayedText.slice(match.start, match.end)}
                    </mark>
                  </Fragment>
                ))}
                {displayedText.slice(
                  result.matches[result.matches.length - 1].end,
                )}
              </>
            ) : (
              displayedText
            )}
          </pre>
        )}
      </div>
      <div className="viewer-footnote">{t("rawHint")}</div>
    </div>
  );
}
