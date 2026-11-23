import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  FolderOpen,
  Globe,
  HardDrive,
  Link2,
  Pencil,
  Play,
  Plus,
  Puzzle,
  Share2,
  Star,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { writeClipboard } from "../../lib/clipboard";
import { api, desktop } from "../../lib/ipc/client";
import type {
  ExportedPluginBundle,
  ParsedPluginPreview,
  PluginKind,
  PluginListSnapshot,
  PluginTestResult,
  PluginView,
  SymbolicatorPlugin,
} from "../../lib/ipc/types";

type ManagerView = "list" | "import" | "edit" | "share";

interface EditorDraft {
  editingId: string | null;
  id: string;
  name: string;
  description: string;
  kind: PluginKind;
  enabled: boolean;
  timeoutMs: string;
  setAsDefault: boolean;
  // HTTP
  endpoint: string;
  healthEndpoint: string;
  authHeader: string;
  token: string;
  existingMaskedToken: string | null;
  headersText: string;
  // Local
  symbolsDir: string;
  flutterBin: string;
  // CLI
  command: string;
  argsText: string;
  workingDir: string;
  envText: string;
}

function emptyDraft(kind: PluginKind = "http"): EditorDraft {
  return {
    editingId: null,
    id: "",
    name: "",
    description: "",
    kind,
    enabled: true,
    timeoutMs: "20000",
    setAsDefault: true,
    endpoint: "",
    healthEndpoint: "",
    authHeader: "",
    token: "",
    existingMaskedToken: null,
    headersText: "",
    symbolsDir: "",
    flutterBin: "",
    command: "",
    argsText: "",
    workingDir: "",
    envText: "",
  };
}

function draftFromPluginView(plugin: PluginView): EditorDraft {
  return {
    editingId: plugin.id,
    id: plugin.id,
    name: plugin.name,
    description: plugin.description ?? "",
    kind: plugin.kind,
    enabled: plugin.enabled,
    timeoutMs: String(plugin.timeoutMs || 20000),
    setAsDefault: plugin.isDefault,
    endpoint: plugin.http?.endpoint ?? "",
    healthEndpoint: plugin.http?.healthEndpoint ?? "",
    authHeader: plugin.http?.authHeader ?? "",
    token: "",
    existingMaskedToken: plugin.http?.maskedToken ?? null,
    headersText: plugin.http
      ? Object.entries(plugin.http.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : "",
    symbolsDir: plugin.local?.symbolsDir ?? "",
    flutterBin: plugin.local?.flutterBin ?? "",
    command: plugin.cli?.command ?? "",
    argsText: plugin.cli ? plugin.cli.args.join("\n") : "",
    workingDir: plugin.cli?.workingDir ?? "",
    envText: plugin.cli
      ? Object.entries(plugin.cli.env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      : "",
  };
}

function parseKeyValues(text: string, sep: ":" | "="): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(sep);
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

/**
 * 堆栈还原插件管理弹窗：支持 Local / HTTP / CLI 插件的导入、安装预览、编辑、连通性测试与一键分享分发。
 */
export function PluginManagerDialog({
  snapshot,
  initialPreview,
  onSnapshotChange,
  onClose,
}: {
  snapshot: PluginListSnapshot;
  initialPreview?: ParsedPluginPreview | null;
  onSnapshotChange: (next: PluginListSnapshot) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<ManagerView>(
    initialPreview ? "import" : "list",
  );
  const [draft, setDraft] = useState<EditorDraft>(() => emptyDraft("http"));
  const [discoveryUrl, setDiscoveryUrl] = useState("");
  const [discoveryToken, setDiscoveryToken] = useState("");
  const [fetchingUrl, setFetchingUrl] = useState(false);
  const [importText, setImportText] = useState("");
  const [preview, setPreview] = useState<ParsedPluginPreview | null>(
    initialPreview ?? null,
  );
  const [previewTokenOverride, setPreviewTokenOverride] = useState("");
  const [sharePlugin, setSharePlugin] = useState<PluginView | null>(null);
  const [shareIncludeSecrets, setShareIncludeSecrets] = useState(false);
  const [shareBundle, setShareBundle] = useState<ExportedPluginBundle | null>(
    null,
  );
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, PluginTestResult>
  >({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (initialPreview) {
      setPreview(initialPreview);
      setPreviewTokenOverride("");
      setView("import");
      setError("");
    }
  }, [initialPreview]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function refreshShareBundle(
    plugin: PluginView,
    includeSecrets: boolean,
  ) {
    try {
      const bundle = await api.exportPluginConfig(plugin.id, includeSecrets);
      setShareBundle(bundle);
      setError("");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handlePickFile() {
    if (!desktop) return;
    setError("");
    try {
      const parsed = await api.pickPluginFile();
      if (parsed) {
        setPreview(parsed);
        setPreviewTokenOverride("");
        setView("import");
      }
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleFetchByUrl() {
    if (!discoveryUrl.trim()) return;
    setFetchingUrl(true);
    setError("");
    try {
      const parsed = await api.fetchPluginFromUrl(
        discoveryUrl.trim(),
        discoveryToken.trim() || null,
      );
      setPreview(parsed);
      setPreviewTokenOverride("");
    } catch (err) {
      setPreview(null);
      setError(String(err));
    } finally {
      setFetchingUrl(false);
    }
  }

  async function handleParseText() {
    const raw = importText.trim();
    if (!raw) return;
    setError("");
    try {
      // 智能识别粘贴的 http(s) 地址，自动走远端清单拉取
      const parsed = /^https?:\/\//i.test(raw)
        ? await api.fetchPluginFromUrl(raw, discoveryToken.trim() || null)
        : await api.parsePluginInput(raw);
      setPreview(parsed);
      setPreviewTokenOverride("");
    } catch (err) {
      setPreview(null);
      setError(String(err));
    }
  }

  async function handleConfirmInstall() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const pluginToInstall: SymbolicatorPlugin = structuredClone(
        preview.plugin,
      );
      if (
        pluginToInstall.kind === "http" &&
        pluginToInstall.http &&
        previewTokenOverride.trim()
      ) {
        pluginToInstall.http.token = previewTokenOverride.trim();
      }
      const next = await api.upsertPlugin(pluginToInstall, false, true);
      onSnapshotChange(next);
      setPreview(null);
      setImportText("");
      setPreviewTokenOverride("");
      setNotice(t("pluginInstalled", { name: pluginToInstall.name }));
      setView("list");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveDraft() {
    setBusy(true);
    setError("");
    try {
      const timeoutMs = Number.parseInt(draft.timeoutMs, 10) || 20000;
      const plugin: SymbolicatorPlugin = {
        schemaVersion: 1,
        id: draft.id.trim(),
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        enabled: draft.enabled,
        kind: draft.kind,
        timeoutMs,
        local:
          draft.kind === "local"
            ? {
                symbolsDir: draft.symbolsDir.trim(),
                flutterBin: draft.flutterBin.trim() || null,
              }
            : null,
        http:
          draft.kind === "http"
            ? {
                endpoint: draft.endpoint.trim(),
                healthEndpoint: draft.healthEndpoint.trim() || null,
                authHeader: draft.authHeader.trim() || null,
                token: draft.token.trim() || null,
                headers: parseKeyValues(draft.headersText, ":"),
              }
            : null,
        cli:
          draft.kind === "cli"
            ? {
                command: draft.command.trim(),
                args: draft.argsText
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
                workingDir: draft.workingDir.trim() || null,
                env: parseKeyValues(draft.envText, "="),
              }
            : null,
      };
      const next = await api.upsertPlugin(
        plugin,
        draft.editingId !== null,
        draft.setAsDefault,
      );
      onSnapshotChange(next);
      setNotice(t("pluginSaved", { name: plugin.name }));
      setView("list");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleTest(pluginId: string) {
    setTestingId(pluginId);
    setError("");
    try {
      const res = await api.testPlugin(pluginId);
      setTestResults((prev) => ({ ...prev, [pluginId]: res }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [pluginId]: {
          ok: false,
          message: String(err),
          latencyMs: 0,
          availableBuilds: null,
          details: null,
        },
      }));
    } finally {
      setTestingId(null);
    }
  }

  async function handleToggle(plugin: PluginView) {
    try {
      const next = await api.setPluginEnabled(plugin.id, !plugin.enabled);
      onSnapshotChange(next);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSetDefault(pluginId: string) {
    try {
      const next = await api.setDefaultPlugin(pluginId);
      onSnapshotChange(next);
      setNotice(t("pluginDefaultUpdated"));
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleRemove(plugin: PluginView) {
    try {
      const next = await api.removePlugin(plugin.id);
      onSnapshotChange(next);
      setNotice(t("pluginRemoved", { name: plugin.name }));
    } catch (err) {
      setError(String(err));
    }
  }

  function kindLabel(kind: PluginKind) {
    if (kind === "http") return t("pluginKindHttp");
    if (kind === "cli") return t("pluginKindCli");
    return t("pluginKindLocal");
  }

  function kindIcon(kind: PluginKind) {
    if (kind === "http") return <Globe size={14} />;
    if (kind === "cli") return <Terminal size={14} />;
    return <HardDrive size={14} />;
  }

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("pluginsTitle")}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="plugin-modal">
        <header className="plugin-modal-header">
          <div className="plugin-modal-title">
            <Puzzle size={16} />
            <strong>{t("pluginsTitle")}</strong>
            <span className="plugin-subtitle">{t("pluginsSubtitle")}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("close")}
            onClick={onClose}
          >
            <X size={15} />
          </Button>
        </header>

        <div className="plugin-nav">
          <button
            type="button"
            className={view === "list" ? "active" : ""}
            onClick={() => {
              setView("list");
              setError("");
            }}
          >
            {t("pluginsInstalled")} ({snapshot.plugins.length})
          </button>
          <button
            type="button"
            className={view === "import" ? "active" : ""}
            onClick={() => {
              setView("import");
              setError("");
            }}
          >
            <Upload size={13} />
            {t("pluginQuickImport")}
          </button>
          <button
            type="button"
            className={view === "edit" ? "active" : ""}
            onClick={() => {
              setDraft(emptyDraft("http"));
              setView("edit");
              setError("");
            }}
          >
            <Plus size={13} />
            {t("pluginAddManual")}
          </button>
        </div>

        <div className="modal-body plugin-body">
          {notice && (
            <div className="inline-note" role="status">
              <span>{notice}</span>
              <Button variant="ghost" size="icon" onClick={() => setNotice("")}>
                <X size={12} />
              </Button>
            </div>
          )}
          {error && (
            <div className="inline-note warning" role="alert">
              <span>{error}</span>
            </div>
          )}

          {view === "list" && (
            <div className="plugin-list-wrap">
              {snapshot.plugins.length === 0 ? (
                <div className="plugin-empty">
                  <Puzzle size={26} />
                  <strong>{t("pluginsEmptyTitle")}</strong>
                  <p>{t("pluginsEmptyHint")}</p>
                  <div className="plugin-empty-actions">
                    <Button variant="primary" onClick={() => setView("import")}>
                      <Upload size={13} />
                      {t("pluginQuickImport")}
                    </Button>
                    <Button
                      onClick={() => {
                        setDraft(emptyDraft("http"));
                        setView("edit");
                      }}
                    >
                      <Plus size={13} />
                      {t("pluginAddManual")}
                    </Button>
                  </div>
                </div>
              ) : (
                snapshot.plugins.map((plugin) => {
                  const test = testResults[plugin.id];
                  const targetDesc =
                    plugin.kind === "http"
                      ? plugin.http?.endpoint
                      : plugin.kind === "local"
                        ? plugin.local?.symbolsDir
                        : [plugin.cli?.command, ...(plugin.cli?.args ?? [])]
                            .filter(Boolean)
                            .join(" ");
                  return (
                    <div
                      key={plugin.id}
                      className={`plugin-item ${plugin.enabled ? "" : "is-disabled"}`}
                    >
                      <div className="plugin-item-main">
                        <div className="plugin-item-head">
                          <span
                            className={`plugin-kind-badge kind-${plugin.kind}`}
                          >
                            {kindIcon(plugin.kind)}
                            {kindLabel(plugin.kind)}
                          </span>
                          <strong>{plugin.name}</strong>
                          <code className="plugin-id-code">{plugin.id}</code>
                          {plugin.isDefault && (
                            <span className="plugin-default-badge">
                              <Star size={11} />
                              {t("pluginDefault")}
                            </span>
                          )}
                          <span className="plugin-source-badge">
                            {plugin.source === "discovered"
                              ? t("pluginSourceDiscovered")
                              : t("pluginSourceManaged")}
                          </span>
                        </div>
                        {plugin.description && (
                          <p className="plugin-item-desc">
                            {plugin.description}
                          </p>
                        )}
                        <div
                          className="plugin-item-target"
                          title={targetDesc ?? ""}
                        >
                          <code>{targetDesc}</code>
                          {plugin.hasSecret && (
                            <span className="plugin-secret-chip">
                              Token: {plugin.maskedToken}
                            </span>
                          )}
                        </div>
                        {test && (
                          <div className="plugin-test-group">
                            <div
                              className={`plugin-test-banner ${test.ok ? "is-ok" : "is-fail"}`}
                            >
                              {test.ok ? (
                                <CheckCircle2 size={13} />
                              ) : (
                                <AlertTriangle size={13} />
                              )}
                              <span>{test.message}</span>
                              {test.latencyMs > 0 && (
                                <small>({test.latencyMs} ms)</small>
                              )}
                            </div>
                            {test.ok &&
                              test.recentBuilds &&
                              test.recentBuilds.length > 0 && (
                                <div className="plugin-builds-strip">
                                  {test.recentBuilds.slice(0, 6).map((b, i) => (
                                    <span
                                      key={b.jobId ?? i}
                                      className="plugin-build-chip"
                                      title={b.jobId ?? ""}
                                    >
                                      {[b.appVersion, b.flavor, b.target]
                                        .filter(Boolean)
                                        .join(" · ") || b.jobId}
                                    </span>
                                  ))}
                                </div>
                              )}
                          </div>
                        )}
                      </div>
                      <div className="plugin-item-actions">
                        <Button
                          variant="ghost"
                          disabled={testingId === plugin.id}
                          onClick={() => void handleTest(plugin.id)}
                          title={t("pluginTest")}
                        >
                          <Play size={12} />
                          {testingId === plugin.id
                            ? t("pluginTesting")
                            : t("pluginTest")}
                        </Button>
                        {!plugin.isDefault && plugin.enabled && (
                          <Button
                            variant="ghost"
                            onClick={() => void handleSetDefault(plugin.id)}
                          >
                            <Star size={12} />
                            {t("pluginSetDefault")}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          onClick={() => void handleToggle(plugin)}
                        >
                          {plugin.enabled
                            ? t("pluginDisable")
                            : t("pluginEnable")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("pluginEdit")}
                          title={t("pluginEdit")}
                          onClick={() => {
                            setDraft(draftFromPluginView(plugin));
                            setView("edit");
                            setError("");
                          }}
                        >
                          <Pencil size={13} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("pluginShare")}
                          title={t("pluginShare")}
                          onClick={() => {
                            setSharePlugin(plugin);
                            setShareIncludeSecrets(false);
                            setView("share");
                            void refreshShareBundle(plugin, false);
                          }}
                        >
                          <Share2 size={13} />
                        </Button>
                        {plugin.source === "managed" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("pluginDelete")}
                            title={t("pluginDelete")}
                            onClick={() => void handleRemove(plugin)}
                          >
                            <Trash2 size={13} />
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              {snapshot.discoveryDir && (
                <p className="plugin-discovery-note">
                  {t("pluginDiscoveryHint")}:{" "}
                  <code>{snapshot.discoveryDir}</code>
                </p>
              )}
            </div>
          )}

          {view === "import" && (
            <div className="plugin-import-wrap">
              <div className="plugin-url-card">
                <div className="plugin-url-card-head">
                  <Globe size={14} />
                  <strong>{t("pluginFetchUrlTitle")}</strong>
                </div>
                <p className="plugin-item-desc">{t("pluginFetchUrlDesc")}</p>
                <div className="plugin-form-grid">
                  <label className="plugin-field">
                    <span>{t("pluginFetchUrlLabel")}</span>
                    <input
                      value={discoveryUrl}
                      placeholder="http://192.168.x.x:17890"
                      onChange={(event) => setDiscoveryUrl(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && discoveryUrl.trim()) {
                          void handleFetchByUrl();
                        }
                      }}
                    />
                  </label>
                  <label className="plugin-field">
                    <span>{t("pluginToken")}</span>
                    <input
                      type="password"
                      value={discoveryToken}
                      placeholder={t("pluginFetchTokenPlaceholder")}
                      onChange={(event) =>
                        setDiscoveryToken(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && discoveryUrl.trim()) {
                          void handleFetchByUrl();
                        }
                      }}
                    />
                  </label>
                </div>
                <div className="plugin-row-end">
                  <Button
                    variant="primary"
                    disabled={!discoveryUrl.trim() || fetchingUrl}
                    onClick={() => void handleFetchByUrl()}
                  >
                    <Download size={13} />
                    {fetchingUrl
                      ? t("pluginFetchingUrl")
                      : t("pluginFetchUrlAction")}
                  </Button>
                </div>
              </div>

              <div className="plugin-import-bar">
                <Button
                  disabled={!desktop}
                  onClick={() => void handlePickFile()}
                >
                  <FolderOpen size={13} />
                  {t("pluginPickFile")}
                </Button>
                <span className="plugin-import-tip">{t("pluginDropTip")}</span>
              </div>

              <label className="plugin-field">
                <span>{t("pluginPasteLabel")}</span>
                <textarea
                  rows={3}
                  placeholder={t("pluginPastePlaceholder")}
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                />
              </label>
              <div className="plugin-row-end">
                <Button
                  disabled={!importText.trim()}
                  onClick={() => void handleParseText()}
                >
                  <Link2 size={13} />
                  {t("pluginParsePreview")}
                </Button>
              </div>

              {preview && (
                <div className="plugin-preview-card">
                  <div className="plugin-preview-head">
                    <span
                      className={`plugin-kind-badge kind-${preview.plugin.kind}`}
                    >
                      {kindIcon(preview.plugin.kind)}
                      {kindLabel(preview.plugin.kind)}
                    </span>
                    <strong>{preview.plugin.name}</strong>
                    <code>{preview.plugin.id}</code>
                  </div>
                  {preview.plugin.description && (
                    <p>{preview.plugin.description}</p>
                  )}
                  {preview.serviceInfo && (
                    <div className="plugin-test-group">
                      <div className="plugin-test-banner is-ok">
                        <CheckCircle2 size={13} />
                        <span>
                          {preview.serviceInfo.message ??
                            t("pluginServiceReady", {
                              count: preview.serviceInfo.availableBuilds ?? 0,
                            })}
                        </span>
                      </div>
                      {preview.serviceInfo.recentBuilds.length > 0 && (
                        <div className="plugin-builds-strip">
                          {preview.serviceInfo.recentBuilds
                            .slice(0, 6)
                            .map((b, i) => (
                              <span
                                key={b.jobId ?? i}
                                className="plugin-build-chip"
                                title={b.jobId ?? ""}
                              >
                                {[b.appVersion, b.flavor, b.target]
                                  .filter(Boolean)
                                  .join(" · ") || b.jobId}
                              </span>
                            ))}
                        </div>
                      )}
                    </div>
                  )}
                  <dl className="plugin-preview-meta">
                    {preview.plugin.kind === "http" && preview.plugin.http && (
                      <>
                        <div>
                          <dt>{t("pluginEndpoint")}</dt>
                          <dd>
                            <code>{preview.plugin.http.endpoint}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>{t("pluginToken")}</dt>
                          <dd>
                            {preview.hasSecret
                              ? `${preview.maskedToken} (${t("pluginTokenIncluded")})`
                              : t("pluginTokenMissing")}
                          </dd>
                        </div>
                      </>
                    )}
                    {preview.plugin.kind === "local" &&
                      preview.plugin.local && (
                        <div>
                          <dt>{t("pluginSymbolsDir")}</dt>
                          <dd>
                            <code>{preview.plugin.local.symbolsDir}</code>
                          </dd>
                        </div>
                      )}
                    {preview.plugin.kind === "cli" && preview.plugin.cli && (
                      <div>
                        <dt>{t("pluginCliCommand")}</dt>
                        <dd>
                          <code>
                            {[
                              preview.plugin.cli.command,
                              ...preview.plugin.cli.args,
                            ].join(" ")}
                          </code>
                        </dd>
                      </div>
                    )}
                  </dl>
                  {preview.plugin.kind === "http" && !preview.hasSecret && (
                    <label className="plugin-field">
                      <span>{t("pluginOptionalTokenInput")}</span>
                      <input
                        type="password"
                        value={previewTokenOverride}
                        placeholder={t("pluginTokenPlaceholder")}
                        onChange={(event) =>
                          setPreviewTokenOverride(event.target.value)
                        }
                      />
                    </label>
                  )}
                  {preview.requiresTrustWarning && (
                    <div className="inline-note warning">
                      <AlertTriangle size={14} />
                      <span>{t("pluginCliTrustWarning")}</span>
                    </div>
                  )}
                  <div className="plugin-row-end">
                    <Button variant="ghost" onClick={() => setPreview(null)}>
                      {t("cancel")}
                    </Button>
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => void handleConfirmInstall()}
                    >
                      <Check size={13} />
                      {t("pluginConfirmInstall")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {view === "edit" && (
            <div className="plugin-form">
              <div className="plugin-kind-tabs" role="group">
                {(["http", "local", "cli"] as PluginKind[]).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={draft.kind === kind ? "active" : ""}
                    onClick={() => setDraft((prev) => ({ ...prev, kind }))}
                  >
                    {kindIcon(kind)}
                    {kindLabel(kind)}
                  </button>
                ))}
              </div>
              <div className="plugin-form-grid">
                <label className="plugin-field">
                  <span>{t("pluginIdLabel")}</span>
                  <input
                    value={draft.id}
                    disabled={draft.editingId !== null}
                    placeholder="team-symbolicator"
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, id: event.target.value }))
                    }
                  />
                </label>
                <label className="plugin-field">
                  <span>{t("pluginNameLabel")}</span>
                  <input
                    value={draft.name}
                    placeholder={t("pluginNamePlaceholder")}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        name: event.target.value,
                      }))
                    }
                  />
                </label>
              </div>
              <div className="plugin-form-grid">
                <label className="plugin-field">
                  <span>{t("pluginDescLabel")}</span>
                  <input
                    value={draft.description}
                    placeholder={t("pluginDescPlaceholder")}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        description: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="plugin-field">
                  <span>{t("pluginTimeoutMs")}</span>
                  <input
                    type="number"
                    min={1000}
                    max={120000}
                    value={draft.timeoutMs}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        timeoutMs: event.target.value,
                      }))
                    }
                  />
                </label>
              </div>

              {draft.kind === "http" && (
                <>
                  <label className="plugin-field">
                    <span>{t("pluginEndpoint")}</span>
                    <input
                      value={draft.endpoint}
                      placeholder="http://192.168.1.10:17890/v1/symbolize"
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          endpoint: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <div className="plugin-form-grid">
                    <label className="plugin-field">
                      <span>{t("pluginToken")}</span>
                      <input
                        type="password"
                        value={draft.token}
                        placeholder={
                          draft.existingMaskedToken
                            ? t("pluginKeepTokenHint", {
                                mask: draft.existingMaskedToken,
                              })
                            : t("pluginTokenPlaceholder")
                        }
                        onChange={(event) =>
                          setDraft((prev) => ({
                            ...prev,
                            token: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="plugin-field">
                      <span>{t("pluginHealthEndpoint")}</span>
                      <input
                        value={draft.healthEndpoint}
                        placeholder={t("pluginHealthPlaceholder")}
                        onChange={(event) =>
                          setDraft((prev) => ({
                            ...prev,
                            healthEndpoint: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>
                  <label className="plugin-field">
                    <span>{t("pluginExtraHeaders")}</span>
                    <textarea
                      rows={2}
                      value={draft.headersText}
                      placeholder="X-Team: qa"
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          headersText: event.target.value,
                        }))
                      }
                    />
                  </label>
                </>
              )}

              {draft.kind === "local" && (
                <>
                  <label className="plugin-field">
                    <span>{t("pluginSymbolsDir")}</span>
                    <div className="plugin-input-with-btn">
                      <input
                        value={draft.symbolsDir}
                        placeholder="/path/to/symbols/dart"
                        onChange={(event) =>
                          setDraft((prev) => ({
                            ...prev,
                            symbolsDir: event.target.value,
                          }))
                        }
                      />
                      <Button
                        disabled={!desktop}
                        onClick={async () => {
                          const picked = await api.pickSymbolsDirectory();
                          if (picked) {
                            setDraft((prev) => ({
                              ...prev,
                              symbolsDir: picked,
                            }));
                          }
                        }}
                      >
                        <FolderOpen size={13} />
                        {t("pluginBrowse")}
                      </Button>
                    </div>
                  </label>
                  <label className="plugin-field">
                    <span>{t("pluginFlutterBin")}</span>
                    <input
                      value={draft.flutterBin}
                      placeholder={t("pluginFlutterBinPlaceholder")}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          flutterBin: event.target.value,
                        }))
                      }
                    />
                  </label>
                </>
              )}

              {draft.kind === "cli" && (
                <>
                  <label className="plugin-field">
                    <span>{t("pluginCliCommand")}</span>
                    <input
                      value={draft.command}
                      placeholder="/usr/bin/python3"
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          command: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="plugin-field">
                    <span>{t("pluginCliArgs")}</span>
                    <textarea
                      rows={3}
                      value={draft.argsText}
                      placeholder={
                        "~/tools/cli_provider.py\n--host\nbuild-host"
                      }
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          argsText: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="plugin-field">
                    <span>{t("pluginCliWorkdir")}</span>
                    <input
                      value={draft.workingDir}
                      placeholder={t("pluginOptionalPlaceholder")}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          workingDir: event.target.value,
                        }))
                      }
                    />
                  </label>
                </>
              )}

              <label className="plugin-checkbox">
                <input
                  type="checkbox"
                  checked={draft.setAsDefault}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      setAsDefault: event.target.checked,
                    }))
                  }
                />
                <span>{t("pluginSetDefaultOnSave")}</span>
              </label>

              <div className="plugin-row-end">
                <Button variant="ghost" onClick={() => setView("list")}>
                  {t("cancel")}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void handleSaveDraft()}
                >
                  <Check size={13} />
                  {t("pluginSave")}
                </Button>
              </div>
            </div>
          )}

          {view === "share" && sharePlugin && (
            <div className="plugin-share-wrap">
              <div className="plugin-preview-head">
                <span className={`plugin-kind-badge kind-${sharePlugin.kind}`}>
                  {kindIcon(sharePlugin.kind)}
                  {kindLabel(sharePlugin.kind)}
                </span>
                <strong>{sharePlugin.name}</strong>
              </div>
              <p className="plugin-item-desc">{t("pluginShareDesc")}</p>
              {sharePlugin.hasSecret && (
                <label className="plugin-checkbox">
                  <input
                    type="checkbox"
                    checked={shareIncludeSecrets}
                    onChange={(event) => {
                      const next = event.target.checked;
                      setShareIncludeSecrets(next);
                      void refreshShareBundle(sharePlugin, next);
                    }}
                  />
                  <span>{t("pluginIncludeSecrets")}</span>
                </label>
              )}
              {shareBundle && (
                <>
                  <div className="plugin-share-actions">
                    <Button
                      variant="primary"
                      onClick={async () => {
                        await writeClipboard(shareBundle.link);
                        setNotice(t("pluginLinkCopied"));
                      }}
                    >
                      <Link2 size={13} />
                      {t("pluginCopyLink")}
                    </Button>
                    <Button
                      onClick={async () => {
                        await writeClipboard(shareBundle.json);
                        setNotice(t("pluginJsonCopied"));
                      }}
                    >
                      <Copy size={13} />
                      {t("pluginCopyJson")}
                    </Button>
                    <Button
                      disabled={!desktop}
                      onClick={async () => {
                        try {
                          if (
                            await api.savePluginFile(
                              sharePlugin.id,
                              shareIncludeSecrets,
                            )
                          ) {
                            setNotice(t("pluginFileSaved"));
                          }
                        } catch (err) {
                          setError(String(err));
                        }
                      }}
                    >
                      <Download size={13} />
                      {t("pluginSaveFile")}
                    </Button>
                  </div>
                  <pre className="plugin-share-pre">{shareBundle.json}</pre>
                </>
              )}
              <div className="plugin-row-end">
                <Button onClick={() => setView("list")}>
                  {t("pluginBack")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
