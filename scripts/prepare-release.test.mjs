import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
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
  mkdirSync(join(root, "docs/releases"), { recursive: true });
  writeFileSync(
    join(root, "docs/releases/v1.2.3.md"),
    "Synthetic release notes",
  );
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
    const name = `Peek-Desktop_1.2.3_${platform}-${architecture}-unsigned.${platform === "macos" ? "dmg" : "exe"}`;
    const data = Buffer.from(`synthetic ${platform}/${architecture}`);
    writeFileSync(join(root, "release-artifacts", name), data);
    const manifest = {
      version: "1.2.3",
      platform,
      architecture,
      revision: "test-revision",
      mode: "unsigned",
      dirty: false,
      profile: "release",
      signed: false,
      notarized: false,
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
        `manifest-${platform}-${architecture}-unsigned.json`,
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
      PACKAGE_MODE: "unsigned",
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
      join(
        root,
        "release-artifacts/Peek-Desktop_1.2.3_windows-x64-unsigned.exe",
      ),
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

test("missing platforms and mismatched source or signing state cannot be released", () => {
  for (const change of ["missing", "revision", "dirty", "signed", "filename"]) {
    const root = fixture();
    try {
      const path = join(
        root,
        "release-artifacts/manifest-windows-x64-unsigned.json",
      );
      if (change === "missing") unlinkSync(path);
      else {
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        if (change === "revision") manifest.revision = "other-source";
        if (change === "dirty") manifest.dirty = true;
        if (change === "signed") manifest.signed = true;
        if (change === "filename") manifest.files[0].name = "../outside.exe";
        writeFileSync(path, JSON.stringify(manifest));
      }
      assert.notEqual(run(root).status, 0, change);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
test("a tag that differs from the application version stops before publishing", () => {
  const root = fixture();
  try {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/check-release.mjs"), "v9.9.9"],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /发布标签必须为 v1.2.3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
