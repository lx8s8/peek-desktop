export interface ComponentNotice {
  name: string;
  license: string;
  authors: string;
  source: string;
  documents: string[];
}
function cells(line: string) {
  const parts: string[] = [];
  let value = "";
  for (let i = 1; i < line.length - 1; i++) {
    const char = line[i];
    if (char === "\\" && line[i + 1] === "|") {
      value += "|";
      i++;
    } else if (char === "|") {
      parts.push(value.trim());
      value = "";
    } else value += char;
  }
  parts.push(value.trim());
  return parts;
}
// Parse the format emitted by scripts/generate-notices.mjs; legal bodies remain
// literal text. Fence lengths are selected by the generator to avoid collisions.
export function parseNotices(text: string) {
  const components: ComponentNotice[] = [];
  const documents = new Map<string, string>();
  const start = text.indexOf("\n## license-");
  for (const line of text
    .slice(0, start < 0 ? text.length : start)
    .split("\n")) {
    if (!/^\| (node|rust):/.test(line)) continue;
    const row = cells(line);
    if (row.length !== 5) continue;
    components.push({
      name: row[0],
      license: row[1],
      authors: row[2],
      source: row[3].match(/\]\(([^)]+)\)/)?.[1] ?? row[3],
      documents: [...row[4].matchAll(/#(license-[a-f0-9]{16})/g)].map(
        (match) => match[1],
      ),
    });
  }
  const headers =
    /^## (license-[a-f0-9]{16})\n\n来源：[^\n]+\n\n(`{3,})text\n/gm;
  let header: RegExpExecArray | null;
  while ((header = headers.exec(text))) {
    const end = text.indexOf(`\n${header[2]}\n`, headers.lastIndex);
    if (end < 0) break;
    documents.set(header[1], text.slice(headers.lastIndex, end));
    headers.lastIndex = end + header[2].length + 2;
  }
  return { components, documents };
}
export function legalPages(text: string, size = 12_000) {
  const pages: string[] = [];
  size = Math.max(2, size);
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length);
    // Keep a UTF-16 surrogate pair on the same page.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    pages.push(text.slice(start, end));
    start = end;
  }
  return pages.length ? pages : [""];
}
