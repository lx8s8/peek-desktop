import {
  commands,
  commandForKey,
  type CommandId,
} from "./lib/commands/dispatcher";
import { useCommand } from "./lib/commands/react";
import { useNativeMenu, useContextMenu } from "./lib/commands/native";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  Archive,
  BarChart3,
  ChevronRight,
  Circle,
  Command,
  FileSearch,
  FolderOpen,
  Globe2,
  HardDrive,
  Eraser,
  Moon,
  Puzzle,
  Radio,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
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
import { SessionSidebar } from "./features/connection/SessionSidebar";
import {
  formatRunStartedAt,
  groupWorkspaceSessions,
} from "./features/connection/sessionGroups";
import { useWorkspace } from "./features/connection/useWorkspace";
import type { PaletteAction } from "./features/command/CommandPalette";
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
import { DetailPane } from "./features/detail/DetailPane";
import { buildRequestBugReport } from "./features/detail/bugReport";
import {
  extractReplayBody,
  parseRequestHeaders,
} from "./features/detail/replayHelpers";
import { writeClipboard } from "./lib/clipboard";
import {
  installSelectScopeTracker,
  isTextInputElement,
  performScopedSelectAll,
} from "./lib/selection";
import { api, desktop } from "./lib/ipc/client";
import type {
  BizErrorRule,
  EntryRow,
  Filter,
  ImportProgress,
  ParsedPluginPreview,
  PluginListSnapshot,
  ReplayResponse,
  RequestSortField,
  RequestStatusFilter,
  SessionSummary,
  SortDirection,
  TimeRange,
  TimelineRow,
} from "./lib/ipc/types";
import {
  formatBytes,
  readBizErrorRule,
  readDeviceAliases,
  readFilterPresets,
  readGlobalNoiseConfig,
  readListenerPrefs,
  readPreference,
  resolveDeviceDisplay,
  writeBizErrorRule,
  writeDeviceAlias,
  writeFilterPresets,
  writeGlobalNoiseConfig,
  writePreference,
  type GlobalNoiseConfig,
  type NetworkFilterPreset,
} from "./lib/preferences";
import "./lib/i18n";
import "./App.css";

// 非首屏重型弹窗按需懒加载，压缩桌面端冷启动首包体积
const LazyDeviceAliasDialog = lazy(() =>
  import("./features/connection/DeviceAliasDialog").then((m) => ({
    default: m.DeviceAliasDialog,
  })),
);
const LazyRequestDiffDialog = lazy(() =>
  import("./features/diff/RequestDiffDialog").then((m) => ({
    default: m.RequestDiffDialog,
  })),
);
const LazyPluginManagerDialog = lazy(() =>
  import("./features/plugins/PluginManagerDialog").then((m) => ({
    default: m.PluginManagerDialog,
  })),
);
const LazyReplayDialog = lazy(() =>
  import("./features/detail/ReplayDialog").then((m) => ({
    default: m.ReplayDialog,
  })),
);
const LazyEndpointStatsDialog = lazy(() =>
  import("./features/console/EndpointStatsDialog").then((m) => ({
    default: m.EndpointStatsDialog,
  })),
);
const LazyNetworkRulesDialog = lazy(() =>
  import("./features/console/NetworkRulesDialog").then((m) => ({
    default: m.NetworkRulesDialog,
  })),
);
const LazyCommandPalette = lazy(() =>
  import("./features/command/CommandPalette").then((m) => ({
    default: m.CommandPalette,
  })),
);

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
  minDurationMs: number | null;
  hostFilter: string | null;
  excludePatterns: string[];
  hosts: string[];
  sortBy: RequestSortField | null;
  sortDir: SortDirection;
  clearMarkSeq: number | null;
  clearActive: boolean;
  clearInitialHidden: number;
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
  minDurationMs: null,
  hostFilter: null,
  excludePatterns: [],
  hosts: [],
  sortBy: null,
  sortDir: "desc",
  clearMarkSeq: null,
  clearActive: false,
  clearInitialHidden: 0,
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
  // 跨运行 / 跨设备对比基准提升为工作区全局状态
  const [compareAnchor, setCompareAnchor] = useState<{
    sessionId: string;
    sessionLabel: string;
    entry: EntryRow;
  } | null>(null);
  const [diffPair, setDiffPair] = useState<{
    leftSessionId: string;
    leftLabel: string;
    left: EntryRow;
    rightSessionId: string;
    rightLabel: string;
    right: EntryRow;
  } | null>(null);
  const [bizErrorRule, setBizErrorRule] = useState<BizErrorRule>(() =>
    readBizErrorRule(),
  );
  const [noiseConfig, setNoiseConfig] = useState<GlobalNoiseConfig>(() =>
    readGlobalNoiseConfig(),
  );
  const [filterPresets, setFilterPresets] = useState<NetworkFilterPreset[]>(
    () => readFilterPresets(),
  );
  const [rulesOpen, setRulesOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const autoStartAttempted = useRef(false);
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
  // 可选的「启动时自动开始监听」：仅在用户显式勾选后于启动时触发一次，失败仅温和提示
  useEffect(() => {
    if (!desktop || autoStartAttempted.current || remote.listening) return;
    const prefs = readListenerPrefs();
    if (!prefs.autoStart) return;
    autoStartAttempted.current = true;
    void api
      .start(prefs.host, Number(prefs.port), prefs.advertise)
      .then(() => refresh())
      .catch((error) => {
        if (String(error) !== "listenerAlreadyRunning") {
          reportError(String(error));
        }
      });
  }, [remote.listening, refresh, reportError]);
  const workspaceGroups = useMemo(
    () => groupWorkspaceSessions(sessions, remote.pairing?.devices ?? []),
    [sessions, remote.pairing?.devices],
  );
  const active = independent
    ? undefined
    : sessions.find((session) => session.id === activeId);
  const independentRun = remote.diagnosticRuns.find(
    (run) => run.id === independent,
  );
  const runs = remote.diagnosticRuns.filter(
    (run) => run.networkSessionKey === active?.id,
  );
  const knownSessionIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!activeId && workspaceGroups.orderedSessions.length) {
      setActiveId(workspaceGroups.orderedSessions[0].id);
    }
  }, [activeId, workspaceGroups.orderedSessions]);
  // 同一设备重启/热重启产生新的在线运行时，若当前停在该设备的离线运行，自动切到最新在线运行
  useEffect(() => {
    const previous = knownSessionIds.current;
    const currentIds = new Set(sessions.map((session) => session.id));
    knownSessionIds.current = currentIds;
    if (!previous || independent || !active?.deviceId || active.online) return;
    const freshOnlineSameDevice = workspaceGroups.orderedSessions.find(
      (session) =>
        session.deviceId === active.deviceId &&
        session.online &&
        !previous.has(session.id),
    );
    if (freshOnlineSameDevice) {
      setActiveId(freshOnlineSameDevice.id);
    }
  }, [sessions, active, independent, workspaceGroups.orderedSessions]);
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

  const formatSessionLabel = useCallback(
    (session: SessionSummary | undefined): string => {
      if (!session) return "";
      const reported = session.header.name || session.filename;
      const display = resolveDeviceDisplay(
        session.deviceId,
        reported,
        deviceAliases,
      );
      const base = display.subtitle
        ? `${display.title} (${display.subtitle})`
        : display.title;
      const runCount = session.deviceId
        ? (workspaceGroups.deviceGroups.find(
            (group) => group.deviceId === session.deviceId,
          )?.runs.length ?? 1)
        : 1;
      const runTime =
        session.deviceId && runCount > 1
          ? formatRunStartedAt(session.header.startedAt, i18n.language)
          : "";
      return runTime ? `${base} · ${runTime}` : base;
    },
    [deviceAliases, i18n.language, workspaceGroups.deviceGroups],
  );
  const activeSessionLabel = useMemo(
    () => formatSessionLabel(active),
    [active, formatSessionLabel],
  );
  const activeDeviceLabel = useMemo(() => {
    if (!active?.deviceId) return activeSessionLabel;
    const reported = active.header.name || active.filename;
    return resolveDeviceDisplay(active.deviceId, reported, deviceAliases).title;
  }, [active, activeSessionLabel, deviceAliases]);

  const effectiveExcludes = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (pattern: string) => {
      const trimmed = pattern.trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(trimmed);
      }
    };
    for (const p of view.excludePatterns) add(p);
    if (noiseConfig.enabled) {
      for (const p of noiseConfig.globalExcludes) add(p);
      if (active?.deviceId) {
        for (const p of noiseConfig.deviceExcludes[active.deviceId] ?? []) {
          add(p);
        }
      }
    }
    return out;
  }, [view.excludePatterns, noiseConfig, active?.deviceId]);

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
      } else if (kind === "report") {
        const [meta, reqBody, resBody] = await Promise.all([
          api.metadata(active.id, entry.id).catch(() => ""),
          api.body(active.id, entry.id, "request").catch(() => null),
          api.body(active.id, entry.id, "response").catch(() => null),
        ]);
        text = buildRequestBugReport({
          entry,
          deviceLabel: activeSessionLabel,
          metadata: meta,
          requestBody: reqBody,
          responseBody: resBody,
        });
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
      const target = sessions.find((session) => session.id === id);
      await api.close(id);
      delete generations.current[id];
      await refresh();
      setViews((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
      if (id === activeId) {
        const remaining = workspaceGroups.orderedSessions.filter(
          (session) => session.id !== id,
        );
        const sameDeviceFallback = target?.deviceId
          ? remaining.find((session) => session.deviceId === target.deviceId)
          : undefined;
        setActiveId(sameDeviceFallback?.id ?? remaining[0]?.id ?? null);
      }
    } catch (error) {
      reportError(String(error));
    }
  }
  async function closeDeviceOfflineRuns(
    deviceId: string,
    deviceDisplayName: string,
  ) {
    const offlineIds = sessions
      .filter((session) => session.deviceId === deviceId && !session.online)
      .map((session) => session.id);
    if (offlineIds.length === 0) return;

    const closedIds = new Set<string>();
    let firstError: string | null = null;
    for (const id of offlineIds) {
      try {
        await api.close(id);
        delete generations.current[id];
        closedIds.add(id);
      } catch (error) {
        if (!firstError) firstError = String(error);
      }
    }

    if (closedIds.size > 0) {
      await refresh();
      setViews((previous) => {
        const next = { ...previous };
        for (const id of closedIds) {
          delete next[id];
        }
        return next;
      });
      if (activeId && closedIds.has(activeId)) {
        const remaining = workspaceGroups.orderedSessions.filter(
          (session) => !closedIds.has(session.id),
        );
        const sameDeviceFallback = remaining.find(
          (session) => session.deviceId === deviceId,
        );
        setActiveId(sameDeviceFallback?.id ?? remaining[0]?.id ?? null);
      }
      if (!firstError) {
        setNotice({
          text: t("clearedOfflineRunsNotice", {
            name: deviceDisplayName,
            count: closedIds.size,
          }),
          error: false,
        });
      }
    }

    if (firstError) {
      reportError(firstError);
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
  useCommand("palette.open", () => setPaletteOpen((value) => !value));
  useCommand("view.stats", () => setStatsOpen(true), !!active);
  useCommand("network.rules", () => setRulesOpen(true), !!active);
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
  // ⌘/Ctrl+P 随时呼出快捷命令面板（不依赖原生菜单项注册）
  useEffect(() => {
    const onPaletteKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onPaletteKey);
    return () => window.removeEventListener("keydown", onPaletteKey);
  }, []);
  useEffect(() => {
    if (nativeReady) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      const id = commandForKey(event);
      if (id === "edit.selectAll" || id === "palette.open") return;
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
    view.minDurationMs ||
    view.searchBody ||
    view.hostFilter ||
    view.excludePatterns.length > 0
  );

  const activeRuleCount =
    (bizErrorRule.enabled ? 1 : 0) +
    (noiseConfig.enabled
      ? noiseConfig.globalExcludes.length +
        (active?.deviceId
          ? (noiseConfig.deviceExcludes[active.deviceId]?.length ?? 0)
          : 0)
      : 0);

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [];
    for (const session of workspaceGroups.orderedSessions) {
      const label = formatSessionLabel(session);
      list.push({
        id: `session:${session.id}`,
        group: t("paletteGroupDevices"),
        title: label,
        subtitle: session.deviceId
          ? `${t(session.online ? "connected" : "disconnected")} · ${session.entryCount} ${t("requests")}`
          : `${session.header.platform} · ${session.entryCount} ${t("requests")}`,
        keywords: `${session.filename} ${session.deviceId ?? ""} ${session.id}`,
        run: () => {
          setIndependent(null);
          setActiveId(session.id);
        },
      });
    }
    list.push(
      {
        id: "cmd:network",
        group: t("paletteGroupViews"),
        title: t("network"),
        shortcut: "⌘1",
        disabled: !active,
        run: () => updateView({ tab: "network" }),
      },
      {
        id: "cmd:logs",
        group: t("paletteGroupViews"),
        title: t("logs"),
        shortcut: "⌘2",
        disabled: !(active?.deviceId || runs.length || independentRun),
        run: () => updateView({ tab: "logs" }),
      },
      {
        id: "cmd:exceptions",
        group: t("paletteGroupViews"),
        title: t("exceptions"),
        shortcut: "⌘3",
        disabled: !(active?.deviceId || runs.length || independentRun),
        run: () => updateView({ tab: "exceptions" }),
      },
      {
        id: "cmd:timeline",
        group: t("paletteGroupViews"),
        title: t("timeline"),
        shortcut: "⌘4",
        disabled: !scopeId,
        run: () => updateView({ tab: "timeline" }),
      },
      {
        id: "cmd:stream",
        group: t("paletteGroupViews"),
        title: t("stream"),
        shortcut: "⌘5",
        disabled: !scopeId,
        run: () => updateView({ tab: "stream" }),
      },
      {
        id: "cmd:stats",
        group: t("paletteGroupViews"),
        title: t("endpointStatsTitle"),
        keywords: "stats analytics slow api",
        disabled: !active,
        run: () => setStatsOpen(true),
      },
      {
        id: "cmd:rules",
        group: t("paletteGroupViews"),
        title: t("networkRulesTitle"),
        keywords: "biz error noise filter preset",
        disabled: !active,
        run: () => setRulesOpen(true),
      },
      {
        id: "cmd:clear",
        group: t("paletteGroupActions"),
        title: t("networkClear"),
        shortcut: "⌘L",
        disabled: !active || active.entryCount === 0,
        run: () => handleClearNetwork(),
      },
      {
        id: "cmd:connection",
        group: t("paletteGroupActions"),
        title: t("connection"),
        shortcut: "⌘K",
        disabled: !desktop,
        run: () => commands.dispatch("connection.open"),
      },
      {
        id: "cmd:pair",
        group: t("paletteGroupActions"),
        title: t("newPairingCode"),
        disabled: !desktop || !remote.listening,
        run: () => commands.dispatch("connection.pair"),
      },
      {
        id: "cmd:open",
        group: t("paletteGroupActions"),
        title: t("open"),
        shortcut: "⌘O",
        disabled: !desktop || busy || saving,
        run: () => commands.dispatch("session.open"),
      },
      {
        id: "cmd:archive",
        group: t("paletteGroupActions"),
        title: t("archiveSession"),
        disabled: !desktop || !scopeId || busy || saving,
        run: () => commands.dispatch("session.archive"),
      },
      {
        id: "cmd:plugins",
        group: t("paletteGroupActions"),
        title: t("pluginsTitle"),
        disabled: !desktop,
        run: () => {
          setPendingPluginPreview(null);
          setPluginsOpen(true);
        },
      },
      {
        id: "cmd:theme",
        group: t("paletteGroupActions"),
        title: t("theme"),
        run: () => commands.dispatch("view.theme"),
      },
      {
        id: "cmd:lang",
        group: t("paletteGroupActions"),
        title: t("language"),
        run: () => commands.dispatch("view.language"),
      },
    );
    return list;
  }, [
    workspaceGroups.orderedSessions,
    formatSessionLabel,
    t,
    active,
    runs.length,
    independentRun,
    scopeId,
    remote.listening,
    busy,
    saving,
  ]);

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
          liveOnline={!!active?.deviceId && !!active?.online}
          spilledCount={liveSpilledCount}
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
          <Button
            variant="ghost"
            onClick={() => setPaletteOpen(true)}
            title={`${t("commandPaletteTitle")} (⌘/Ctrl+P)`}
          >
            <Command size={14} aria-hidden="true" />
            {t("commandPaletteBtn")}
          </Button>
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
          <SessionSidebar
            sessions={sessions}
            remote={remote}
            activeId={activeId}
            independentId={independent}
            deviceAliases={deviceAliases}
            desktop={desktop}
            busy={busy}
            saving={saving}
            onSelectSession={(sessionId) => {
              setIndependent(null);
              setActiveId(sessionId);
            }}
            onSelectIndependent={(runId) => {
              setIndependent(runId);
            }}
            onOpenFile={() => commands.dispatch("session.open")}
            onCloseSession={(sessionId) => void close(sessionId)}
            onCloseDeviceOfflineRuns={(deviceId, displayName) =>
              void closeDeviceOfflineRuns(deviceId, displayName)
            }
            onCloseDiagnostic={(runId) =>
              void api
                .closeDiagnostic(runId)
                .then(refresh)
                .catch((error) => reportError(String(error)))
            }
            onEditDeviceAlias={(deviceId, reportedName) =>
              setAliasTarget({ deviceId, reportedName })
            }
            onSessionContextMenu={(sessionId, event) => {
              setIndependent(null);
              setActiveId(sessionId);
              sessionContextMenu(event);
            }}
            onIndependentContextMenu={(runId, event) => {
              setIndependent(runId);
              sessionContextMenu(event);
            }}
          />
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
                    {active && (
                      <span
                        className="muted filename"
                        title={activeSessionLabel}
                      >
                        {activeSessionLabel}
                      </span>
                    )}
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
                            <option value="bizError">
                              {t("statusBizErrorOnly")}
                            </option>
                          </select>
                          <button
                            type="button"
                            className={`filter-pill-btn${view.minDurationMs ? " is-active" : ""}`}
                            aria-pressed={!!view.minDurationMs}
                            title={t("slowFilterHint")}
                            onClick={() =>
                              updateView({
                                minDurationMs: view.minDurationMs ? null : 1000,
                                selected: null,
                              })
                            }
                          >
                            {t("slowFilterToggle")}
                          </button>
                          <button
                            type="button"
                            className={`filter-pill-btn${activeRuleCount > 0 ? " is-active" : ""}`}
                            title={t("networkRulesTitle")}
                            onClick={() => setRulesOpen(true)}
                          >
                            <SlidersHorizontal size={11} aria-hidden="true" />
                            <span>{t("networkRulesBtn")}</span>
                            {activeRuleCount > 0 && (
                              <span className="filter-pill-badge">
                                {activeRuleCount}
                              </span>
                            )}
                          </button>
                          <button
                            type="button"
                            className="filter-pill-btn"
                            title={t("endpointStatsTitle")}
                            onClick={() => setStatsOpen(true)}
                          >
                            <BarChart3 size={11} aria-hidden="true" />
                            <span>{t("endpointStatsBtn")}</span>
                          </button>
                          {hasAdvancedNetworkFilter && (
                            <button
                              type="button"
                              className="filter-reset-btn"
                              onClick={() =>
                                updateView({
                                  methodFilter: null,
                                  statusFilter: null,
                                  minDurationMs: null,
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
                        effectiveExcludes.length > 0 ||
                        filterPresets.length > 0 ||
                        compareAnchor) && (
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
                          {filterPresets.slice(0, 4).map((preset) => (
                            <button
                              key={preset.id}
                              type="button"
                              className="host-chip is-preset"
                              onClick={() =>
                                updateView({
                                  filter: preset.filter,
                                  methodFilter: preset.methodFilter,
                                  statusFilter: preset.statusFilter,
                                  minDurationMs: preset.minDurationMs,
                                  search: preset.search,
                                  searchBody: preset.searchBody,
                                  hostFilter: preset.hostFilter,
                                  selected: null,
                                })
                              }
                            >
                              ★ {preset.name}
                            </button>
                          ))}
                          {effectiveExcludes.map((pattern) => (
                            <button
                              key={pattern}
                              type="button"
                              className="host-chip is-exclude"
                              title={t("hiddenPathChip")}
                              onClick={() => {
                                updateView({
                                  excludePatterns: view.excludePatterns.filter(
                                    (p) => p !== pattern,
                                  ),
                                });
                                if (
                                  noiseConfig.globalExcludes.includes(
                                    pattern,
                                  ) ||
                                  (active?.deviceId &&
                                    (
                                      noiseConfig.deviceExcludes[
                                        active.deviceId
                                      ] ?? []
                                    ).includes(pattern))
                                ) {
                                  const next: GlobalNoiseConfig = {
                                    ...noiseConfig,
                                    globalExcludes:
                                      noiseConfig.globalExcludes.filter(
                                        (p) => p !== pattern,
                                      ),
                                    deviceExcludes: {
                                      ...noiseConfig.deviceExcludes,
                                    },
                                  };
                                  if (active?.deviceId) {
                                    const filtered = (
                                      next.deviceExcludes[active.deviceId] ?? []
                                    ).filter((p) => p !== pattern);
                                    if (filtered.length > 0)
                                      next.deviceExcludes[active.deviceId] =
                                        filtered;
                                    else
                                      delete next.deviceExcludes[
                                        active.deviceId
                                      ];
                                  }
                                  setNoiseConfig(next);
                                  writeGlobalNoiseConfig(next);
                                }
                              }}
                            >
                              -{pattern} ×
                            </button>
                          ))}
                          {compareAnchor && (
                            <button
                              type="button"
                              className="host-chip is-compare"
                              onClick={() => setCompareAnchor(null)}
                            >
                              {t("compareBaselineReady")}:{" "}
                              {compareAnchor.entry.method}
                              {compareAnchor.sessionId !== active.id
                                ? ` (${compareAnchor.sessionLabel})`
                                : ""}{" "}
                              ×
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
                      excludePatterns={effectiveExcludes}
                      methodFilter={view.methodFilter}
                      statusFilter={view.statusFilter}
                      searchBody={view.searchBody}
                      minDurationMs={view.minDurationMs}
                      bizErrorRule={bizErrorRule}
                      sortBy={view.sortBy}
                      sortDir={view.sortDir}
                      afterSeq={effectiveAfterSeq}
                      clearMarkSeq={view.clearMarkSeq}
                      clearEvictedCount={evictedHiddenCount}
                      range={view.range}
                      selectedId={view.selected?.id}
                      compareAnchor={compareAnchor}
                      onSelect={(entry) => updateView({ selected: entry })}
                      onCount={setCount}
                      onMeta={(meta) =>
                        setNetworkMeta((prev) =>
                          prev &&
                          prev.sessionId === active.id &&
                          prev.latestSeq === meta.latestSeq &&
                          prev.hiddenCount === meta.hiddenCount &&
                          prev.totalBytes === meta.totalBytes &&
                          prev.maxBytes === meta.maxBytes &&
                          prev.spilledCount === meta.spilledCount &&
                          prev.spilledBytes === meta.spilledBytes
                            ? prev
                            : { ...meta, sessionId: active.id },
                        )
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
                        if (
                          !noiseConfig.globalExcludes.some(
                            (p) => p.toLowerCase() === pattern.toLowerCase(),
                          )
                        ) {
                          const next: GlobalNoiseConfig = {
                            ...noiseConfig,
                            enabled: true,
                            globalExcludes: [
                              ...noiseConfig.globalExcludes,
                              pattern,
                            ],
                          };
                          setNoiseConfig(next);
                          writeGlobalNoiseConfig(next);
                          setNotice({
                            text: t("noiseRuleAddedNotice", { pattern }),
                            error: false,
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
                        setCompareAnchor({
                          sessionId: active.id,
                          sessionLabel: activeSessionLabel,
                          entry,
                        })
                      }
                      onCompareWithAnchor={(entry) => {
                        if (compareAnchor) {
                          setDiffPair({
                            leftSessionId: compareAnchor.sessionId,
                            leftLabel: compareAnchor.sessionLabel,
                            left: compareAnchor.entry,
                            rightSessionId: active.id,
                            rightLabel: activeSessionLabel,
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
              deviceLabel={activeSessionLabel || independentRun?.runId}
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
              deviceLabel={activeSessionLabel}
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
      <Suspense fallback={null}>
        {replayTarget && (
          <LazyReplayDialog
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
          <LazyDeviceAliasDialog
            deviceId={aliasTarget.deviceId}
            reportedName={aliasTarget.reportedName}
            initialAlias={deviceAliases[aliasTarget.deviceId] ?? ""}
            onSave={(deviceId, alias) =>
              setDeviceAliases((prev) =>
                writeDeviceAlias(prev, deviceId, alias),
              )
            }
            onClose={() => setAliasTarget(null)}
          />
        )}
        {diffPair && (
          <LazyRequestDiffDialog
            leftSessionId={diffPair.leftSessionId}
            leftLabel={diffPair.leftLabel}
            left={diffPair.left}
            rightSessionId={diffPair.rightSessionId}
            rightLabel={diffPair.rightLabel}
            right={diffPair.right}
            onClose={() => setDiffPair(null)}
          />
        )}
        {pluginsOpen && (
          <LazyPluginManagerDialog
            snapshot={pluginSnapshot}
            initialPreview={pendingPluginPreview}
            onSnapshotChange={setPluginSnapshot}
            onClose={() => {
              setPluginsOpen(false);
              setPendingPluginPreview(null);
            }}
          />
        )}
        {statsOpen && active && (
          <LazyEndpointStatsDialog
            sessionId={active.id}
            sessionLabel={activeSessionLabel}
            range={view.range}
            afterSeq={effectiveAfterSeq}
            bizErrorRule={bizErrorRule}
            onFilterEndpoint={(pathKeyword, host) => {
              updateView({
                tab: "network",
                hostFilter: host || null,
                search: pathKeyword,
                selected: null,
              });
            }}
            onInspectSample={(entryId) => void openNetwork(active.id, entryId)}
            onClose={() => setStatsOpen(false)}
          />
        )}
        {rulesOpen && (
          <LazyNetworkRulesDialog
            bizErrorRule={bizErrorRule}
            noiseConfig={noiseConfig}
            currentDeviceId={active?.deviceId}
            currentDeviceLabel={activeDeviceLabel}
            presets={filterPresets}
            onSaveBizErrorRule={(rule) => {
              setBizErrorRule(rule);
              writeBizErrorRule(rule);
            }}
            onSaveNoiseConfig={(config) => {
              setNoiseConfig(config);
              writeGlobalNoiseConfig(config);
            }}
            onApplyPreset={(preset) => {
              updateView({
                filter: preset.filter,
                methodFilter: preset.methodFilter,
                statusFilter: preset.statusFilter,
                minDurationMs: preset.minDurationMs,
                search: preset.search,
                searchBody: preset.searchBody,
                hostFilter: preset.hostFilter,
                selected: null,
              });
            }}
            onSaveCurrentAsPreset={(name) => {
              const next: NetworkFilterPreset[] = [
                {
                  id: `preset-${Date.now()}`,
                  name,
                  filter: view.filter,
                  methodFilter: view.methodFilter,
                  statusFilter: view.statusFilter,
                  minDurationMs: view.minDurationMs,
                  search: view.search,
                  searchBody: view.searchBody,
                  hostFilter: view.hostFilter,
                },
                ...filterPresets,
              ].slice(0, 20);
              setFilterPresets(next);
              writeFilterPresets(next);
            }}
            onDeletePreset={(id) => {
              const next = filterPresets.filter((item) => item.id !== id);
              setFilterPresets(next);
              writeFilterPresets(next);
            }}
            onClose={() => setRulesOpen(false)}
          />
        )}
        {paletteOpen && (
          <LazyCommandPalette
            actions={paletteActions}
            onClose={() => setPaletteOpen(false)}
          />
        )}
      </Suspense>
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
