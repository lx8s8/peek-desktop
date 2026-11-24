import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  UpdateInfo,
  AppInfo,
  ProjectLink,
  Imported,
  RecoveryStatus,
  BodyView,
  Filter,
  ImportProgress,
  QueryPage,
  SessionSummary,
  EntryRow,
  RemoteSnapshot,
  DiagnosticPage,
  ReviewQuery,
  ReviewPage,
  Scope,
  TimelinePage,
  StreamQuery,
  StreamPage,
  StreamMatches,
  SnippetFormat,
  ReplayBatchReport,
  ReplayBatchRequest,
  ReplayRequest,
  ReplayResponse,
  RequestSortField,
  RequestStatusFilter,
  SortDirection,
  DiagnosticRef,
  TimeRange,
  PluginListSnapshot,
  SymbolicatorPlugin,
  ParsedPluginPreview,
  ExportedPluginBundle,
  PluginTestResult,
  SymbolicateRequest,
  SymbolicateResponse,
} from "./types";

export const desktop = isTauri();
export const emptyRemote: RemoteSnapshot = {
  listening: false,
  host: "",
  port: 9741,
  addresses: [],
  mdns: "off",
  revision: 0,
  pairing: null,
  sessions: [],
  diagnosticRuns: [],
};
export const api = {
  checkUpdates: () => invoke<UpdateInfo>("check_updates"),
  openReleaseLink: (url: string) => invoke<void>("open_release_link", { url }),
  appInfo: () => invoke<AppInfo>("app_info"),
  legalText: (document: "license" | "notices") =>
    invoke<string>("legal_text", { document }),
  openProjectLink: (link: ProjectLink) =>
    invoke<void>("open_project_link", { link }),
  recoveryStatus: () => invoke<RecoveryStatus>("recovery_status"),
  setRecoveryEnabled: (enabled: boolean) =>
    invoke<RecoveryStatus>("set_recovery_enabled", { enabled }),
  saveRecovery: () => invoke<RecoveryStatus>("save_recovery"),
  restoreRecovery: () => invoke<Imported>("restore_recovery"),
  startNewRecovery: () => invoke<RecoveryStatus>("start_new_recovery"),
  exportScope: (scope: Scope, kind: "har" | "jsonl" | "text") =>
    invoke<boolean>("export_scope", { scope, kind }),
  copyCurl: (sessionId: string, entryId: string) =>
    invoke<string>("copy_curl", { sessionId, entryId }),
  copySnippet: (sessionId: string, entryId: string, format: SnippetFormat) =>
    invoke<string>("copy_snippet", { sessionId, entryId, format }),
  replay: (request: ReplayRequest) =>
    invoke<ReplayResponse>("replay_request", { request }),
  replayBatch: (request: ReplayBatchRequest) =>
    invoke<ReplayBatchReport>("replay_request_batch", { request }),
  togglePin: (sessionId: string, entryId: string) =>
    invoke<boolean>("toggle_entry_pin", { sessionId, entryId }),
  popupContextMenu: (rid: number, x: number, y: number) =>
    invoke<void>("popup_context_menu", { rid, x, y }),
  writeClipboard: (text: string) => invoke<void>("write_clipboard", { text }),
  review: (runId: string, query: ReviewQuery) =>
    invoke<ReviewPage>("review_diagnostics", { runId, query }),
  timeline: (scope: Scope, query: ReviewQuery) =>
    invoke<TimelinePage>("query_timeline", { scope, query }),
  stream: (scope: Scope, query: StreamQuery) =>
    invoke<StreamPage>("query_stream", { scope, query }),
  findStreamMatches: (scope: Scope, query: StreamQuery) =>
    invoke<StreamMatches>("find_stream_matches", { scope, query }),
  locateStreamEntry: (
    scope: Scope,
    query: StreamQuery,
    entryId: string,
    preferredKind?: string | null,
  ) =>
    invoke<number | null>("locate_stream_entry", {
      scope,
      query,
      entryId,
      preferredKind: preferredKind ?? null,
    }),
  copyStreamBlock: (scope: Scope, query: StreamQuery, blockId: string) =>
    invoke<string>("copy_stream_block", { scope, query, blockId }),
  exportStreamText: (scope: Scope, query: StreamQuery) =>
    invoke<boolean>("export_stream_text", { scope, query }),
  copyDiagnostics: (
    selection: DiagnosticRef[],
    kind: "message" | "stack" | "raw",
  ) => invoke<string>("copy_diagnostics", { selection, kind }),
  exportDiagnostics: (selection: DiagnosticRef[]) =>
    invoke<boolean>("export_diagnostics", { selection }),
  localAddresses: () => invoke<string[]>("local_addresses"),
  remote: () =>
    desktop
      ? invoke<RemoteSnapshot>("remote_snapshot")
      : Promise.resolve(emptyRemote),
  start: (host: string, port: number, advertise: boolean) =>
    invoke<RemoteSnapshot>("start_listener", { host, port, advertise }),
  stop: () => invoke<void>("stop_listener"),
  pair: (diagnostics: boolean) =>
    invoke<RemoteSnapshot>("issue_pairing_code", { diagnostics }),
  revoke: (deviceId: string, diagnostics?: boolean) =>
    invoke<void>("revoke_device", {
      deviceId,
      diagnostics: diagnostics ?? null,
    }),
  entryInfo: (sessionId: string, entryId: string) =>
    invoke<EntryRow>("get_entry_info", { sessionId, entryId }),
  diagnostics: (
    runId: string,
    search: string,
    level: string,
    exceptions: boolean,
    offset: number,
    revision: number,
  ) =>
    invoke<DiagnosticPage>("query_diagnostics", {
      runId,
      search,
      level,
      exceptions,
      offset,
      limit: 300,
      revision,
    }),
  diagnostic: (runId: string, eventId: string) =>
    invoke<string>("get_diagnostic", { runId, eventId }),
  closeDiagnostic: (runId: string) =>
    invoke<void>("close_diagnostic", { runId }),
  watch: (onUpdate: (revision: number) => Promise<void>) => {
    const id = crypto.randomUUID();
    const updates = new Channel<{ revision: number }>();
    updates.onmessage = ({ revision }) => {
      void onUpdate(revision)
        .finally(() =>
          invoke("acknowledge_remote", { subscriptionId: id, revision }),
        )
        .catch(() => {});
    };
    const ready = invoke<void>("subscribe_remote", {
      subscriptionId: id,
      updates,
    });
    return {
      ready,
      stop: async () => {
        await ready.catch(() => {});
        await invoke("unsubscribe_remote", { subscriptionId: id });
      },
    };
  },
  sessions: () =>
    desktop ? invoke<SessionSummary[]>("list_sessions") : Promise.resolve([]),
  open: (onProgress: (progress: ImportProgress) => void) => {
    const progress = new Channel<ImportProgress>();
    progress.onmessage = onProgress;
    return invoke<Imported | null>("open_peek", { progress });
  },
  openPath: (path: string, onProgress: (progress: ImportProgress) => void) => {
    const progress = new Channel<ImportProgress>();
    progress.onmessage = onProgress;
    return invoke<Imported | null>("open_file_path", { path, progress });
  },
  watchFiles: (onFiles: () => void) => listen("peek-open-files", onFiles),
  hasPendingFiles: () => invoke<boolean>("has_pending_files"),
  openPending: (onProgress: (progress: ImportProgress) => void) => {
    const progress = new Channel<ImportProgress>();
    progress.onmessage = onProgress;
    return invoke<Imported | null>("open_pending_file", { progress });
  },
  cancel: () => invoke<void>("cancel_import"),
  close: (sessionId: string) => invoke<void>("close_session", { sessionId }),
  archive: (scope: Scope) => invoke<boolean>("save_bundle", { scope }),
  save: (sessionId: string) => invoke<boolean>("save_peek", { sessionId }),
  query: (
    sessionId: string,
    search: string,
    filter: Filter,
    offset: number,
    revision: number,
    limit = 300,
    range: TimeRange = {},
    hostFilter?: string | null,
    excludePatterns?: string[],
    sortBy?: RequestSortField | null,
    sortDir?: SortDirection | null,
    afterSeq?: number | null,
    methodFilter?: string | null,
    statusFilter?: RequestStatusFilter | null,
    searchBody?: boolean,
  ) =>
    invoke<QueryPage>("query_entries", {
      sessionId,
      search,
      filter,
      offset,
      limit,
      revision,
      range,
      ...(hostFilter ? { hostFilter } : {}),
      ...(excludePatterns?.length ? { excludePatterns } : {}),
      ...(sortBy ? { sortBy, sortDir: sortDir ?? "desc" } : {}),
      ...(afterSeq != null ? { afterSeq } : {}),
      ...(methodFilter ? { methodFilter } : {}),
      ...(statusFilter ? { statusFilter } : {}),
      ...(searchBody ? { searchBody: true } : {}),
    }),
  metadata: (sessionId: string, entryId: string) =>
    invoke<string>("get_entry_metadata", { sessionId, entryId }),
  body: (sessionId: string, entryId: string, side: "request" | "response") =>
    invoke<BodyView>("get_body", { sessionId, entryId, side }),
  listPlugins: () =>
    desktop
      ? invoke<PluginListSnapshot>("list_plugins")
      : Promise.resolve({
          defaultPluginId: null,
          discoveryDir: null,
          plugins: [],
        }),
  upsertPlugin: (
    plugin: SymbolicatorPlugin,
    keepExistingSecret = true,
    setAsDefault = false,
  ) =>
    invoke<PluginListSnapshot>("upsert_plugin", {
      plugin,
      keepExistingSecret,
      setAsDefault,
    }),
  removePlugin: (pluginId: string) =>
    invoke<PluginListSnapshot>("remove_plugin", { pluginId }),
  setPluginEnabled: (pluginId: string, enabled: boolean) =>
    invoke<PluginListSnapshot>("set_plugin_enabled", { pluginId, enabled }),
  setDefaultPlugin: (pluginId: string) =>
    invoke<PluginListSnapshot>("set_default_plugin", { pluginId }),
  parsePluginInput: (rawText: string) =>
    invoke<ParsedPluginPreview>("parse_plugin_input", { rawText }),
  parsePluginFilePath: (path: string) =>
    invoke<ParsedPluginPreview>("parse_plugin_file_path", { path }),
  fetchPluginFromUrl: (url: string, token?: string | null) =>
    invoke<ParsedPluginPreview>("fetch_plugin_from_url", {
      url,
      token: token?.trim() || null,
    }),
  pickPluginFile: () => invoke<ParsedPluginPreview | null>("pick_plugin_file"),
  pickSymbolsDirectory: () => invoke<string | null>("pick_symbols_directory"),
  exportPluginConfig: (pluginId: string, includeSecrets = false) =>
    invoke<ExportedPluginBundle>("export_plugin_config", {
      pluginId,
      includeSecrets,
    }),
  savePluginFile: (pluginId: string, includeSecrets = false) =>
    invoke<boolean>("save_plugin_file", { pluginId, includeSecrets }),
  testPlugin: (pluginId: string) =>
    invoke<PluginTestResult>("test_symbolicator_plugin", { pluginId }),
  symbolicateStack: (request: SymbolicateRequest) =>
    invoke<SymbolicateResponse>("symbolicate_stack", { request }),
  clearSymbolicateCache: () => invoke<void>("clear_symbolicate_cache"),
};
