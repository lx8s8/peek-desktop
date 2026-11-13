// Reproducible synthetic input; never contains real app traffic or credentials.
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const [destination, countText = "10000"] = process.argv.slice(2);
const count = Number(countText);
if (!destination || !Number.isInteger(count) || count < 1 || count > 100000) {
  throw new Error(
    "Usage: node scripts/generate-session.mjs <new-file.peek> [1..100000]",
  );
}
const started = Date.parse("2026-11-13T00:00:00.000Z");
function* lines() {
  yield (
    JSON.stringify({
      format: "peek",
      formatVersion: 1,
      peekVersion: "2.0.0",
      name: `P0 Synthetic ${count.toLocaleString("en")}`,
      platform: "unknown",
      startedAt: new Date(started).toISOString(),
    }) + "\n"
  );
  for (let index = 0; index < count; index++) {
    yield (
      JSON.stringify({
        id: `synthetic-${index}`,
        source: "synthetic",
        startedAt: new Date(started + index * 10).toISOString(),
        completedAt: new Date(started + index * 10 + 25).toISOString(),
        pinned: index % 100 === 0,
        request: {
          method: index % 3 === 0 ? "POST" : "GET",
          url: `https://synthetic.example.test/records/${index}`,
          headers: [["Accept", "application/json"]],
        },
        response: {
          status: index % 20 === 0 ? 500 : 200,
          body: {
            kind: "text",
            type: "application/json",
            text:
              index === 0
                ? '{"id":900719925474099312345,"amount":0.12345678901234567890,"message":"合成精度样例"}'
                : `{"index":${index},"message":"合成测试数据"}`,
          },
        },
      }) + "\n"
    );
  }
}
await pipeline(
  Readable.from(lines()),
  createWriteStream(destination, { flags: "wx" }),
);
console.log(`Generated ${count} synthetic records: ${destination}`);
