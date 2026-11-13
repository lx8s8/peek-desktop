import { api, desktop } from "./ipc/client";
export function writeClipboard(text: string): Promise<void> {
  return desktop
    ? api.writeClipboard(text)
    : navigator.clipboard.writeText(text);
}
