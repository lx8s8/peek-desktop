import { describe, expect, it } from "vitest";
import { analyzeJson, losslessParser } from "./json";

describe("lossless JSON views", () => {
  it("keeps integers, decimal digits and numeric syntax in formatting and tree parsing", () => {
    const original = '{"id":900719925474099312345,"amount":0.12345678901234567890,"exponent":1.20e+50}';
    const result = analyzeJson(original);
    expect(result.error).toBe(""); expect(result.treeSafe).toBe(true);
    expect(result.formatted).toContain("900719925474099312345");
    expect(result.formatted).toContain("0.12345678901234567890");
    expect(result.formatted).toContain("1.20e+50");
    expect(losslessParser.stringify(losslessParser.parse(original))).toBe(original);
  });
  it("refuses duplicate keys and invalid JSON instead of silently repairing them", () => {
    for (const text of ['{"a":1,"a":2}', '{"a":', '{"a":NaN}']) {
      const result = analyzeJson(text);
      expect(result.error).not.toBe(""); expect(result.treeSafe).toBe(false);
    }
  });
  it("does not enable the tree for large, deep or wide JSON", () => {
    expect(analyzeJson(JSON.stringify(Array.from({ length: 21000 }, () => 1))).treeSafe).toBe(false);
    expect(analyzeJson('['.repeat(60) + '1' + ']'.repeat(60)).treeSafe).toBe(false);
    expect(analyzeJson(JSON.stringify("x".repeat(1024 * 1024))).treeSafe).toBe(false);
  });
});
