import { writeClipboard } from "../../lib/clipboard";
import { lazy, Suspense, useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";

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
  const [copyState, setCopyState] = useState("");
  useEffect(() => {
    setAnalysis(null);
    setMode("raw");
    setCopyState("");
    if (!json) return;
    const worker = new Worker(new URL("./json.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<Analysis>) => {
      setAnalysis(event.data);
      if (event.data.treeSafe) setMode("tree");
    };
    worker.onerror = () =>
      setAnalysis({
        formatted: "",
        error: "JSON worker failed",
        treeSafe: false,
      });
    worker.postMessage(text);
    return () => worker.terminate();
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
    <div className="json-viewer">
      <div className="viewer-toolbar">
        <div className="segmented" role="group" aria-label={t("body")}>
          <button
            className={mode === "raw" ? "active" : ""}
            onClick={() => setMode("raw")}
          >
            {t("raw")}
          </button>
          {json && (
            <>
              <button
                disabled={!analysis || !!analysis.error || !analysis.treeSafe}
                className={mode === "tree" ? "active" : ""}
                onClick={() => setMode("tree")}
              >
                {t("tree")}
              </button>
              <button
                disabled={!analysis || !!analysis.error}
                className={mode === "formatted" ? "active" : ""}
                onClick={() => setMode("formatted")}
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
        {mode === "tree" && analysis?.treeSafe ? (
          <Suspense fallback={<div className="loading">{t("loading")}</div>}>
            <JsonTree text={text} theme={theme} />
          </Suspense>
        ) : (
          <pre className="raw-text" tabIndex={0}>
            {mode === "formatted" ? analysis?.formatted : text}
          </pre>
        )}
      </div>
      <div className="viewer-footnote">{t("rawHint")}</div>
    </div>
  );
}
