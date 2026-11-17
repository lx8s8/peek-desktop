import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JsonViewer } from "./JsonViewer";
import { analyzeJson } from "./json";
import { searchText } from "./text-search";
import { writeClipboard } from "../../lib/clipboard";

vi.mock("../../lib/clipboard", () => ({
  writeClipboard: vi.fn().mockResolvedValue(undefined),
}));
class TestWorker {
  static all: TestWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  input: unknown;
  terminated = false;
  constructor(public url: URL) {
    TestWorker.all.push(this);
  }
  postMessage(input: unknown) {
    this.input = input;
    if (typeof input === "string")
      queueMicrotask(() => this.respond(analyzeJson(input)));
    else {
      const { text, query, caseSensitive } = input as {
        text: string;
        query: string;
        caseSensitive: boolean;
      };
      queueMicrotask(() =>
        this.respond(searchText(text, query, caseSensitive)),
      );
    }
  }
  respond(data: unknown) {
    this.onmessage?.({ data });
  }
  terminate() {
    this.terminated = true;
  }
}
beforeEach(() => {
  TestWorker.all = [];
  vi.clearAllMocks();
  vi.stubGlobal("Worker", TestWorker);
});
afterEach(() => vi.unstubAllGlobals());

it("defaults to lossless formatted JSON and searches keys and values with wrapping navigation", async () => {
  const text = '{"id":900719925474099312345,"value":"hello","other":"HELLO"}';
  const { container } = render(<JsonViewer text={text} theme="light" />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "格式化" }).className).toBe(
      "active",
    ),
  );
  expect(container.querySelector("pre")?.textContent).toContain(
    "900719925474099312345",
  );
  const input = screen.getByRole("searchbox", { name: "搜索正文" });
  fireEvent.change(input, { target: { value: "hello" } });
  await screen.findByText("1/2");
  expect(container.querySelectorAll("mark")).toHaveLength(2);
  expect(container.querySelector("mark.current-match")?.textContent).toBe(
    "hello",
  );
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByText("2/2")).toBeTruthy();
  expect(container.querySelector("mark.current-match")?.textContent).toBe(
    "HELLO",
  );
  fireEvent.click(screen.getByRole("button", { name: "下一处匹配" }));
  expect(screen.getByText("1/2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "区分大小写" }));
  await screen.findByText("1/1");
  fireEvent.click(screen.getByRole("button", { name: "复制原文" }));
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(text));
  fireEvent.keyDown(input, { key: "Escape" });
  expect((input as HTMLInputElement).value).toBe("");
  expect(container.querySelectorAll("mark")).toHaveLength(0);
});
it("ignores a terminated search when the selected body changes", async () => {
  const { rerender, container } = render(
    <JsonViewer text="old old" json={false} theme="light" />,
  );
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "old" } });
  await screen.findByText("1/2");
  const worker = TestWorker.all[TestWorker.all.length - 1]!;
  rerender(<JsonViewer text="new body" json={false} theme="light" />);
  await act(async () =>
    worker.respond({ matches: [{ start: 0, end: 3 }], limited: false }),
  );
  expect(worker.terminated).toBe(true);
  expect(container.querySelector("pre")?.textContent).toBe("new body");
  expect(container.querySelector("mark")).toBeNull();
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
});
it("retains invalid JSON verbatim and renders captured markup as text", async () => {
  const text = '{"a":1,"a":2,"html":"<img src=x onerror=alert(1)>"}';
  const { container } = render(<JsonViewer text={text} theme="light" />);
  await screen.findByText(/无法解析为 JSON/);
  expect(container.querySelector("pre")?.textContent).toBe(text);
  expect(container.querySelector("img")).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "a" } });
  await waitFor(() =>
    expect(container.querySelectorAll("mark").length).toBeGreaterThan(0),
  );
  expect(container.querySelector("pre")?.textContent).toBe(text);
});
