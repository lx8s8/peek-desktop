export function readPreference(key: string, fallback: string): string {
  try { return localStorage.getItem(`peek.${key}`) ?? fallback; } catch { return fallback; }
}
export function writePreference(key: string, value: string) {
  try { localStorage.setItem(`peek.${key}`, value); } catch { /* Read-only storage keeps defaults. */ }
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
