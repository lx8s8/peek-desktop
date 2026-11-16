import { mkdtempSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const temporary = mkdtempSync(join(tmpdir(), "peek-icons-"));
try {
  const result = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["exec", "tauri", "icon", "assets/peek-desktop.svg", "--output", temporary],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else
    for (const entry of readdirSync(temporary, { withFileTypes: true })) {
      if (entry.isFile() && /\.(png|icns|ico)$/.test(entry.name))
        copyFileSync(
          join(temporary, entry.name),
          join("src-tauri/icons", entry.name),
        );
    }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
