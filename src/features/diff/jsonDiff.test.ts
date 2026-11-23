import { expect, it } from "vitest";
import { diffBodies, diffKeyValuePairs } from "./jsonDiff";

it("computes lossless field-level JSON diffs across nested objects and arrays", () => {
  const left =
    '{"vCode":60384,"id":900719925474099312345,"onlyLeft":true,"arr":[1,2]}';
  const right =
    '{"vCode":60385,"id":900719925474099312345,"onlyRight":"ok","arr":[1,3,4]}';
  const { mode, rows } = diffBodies(left, right);
  expect(mode).toBe("json");
  expect(rows.find((r) => r.path === "$.vCode")).toEqual({
    path: "$.vCode",
    status: "changed",
    left: "60384",
    right: "60385",
  });
  expect(rows.find((r) => r.path === "$.id")?.status).toBe("equal");
  expect(rows.find((r) => r.path === "$.onlyLeft")?.status).toBe("removed");
  expect(rows.find((r) => r.path === "$.onlyRight")?.status).toBe("added");
  expect(rows.find((r) => r.path === "$.arr[1]")?.status).toBe("changed");
  expect(rows.find((r) => r.path === "$.arr[2]")?.status).toBe("added");
});

it("diffs HTTP headers case-insensitively", () => {
  const rows = diffKeyValuePairs(
    [
      ["Content-Type", "application/json"],
      ["X-Old", "1"],
    ],
    [
      ["content-type", "application/json"],
      ["X-New", "2"],
    ],
    true,
  );
  expect(rows.find((r) => r.path === "Content-Type")?.status).toBe("equal");
  expect(rows.find((r) => r.path === "X-Old")?.status).toBe("removed");
  expect(rows.find((r) => r.path === "X-New")?.status).toBe("added");
});
