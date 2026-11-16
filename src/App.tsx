import {
  commands,
  commandForKey,
  type CommandId,
} from "./lib/commands/dispatcher";
import { useCommand } from "./lib/commands/react";
import { useNativeMenu, useContextMenu } from "./lib/commands/native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Archive,
  ArrowRight,
  ChevronRight,
  Circle,
  FileCode2,
  FileStack,
  FolderOpen,
  Globe2,
  Monitor,
  Ellipsis,
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
import {
  TimelineTable,
  type TimelineView,
} from "./features/timeline/TimelineTable";
import { TimeRangeBar } from "./features/console/TimeRangeBar";
import {
  emptyDiagnosticView,
  type DiagnosticView,
} from "./features/diagnostics/view";
import { RequestTable } from "./features/console/RequestTable";
import { DetailPane } from "./features/detail/DetailPane";
import { api, desktop } from "./lib/ipc/client";
import type {
  EntryRow,
  Filter,
  ImportProgress,
  TimeRange,
  TimelineRow,
} from "./lib/ipc/types";
import {
  formatBytes,
  readPreference,
  writePreference,
} from "./lib/preferences";
import "./lib/i18n";
import "./App.css";

interface DiagnosticPaneState {
  view: DiagnosticView;
  selected: LogSelection | null;
  selection: LogSelection[];
}
const emptyDiagnosticPane: DiagnosticPaneState = {
  view: emptyDiagnosticView,
  selected: null,
  selection: [],
};
interface ViewState {
  search: string;
  filter: Filter;
  selected: EntryRow | null;
  tab: "network" | "logs" | "exceptions" | "timeline";
  timeline: TimelineView;
  timelineSelected: TimelineRow | null;
  timelineEntry: EntryRow | null;
  logs: DiagnosticPaneState;
  exceptions: DiagnosticPaneState;
  range: TimeRange;
}
const emptyView: ViewState = {
  search: "",
  filter: "all",
  selected: null,
  tab: "network",
  logs: emptyDiagnosticPane,
  exceptions: {
    ...emptyDiagnosticPane,
    view: { ...emptyDiagnosticView, grouped: true },
  },
  range: {},
  timeline: { search: "", following: true },
  timelineSelected: null,
  timelineEntry: null,
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

  const scopeId = independent ?? activeId;
  const view = scopeId ? (views[scopeId] ?? emptyView) : emptyView;
  const currentTab = independent && view.tab === "network" ? "logs" : view.tab;
  const diagnostic = currentTab === "exceptions" ? view.exceptions : view.logs;
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
    }
  }, [independent, independentRun]);
  const generations = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!active?.deviceId) return;
    const next = active.generation ?? 0,
      previous = generations.current[active.id];
    generations.current[active.id] = next;
    if (previous !== undefined && previous !== next)
      setViews((views) => ({
        ...views,
        [active.id]: {
          ...(views[active.id] ?? emptyView),
          selected: null,
          timelineSelected: null,
          timelineEntry: null,
        },
      }));
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
    if (scopeId)
      setViews((previous) => ({
        ...previous,
        [scopeId]: { ...(previous[scopeId] ?? emptyView), ...update },
      }));
  };

  const changeDiagnostic = (update: Partial<DiagnosticPaneState>) => {
    if (scopeId)
      setViews((previous) => {
        const value = previous[scopeId] ?? emptyView;
        const key = currentTab === "exceptions" ? "exceptions" : "logs";
        return {
          ...previous,
          [scopeId]: { ...value, [key]: { ...value[key], ...update } },
        };
      });
  };
  const changeDiagnosticView = (update: Partial<DiagnosticView>) => {
    if (scopeId)
      setViews((previous) => {
        const value = previous[scopeId] ?? emptyView;
        const key = currentTab === "exceptions" ? "exceptions" : "logs";
        return {
          ...previous,
          [scopeId]: {
            ...value,
            [key]: { ...value[key], view: { ...value[key].view, ...update } },
          },
        };
      });
  };
  const navigation = useRef(0);
  useEffect(() => {
    ++navigation.current;
  }, [scopeId, active?.generation, currentTab]);
  const openNetwork = async (sessionId: string, entryId: string) => {
    const request = ++navigation.current;
    try {
      const entry = await api.entryInfo(sessionId, entryId);
      if (request !== navigation.current) return;
      setViews((previous) => ({
        ...previous,
        [sessionId]: {
          ...(previous[sessionId] ?? emptyView),
          tab: "network",
          selected: entry,
        },
      }));
      setIndependent(null);
      setActiveId(sessionId);
    } catch (error) {
      if (request === navigation.current) reportError(String(error));
    }
  };
  const timelineLog =
    view.timelineSelected?.runId && view.timelineSelected.eventId
      ? {
          runId: view.timelineSelected.runId,
          eventId: view.timelineSelected.eventId,
        }
      : null;
  const detailLog =
    currentTab === "timeline" ? timelineLog : diagnostic.selected;
  const selectedRun = remote.diagnosticRuns.find(
    (run) => run.id === detailLog?.runId,
  );
  const boundNetwork = sessions.find(
    (session) => session.id === selectedRun?.networkSessionKey,
  );
  const selectTimeline = async (row: TimelineRow | null) => {
    const request = ++navigation.current;
    updateView({ timelineSelected: row, timelineEntry: null });
    if (row?.kind === "network" && row.sessionId && row.entryId)
      try {
        const entry = await api.entryInfo(row.sessionId, row.entryId);
        if (request === navigation.current)
          updateView({ timelineEntry: entry });
      } catch (error) {
        if (request === navigation.current) reportError(String(error));
      }
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
        setIndependent(session.sessionId ? null : session.runId);
        setActiveId(session.sessionId);
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
    if (!active || saveRef.current || busyRef.current || !desktop) return;
    saveRef.current = true;
    setSaving(true);
    setNotice(null);
    try {
      if (await api.save(active.id))
        setNotice({ text: t("saved"), error: false });
    } catch (error) {
      reportError(String(error));
    } finally {
      saveRef.current = false;
      setSaving(false);
    }
  }, [active, t, reportError]);
  const archive = async () => {
    if (!scopeId || saveRef.current || busyRef.current || !desktop) return;
    saveRef.current = true;
    setSaving(true);
    try {
      if (
        await api.archive({
          kind: independentRun ? "diagnostic" : "network",
          id: scopeId,
        })
      )
        setNotice({ text: t("saved"), error: false });
    } catch (error) {
      reportError(String(error));
    } finally {
      saveRef.current = false;
      setSaving(false);
    }
  };
  async function close(id: string) {
    try {
      await api.close(id);
      delete generations.current[id];
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
  useCommand(
    "session.archive",
    archive,
    desktop && !!scopeId && !busy && !saving,
  );
  useCommand("session.open", open, desktop && !busy && !saving);
  useCommand("session.save", save, desktop && !!active && !busy && !saving);
  useCommand(
    "session.close",
    async () => {
      if (independentRun) {
        await api.closeDiagnostic(independentRun.id);
        await refresh();
        setIndependent(null);
      } else if (active) await close(active.id);
    },
    !!(active || independentRun) &&
      !(active?.online || independentRun?.online) &&
      !busy &&
      !saving,
  );
  useCommand(
    "edit.find",
    () => {
      const input = document.querySelector<HTMLInputElement>(
        ".console [data-search]",
      );
      input?.focus();
      input?.select();
    },
    !!scopeId,
  );
  useCommand("view.network", () => updateView({ tab: "network" }), !!active);
  useCommand(
    "view.logs",
    () => updateView({ tab: "logs" }),
    !!(active?.deviceId || runs.length || independentRun),
  );
  useCommand(
    "view.exceptions",
    () => updateView({ tab: "exceptions" }),
    !!(active?.deviceId || runs.length || independentRun),
  );
  useCommand("view.timeline", () => updateView({ tab: "timeline" }), !!scopeId);
  useCommand("view.theme", () =>
    setTheme((value) => (value === "dark" ? "light" : "dark")),
  );
  useCommand("view.language", () =>
    i18n.changeLanguage(i18n.language === "en" ? "zh-CN" : "en"),
  );
  useCommand("language.zh-CN", () => i18n.changeLanguage("zh-CN"));
  useCommand("language.en", () => i18n.changeLanguage("en"));
  useCommand("help.shortcuts", () =>
    setNotice({ text: t("menuShortcutHint"), error: false }),
  );
  useCommand("help.retention", () =>
    setNotice({ text: t("menuRetentionHint"), error: false }),
  );
  useEffect(() => {
    commands.onError = reportError;
    return () => {
      commands.onError = () => {};
    };
  }, [reportError]);
  const nativeReady = useNativeMenu(
    i18n.language,
    {
      "view.network": !!scopeId && currentTab === "network",
      "view.logs": !!scopeId && currentTab === "logs",
      "view.exceptions": !!scopeId && currentTab === "exceptions",
      "view.timeline": !!scopeId && currentTab === "timeline",
      "view.theme": theme === "dark",
      "language.zh-CN": i18n.language !== "en",
      "language.en": i18n.language === "en",
      "view.follow":
        !!scopeId &&
        (currentTab === "timeline"
          ? view.timeline.following
          : currentTab === "logs" || currentTab === "exceptions"
            ? diagnostic.view.following
            : false),
    },
    reportError,
  );
  const sessionContextMenu = useContextMenu(
    ["session.save", "session.archive", "session.close"],
    reportError,
  );
  useEffect(() => {
    if (nativeReady) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      const id = commandForKey(event);
      if (id && commands.dispatch(id)) event.preventDefault();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [nativeReady]);
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
          onClick={() => commands.dispatch("session.open")}
          disabled={!desktop || busy || saving}
        >
          <FolderOpen />
          {t("open")}
        </Button>
        <Button
          onClick={() => commands.dispatch("session.save")}
          disabled={!active || saving || busy}
        >
          <Save />
          {t("save")}
        </Button>
        <Button
          onClick={() => commands.dispatch("session.archive")}
          disabled={!scopeId || saving || busy || !desktop}
        >
          <Archive />
          {t("archiveSession")}
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
            onClick={() => commands.dispatch("view.language")}
            aria-label={t("language")}
            title={t("language")}
          >
            <Globe2 />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => commands.dispatch("view.theme")}
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
              {new Set(
                remote.sessions
                  .filter((session) => session.online)
                  .map((session) => session.deviceId),
              ).size || t("noConnectedDevice")}
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
                onClick={() => commands.dispatch("session.open")}
              >
                <FolderOpen />
              </Button>
            </div>
            <div className="session-list">
              {sessions.length ? (
                sessions.map((session) => (
                  <div
                    key={session.id}
                    onContextMenu={(event) => {
                      setIndependent(null);
                      setActiveId(session.id);
                      sessionContextMenu(event);
                    }}
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
                        {session.archive && (
                          <small>
                            {t(
                              session.archive.recovered
                                ? "recoveredSession"
                                : "archivedSession",
                            )}
                            {` · ${t("archiveLoss", { dropped: session.archive.dropped, evicted: session.archive.evicted })}`}
                            {session.archive.syncing
                              ? ` · ${t("archiveSyncing")}`
                              : ""}
                          </small>
                        )}
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
                          {session.deviceId && (
                            <>
                              {" "}
                              ·{" "}
                              {t(
                                session.diagnosticsOnline
                                  ? "diagnosticsLive"
                                  : session.diagnosticCount
                                    ? "diagnosticsRetained"
                                    : "diagnosticsNotConnected",
                              )}
                            </>
                          )}
                        </small>
                      </span>
                    </button>
                    {desktop && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-haspopup="menu"
                        aria-label={`${t("menuActions")} ${session.header.name || session.filename}`}
                        onClick={(event) => {
                          setIndependent(null);
                          setActiveId(session.id);
                          sessionContextMenu(event);
                        }}
                      >
                        <Ellipsis />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("close")} ${session.filename}`}
                      disabled={session.online || busy || saving}
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
                        onContextMenu={(event) => {
                          setIndependent(run.id);
                          sessionContextMenu(event);
                        }}
                      >
                        <button
                          className="session-select"
                          onClick={() => {
                            setIndependent(run.id);
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
                          disabled={run.online || busy || saving}
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
              <span className="development-label">P2 · {t("previewOnly")}</span>
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
                {t(currentTab)}
              </span>
              {active && (
                <span className="muted filename">{active.filename}</span>
              )}
            </div>
            {independentRun || active ? (
              <>
                <TimeRangeBar
                  range={view.range}
                  onChange={(range) => updateView({ range })}
                />
                {(independentRun || active) && (
                  <div className="live-tabs segmented">
                    {(independentRun
                      ? (["logs", "exceptions", "timeline"] as const)
                      : active?.deviceId || runs.length
                        ? ([
                            "network",
                            "logs",
                            "exceptions",
                            "timeline",
                          ] as const)
                        : (["network", "timeline"] as const)
                    ).map((tab) => (
                      <button
                        key={tab}
                        className={currentTab === tab ? "active" : ""}
                        aria-pressed={currentTab === tab}
                        onClick={() =>
                          commands.dispatch(`view.${tab}` as CommandId)
                        }
                      >
                        {t(tab)}
                        {tab === "logs"
                          ? ` (${independentRun?.count ?? runs.reduce((total, run) => total + run.count, 0)})`
                          : ""}
                      </button>
                    ))}
                  </div>
                )}
                {currentTab === "timeline" ? (
                  <TimelineTable
                    key={scopeId}
                    scope={{
                      kind: independentRun ? "diagnostic" : "network",
                      id: scopeId!,
                    }}
                    range={view.range}
                    view={view.timeline}
                    selected={view.timelineSelected}
                    networkOnly={!!active?.deviceId && !runs.length}
                    version={`${active?.version ?? 0}:${(independentRun
                      ? [independentRun]
                      : runs
                    )
                      .map((run) => `${run.id}:${run.version}`)
                      .sort()
                      .join(",")}`}
                    onViewChange={(update) =>
                      updateView({ timeline: { ...view.timeline, ...update } })
                    }
                    onSelect={(row) => void selectTimeline(row)}
                    onError={reportError}
                  />
                ) : currentTab !== "network" ? (
                  <DiagnosticsTable
                    key={`${scopeId}:${currentTab}`}
                    runs={independentRun ? [independentRun] : runs}
                    exceptions={currentTab === "exceptions"}
                    selected={diagnostic.selected}
                    selection={diagnostic.selection}
                    view={diagnostic.view}
                    range={view.range}
                    onViewChange={changeDiagnosticView}
                    onSelect={(selected, selection) =>
                      changeDiagnostic({ selected, selection })
                    }
                    onError={reportError}
                  />
                ) : active ? (
                  <>
                    <div className="filter-toolbar">
                      <label className="search-field">
                        <Search size={14} />
                        <input
                          ref={searchInput}
                          data-search
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
                      range={view.range}
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
                ) : null}
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
                  onClick={() => commands.dispatch("session.open")}
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
          {currentTab === "timeline" && !view.timelineSelected ? (
            <aside className="detail-empty">
              <h2>{t("selectTimelineEvent")}</h2>
              <p>{t("selectTimelineHint")}</p>
            </aside>
          ) : currentTab !== "network" &&
            !(
              currentTab === "timeline" &&
              view.timelineSelected?.kind === "network"
            ) ? (
            <DiagnosticDetail
              selected={detailLog}
              evictionVersion={selectedRun?.evicted}
              networkSessionId={boundNetwork?.id ?? null}
              networkVersion={`${boundNetwork?.generation ?? 0}:${boundNetwork?.evicted ?? 0}`}
              onNetwork={(sessionId, entryId) =>
                void openNetwork(sessionId, entryId)
              }
              theme={theme}
            />
          ) : (
            <DetailPane
              key={`${activeId}:${active?.generation ?? 0}:${currentTab}`}
              version={active?.version}
              sessionId={active?.id ?? null}
              entry={
                currentTab === "timeline" ? view.timelineEntry : view.selected
              }
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
