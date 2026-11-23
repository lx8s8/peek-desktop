import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { inspectSmartValue } from "./smartDecode";
import JsonTree from "./JsonTree";

vi.mock("../../lib/clipboard", () => ({
  writeClipboard: vi.fn().mockResolvedValue(undefined),
}));

it("decodes JWT, Unix timestamps, URL-encoded strings, and Base64 JSON", () => {
  // 构造合法 JWT（header + payload）
  const hdr = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(
    /=+$/,
    "",
  );
  const pay = btoa(JSON.stringify({ sub: "u_1001", exp: 1893456000 })).replace(
    /=+$/,
    "",
  );
  const jwt = inspectSmartValue(`Bearer ${hdr}.${pay}.signature123`);
  expect(jwt?.kind).toBe("jwt");
  expect(jwt?.detail).toContain("u_1001");

  // 13 位毫秒时间戳
  const ts = inspectSmartValue("1795398011000");
  expect(ts?.kind).toBe("timestamp");
  expect(ts?.detail).toContain("UTC");

  // URL 编码
  const url = inspectSmartValue("%E4%B8%AD%E6%96%87%20test");
  expect(url?.kind).toBe("url");
  expect(url?.detail).toBe("中文 test");

  // Base64 JSON
  const b64 = inspectSmartValue(btoa('{"device":"ios","score":99}'));
  expect(b64?.kind).toBe("base64");
  expect(b64?.isJson).toBe(true);
  expect(b64?.detail).toContain('"score": 99');
});

it("renders custom lossless JSON tree with collapsing and smart decode without vanilla-jsoneditor", () => {
  const sample = JSON.stringify({
    bigId: 123,
    ts: "1795398011000",
    nested: { a: 1, b: 2 },
  }).replace("123", "900719925474099312345");

  render(<JsonTree text={sample} theme="light" />);
  // 保留无损长整数
  expect(screen.getByText("900719925474099312345")).toBeTruthy();
  // 自动出现时间戳解码徽章，点击展开解码卡
  fireEvent.click(screen.getByText("时间戳(ms)"));
  expect(screen.getByText(/UTC 时间/)).toBeTruthy();
  // 支持全部收起并展示键计数摘要
  fireEvent.click(screen.getByRole("button", { name: "全部收起" }));
  expect(screen.getByText(/3 keys/)).toBeTruthy();
});
