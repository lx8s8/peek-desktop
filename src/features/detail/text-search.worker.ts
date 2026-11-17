import { searchText } from "./text-search";
self.onmessage = (
  event: MessageEvent<{ text: string; query: string; caseSensitive: boolean }>,
) => {
  const { text, query, caseSensitive } = event.data;
  self.postMessage(searchText(text, query, caseSensitive));
};
