import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Columns2,
  Copy,
  Puzzle,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { writeClipboard } from "../../lib/clipboard";
import { api, desktop } from "../../lib/ipc/client";
import type { PluginView, SymbolicateResponse } from "../../lib/ipc/types";
import { readPreference, writePreference } from "../../lib/preferences";
import { detectAotStack, extractBuildHints } from "./aotDetect";

type StackViewMode = "symbolized" | "original" | "split";

/**
 * 异常堆栈符号化还原面板：自动检测 AOT 混淆栈、支持点击快速还原或自动还原并切换原文/双栏对照。
 */
export function StackSymbolicator({
  stack,
  stackFormat,
  attributes,
  exceptionMessage,
  plugins,
  defaultPluginId,
  autoTriggerNonce,
  onOpenPlugins,
  onCopySuccess,
}: {
  stack: string;
  stackFormat?: string | null;
  attributes?: unknown;
  exceptionMessage?: string | null;
  plugins?: PluginView[];
  defaultPluginId?: string | null;
  autoTriggerNonce?: number;
  onOpenPlugins?: () => void;
  onCopySuccess?: (text: string) => void;
}) {
  const { t } = useTranslation();
  const detected = useMemo(() => detectAotStack(stack), [stack]);
  const hints = useMemo(
    () => extractBuildHints(attributes, detected),
    [attributes, detected],
  );
  const enabledPlugins = useMemo(
    () => (plugins ?? []).filter((item) => item.enabled),
    [plugins],
  );

  const [selectedPluginId, setSelectedPluginId] = useState<string>("");
  const effectivePluginId =
    (selectedPluginId && enabledPlugins.some((p) => p.id === selectedPluginId)
      ? selectedPluginId
      : null) ||
    (defaultPluginId &&
      enabledPlugins.find((p) => p.id === defaultPluginId)?.id) ||
    enabledPlugins[0]?.id ||
    null;
  const [autoSymbolicate, setAutoSymbolicate] = useState<boolean>(
    () => readPreference("autoSymbolicate", "true") !== "false",
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SymbolicateResponse | null>(null);
  const [error, setError] = useState<string>("");
  const [viewMode, setViewMode] = useState<StackViewMode>("symbolized");
  const requestGen = useRef(0);
  const autoAttemptedKey = useRef("");

  useEffect(() => {
    requestGen.current += 1;
    setResult(null);
    setError("");
    setViewMode("symbolized");
    autoAttemptedKey.current = "";
  }, [stack]);

  const runSymbolicate = useCallback(
    async (forceRefresh = false) => {
      if (!stack.trim()) return;
      const gen = ++requestGen.current;
      setBusy(true);
      setError("");
      try {
        const response = await api.symbolicateStack({
          pluginId: effectivePluginId,
          stackTrace: stack,
          stackFormat: stackFormat ?? "dart",
          buildId: hints.buildId,
          platform: hints.platform,
          arch: hints.arch,
          appVersion: hints.appVersion,
          buildNumber: hints.buildNumber,
          flavor: hints.flavor,
          brand: hints.brand,
          jobId: hints.jobId,
          attributes:
            attributes &&
            typeof attributes === "object" &&
            !Array.isArray(attributes)
              ? (attributes as Record<string, unknown>)
              : null,
          forceRefresh,
        });
        if (gen !== requestGen.current) return;
        if (response.ok && response.symbolizedStack) {
          setResult(response);
          setViewMode("symbolized");
        } else {
          setResult(null);
          setError(response.error ?? t("symbolicateFailed"));
        }
      } catch (err) {
        if (gen !== requestGen.current) return;
        setResult(null);
        setError(String(err));
      } finally {
        if (gen === requestGen.current) setBusy(false);
      }
    },
    [stack, effectivePluginId, stackFormat, hints, attributes, t],
  );

  // 自动还原：已启用插件且检测到 AOT 混淆栈时自动拉取（复用服务端/本地 LRU 缓存）
  useEffect(() => {
    if (!desktop || !autoSymbolicate || !detected.isAot || !stack.trim()) {
      return;
    }
    if (!effectivePluginId) return;
    const key = `${effectivePluginId}:${stack}`;
    if (autoAttemptedKey.current === key) return;
    autoAttemptedKey.current = key;
    void runSymbolicate(false);
  }, [
    autoSymbolicate,
    detected.isAot,
    stack,
    effectivePluginId,
    runSymbolicate,
  ]);

  // 响应控制台快捷按钮「还原堆栈」显式触发
  useEffect(() => {
    if (!autoTriggerNonce || !desktop || !stack.trim()) return;
    if (enabledPlugins.length === 0) {
      onOpenPlugins?.();
      return;
    }
    void runSymbolicate(false);
  }, [autoTriggerNonce]);

  async function copyText(text: string) {
    try {
      await writeClipboard(text);
      onCopySuccess?.(t("copied"));
    } catch {
      onCopySuccess?.(t("copyFailed"));
    }
  }

  const matched = result?.matchedBuild;
  const matchedSummary = matched
    ? [
        matched.appVersion,
        matched.flavor,
        matched.target,
        matched.jobId,
        matched.sourceBranch && matched.sourceSha
          ? `${matched.sourceBranch}@${matched.sourceSha.slice(0, 7)}`
          : matched.sourceSha?.slice(0, 8),
        matched.matchedBy ? `matched:${matched.matchedBy}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <section className="stack-section">
      <div className="section-label stack-header-bar">
        <span className="stack-title-group">
          <span>{t("originalStack")}</span>
          {detected.isAot && (
            <span className="stack-aot-badge" title={t("aotDetectedHint")}>
              {t("aotObfuscated")}
              {hints.buildId ? ` · ${hints.buildId.slice(0, 10)}` : ""}
              {hints.platform || hints.arch
                ? ` · ${[hints.platform, hints.arch].filter(Boolean).join("/")}`
                : ""}
            </span>
          )}
          {hints.appVersion && (
            <span className="stack-meta-pill">
              v{hints.appVersion}
              {hints.buildNumber ? `+${hints.buildNumber}` : ""}
              {hints.flavor ? ` (${hints.flavor})` : ""}
            </span>
          )}
        </span>
        <div className="stack-actions">
          {desktop && stack && enabledPlugins.length > 0 && detected.isAot && (
            <label
              className="stack-auto-toggle"
              title={t("autoSymbolicateHint")}
            >
              <input
                type="checkbox"
                checked={autoSymbolicate}
                onChange={(event) => {
                  const next = event.target.checked;
                  setAutoSymbolicate(next);
                  writePreference("autoSymbolicate", String(next));
                }}
              />
              <span>{t("autoSymbolicate")}</span>
            </label>
          )}
          {desktop && stack && enabledPlugins.length > 1 && (
            <select
              className="stack-plugin-select"
              aria-label={t("selectPlugin")}
              value={effectivePluginId ?? ""}
              onChange={(event) => setSelectedPluginId(event.target.value)}
            >
              {enabledPlugins.map((plugin) => (
                <option key={plugin.id} value={plugin.id}>
                  {plugin.name}
                </option>
              ))}
            </select>
          )}
          {desktop && stack && enabledPlugins.length > 0 && (
            <Button
              variant={detected.isAot ? "primary" : "default"}
              disabled={busy}
              onClick={() => void runSymbolicate(false)}
            >
              <Sparkles size={13} />
              {busy ? t("symbolicating") : t("symbolicateStack")}
            </Button>
          )}
          {desktop && stack && result?.ok && (
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              title={t("resymbolicate")}
              aria-label={t("resymbolicate")}
              onClick={() => void runSymbolicate(true)}
            >
              <RefreshCw size={13} />
            </Button>
          )}
          {desktop && stack && enabledPlugins.length === 0 && onOpenPlugins && (
            <Button
              variant={detected.isAot ? "primary" : "default"}
              onClick={onOpenPlugins}
            >
              <Puzzle size={13} />
              {t("configurePlugin")}
            </Button>
          )}
          {result?.symbolizedStack && (
            <Button onClick={() => void copyText(result.symbolizedStack!)}>
              <Copy size={13} />
              {t("copySymbolizedStack")}
            </Button>
          )}
          <Button disabled={!stack} onClick={() => void copyText(stack)}>
            {t("copyStack")}
          </Button>
        </div>
      </div>

      {exceptionMessage && <p className="stack-exc-msg">{exceptionMessage}</p>}

      {error && (
        <div className="inline-note warning" role="alert">
          <span>{error}</span>
          {onOpenPlugins && (
            <Button variant="ghost" onClick={onOpenPlugins}>
              <Puzzle size={13} />
              {t("managePlugins")}
            </Button>
          )}
        </div>
      )}

      {result?.ok && result.symbolizedStack ? (
        <div className="symbolized-card">
          <div className="symbolized-meta-bar">
            <span className="symbolized-status">
              <CheckCircle2 size={13} />
              <strong>{result.providerName}</strong>
              {matchedSummary && <span>· {matchedSummary}</span>}
              <span className="symbolized-timing">
                {result.cached
                  ? t("symbolicateCached")
                  : `${result.durationMs} ms`}
              </span>
            </span>
            <div className="segmented" role="group">
              <button
                type="button"
                className={viewMode === "symbolized" ? "active" : ""}
                onClick={() => setViewMode("symbolized")}
              >
                {t("viewSymbolized")}
              </button>
              <button
                type="button"
                className={viewMode === "original" ? "active" : ""}
                onClick={() => setViewMode("original")}
              >
                {t("viewOriginal")}
              </button>
              <button
                type="button"
                className={viewMode === "split" ? "active" : ""}
                onClick={() => setViewMode("split")}
                title={t("viewSplit")}
              >
                <Columns2 size={12} />
                {t("viewSplit")}
              </button>
            </div>
          </div>
          {viewMode === "split" ? (
            <div className="symbolized-split">
              <div>
                <div className="symbolized-col-label">
                  {t("viewSymbolized")}
                </div>
                <pre className="symbolized-pre">{result.symbolizedStack}</pre>
              </div>
              <div>
                <div className="symbolized-col-label">{t("viewOriginal")}</div>
                <pre className="original-pre">{stack}</pre>
              </div>
            </div>
          ) : viewMode === "symbolized" ? (
            <pre className="symbolized-pre">{result.symbolizedStack}</pre>
          ) : (
            <pre className="original-pre">{stack}</pre>
          )}
        </div>
      ) : stack ? (
        <pre>{stack}</pre>
      ) : (
        <p>{t("noStack")}</p>
      )}
    </section>
  );
}
