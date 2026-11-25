import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { UPDATER_ENDPOINT, signing, versions } from "./release-config.mjs";

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
    assert.equal(result.config.bundle.createUpdaterArtifacts, false);
    if (platform === "darwin")
      assert.equal(result.config.bundle.macOS.signingIdentity, "-");
    else {
      assert.equal(result.config.bundle.windows.certificateThumbprint, null);
      assert.equal(result.config.bundle.windows.signCommand, null);
    }
  }
});

test("updater signing mode preserves only updater credentials and enables updater artifacts", () => {
  for (const platform of ["darwin", "win32"]) {
    const result = signing(
      platform,
      "unsigned",
      {
        APPLE_SIGNING_IDENTITY: "unexpected",
        WINDOWS_CERTIFICATE: "synthetic",
        TAURI_SIGNING_PRIVATE_KEY: "synthetic-key",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "synthetic-password",
        PATH: "test",
      },
      { updater: true },
    );
    assert.deepEqual(result.env, {
      TAURI_SIGNING_PRIVATE_KEY: "synthetic-key",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "synthetic-password",
      PATH: "test",
    });
    assert.equal(result.config.bundle.createUpdaterArtifacts, true);
    assert.throws(
      () => signing(platform, "unsigned", { PATH: "test" }, { updater: true }),
      /TAURI_SIGNING_PRIVATE_KEY/,
    );
  }
});

test("certificate modes and unsupported platforms are rejected", () => {
  for (const mode of ["signed", "development", "preview", "unknown"])
    assert.throws(() => signing("darwin", mode, {}), /unsigned/);
  assert.throws(() => signing("linux", "unsigned", {}), /macOS/);
});

test("release preflight rejects version drift and invalid updater configuration", () => {
  const current = versions();
  assert.match(current.version, /^\d+\.\d+\.\d+$/);
  assert.ok(current.updaterPubkey);

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

    writeFileSync(join(root, "src-tauri/Cargo.toml"), 'version = "1.2.3"');
    writeFileSync(
      join(root, "src-tauri/tauri.conf.json"),
      JSON.stringify({
        version: "1.2.3",
        identifier: "local.peek.desktop",
        bundle: { publisher: "kasen" },
        plugins: {
          updater: {
            requireSignedVersion: false,
            pubkey: "synthetic",
            endpoints: [UPDATER_ENDPOINT],
          },
        },
      }),
    );
    assert.throws(() => versions(root), /updater 配置无效/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
