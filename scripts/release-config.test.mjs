import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { signing, versions } from "./release-config.mjs";
test("preview never inherits an Apple signing identity or notarization credentials", () => {
  const result = signing("darwin", "preview", {
    APPLE_SIGNING_IDENTITY: "unexpected",
    APPLE_PASSWORD: "synthetic",
    PATH: "test",
  });
  assert.equal(result.config.bundle.macOS.signingIdentity, "-");
  assert.equal(result.env.APPLE_PASSWORD, undefined);
  assert.equal(result.env.APPLE_SIGNING_IDENTITY, undefined);
  assert.equal(result.env.PATH, "test");
});
test("distribution refuses development certificates and incomplete notarization", () => {
  assert.throws(
    () =>
      signing("darwin", "signed", {
        APPLE_SIGNING_IDENTITY: "Apple Development: synthetic",
      }),
    /Developer ID/,
  );
  assert.throws(
    () =>
      signing("darwin", "signed", {
        APPLE_SIGNING_IDENTITY: "Developer ID Application: synthetic",
      }),
    /公证/,
  );
  assert.throws(() => signing("win32", "signed", {}), /证书指纹/);
  assert.throws(() => signing("darwin", "unknown", {}), /模式/);
});
test("development signing is explicit and cannot inherit notarization", () => {
  const result = signing("darwin", "development", {
    APPLE_SIGNING_IDENTITY: "Apple Development: synthetic",
    APPLE_ID: "synthetic",
  });
  assert.equal(result.env.APPLE_ID, undefined);
  assert.equal(result.config.bundle.macOS.hardenedRuntime, true);
  assert.throws(() => signing("win32", "development", {}), /macOS/);
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
