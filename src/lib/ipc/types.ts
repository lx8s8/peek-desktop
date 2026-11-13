export interface SessionSummary {
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
export interface BodyView {
  kind: string;
  mediaType: string | null;
  size: number | null;
  capturedBytes: number;
  truncated: boolean;
  previewTruncated: boolean;
  text: string;
  reason: string | null;
}
