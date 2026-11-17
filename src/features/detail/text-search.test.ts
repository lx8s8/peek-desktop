import { expect, it } from "vitest";
import { MAX_MATCHES, searchText } from "./text-search";

it("finds literal keys and values without interpreting regex or changing numeric text", () => {
  const text = '{"id":900719925474099312345,"value":"[a].*","other":"[a].*"}';
  expect(searchText(text, "id", false).matches).toEqual([{ start: 2, end: 4 }]);
  for (const match of searchText(text, "[a].*", false).matches)
    expect(text.slice(match.start, match.end)).toBe("[a].*");
  expect(searchText(text, "[a].*", false).matches).toHaveLength(2);
  expect(searchText(text, "900719925474099312345", false).matches).toHaveLength(
    1,
  );
});
it("keeps Unicode offsets and supports case-sensitive, empty and missing queries", () => {
  const text = "İ😀中文 ID id";
  expect(searchText(text, "中文", false).matches).toEqual([
    { start: 3, end: 5 },
  ]);
  expect(searchText(text, "id", false).matches).toHaveLength(2);
  expect(searchText(text, "id", true).matches).toEqual([{ start: 9, end: 11 }]);
  expect(searchText(text, "", false).matches).toEqual([]);
  expect(searchText(text, "missing", false).matches).toEqual([]);
});
it("bounds highlights and reports whether more matches exist", () => {
  const full = searchText("x".repeat(MAX_MATCHES), "x", false);
  expect(full.matches).toHaveLength(MAX_MATCHES);
  expect(full.limited).toBe(false);
  const extra = searchText("x".repeat(MAX_MATCHES + 1), "x", false);
  expect(extra.matches).toHaveLength(MAX_MATCHES);
  expect(extra.limited).toBe(true);
});
