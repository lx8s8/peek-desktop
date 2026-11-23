import { useEffect, useRef, useState } from "react";
import { desktop } from "../../lib/ipc/client";

/**
 * 监听 Tauri 桌面窗口的原生文件拖放事件，支持将 .peek / .peekbundle / .jsonl 直接拖入打开。
 */
export function useFileDrop(onDrop: (paths: string[]) => void) {
  const [dragging, setDragging] = useState(false);
  const callbackRef = useRef(onDrop);
  callbackRef.current = onDrop;

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (disposed) return;
          if (event.payload.type === "over" || event.payload.type === "enter") {
            setDragging(true);
          } else if (event.payload.type === "leave") {
            setDragging(false);
          } else if (event.payload.type === "drop") {
            setDragging(false);
            if (event.payload.paths.length > 0) {
              callbackRef.current(event.payload.paths);
            }
          }
        }),
      )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        /* 测试环境或浏览器预览中跳过原生拖放监听 */
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return dragging;
}
