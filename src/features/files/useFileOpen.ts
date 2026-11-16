import { useEffect, useRef, useState } from "react";
import { api, desktop } from "../../lib/ipc/client";

// Subscribe before checking pending intents: Finder may open a file before React mounts.
export function useFileOpen(
  blocked: boolean,
  openPending: () => Promise<boolean>,
  reportError: (error: string) => void,
) {
  const [revision, setRevision] = useState(0);
  const handled = useRef(0);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void api
      .watchFiles(() => setRevision((value) => value + 1))
      .then((unlisten) => {
        if (disposed) unlisten();
        else {
          stop = unlisten;
          setRevision((value) => value + 1);
        }
      })
      .catch((error) => {
        if (!disposed) reportError(String(error));
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [reportError]);
  useEffect(() => {
    if (blocked || revision === 0 || handled.current === revision) return;
    const current = revision;
    handled.current = current;
    void openPending()
      .then((started) => {
        if (!started) handled.current = Math.min(handled.current, current - 1);
      })
      .catch((error) => reportError(String(error)));
  }, [blocked, revision, openPending, reportError]);
}
