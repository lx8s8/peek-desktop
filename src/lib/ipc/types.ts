export interface Imported {
  sessionId: string | null;
  runId: string | null;
}
export interface RecoveryStatus {
  enabled: boolean;
  available: boolean;
  pending: boolean;
  restored: boolean;
  usedBackup: boolean;
  updatedAt: number | null;
  bytes: number;
  error: string | null;
}
export interface SessionSummary {
  archive?: {
    recovered: boolean;
    dropped: number;
    evicted: number;
    syncing: boolean;
  } | null;
  deviceId?: string;
  networkSessionId?: string;
  online?: boolean;
  syncing?: boolean;
  generation?: number;
  version?: number;
  dropped?: number;
  evicted?: number;
  diagnosticCount?: number;
  diagnosticsOnline?: boolean;
  id: string;
  filename: string;
  header: {
    formatVersion: number;
    peekVersion: string;
    name: string | null;
    platform: string;
    startedAt: string;
  };
  entryCount: number;
  skipped: number;
  newerFormat: boolean;
  rawBytes: number;
}

export interface EntryRow {
  contentRevision?: string;
  id: string;
  source: string;
  method: string;
  url: string;
  startedAt: string;
  durationMs: number | null;
  status: number | null;
  state: "pending" | "completed" | "failed";
  pinned: boolean;
  responseBytes: number | null;
}

export interface DiagnosticRun {
  id: string;
  deviceId: string;
  runId: string;
  networkSessionKey: string | null;
  online: boolean;
  count: number;
  received: number;
  duplicates: number;
  evicted: number;
  gapCount: number;
  version: number;
  gaps: {
    emitterId: string;
    fromSequence: string;
    toSequence: string;
    reason: string;
  }[];
}
export interface DiagnosticRow {
  fingerprint?: string | null;
  exceptionType?: string | null;
  relatedNetworkEntryId?: string | null;
  eventId: string;
  sequence: string;
  occurredAt: string;
  kind: string;
  level: string;
  source: string;
  tag: string | null;
  message: string;
  emitterId: string;
  truncated: boolean;
}

export interface TimeRange {
  from?: string | null;
  to?: string | null;
}
export interface ReviewQuery {
  search: string;
  level?: string;
  source?: string;
  tag?: string;
  emitter?: string;
  exceptions?: boolean;
  grouped?: boolean;
  fingerprint?: string | null;
  range: TimeRange;
  offset: number;
  limit: number;
  revision: number;
}
export interface ExceptionGroup {
  fingerprint: string;
  exceptionType: string;
  message: string;
  count: number;
  firstAt: string;
  lastAt: string;
  latestEventId: string;
}
export interface ReviewPage extends DiagnosticPage {
  groups: ExceptionGroup[];
  facets: {
    sources: string[];
    tags: string[];
    emitters: string[];
    limited: boolean;
  };
}
export type Scope = { kind: "network" | "diagnostic"; id: string };
export interface TimelineRow {
  id: string;
  kind: "network" | "log" | "exception";
  occurredAt: string;
  level: string;
  source: string;
  message: string;
  sessionId: string | null;
  entryId: string | null;
  runId: string | null;
  eventId: string | null;
  association: "time" | "explicit" | "unavailable";
  relatedNetworkEntryId: string | null;
}
export interface TimelinePage {
  total: number;
  offset: number;
  revision: number;
  rows: TimelineRow[];
}
export type StreamKindFilter = "all" | "network" | "logs" | "errors";
export type StreamSearchMode = "filter" | "locate";
export type StreamLineRole =
  "top" | "header" | "meta" | "body" | "error" | "remote" | "bottom";
export interface RemoteBodyHint {
  sessionId: string;
  entryId: string;
  side: "request" | "response";
  size: number | null;
  mediaType: string | null;
}
export interface StreamLine {
  lineIndex: number;
  blockId: string;
  blockStartLine: number;
  blockLineCount: number;
  kind: string;
  level: string;
  role: StreamLineRole;
  text: string;
  occurredAt: string;
  sessionId: string | null;
  entryId: string | null;
  runId: string | null;
  eventId: string | null;
  remoteBody: RemoteBodyHint | null;
  collapsed?: boolean;
  hiddenLines?: number;
  pairLine?: number | null;
  pairLabel?: string | null;
}
export interface StreamQuery {
  search: string;
  searchMode?: StreamSearchMode;
  kindFilter: StreamKindFilter;
  range: TimeRange;
  minTimestampMicros?: number | null;
  collapsedBlocks?: string[];
  compactAll?: boolean;
  lineOffset: number;
  lineLimit: number;
  tzOffsetEastSeconds: number;
  revision: number;
}
export interface StreamPage {
  totalLines: number;
  totalBlocks: number;
  lineOffset: number;
  revision: number;
  latestTimestampMicros?: number | null;
  lines: StreamLine[];
}
export interface StreamMatches {
  lineIndices: number[];
  limited: boolean;
}
export type SnippetFormat = "curl" | "dio" | "fetch";
export interface ReplayRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
}
export interface ReplayResponse {
  status: number;
  statusText: string;
  durationMs: number;
  headers: [string, string][];
  mediaType: string | null;
  body: string;
  bytes: number;
  truncated: boolean;
}
export interface DiagnosticRef {
  runId: string;
  eventId: string;
}
export interface DiagnosticPage {
  total: number;
  offset: number;
  rows: DiagnosticRow[];
  revision: number;
}
export interface RemoteSnapshot {
  listening: boolean;
  host: string;
  port: number;
  addresses: string[];
  mdns: string;
  revision: number;
  pairing: {
    serverId: string;
    code: string | null;
    expiresInSeconds: number;
    devices: { id: string; name: string; diagnostics: boolean }[];
  } | null;
  sessions: SessionSummary[];
  diagnosticRuns: DiagnosticRun[];
}

export type Filter = "all" | "errors" | "pending" | "pinned";
export interface QueryPage {
  total: number;
  offset: number;
  rows: EntryRow[];
  revision: number;
  hosts?: string[];
}
export interface ImportProgress {
  bytesRead: number;
  totalBytes: number;
}
export interface ImagePreview {
  dataUrl: string;
  mediaType: string;
  width: number;
  height: number;
}
export interface BodyView {
  kind: string;
  mediaType: string | null;
  size: number | null;
  capturedBytes: number;
  truncated: boolean;
  previewTruncated: boolean;
  text: string;
  reason: string | null;
  image?: ImagePreview;
  imageUnavailable?: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  architecture: string;
}
export type ProjectLink =
  "project" | "issues" | "releases" | "sdk" | "upstream";

export interface UpdateInfo {
  status: "available" | "current" | "ahead" | "notPublished";
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  downloadUrl: string | null;
  notes: string;
}

export type PluginKind = "local" | "http" | "cli";

export interface LocalPluginConfig {
  symbolsDir: string;
  flutterBin?: string | null;
}

export interface HttpPluginConfig {
  endpoint: string;
  healthEndpoint?: string | null;
  authHeader?: string | null;
  token?: string | null;
  headers: Record<string, string>;
}

export interface HttpPluginView {
  endpoint: string;
  healthEndpoint?: string | null;
  authHeader?: string | null;
  hasToken: boolean;
  maskedToken?: string | null;
  headers: Record<string, string>;
}

export interface CliPluginConfig {
  command: string;
  args: string[];
  workingDir?: string | null;
  env: Record<string, string>;
}

export interface SymbolicatorPlugin {
  schemaVersion: number;
  id: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  kind: PluginKind;
  timeoutMs: number;
  local?: LocalPluginConfig | null;
  http?: HttpPluginConfig | null;
  cli?: CliPluginConfig | null;
}

export interface PluginView {
  schemaVersion: number;
  id: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  kind: PluginKind;
  timeoutMs: number;
  source: "managed" | "discovered" | string;
  isDefault: boolean;
  hasSecret: boolean;
  maskedToken?: string | null;
  local?: LocalPluginConfig | null;
  http?: HttpPluginView | null;
  cli?: CliPluginConfig | null;
}

export interface PluginListSnapshot {
  defaultPluginId: string | null;
  discoveryDir: string | null;
  plugins: PluginView[];
}

export interface ServiceBuildSummary {
  jobId?: string | null;
  appVersion?: string | null;
  flavor?: string | null;
  brand?: string | null;
  target?: string | null;
  finishedAt?: string | null;
}

export interface ServiceDiscoveryInfo {
  availableBuilds?: number | null;
  symbolCount?: number | null;
  recentBuilds: ServiceBuildSummary[];
  message?: string | null;
}

export interface ParsedPluginPreview {
  plugin: SymbolicatorPlugin;
  hasSecret: boolean;
  maskedToken?: string | null;
  requiresTrustWarning: boolean;
  serviceInfo?: ServiceDiscoveryInfo | null;
}

export interface ExportedPluginBundle {
  json: string;
  link: string;
}

export interface AotStackInfo {
  isAot: boolean;
  buildId: string | null;
  os: string | null;
  arch: string | null;
}

export interface MatchedBuildInfo {
  jobId?: string | null;
  appVersion?: string | null;
  flavor?: string | null;
  brand?: string | null;
  target?: string | null;
  sourceSha?: string | null;
  sourceBranch?: string | null;
  matchedBy?: string | null;
  symbolFile?: string | null;
}

export interface SymbolicateRequest {
  pluginId?: string | null;
  stackTrace: string;
  stackFormat?: string | null;
  buildId?: string | null;
  platform?: string | null;
  arch?: string | null;
  appVersion?: string | null;
  buildNumber?: string | null;
  flavor?: string | null;
  brand?: string | null;
  jobId?: string | null;
  attributes?: Record<string, unknown> | null;
  forceRefresh?: boolean;
}

export interface SymbolicateResponse {
  ok: boolean;
  symbolizedStack: string | null;
  providerId: string;
  providerName: string;
  cached: boolean;
  durationMs: number;
  detected: AotStackInfo;
  matchedBuild: MatchedBuildInfo | null;
  warnings: string[];
  error: string | null;
}

export interface PluginTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  availableBuilds: number | null;
  details: string | null;
  recentBuilds?: ServiceBuildSummary[];
}
