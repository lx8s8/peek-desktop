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
