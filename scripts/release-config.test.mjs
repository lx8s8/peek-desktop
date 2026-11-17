import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { signing, versions } from "./release-config.mjs";
test("unsigned packaging never inherits certificate credentials on either platform", () => {
  for (const platform of ["darwin", "win32"]) {
    const result = signing(platform, "unsigned", {
      APPLE_SIGNING_IDENTITY: "unexpected",
      APPLE_PASSWORD: "synthetic",
      WINDOWS_CERTIFICATE: "synthetic",
      WINDOWS_CERTIFICATE_THUMBPRINT: "synthetic",
      TAURI_SIGNING_PRIVATE_KEY: "synthetic",
      PATH: "test",
    });
    assert.deepEqual(result.env, { PATH: "test" });
    if (platform === "darwin")
      assert.equal(result.config.bundle.macOS.signingIdentity, "-");
    else {
      assert.equal(result.config.bundle.windows.certificateThumbprint, null);
      assert.equal(result.config.bundle.windows.signCommand, null);
    }
  }
});
test("certificate modes and unsupported platforms are rejected", () => {
  for (const mode of ["signed", "development", "preview", "unknown"])
    assert.throws(() => signing("darwin", mode, {}), /unsigned/);
  assert.throws(() => signing("linux", "unsigned", {}), /macOS/);
});
test("release preflight rejects version drift", () => {
  assert.match(versions().version, /^\d+\.\d+\.\d+$/);
  const root = mkdtempSync(join(tmpdir(), "peek-version-test-"));
  try {
    mkdirSync(join(root, "src-tauri"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
    );
    writeFileSync(join(root, "src-tauri/Cargo.toml"), 'version = "1.2.4"');
    writeFileSync(
      join(root, "src-tauri/tauri.conf.json"),
      JSON.stringify({ version: "1.2.3" }),
    );
    assert.throws(() => versions(root), /相同/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
