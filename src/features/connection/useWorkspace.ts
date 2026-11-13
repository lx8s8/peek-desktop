import { useCallback, useEffect, useRef, useState } from "react";
import { api, desktop, emptyRemote } from "../../lib/ipc/client";
import type { SessionSummary } from "../../lib/ipc/types";

export function useWorkspace(onError: (error: string) => void) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [remote, setRemote] = useState(emptyRemote);
  const revision = useRef(0);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const [sessions, snapshot] = await Promise.all([
        api.sessions(),
        api.remote(),
      ]);
      if (mounted.current && request === revision.current) {
        setSessions(sessions);
        setRemote(snapshot);
      }
    } catch (error) {
      if (mounted.current) onError(String(error));
    }
  }, [onError]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const stream = desktop ? api.watch(async () => refresh()) : null;
    void stream?.ready.catch((error) => onError(String(error)));
    // Low-frequency recovery if a WebView reload interrupts its channel subscription.
    const timer = desktop
      ? window.setInterval(() => void refresh(), 3000)
      : undefined;
    return () => {
      mounted.current = false;
      ++revision.current;
      clearInterval(timer);
      void stream?.stop().catch(() => {});
    };
  }, [refresh, onError]);
  return { sessions, setSessions, remote, refresh };
}
