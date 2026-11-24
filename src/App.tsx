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
  ChevronRight,
  Circle,
  FileCode2,
  FileSearch,
  FileStack,
  FolderOpen,
  Globe2,
  HardDrive,
  Monitor,
  Ellipsis,
  Eraser,
  Moon,
  Pencil,
  Puzzle,
  Radio,
  RotateCcw,
  Save,
  Search,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import { useTranslation } from "react-i18next";
import { Button } from "./components/ui/button";
import { FileTools } from "./features/files/FileTools";
import { useFileOpen } from "./features/files/useFileOpen";
import { useFileDrop } from "./features/files/useFileDrop";
import { AboutPanel } from "./features/about/AboutPanel";
import { ConnectionPanel } from "./features/connection/ConnectionPanel";
import { DeviceAliasDialog } from "./features/connection/DeviceAliasDialog";
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
import {
  ConsoleStream,
  emptyStreamView,
  type StreamSelection,
  type StreamViewState,
} from "./features/stream/ConsoleStream";
import { TimeRangeBar } from "./features/console/TimeRangeBar";
import {
  emptyDiagnosticView,
  type DiagnosticView,
} from "./features/diagnostics/view";
import {
  RequestTable,
  type RequestCopyKind,
  type RequestTableMeta,
} from "./features/console/RequestTable";
import { RequestDiffDialog } from "./features/diff/RequestDiffDialog";
import { PluginManagerDialog } from "./features/plugins/PluginManagerDialog";
import { DetailPane } from "./features/detail/DetailPane";
import {
  extractReplayBody,
  parseRequestHeaders,
  ReplayDialog,
} from "./features/detail/ReplayDialog";
import { writeClipboard } from "./lib/clipboard";
import {
  installSelectScopeTracker,
  isTextInputElement,
  performScopedSelectAll,
} from "./lib/selection";
import { api, desktop } from "./lib/ipc/client";
import type {
  EntryRow,
  Filter,
  ImportProgress,
  ParsedPluginPreview,
  PluginListSnapshot,
  ReplayResponse,
  RequestSortField,
  RequestStatusFilter,
  SortDirection,
  TimeRange,
  TimelineRow,
} from "./lib/ipc/types";
import {
  formatBytes,
  readDeviceAliases,
  readPreference,
  resolveDeviceDisplay,
  writeDeviceAlias,
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
const FILTER_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
] as const;

interface ViewState {
  search: string;
  searchBody: boolean;
  filter: Filter;
  methodFilter: string | null;
  statusFilter: RequestStatusFilter | null;
  hostFilter: string | null;
  excludePatterns: string[];
  hosts: string[];
  sortBy: RequestSortField | null;
  sortDir: SortDirection;
  clearMarkSeq: number | null;
  clearActive: boolean;
  clearInitialHidden: number;
  compareAnchor: EntryRow | null;
  selected: EntryRow | null;
  tab: "network" | "logs" | "exceptions" | "timeline" | "stream";
  timeline: TimelineView;
  timelineSelected: TimelineRow | null;
  timelineEntry: EntryRow | null;
  stream: StreamViewState;
  streamSelected: StreamSelection | null;
  streamEntry: EntryRow | null;
  logs: DiagnosticPaneState;
  exceptions: DiagnosticPaneState;
  range: TimeRange;
}
const emptyView: ViewState = {
  search: "",
  searchBody: false,
  filter: "all",
  methodFilter: null,
  statusFilter: null,
  hostFilter: null,
  excludePatterns: [],
  hosts: [],
  sortBy: null,
  sortDir: "desc",
  clearMarkSeq: null,
  clearActive: false,
  clearInitialHidden: 0,
  compareAnchor: null,
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
  stream: emptyStreamView,
  streamSelected: null,
  streamEntry: null,
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
  const [notice, setNotice] = useState<{
    text: string;
    error: boolean;
    action?: { label: string; onClick: () => void };
  } | null>(null);
  const [count, setCount] = useState(0);
  const [networkMeta, setNetworkMeta] = useState<
    (RequestTableMeta & { sessionId: string }) | null
  >(null);
  const [pinTick, setPinTick] = useState(0);
  const [diffPair, setDiffPair] = useState<{
    sessionId: string;
    left: EntryRow;
    right: EntryRow;
  } | null>(null);
  const [replayTarget, setReplayTarget] = useState<{
    sessionId: string;
    entry: EntryRow;
    metadata?: string;
    initialBatchMode?: boolean;
    initialResponse?: ReplayResponse | null;
  } | null>(null);
  const [deviceAliases, setDeviceAliases] = useState<Record<string, string>>(
    () => readDeviceAliases(),
  );
  const [aliasTarget, setAliasTarget] = useState<{
    deviceId: string;
    reportedName: string;
  } | null>(null);
  const [streamLocate, setStreamLocate] = useState<{
    entryId: string;
    nonce: number;
  } | null>(null);
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
  const [pluginSnapshot, setPluginSnapshot] = useState<PluginListSnapshot>({
    defaultPluginId: null,
    discoveryDir: null,
    plugins: [],
  });
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [pendingPluginPreview, setPendingPluginPreview] =
    useState<ParsedPluginPreview | null>(null);
  const [symbolicateNonce, setSymbolicateNonce] = useState(0);
  useEffect(() => {
    if (!desktop) return;
    let activeFlag = true;
    void api
      .listPlugins()
      .then((snap) => {
        if (activeFlag) setPluginSnapshot(snap);
      })
      .catch(() => {});
    return () => {
      activeFlag = false;
    };
  }, []);
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
          clearMarkSeq: null,
          clearActive: false,
          clearInitialHidden: 0,
          timelineSelected: null,
          timelineEntry: null,
          streamSelected: null,
          streamEntry: null,
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
      setViews((previous) => {
        const cur = previous[sessionId] ?? emptyView;
        const hiddenByClear =
          cur.clearActive &&
          cur.clearMarkSeq !== null &&
          entry.seq != null &&
          entry.seq <= cur.clearMarkSeq;
        return {
          ...previous,
          [sessionId]: {
            ...cur,
            tab: "network",
            selected: entry,
            ...(hiddenByClear ? { clearActive: false } : {}),
          },
        };
      });
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
  const streamLog =
    view.streamSelected?.runId && view.streamSelected.eventId
      ? {
          runId: view.streamSelected.runId,
          eventId: view.streamSelected.eventId,
        }
      : null;
  const detailLog =
    currentTab === "timeline"
      ? timelineLog
      : currentTab === "stream"
        ? streamLog
        : diagnostic.selected;
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
  const selectStream = async (selection: StreamSelection | null) => {
    const request = ++navigation.current;
    updateView({ streamSelected: selection, streamEntry: null });
    if (selection?.sessionId && selection.entryId)
      try {
        const entry = await api.entryInfo(
          selection.sessionId,
          selection.entryId,
        );
        if (request === navigation.current) updateView({ streamEntry: entry });
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
  const openPending = useCallback(async () => {
    if (!desktop || busyRef.current || saveRef.current) return false;
    try {
      if (!(await api.hasPendingFiles())) return true;
    } catch (error) {
      reportError(String(error));
      return true;
    }
    if (busyRef.current || saveRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      // The native queue is bounded to 32 files. Continue past a bad file.
      for (let attempt = 0; attempt < 64; attempt++) {
        try {
          const imported = await api.openPending(setProgress);
          if (!imported) break;
          await refresh();
          setIndependent(imported.sessionId ? null : imported.runId);
          setActiveId(imported.sessionId);
        } catch (error) {
          const code = String(error);
          if (code === "cancelled") {
            setNotice({ text: t("cancelled"), error: false });
            break;
          }
          reportError(code);
          if (code === "importBusy") return false;
        }
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      setProgress(null);
    }
    return true;
  }, [refresh, reportError, t]);
  useFileOpen(busy || saving, openPending, reportError);

  const openDroppedFiles = useCallback(
    async (paths: string[]) => {
      if (!desktop || busyRef.current || saveRef.current) return;
      // 优先识别 .peekplugin / .peekplugin.json 插件清单，直接唤起安装预览弹窗
      const pluginFile = paths.find((p) =>
        /(\.peekplugin\.json|\.peekplugin)$/i.test(p),
      );
      if (pluginFile) {
        try {
          const preview = await api.parsePluginFilePath(pluginFile);
          setPendingPluginPreview(preview);
          setPluginsOpen(true);
        } catch (error) {
          reportError(String(error));
        }
        return;
      }
      const supported = paths.filter((p) =>
        /\.(peek|peekbundle|jsonl)$/i.test(p),
      );
      if (supported.length === 0) {
        reportError("unsupportedFile");
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setProgress(null);
      setNotice(null);
      try {
        for (const path of supported) {
          const imported = await api.openPath(path, setProgress);
          if (imported) {
            await refresh();
            setIndependent(imported.sessionId ? null : imported.runId);
            setActiveId(imported.sessionId);
          }
        }
      } catch (error) {
        if (String(error) === "cancelled") {
          setNotice({ text: t("cancelled"), error: false });
        } else {
          reportError(String(error));
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
        setProgress(null);
      }
    },
    [refresh, reportError, t],
  );
  const draggingFiles = useFileDrop((paths) => void openDroppedFiles(paths));

  const handleTogglePin = async (entry: EntryRow) => {
    if (!active) return;
    try {
      const pinned = await api.togglePin(active.id, entry.id);
      setPinTick((v) => v + 1);
      if (view.selected?.id === entry.id) {
        updateView({ selected: { ...view.selected, pinned } });
      }
    } catch (error) {
      reportError(String(error));
    }
  };

  const handleRequestCopy = async (entry: EntryRow, kind: RequestCopyKind) => {
    if (!active) return;
    try {
      let text = "";
      if (kind === "url") {
        text = entry.url;
      } else if (kind === "curl") {
        text = await api.copyCurl(active.id, entry.id);
      } else if (kind === "dio" || kind === "fetch") {
        text = await api.copySnippet(active.id, entry.id, kind);
      } else if (kind === "body") {
        const resBody = await api.body(active.id, entry.id, "response");
        text = resBody.text;
        if (!text) {
          setNotice({ text: t("emptyBody"), error: false });
          return;
        }
      }
      await writeClipboard(text);
      setNotice({ text: t("copied"), error: false });
    } catch (error) {
      reportError(String(error));
    }
  };

  /** 右键「原样重发一次」：后台拉取完整请求头与正文并直接重发，在顶部提示结果且支持一键展开详情弹窗。 */
  const handleQuickRepeat = async (entry: EntryRow) => {
    if (!active || !desktop) return;
    const sessionId = active.id;
    let shortPath = entry.url;
    try {
      shortPath = new URL(entry.url).pathname || "/";
    } catch {
      /* 保留原始 URL */
    }
    try {
      const [meta, bodyView] = await Promise.all([
        api.metadata(sessionId, entry.id).catch(() => ""),
        api.body(sessionId, entry.id, "request").catch(() => null),
      ]);
      const reqHeaders = parseRequestHeaders(meta).filter(
        ([k]) => k.trim().length > 0,
      );
      const extracted = extractReplayBody(bodyView);
      const res = await api.replay({
        method: entry.method.toUpperCase(),
        url: entry.url,
        headers: reqHeaders,
        body: extracted.text.length > 0 ? extracted.text : null,
      });
      setNotice({
        text: t("quickRepeatDone", {
          method: entry.method.toUpperCase(),
          path: shortPath,
          status: res.status,
          ms: Math.round(res.durationMs),
          size: formatBytes(res.bytes),
        }),
        error: res.status >= 500,
        action: {
          label: t("quickRepeatInspect"),
          onClick: () =>
            setReplayTarget({
              sessionId,
              entry,
              metadata: meta,
              initialResponse: res,
            }),
        },
      });
    } catch (error) {
      setNotice({
        text: t("quickRepeatFailed", { error: String(error) }),
        error: true,
      });
    }
  };

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
  useCommand("edit.selectAll", () => {
    performScopedSelectAll();
  });
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
  useCommand("view.stream", () => updateView({ tab: "stream" }), !!scopeId);
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
      "view.stream": !!scopeId && currentTab === "stream",
      "view.theme": theme === "dark",
      "language.zh-CN": i18n.language !== "en",
      "language.en": i18n.language === "en",
      "view.follow":
        !!scopeId &&
        (currentTab === "timeline"
          ? view.timeline.following
          : currentTab === "stream"
            ? view.stream.following
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
  useEffect(() => installSelectScopeTracker(), []);
  // 防止在非输入区按 ⌘/Ctrl+A 触发 WebView 全文档选中（波及工具栏、菜单、侧边栏）
  useEffect(() => {
    const guardSelectAll = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "a"
      ) {
        if (
          isTextInputElement(event.target) ||
          isTextInputElement(document.activeElement)
        ) {
          return;
        }
        event.preventDefault();
        performScopedSelectAll(event.target);
      }
    };
    window.addEventListener("keydown", guardSelectAll);
    return () => window.removeEventListener("keydown", guardSelectAll);
  }, []);
  useEffect(() => {
    if (nativeReady) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      const id = commandForKey(event);
      if (id === "edit.selectAll") return;
      if (id && commands.dispatch(id)) event.preventDefault();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [nativeReady]);
  const activeMeta =
    active && networkMeta?.sessionId === active.id ? networkMeta : null;
  const effectiveAfterSeq =
    view.clearActive && view.clearMarkSeq !== null ? view.clearMarkSeq : null;
  const retainedHiddenCount =
    effectiveAfterSeq !== null ? (activeMeta?.hiddenCount ?? 0) : 0;
  const evictedHiddenCount =
    effectiveAfterSeq !== null
      ? Math.max(0, view.clearInitialHidden - retainedHiddenCount)
      : 0;
  const handleClearNetwork = () => {
    if (!active || active.entryCount === 0) return;
    const latestSeq = activeMeta?.latestSeq ?? 0;
    const mark = Math.max(latestSeq, view.clearMarkSeq ?? 0, active.entryCount);
    updateView({
      clearMarkSeq: mark,
      clearActive: true,
      clearInitialHidden: active.entryCount,
      selected: null,
    });
  };
  const liveUsedBytes = activeMeta?.totalBytes ?? active?.rawBytes ?? 0;
  const liveMaxBytes = activeMeta?.maxBytes ?? null;
  const liveSpilledCount =
    activeMeta?.spilledCount ?? active?.spilledCount ?? 0;
  const liveSpilledBytes =
    activeMeta?.spilledBytes ?? active?.spilledBytes ?? 0;
  const liveNearLimit =
    liveMaxBytes !== null &&
    liveMaxBytes > 0 &&
    liveUsedBytes / liveMaxBytes >= 0.75;
  const hasAdvancedNetworkFilter = !!(
    view.methodFilter ||
    view.statusFilter ||
    view.searchBody ||
    view.hostFilter ||
    view.excludePatterns.length > 0
  );

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
        <FileTools
          hasData={!!(sessions.length || remote.diagnosticRuns.length)}
          onRestored={async (result) => {
            await refresh();
            setIndependent(result.sessionId ? null : result.runId);
            setActiveId(result.sessionId);
          }}
          scope={
            scopeId
              ? { kind: independentRun ? "diagnostic" : "network", id: scopeId }
              : null
          }
          hasLogs={!!(independentRun || runs.length)}
          networkId={active?.id}
          entryId={
            currentTab === "network"
              ? view.selected?.id
              : currentTab === "timeline"
                ? view.timelineEntry?.id
                : currentTab === "stream"
                  ? view.streamEntry?.id
                  : undefined
          }
          onError={reportError}
          onNotice={(text) => setNotice({ text, error: false })}
        />
        <ConnectionPanel
          remote={remote}
          deviceAliases={deviceAliases}
          onEditDeviceAlias={(deviceId, reportedName) =>
            setAliasTarget({ deviceId, reportedName })
          }
          onChange={refresh}
          onError={reportError}
        />
        <span className={`mode-badge ${remote.listening ? "is-live" : ""}`}>
          <Circle size={6} fill="currentColor" />
          {t(remote.listening ? "listening" : "offline")}
        </span>
        <div className="toolbar-end">
          {desktop && (
            <Button
              variant="ghost"
              onClick={() => {
                setPendingPluginPreview(null);
                setPluginsOpen(true);
              }}
              title={t("pluginsTitle")}
            >
              <Puzzle size={14} />
              {t("plugins")}
              {pluginSnapshot.plugins.some((p) => p.enabled) && (
                <span className="plugin-count-badge">
                  {pluginSnapshot.plugins.filter((p) => p.enabled).length}
                </span>
              )}
            </Button>
          )}
          <AboutPanel />
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
          <span className="notice-text">{notice.text}</span>
          <div className="notice-actions">
            {notice.action && (
              <button
                type="button"
                className="notice-action-btn"
                onClick={() => {
                  const fn = notice.action?.onClick;
                  setNotice(null);
                  fn?.();
                }}
              >
                {notice.action.label}
              </button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("dismiss")}
              onClick={() => setNotice(null)}
            >
              <X />
            </Button>
          </div>
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
              {(() => {
                const onlineDevices = new Set(
                  remote.sessions
                    .filter((session) => session.online)
                    .map((session) => session.deviceId),
                ).size;
                return (
                  <>
                    <span
                      className={`live-dot ${onlineDevices > 0 ? "is-online" : ""}`}
                    />
                    {onlineDevices || t("noConnectedDevice")}
                  </>
                );
              })()}
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
                sessions.map((session) => {
                  const reportedName = session.header.name || session.filename;
                  const display = resolveDeviceDisplay(
                    session.deviceId,
                    reportedName,
                    deviceAliases,
                  );
                  return (
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
                          <strong title={display.title}>{display.title}</strong>
                          {display.subtitle && (
                            <small
                              className="session-alias-origin"
                              title={display.subtitle}
                            >
                              {display.subtitle}
                            </small>
                          )}
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
                      <div className="session-item-actions">
                        {session.deviceId && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t("deviceAliasTitle")}
                            aria-label={`${t("deviceAliasTitle")} ${display.title}`}
                            onClick={() =>
                              setAliasTarget({
                                deviceId: session.deviceId!,
                                reportedName,
                              })
                            }
                          >
                            <Pencil size={12} />
                          </Button>
                        )}
                        {desktop && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-haspopup="menu"
                            aria-label={`${t("menuActions")} ${display.title}`}
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
                    </div>
                  );
                })
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
          </nav>
        </Panel>
        <Separator className="panel-separator" />
        <Panel id="console" defaultSize="49%" minSize={360}>
          <section
            className="console"
            onKeyDown={(event) => {
              // 网络视图聚焦时支持 ⌘/Ctrl + L 快捷软清屏（不丢数据，随时可切回）
              if (
                currentTab === "network" &&
                active &&
                (event.metaKey || event.ctrlKey) &&
                !event.shiftKey &&
                !event.altKey &&
                event.key.toLowerCase() === "l" &&
                !isTextInputElement(event.target)
              ) {
                event.preventDefault();
                handleClearNetwork();
              }
            }}
          >
            {independentRun || active ? (
              <>
                <div className="console-bar">
                  <div className="live-tabs segmented">
                    {(independentRun
                      ? (["logs", "exceptions", "timeline", "stream"] as const)
                      : active?.deviceId || runs.length
                        ? ([
                            "network",
                            "logs",
                            "exceptions",
                            "timeline",
                            "stream",
                          ] as const)
                        : (["network", "timeline", "stream"] as const)
                    ).map((tab) => (
                      <button
                        key={tab}
                        className={currentTab === tab ? "active" : ""}
                        aria-pressed={currentTab === tab}
                        onClick={() =>
                          commands.dispatch(`view.${tab}` as CommandId)
                        }
                      >
                        {tab === "stream" && <Terminal size={12} />}
                        {t(tab)}
                        {tab === "logs"
                          ? ` (${independentRun?.count ?? runs.reduce((total, run) => total + run.count, 0)})`
                          : ""}
                      </button>
                    ))}
                  </div>
                  <div className="console-bar-meta">
                    {active &&
                      (() => {
                        const reported = active.header.name || active.filename;
                        const activeDisplay = resolveDeviceDisplay(
                          active.deviceId,
                          reported,
                          deviceAliases,
                        );
                        const label = activeDisplay.subtitle
                          ? `${activeDisplay.title} (${activeDisplay.subtitle})`
                          : activeDisplay.title;
                        return (
                          <span className="muted filename" title={label}>
                            {label}
                          </span>
                        );
                      })()}
                    <TimeRangeBar
                      range={view.range}
                      onChange={(range) => updateView({ range })}
                    />
                  </div>
                </div>
                {currentTab === "stream" ? (
                  <ConsoleStream
                    key={scopeId}
                    scope={{
                      kind: independentRun ? "diagnostic" : "network",
                      id: scopeId!,
                    }}
                    live={!!active?.deviceId && !!active?.online}
                    range={view.range}
                    view={view.stream}
                    selected={view.streamSelected}
                    locateEntry={streamLocate}
                    onLocateHandled={() => setStreamLocate(null)}
                    version={`${active?.version ?? 0}:${(independentRun
                      ? [independentRun]
                      : runs
                    )
                      .map((run) => `${run.id}:${run.version}`)
                      .sort()
                      .join(",")}`}
                    onViewChange={(update) =>
                      updateView({ stream: { ...view.stream, ...update } })
                    }
                    onSelect={(selection) => void selectStream(selection)}
                    onQuickSymbolicate={(selection) => {
                      void selectStream(selection);
                      if (!pluginSnapshot.plugins.some((p) => p.enabled)) {
                        setPendingPluginPreview(null);
                        setPluginsOpen(true);
                      } else {
                        setSymbolicateNonce((n) => n + 1);
                      }
                    }}
                    onError={reportError}
                  />
                ) : currentTab === "timeline" ? (
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
                            type="button"
                            aria-label={t("dismiss")}
                            onClick={() =>
                              updateView({ search: "", selected: null })
                            }
                          >
                            <X size={13} />
                          </button>
                        )}
                        <button
                          type="button"
                          className={`search-body-toggle${view.searchBody ? " active" : ""}`}
                          aria-pressed={view.searchBody}
                          title={t("searchBodyHint")}
                          onClick={(event) => {
                            event.preventDefault();
                            updateView({
                              searchBody: !view.searchBody,
                              selected: null,
                            });
                          }}
                        >
                          <FileSearch size={12} />
                          <span>{t("searchBodyToggle")}</span>
                        </button>
                      </label>
                      <div className="filter-row">
                        <div className="filter-row-left">
                          <div className="segmented">
                            {(
                              ["all", "errors", "pending", "pinned"] as Filter[]
                            ).map((filter) => (
                              <button
                                key={filter}
                                aria-pressed={view.filter === filter}
                                className={
                                  view.filter === filter ? "active" : ""
                                }
                                onClick={() =>
                                  updateView({ filter, selected: null })
                                }
                              >
                                {t(filter)}
                              </button>
                            ))}
                          </div>
                          <select
                            className={`filter-select${view.methodFilter ? " is-active" : ""}`}
                            aria-label={t("method")}
                            value={view.methodFilter ?? ""}
                            onChange={(event) =>
                              updateView({
                                methodFilter: event.target.value || null,
                                selected: null,
                              })
                            }
                          >
                            <option value="">{t("allMethods")}</option>
                            {FILTER_METHODS.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                          <select
                            className={`filter-select${view.statusFilter ? " is-active" : ""}`}
                            aria-label={t("status")}
                            value={view.statusFilter ?? ""}
                            onChange={(event) =>
                              updateView({
                                statusFilter:
                                  (event.target.value as RequestStatusFilter) ||
                                  null,
                                selected: null,
                              })
                            }
                          >
                            <option value="">{t("allStatusCodes")}</option>
                            <option value="2xx">2xx</option>
                            <option value="3xx">3xx</option>
                            <option value="4xx">4xx</option>
                            <option value="5xx">5xx</option>
                            <option value="failed">
                              {t("statusFailedOnly")}
                            </option>
                          </select>
                          {hasAdvancedNetworkFilter && (
                            <button
                              type="button"
                              className="filter-reset-btn"
                              onClick={() =>
                                updateView({
                                  methodFilter: null,
                                  statusFilter: null,
                                  searchBody: false,
                                  hostFilter: null,
                                  excludePatterns: [],
                                  selected: null,
                                })
                              }
                            >
                              {t("resetFilters")}
                            </button>
                          )}
                        </div>
                        <div className="filter-row-end">
                          {view.clearMarkSeq !== null && view.clearActive ? (
                            <span className="clear-toggle-group">
                              {retainedHiddenCount > 0 ? (
                                <Button
                                  size="sm"
                                  variant="default"
                                  className="is-cleared-chip"
                                  onClick={() =>
                                    updateView({ clearActive: false })
                                  }
                                  title={
                                    evictedHiddenCount > 0
                                      ? t("networkClearedWithEvictedHint", {
                                          retained: retainedHiddenCount,
                                          evicted: evictedHiddenCount,
                                        })
                                      : t("networkClearedHint")
                                  }
                                >
                                  <RotateCcw size={12} />
                                  {t("networkShowHistory", {
                                    count: retainedHiddenCount,
                                  })}
                                  {evictedHiddenCount > 0 && (
                                    <span className="evicted-pill">
                                      {t("networkEvictedBadge", {
                                        count: evictedHiddenCount,
                                      })}
                                    </span>
                                  )}
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="is-cleared-chip is-all-evicted"
                                  onClick={() =>
                                    updateView({
                                      clearMarkSeq: null,
                                      clearActive: false,
                                      clearInitialHidden: 0,
                                    })
                                  }
                                  title={t("networkClearedAllEvictedHint", {
                                    evicted: evictedHiddenCount,
                                  })}
                                >
                                  {t("networkEvictedBadge", {
                                    count: evictedHiddenCount,
                                  })}
                                  <X size={11} />
                                </Button>
                              )}
                              {count > 0 && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={handleClearNetwork}
                                  title={t("networkClearHint")}
                                >
                                  <Eraser size={12} />
                                  {t("networkClear")}
                                </Button>
                              )}
                            </span>
                          ) : view.clearMarkSeq !== null &&
                            !view.clearActive ? (
                            <span className="clear-toggle-group">
                              <Button
                                size="sm"
                                variant="default"
                                className="is-cleared-chip"
                                onClick={() =>
                                  updateView({
                                    clearActive: true,
                                    selected: null,
                                  })
                                }
                                title={t("networkHideHistory")}
                              >
                                <Eraser size={12} />
                                {t("networkHideHistory")}
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="clear-dismiss-btn"
                                aria-label={t("networkClearDismiss")}
                                title={t("networkClearDismiss")}
                                onClick={() =>
                                  updateView({
                                    clearMarkSeq: null,
                                    clearActive: false,
                                    clearInitialHidden: 0,
                                  })
                                }
                              >
                                <X size={11} />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={active.entryCount === 0}
                                onClick={handleClearNetwork}
                                title={t("networkClearHint")}
                              >
                                <Eraser size={12} />
                                {t("networkClear")}
                              </Button>
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={active.entryCount === 0}
                              onClick={handleClearNetwork}
                              title={t("networkClearHint")}
                            >
                              <Eraser size={12} />
                              {t("networkClear")}
                            </Button>
                          )}
                          <span className="num-cell filter-match-count">
                            {count.toLocaleString()} {t("matches")}
                          </span>
                        </div>
                      </div>
                      {(view.hosts.length > 1 ||
                        view.hostFilter ||
                        view.excludePatterns.length > 0 ||
                        view.compareAnchor) && (
                        <div className="host-chips-row">
                          {view.hosts.length > 1 && (
                            <>
                              <button
                                type="button"
                                className={`host-chip ${!view.hostFilter ? "active" : ""}`}
                                onClick={() =>
                                  updateView({
                                    hostFilter: null,
                                    selected: null,
                                  })
                                }
                              >
                                {t("clearHostFilter")}
                              </button>
                              {view.hosts.slice(0, 6).map((host) => (
                                <button
                                  key={host}
                                  type="button"
                                  className={`host-chip ${view.hostFilter === host ? "active" : ""}`}
                                  onClick={() =>
                                    updateView({
                                      hostFilter:
                                        view.hostFilter === host ? null : host,
                                      selected: null,
                                    })
                                  }
                                >
                                  {host}
                                </button>
                              ))}
                            </>
                          )}
                          {view.hostFilter &&
                            !view.hosts
                              .slice(0, 6)
                              .includes(view.hostFilter) && (
                              <button
                                type="button"
                                className="host-chip active"
                                onClick={() =>
                                  updateView({
                                    hostFilter: null,
                                    selected: null,
                                  })
                                }
                              >
                                {view.hostFilter} ×
                              </button>
                            )}
                          {view.excludePatterns.map((pattern) => (
                            <button
                              key={pattern}
                              type="button"
                              className="host-chip is-exclude"
                              title={t("hiddenPathChip")}
                              onClick={() =>
                                updateView({
                                  excludePatterns: view.excludePatterns.filter(
                                    (p) => p !== pattern,
                                  ),
                                })
                              }
                            >
                              -{pattern} ×
                            </button>
                          ))}
                          {view.compareAnchor && (
                            <button
                              type="button"
                              className="host-chip is-compare"
                              onClick={() =>
                                updateView({ compareAnchor: null })
                              }
                            >
                              {t("compareBaselineReady")}:{" "}
                              {view.compareAnchor.method} ×
                            </button>
                          )}
                        </div>
                      )}
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
                      version={(active.version ?? 0) + pinTick}
                      live={!!active.deviceId}
                      sessionId={active.id}
                      search={
                        search.sessionId === active.id
                          ? search.value
                          : view.search
                      }
                      filter={view.filter}
                      hostFilter={view.hostFilter}
                      excludePatterns={view.excludePatterns}
                      methodFilter={view.methodFilter}
                      statusFilter={view.statusFilter}
                      searchBody={view.searchBody}
                      sortBy={view.sortBy}
                      sortDir={view.sortDir}
                      afterSeq={effectiveAfterSeq}
                      clearMarkSeq={view.clearMarkSeq}
                      clearEvictedCount={evictedHiddenCount}
                      range={view.range}
                      selectedId={view.selected?.id}
                      compareAnchor={view.compareAnchor}
                      onSelect={(entry) => updateView({ selected: entry })}
                      onCount={setCount}
                      onMeta={(meta) =>
                        setNetworkMeta({ ...meta, sessionId: active.id })
                      }
                      onSortChange={(sortBy, sortDir) =>
                        updateView({ sortBy, sortDir })
                      }
                      onRestoreHistory={() =>
                        updateView({ clearActive: false })
                      }
                      onDismissClear={() =>
                        updateView({
                          clearMarkSeq: null,
                          clearActive: false,
                          clearInitialHidden: 0,
                        })
                      }
                      onHosts={(hosts) => {
                        if (
                          JSON.stringify(hosts) !== JSON.stringify(view.hosts)
                        ) {
                          updateView({ hosts });
                        }
                      }}
                      onPinToggle={(entry) => void handleTogglePin(entry)}
                      onFilterHost={(host) =>
                        updateView({ hostFilter: host, selected: null })
                      }
                      onExcludePath={(pattern) => {
                        if (!view.excludePatterns.includes(pattern)) {
                          updateView({
                            excludePatterns: [...view.excludePatterns, pattern],
                          });
                        }
                      }}
                      onLocateInStream={(entry) => {
                        updateView({
                          tab: "stream",
                          stream: {
                            ...view.stream,
                            following: false,
                            minTimestampMicros: null,
                          },
                          streamEntry: entry,
                          streamSelected: {
                            blockId: `req:${active.id}:${entry.id}`,
                            kind: "http-request",
                            sessionId: active.id,
                            entryId: entry.id,
                            runId: null,
                            eventId: null,
                          },
                        });
                        setStreamLocate({
                          entryId: entry.id,
                          nonce: Date.now(),
                        });
                      }}
                      onReplay={
                        desktop
                          ? (entry) =>
                              setReplayTarget({ sessionId: active.id, entry })
                          : undefined
                      }
                      onQuickRepeat={
                        desktop
                          ? (entry) => void handleQuickRepeat(entry)
                          : undefined
                      }
                      onRepeatBatch={
                        desktop
                          ? (entry) =>
                              setReplayTarget({
                                sessionId: active.id,
                                entry,
                                initialBatchMode: true,
                              })
                          : undefined
                      }
                      onSetCompareAnchor={(entry) =>
                        updateView({ compareAnchor: entry })
                      }
                      onCompareWithAnchor={(entry) => {
                        if (view.compareAnchor) {
                          setDiffPair({
                            sessionId: active.id,
                            left: view.compareAnchor,
                            right: entry,
                          });
                        }
                      }}
                      onCopyAction={(entry, kind) =>
                        void handleRequestCopy(entry, kind)
                      }
                      onError={reportError}
                    />
                    {active.deviceId && (
                      <div className="diagnostic-stats">
                        <span>
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
                        </span>
                        {liveSpilledCount > 0 && (
                          <span
                            className="spill-badge"
                            title={t("networkSpilledHint")}
                          >
                            <HardDrive size={11} />
                            {t("networkSpilledBadge", {
                              count: liveSpilledCount,
                              size: formatBytes(liveSpilledBytes),
                            })}
                          </span>
                        )}
                        {liveMaxBytes !== null && (
                          <span
                            className={`capacity-meter${liveNearLimit || evictedHiddenCount > 0 ? " is-near-limit" : ""}`}
                            title={
                              liveNearLimit
                                ? t("networkCapacityNearLimit")
                                : undefined
                            }
                          >
                            {t("networkCapacityUsage", {
                              used: formatBytes(liveUsedBytes),
                              limit: formatBytes(liveMaxBytes),
                            })}
                            {(liveNearLimit || evictedHiddenCount > 0) &&
                              desktop && (
                                <button
                                  type="button"
                                  className="capacity-save-link"
                                  onClick={() =>
                                    commands.dispatch("session.save")
                                  }
                                >
                                  {t("saveSessionNow")}
                                </button>
                              )}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                ) : null}
              </>
            ) : (
              <div className="empty-workspace">
                <span className="empty-workspace-icon">
                  <Activity size={24} />
                </span>
                <h2>{t("emptyFiles")}</h2>
                <p>{t("connectionReady")}</p>
                <div className="empty-workspace-actions">
                  {desktop && (
                    <Button
                      variant="primary"
                      onClick={() => commands.dispatch("connection.open")}
                    >
                      <Radio />
                      {t("connectNow")}
                    </Button>
                  )}
                  <Button
                    variant={desktop ? "default" : "primary"}
                    disabled={!desktop || busy || saving}
                    onClick={() => commands.dispatch("session.open")}
                  >
                    <FolderOpen />
                    {t("open")}
                  </Button>
                </div>
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
          ) : currentTab === "stream" && !view.streamSelected ? (
            <aside className="detail-empty">
              <Terminal />
              <h2>{t("selectTimelineEvent")}</h2>
              <p>{t("selectTimelineHint")}</p>
            </aside>
          ) : currentTab !== "network" &&
            !(
              currentTab === "timeline" &&
              view.timelineSelected?.kind === "network"
            ) &&
            !(currentTab === "stream" && !!view.streamSelected?.entryId) ? (
            <DiagnosticDetail
              selected={detailLog}
              evictionVersion={selectedRun?.evicted}
              networkSessionId={boundNetwork?.id ?? null}
              networkVersion={`${boundNetwork?.generation ?? 0}:${boundNetwork?.evicted ?? 0}`}
              onNetwork={(sessionId, entryId) =>
                void openNetwork(sessionId, entryId)
              }
              plugins={pluginSnapshot.plugins}
              defaultPluginId={pluginSnapshot.defaultPluginId}
              autoSymbolicateNonce={symbolicateNonce}
              onOpenPlugins={() => {
                setPendingPluginPreview(null);
                setPluginsOpen(true);
              }}
              theme={theme}
            />
          ) : (
            <DetailPane
              key={`${activeId}:${active?.generation ?? 0}:${currentTab}`}
              version={active?.version}
              sessionId={active?.id ?? null}
              entry={
                currentTab === "timeline"
                  ? view.timelineEntry
                  : currentTab === "stream"
                    ? view.streamEntry
                    : view.selected
              }
              onReplay={
                active?.id
                  ? (entry, metadata) =>
                      setReplayTarget({
                        sessionId: active.id,
                        entry,
                        metadata,
                      })
                  : undefined
              }
              theme={theme}
            />
          )}
        </Panel>
      </Group>
      {replayTarget && (
        <ReplayDialog
          key={`${replayTarget.sessionId}:${replayTarget.entry.id}:${replayTarget.initialBatchMode ? "batch" : "single"}`}
          sessionId={replayTarget.sessionId}
          entry={replayTarget.entry}
          metadata={replayTarget.metadata}
          initialBatchMode={replayTarget.initialBatchMode}
          initialResponse={replayTarget.initialResponse}
          theme={theme}
          onClose={() => setReplayTarget(null)}
        />
      )}
      {aliasTarget && (
        <DeviceAliasDialog
          deviceId={aliasTarget.deviceId}
          reportedName={aliasTarget.reportedName}
          initialAlias={deviceAliases[aliasTarget.deviceId] ?? ""}
          onSave={(deviceId, alias) =>
            setDeviceAliases((prev) => writeDeviceAlias(prev, deviceId, alias))
          }
          onClose={() => setAliasTarget(null)}
        />
      )}
      {diffPair && (
        <RequestDiffDialog
          sessionId={diffPair.sessionId}
          left={diffPair.left}
          right={diffPair.right}
          onClose={() => setDiffPair(null)}
        />
      )}
      {pluginsOpen && (
        <PluginManagerDialog
          snapshot={pluginSnapshot}
          initialPreview={pendingPluginPreview}
          onSnapshotChange={setPluginSnapshot}
          onClose={() => {
            setPluginsOpen(false);
            setPendingPluginPreview(null);
          }}
        />
      )}
      {draggingFiles && (
        <div className="drop-overlay" role="status">
          <div className="drop-overlay-card">
            <FolderOpen size={28} />
            <strong>{t("dropFilesTitle")}</strong>
            <span>{t("dropFilesHint")}</span>
          </div>
        </div>
      )}
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
          <span className={`live-dot ${remote.listening ? "is-online" : ""}`} />
          {t(
            active?.archive
              ? "archivedSession"
              : remote.listening
                ? "live"
                : "fileOnly",
          )}
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
            sessions.reduce(
              (sum, session) =>
                sum + session.rawBytes + (session.spilledBytes ?? 0),
              0,
            ),
          )}
        </span>
        <span className="shortcut-hint">{t("shortcuts")}</span>
      </footer>
    </main>
  );
}
