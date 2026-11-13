import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  ChevronRight,
  Circle,
  FileCode2,
  FileStack,
  FolderOpen,
  Globe2,
  Monitor,
  Moon,
  Save,
  Search,
  Sun,
  X,
} from "lucide-react";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import { useTranslation } from "react-i18next";
import { Button } from "./components/ui/button";
import { ConnectionPanel } from "./features/connection/ConnectionPanel";
import { useWorkspace } from "./features/connection/useWorkspace";
import {
  DiagnosticsTable,
  type LogSelection,
} from "./features/diagnostics/DiagnosticsTable";
import { DiagnosticDetail } from "./features/diagnostics/DiagnosticDetail";
import { RequestTable } from "./features/console/RequestTable";
import { DetailPane } from "./features/detail/DetailPane";
import { api, desktop } from "./lib/ipc/client";
import type { EntryRow, Filter, ImportProgress } from "./lib/ipc/types";
import {
  formatBytes,
  readPreference,
  writePreference,
} from "./lib/preferences";
import "./lib/i18n";
import "./App.css";

interface ViewState {
  search: string;
  filter: Filter;
  selected: EntryRow | null;
  tab: "network" | "logs" | "exceptions";
  log: LogSelection | null;
}
const emptyView: ViewState = {
  search: "",
  filter: "all",
  selected: null,
  tab: "network",
  log: null,
};
function readLayout(): Layout | undefined {
  try {
    const layout = JSON.parse(readPreference("layout", "null"));
    if (
      layout &&
      ["sidebar", "console", "detail"].every(
        (key) =>
          typeof layout[key] === "number" &&
          Number.isFinite(layout[key]) &&
          layout[key] > 0 &&
          layout[key] < 100,
      )
    )
      return layout;
  } catch {
    /* Use default layout. */
  }
}

export default function App() {
  const { t, i18n } = useTranslation();
  const [independent, setIndependent] = useState<string | null>(null);
  const [independentLog, setIndependentLog] = useState<LogSelection | null>(
    null,
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [views, setViews] = useState<Record<string, ViewState>>({});
  const [theme, setTheme] = useState(() =>
    readPreference(
      "theme",
      window.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
    ) === "dark"
      ? "dark"
      : "light",
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const saveRef = useRef(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [count, setCount] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const [layout] = useState(readLayout);

  const view = activeId ? (views[activeId] ?? emptyView) : emptyView;
  const [search, setSearch] = useState({ sessionId: activeId, value: "" });

  const reportError = useCallback(
    (error: string) => {
      setNotice({
        text: i18n.exists(error)
          ? String(i18n.t(error))
          : String(i18n.t("unexpected", { error })),
        error: true,
      });
    },
    [i18n],
  );
  const { sessions, remote, refresh } = useWorkspace(reportError);
  const active = independent
    ? undefined
    : sessions.find((session) => session.id === activeId);
  const independentRun = remote.diagnosticRuns.find(
    (run) => run.id === independent,
  );
  const runs = remote.diagnosticRuns.filter(
    (run) => run.networkSessionKey === active?.id,
  );
  useEffect(() => {
    if (!activeId && sessions.length) setActiveId(sessions[0].id);
  }, [activeId, sessions]);
  useEffect(() => {
    if (independent && !independentRun) {
      setIndependent(null);
      setIndependentLog(null);
    }
  }, [independent, independentRun]);
  const generation = useRef<string>("");
  useEffect(() => {
    const next = `${active?.id ?? ""}:${active?.generation ?? 0}`;
    if (generation.current !== next) {
      generation.current = next;
      if (active?.deviceId)
        setViews((previous) => ({
          ...previous,
          [active.id]: {
            ...(previous[active.id] ?? emptyView),
            selected: null,
          },
        }));
    }
  }, [active?.id, active?.generation, active?.deviceId]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writePreference("theme", theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = i18n.language;
    writePreference("language", i18n.language);
  }, [i18n.language]);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setSearch({ sessionId: activeId, value: view.search }),
      180,
    );
    return () => clearTimeout(timer);
  }, [view.search, activeId]);
  const updateView = (update: Partial<ViewState>) => {
    if (activeId)
      setViews((previous) => ({
        ...previous,
        [activeId]: { ...(previous[activeId] ?? emptyView), ...update },
      }));
  };

  const open = useCallback(async () => {
    if (!desktop || busyRef.current || saveRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setProgress(null);
    setNotice(null);
    try {
      const session = await api.open(setProgress);
      if (session) {
        await refresh();
        setIndependent(null);
        setActiveId(session.id);
      }
    } catch (error) {
      if (String(error) === "cancelled")
        setNotice({ text: t("cancelled"), error: false });
      else reportError(String(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
      setProgress(null);
    }
  }, [t, reportError, refresh]);
  const save = useCallback(async () => {
    if (!activeId || saveRef.current || busyRef.current || !desktop) return;
    saveRef.current = true;
    setSaving(true);
    setNotice(null);
    try {
      if (await api.save(activeId))
        setNotice({ text: t("saved"), error: false });
    } catch (error) {
      reportError(String(error));
    } finally {
      saveRef.current = false;
      setSaving(false);
    }
  }, [activeId, t, reportError]);
  async function close(id: string) {
    try {
      await api.close(id);
      await refresh();
      setViews((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
      if (id === activeId)
        setActiveId(sessions.find((session) => session.id !== id)?.id ?? null);
    } catch (error) {
      reportError(String(error));
    }
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void open();
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [open, save]);
  return (
    <main className="workspace">
      <header className="toolbar">
        <div className="brand">
          <span className="brand-icon">
            <Activity size={19} />
          </span>
          <span>
            Peek<span className="brand-desktop"> Desktop</span>
          </span>
        </div>
        <div className="toolbar-divider" />
        <Button
          variant="primary"
          onClick={() => void open()}
          disabled={!desktop || busy || saving}
        >
          <FolderOpen />
          {t("open")}
        </Button>
        <Button
          onClick={() => void save()}
          disabled={!active || saving || busy}
        >
          <Save />
          {t("save")}
        </Button>
        <ConnectionPanel
          remote={remote}
          onChange={refresh}
          onError={reportError}
        />
        <span className={`mode-badge ${remote.listening ? "is-live" : ""}`}>
          <Circle size={6} fill="currentColor" />
          {t(remote.listening ? "listening" : "offline")}
        </span>
        <div className="toolbar-end">
          <Button
            size="icon"
            variant="ghost"
            onClick={() =>
              void i18n.changeLanguage(i18n.language === "en" ? "zh-CN" : "en")
            }
            aria-label={t("language")}
            title={t("language")}
          >
            <Globe2 />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() =>
              setTheme((value) => (value === "dark" ? "light" : "dark"))
            }
            aria-label={t("theme")}
            title={t("theme")}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>
      {notice && (
        <div
          className={`notice ${notice.error ? "warning" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          <span>{notice.text}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("dismiss")}
            onClick={() => setNotice(null)}
          >
            <X />
          </Button>
        </div>
      )}
      {!desktop && <div className="browser-notice">{t("browser")}</div>}
      <Group
        orientation="horizontal"
        className="panels"
        defaultLayout={layout}
        onLayoutChanged={(value, meta) => {
          if (meta.isUserInteraction)
            writePreference(
              "layout",
              JSON.stringify(meta.requestedLayout ?? value),
            );
        }}
      >
        <Panel id="sidebar" defaultSize="17%" minSize={180} maxSize="28%">
          <nav className="sidebar" aria-label={t("sessions")}>
            <div className="sidebar-heading">
              {t("sessions")}
              <span>{sessions.length}</span>
            </div>
            <div className="sidebar-section-title">
              <Monitor size={13} />
              {t("devices")}
            </div>
            <div className="device-placeholder">
              <span className="offline-dot" />
              {remote.sessions.filter((session) => session.online).length ||
                t("noConnectedDevice")}
            </div>
            <div className="sidebar-section-title files-title">
              <FileStack size={13} />
              {t("runsAndFiles")}
              <Button
                variant="ghost"
                size="icon"
                title={t("open")}
                aria-label={t("open")}
                disabled={!desktop || busy || saving}
                onClick={() => void open()}
              >
                <FolderOpen />
              </Button>
            </div>
            <div className="session-list">
              {sessions.length ? (
                sessions.map((session) => (
                  <div
                    key={session.id}
                    className={`session-item ${session.id === active?.id ? "active" : ""}`}
                  >
                    <button
                      className="session-select"
                      onClick={() => {
                        setIndependent(null);
                        setActiveId(session.id);
                      }}
                      aria-current={
                        session.id === active?.id ? "true" : undefined
                      }
                    >
                      {session.deviceId ? (
                        <Monitor size={16} />
                      ) : (
                        <FileCode2 size={16} />
                      )}
                      <span>
                        <strong>
                          {session.header.name || session.filename}
                        </strong>
                        <small>
                          {session.deviceId
                            ? t(
                                session.syncing
                                  ? "syncing"
                                  : session.online
                                    ? "connected"
                                    : "disconnected",
                              )
                            : session.header.platform}{" "}
                          · {session.entryCount.toLocaleString()}{" "}
                          {t("requests")}
                        </small>
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("close")} ${session.filename}`}
                      onClick={() => void close(session.id)}
                    >
                      <X />
                    </Button>
                  </div>
                ))
              ) : (
                <div className="no-files">{t("emptyFiles")}</div>
              )}
            </div>
            {remote.diagnosticRuns.some(
              (run) =>
                !run.networkSessionKey ||
                !sessions.some(
                  (session) => session.id === run.networkSessionKey,
                ),
            ) && (
              <>
                <div className="sidebar-section-title">
                  {t("independentRuns")}
                </div>
                <div className="session-list">
                  {remote.diagnosticRuns
                    .filter(
                      (run) =>
                        !run.networkSessionKey ||
                        !sessions.some(
                          (session) => session.id === run.networkSessionKey,
                        ),
                    )
                    .map((run) => (
                      <div
                        className={`session-item ${independent === run.id ? "active" : ""}`}
                        key={run.id}
                      >
                        <button
                          className="session-select"
                          onClick={() => {
                            setIndependent(run.id);
                            setIndependentLog(null);
                          }}
                        >
                          <Activity size={16} />
                          <span>
                            <strong>{run.runId}</strong>
                            <small>
                              {t(run.online ? "connected" : "disconnected")} ·{" "}
                              {run.count}
                            </small>
                          </span>
                        </button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`${t("close")} ${run.runId}`}
                          onClick={() =>
                            void api
                              .closeDiagnostic(run.id)
                              .then(refresh)
                              .catch((error) => reportError(String(error)))
                          }
                        >
                          <X />
                        </Button>
                      </div>
                    ))}
                </div>
              </>
            )}
            <div className="sidebar-bottom">
              <span className="development-label">P1 · {t("previewOnly")}</span>
              <p>{t("connectionReady")}</p>
            </div>
          </nav>
        </Panel>
        <Separator className="panel-separator" />
        <Panel id="console" defaultSize="49%" minSize={360}>
          <section className="console">
            <div className="console-heading">
              <span>
                <Activity size={14} />
                {t(
                  independent
                    ? "logs"
                    : active?.deviceId
                      ? view.tab
                      : "network",
                )}
              </span>
              {active && (
                <span className="muted filename">{active.filename}</span>
              )}
            </div>
            {independentRun ? (
              <DiagnosticsTable
                key={independentRun.id}
                runs={[independentRun]}
                exceptions={false}
                selected={independentLog}
                onSelect={setIndependentLog}
                onError={reportError}
              />
            ) : active ? (
              <>
                {active.deviceId && (
                  <div className="live-tabs segmented">
                    {(["network", "logs", "exceptions"] as const).map((tab) => (
                      <button
                        key={tab}
                        className={view.tab === tab ? "active" : ""}
                        aria-pressed={view.tab === tab}
                        onClick={() => updateView({ tab })}
                      >
                        {t(tab)}
                        {tab === "logs"
                          ? ` (${active.diagnosticCount ?? 0})`
                          : ""}
                      </button>
                    ))}
                  </div>
                )}
                {view.tab !== "network" && active.deviceId ? (
                  <DiagnosticsTable
                    key={active.id}
                    runs={runs}
                    exceptions={view.tab === "exceptions"}
                    selected={view.log}
                    onSelect={(log) => updateView({ log })}
                    onError={reportError}
                  />
                ) : (
                  <>
                    <div className="filter-toolbar">
                      <label className="search-field">
                        <Search size={14} />
                        <input
                          ref={searchInput}
                          aria-label={t("search")}
                          placeholder={t("search")}
                          value={view.search}
                          onChange={(event) =>
                            updateView({
                              search: event.target.value,
                              selected: null,
                            })
                          }
                        />
                        {view.search && (
                          <button
                            aria-label={t("dismiss")}
                            onClick={() =>
                              updateView({ search: "", selected: null })
                            }
                          >
                            <X size={13} />
                          </button>
                        )}
                      </label>
                      <div className="filter-row">
                        <div className="segmented">
                          {(
                            ["all", "errors", "pending", "pinned"] as Filter[]
                          ).map((filter) => (
                            <button
                              key={filter}
                              aria-pressed={view.filter === filter}
                              className={view.filter === filter ? "active" : ""}
                              onClick={() =>
                                updateView({ filter, selected: null })
                              }
                            >
                              {t(filter)}
                            </button>
                          ))}
                        </div>
                        <span>
                          {count.toLocaleString()} {t("matches")}
                        </span>
                      </div>
                    </div>
                    {(active.skipped > 0 || active.newerFormat) && (
                      <div className="session-warning">
                        {active.skipped > 0 &&
                          t("skipped", { count: active.skipped })}{" "}
                        {active.newerFormat && t("future")}
                      </div>
                    )}
                    <RequestTable
                      key={`${active.id}:${active.generation ?? 0}`}
                      version={active.version}
                      live={!!active.deviceId}
                      sessionId={active.id}
                      search={
                        search.sessionId === active.id
                          ? search.value
                          : view.search
                      }
                      filter={view.filter}
                      selectedId={view.selected?.id}
                      onSelect={(entry) => updateView({ selected: entry })}
                      onCount={setCount}
                      onError={reportError}
                    />
                    {active.deviceId && (
                      <div className="diagnostic-stats">
                        {t(
                          active.syncing
                            ? "syncing"
                            : active.online
                              ? "connected"
                              : "disconnected",
                        )}{" "}
                        ·{" "}
                        {t("networkLoss", {
                          dropped: active.dropped ?? 0,
                          evicted: active.evicted ?? 0,
                        })}
                      </div>
                    )}
                  </>
                )}
              </>
            ) : (
              <div className="welcome">
                <div className="welcome-symbol">
                  <Activity size={40} strokeWidth={1.5} />
                </div>
                <span className="eyebrow">PEEK DESKTOP</span>
                <h1>{t("intro")}</h1>
                <p>{t("connectionReady")}</p>
                <Button
                  variant="primary"
                  disabled={!desktop || busy || saving}
                  onClick={() => void open()}
                >
                  <FolderOpen />
                  {t("open")}
                  <ArrowRight />
                </Button>
                <span className="file-hint">{t("fileHint")}</span>
              </div>
            )}
          </section>
        </Panel>
        <Separator className="panel-separator" />
        <Panel id="detail" defaultSize="34%" minSize={300}>
          {independent || (active?.deviceId && view.tab !== "network") ? (
            <DiagnosticDetail
              selected={independent ? independentLog : view.log}
              theme={theme}
            />
          ) : (
            <DetailPane
              key={`${activeId}:${active?.generation ?? 0}`}
              version={active?.version}
              sessionId={active?.id ?? null}
              entry={view.selected}
              theme={theme}
            />
          )}
        </Panel>
      </Group>
      {busy && (
        <div className="import-progress" role="status">
          <div className="spinner" />
          <span>
            {t("processing")}
            {progress
              ? ` ${Math.min(100, Math.round((progress.bytesRead / Math.max(1, progress.totalBytes)) * 100))}%`
              : ""}
          </span>
          <Button
            onClick={() =>
              void api.cancel().catch((e) => reportError(String(e)))
            }
          >
            {t("cancel")}
          </Button>
        </div>
      )}
      <footer className="status-bar">
        <span className="status-left">
          <span className="offline-dot" />
          {t(remote.listening ? "live" : "fileOnly")}
          <ChevronRight size={11} />
          {sessions.length} {t("sessionCount")}
          {active && (
            <>
              <ChevronRight size={11} />
              {active.entryCount.toLocaleString()} {t("requests")}
            </>
          )}
        </span>
        <span>
          {t("retained")}{" "}
          {formatBytes(
            sessions.reduce((sum, session) => sum + session.rawBytes, 0),
          )}
        </span>
        <span className="shortcut-hint">{t("shortcuts")}</span>
      </footer>
    </main>
  );
}
