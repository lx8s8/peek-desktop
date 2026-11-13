import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type {
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
  DiagnosticRef,
  TimeRange,
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
  review: (runId: string, query: ReviewQuery) =>
    invoke<ReviewPage>("review_diagnostics", { runId, query }),
  timeline: (scope: Scope, query: ReviewQuery) =>
    invoke<TimelinePage>("query_timeline", { scope, query }),
  copyDiagnostics: (
    selection: DiagnosticRef[],
    kind: "message" | "stack" | "raw",
  ) => invoke<string>("copy_diagnostics", { selection, kind }),
  exportDiagnostics: (selection: DiagnosticRef[]) =>
    invoke<boolean>("export_diagnostics", { selection }),
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
    return invoke<SessionSummary | null>("open_peek", { progress });
  },
  cancel: () => invoke<void>("cancel_import"),
  close: (sessionId: string) => invoke<void>("close_session", { sessionId }),
  save: (sessionId: string) => invoke<boolean>("save_peek", { sessionId }),
  query: (
    sessionId: string,
    search: string,
    filter: Filter,
    offset: number,
    revision: number,
    limit = 300,
    range: TimeRange = {},
  ) =>
    invoke<QueryPage>("query_entries", {
      sessionId,
      search,
      filter,
      offset,
      limit,
      revision,
      range,
    }),
  metadata: (sessionId: string, entryId: string) =>
    invoke<string>("get_entry_metadata", { sessionId, entryId }),
  body: (sessionId: string, entryId: string, side: "request" | "response") =>
    invoke<BodyView>("get_body", { sessionId, entryId, side }),
};
