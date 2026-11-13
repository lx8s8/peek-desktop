import { useRef } from "react";
import { api, desktop } from "../../lib/ipc/client";
import { writeClipboard } from "../../lib/clipboard";
import { useCommand } from "../../lib/commands/react";
import type { DiagnosticRef } from "../../lib/ipc/types";
import { useTranslation } from "react-i18next";
export function useDiagnosticActions(
  selection: DiagnosticRef[],
  onNotice: (notice: string) => void,
  onError: (error: string) => void,
  enabled = true,
) {
  const { t } = useTranslation();
  const exporting = useRef(false);
  async function copy(kind: "message" | "stack" | "raw" = "message") {
    try {
      await writeClipboard(await api.copyDiagnostics(selection, kind));
      onNotice(t("copied"));
    } catch (error) {
      onError(String(error));
    }
  }
  async function save() {
    if (exporting.current) return;
    exporting.current = true;
    try {
      if (await api.exportDiagnostics(selection)) onNotice(t("exportSaved"));
    } catch (error) {
      onError(String(error));
    } finally {
      exporting.current = false;
    }
  }
  const canCopy = enabled && selection.length > 0;
  useCommand("edit.copyMessage", () => copy(), canCopy);
  useCommand("edit.copyStack", () => copy("stack"), canCopy);
  useCommand("edit.copyRaw", () => copy("raw"), canCopy);
  useCommand("diagnostics.export", save, desktop && canCopy);
  return { copy, save };
}
