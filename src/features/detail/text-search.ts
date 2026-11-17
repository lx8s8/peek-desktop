export type TextMatch = { start: number; end: number };
export type TextSearchResult = { matches: TextMatch[]; limited: boolean };
export const MAX_MATCHES = 2000;

// A literal Unicode search keeps offsets in the original text, including characters
// whose lowercase form has a different length. Never interpret input as a regex.
export function searchText(
  text: string,
  query: string,
  caseSensitive: boolean,
): TextSearchResult {
  if (!query) return { matches: [], limited: false };
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    caseSensitive ? "gu" : "giu",
  );
  const matches: TextMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (matches.length === MAX_MATCHES) return { matches, limited: true };
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return { matches, limited: false };
}
