import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { BodyView, Filter, ImportProgress, QueryPage, SessionSummary } from "./types";

export const desktop = isTauri();
export const api = {
  sessions: () => desktop ? invoke<SessionSummary[]>("list_sessions") : Promise.resolve([]),
  open: (onProgress: (progress: ImportProgress) => void) => {
    const progress = new Channel<ImportProgress>();
    progress.onmessage = onProgress;
    return invoke<SessionSummary | null>("open_peek", { progress });
  },
  cancel: () => invoke<void>("cancel_import"),
  close: (sessionId: string) => invoke<void>("close_session", { sessionId }),
  save: (sessionId: string) => invoke<boolean>("save_peek", { sessionId }),
  query: (sessionId: string, search: string, filter: Filter, offset: number, revision: number, limit = 300) =>
    invoke<QueryPage>("query_entries", { sessionId, search, filter, offset, limit, revision }),
  metadata: (sessionId: string, entryId: string) => invoke<string>("get_entry_metadata", { sessionId, entryId }),
  body: (sessionId: string, entryId: string, side: "request" | "response") => invoke<BodyView>("get_body", { sessionId, entryId, side }),
};
