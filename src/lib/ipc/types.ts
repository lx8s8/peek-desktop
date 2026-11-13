export interface SessionSummary {
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
