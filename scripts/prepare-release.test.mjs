import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "peek-release-test-"));
  mkdirSync(join(root, "src-tauri"));
  mkdirSync(join(root, "release-artifacts"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ version: "1.2.3" }),
  );
  writeFileSync(join(root, "src-tauri/Cargo.toml"), 'version = "1.2.3"');
  writeFileSync(
    join(root, "src-tauri/tauri.conf.json"),
    JSON.stringify({
      version: "1.2.3",
      identifier: "local.peek.desktop",
      bundle: { publisher: "kasen" },
    }),
  );
  for (const [platform, architecture] of [
    ["macos", "arm64"],
    ["macos", "x64"],
    ["windows", "x64"],
  ]) {
    const name = `Peek-Desktop_1.2.3_${platform}-${architecture}-signed.${platform === "macos" ? "dmg" : "exe"}`;
    const data = Buffer.from(`synthetic ${platform}/${architecture}`);
    writeFileSync(join(root, "release-artifacts", name), data);
    const manifest = {
      version: "1.2.3",
      platform,
      architecture,
      revision: "test-revision",
      mode: "signed",
      dirty: false,
      profile: "release",
      signed: true,
      notarized: platform === "macos",
      files: [
        {
          name,
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        },
      ],
    };
    writeFileSync(
      join(
        root,
        "release-artifacts",
        `manifest-${platform}-${architecture}-signed.json`,
      ),
      JSON.stringify(manifest),
    );
  }
  return root;
}
function run(root) {
  return spawnSync(process.execPath, [resolve("scripts/prepare-release.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      PACKAGE_MODE: "signed",
      GITHUB_SHA: "test-revision",
      GITHUB_OUTPUT: join(root, "output"),
    },
    encoding: "utf8",
  });
}
test("release aggregation requires all three platforms and writes verified checksums", () => {
  const root = fixture();
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(root, "release-artifacts/SHA256SUMS.txt")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("tampered installers cannot reach a release draft", () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, "release-artifacts/Peek-Desktop_1.2.3_windows-x64-signed.exe"),
      "tampered",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /校验失败/);
    assert.equal(
      existsSync(join(root, "release-artifacts/SHA256SUMS.txt")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
