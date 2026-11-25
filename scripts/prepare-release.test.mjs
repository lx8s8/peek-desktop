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
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import { UPDATER_ENDPOINT } from "./release-config.mjs";
import { verifyUpdaterSignature } from "./updater-signature.mjs";

function createSyntheticSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const rawKey = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const pubkey = Buffer.from(
    `untrusted comment: synthetic test key\n${Buffer.concat([Buffer.from("Ed"), keyId, rawKey]).toString("base64")}\n`,
  ).toString("base64");

  function signPayload(payload, filename, version) {
    const fileSig = sign(
      null,
      createHash("blake2b512").update(payload).digest(),
      privateKey,
    );
    const comment = `timestamp:0\tfile:${filename}\tversion:${version}`;
    const globalSig = sign(
      null,
      Buffer.concat([fileSig, Buffer.from(comment)]),
      privateKey,
    );
    return Buffer.from(
      `untrusted comment: synthetic fixture\n${Buffer.concat([Buffer.from("ED"), keyId, fileSig]).toString("base64")}\ntrusted comment: ${comment}\n${globalSig.toString("base64")}\n`,
    ).toString("base64");
  }

  return { pubkey, signPayload };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "peek-release-test-"));
  const signer = createSyntheticSigner();
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
      bundle: { publisher: "kasen", createUpdaterArtifacts: false },
      plugins: {
        updater: {
          requireSignedVersion: true,
          pubkey: signer.pubkey,
          endpoints: [UPDATER_ENDPOINT],
        },
      },
    }),
  );

  const specs = [
    ["macos", "arm64", "darwin-aarch64"],
    ["macos", "x64", "darwin-x86_64"],
    ["windows", "x64", "windows-x86_64"],
  ];
  for (const [platform, architecture, target] of specs) {
    const name = `Peek-Desktop_1.2.3_${platform}-${architecture}-unsigned.${platform === "macos" ? "dmg" : "exe"}`;
    const data = Buffer.from(`synthetic ${platform}/${architecture}`);
    writeFileSync(join(root, "release-artifacts", name), data);

    const updaterFile =
      platform === "macos"
        ? `Peek-Desktop_1.2.3_${platform}-${architecture}-unsigned.app.tar.gz`
        : name;
    const updaterData =
      platform === "macos"
        ? Buffer.from(`synthetic updater ${platform}/${architecture}`)
        : data;
    if (platform === "macos") {
      writeFileSync(join(root, "release-artifacts", updaterFile), updaterData);
    }
    const sigFile = `${updaterFile}.sig`;
    writeFileSync(
      join(root, "release-artifacts", sigFile),
      signer.signPayload(updaterData, updaterFile, "1.2.3"),
    );

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
      updater: {
        target,
        file: updaterFile,
        bytes: updaterData.length,
        sha256: createHash("sha256").update(updaterData).digest("hex"),
        signatureFile: sigFile,
      },
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

test("release aggregation requires all three platforms and writes verified latest.json and checksums", () => {
  const root = fixture();
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    const sumsPath = join(root, "release-artifacts/SHA256SUMS.txt");
    const latestPath = join(root, "release-artifacts/latest.json");
    assert.ok(existsSync(sumsPath));
    assert.ok(existsSync(latestPath));

    const latest = JSON.parse(readFileSync(latestPath, "utf8"));
    assert.equal(latest.version, "1.2.3");
    assert.equal(latest.notes, "Synthetic release notes");
    assert.deepEqual(Object.keys(latest.platforms).sort(), [
      "darwin-aarch64",
      "darwin-x86_64",
      "windows-x86_64",
      "windows-x86_64-nsis",
    ]);
    for (const entry of Object.values(latest.platforms)) {
      assert.match(
        entry.url,
        /^https:\/\/github\.com\/lx8s8\/peek-desktop\/releases\/download\/v1\.2\.3\//,
      );
      assert.match(
        Buffer.from(entry.signature, "base64").toString("utf8"),
        /trusted comment:.*version:1\.2\.3/,
      );
    }

    const lines = readFileSync(sumsPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 6);
    assert.ok(!lines.some((line) => line.endsWith(".sig")));
    for (const line of lines) {
      const [hash, filename] = line.split("  ");
      const actual = createHash("sha256")
        .update(readFileSync(join(root, "release-artifacts", filename)))
        .digest("hex");
      assert.equal(hash, actual);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tampered installers or updater signatures cannot reach a release draft", () => {
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

  const badSig = fixture();
  try {
    writeFileSync(
      join(
        badSig,
        "release-artifacts/Peek-Desktop_1.2.3_macos-arm64-unsigned.app.tar.gz.sig",
      ),
      Buffer.from("invalid").toString("base64"),
    );
    const result = run(badSig);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /更新签名/);
  } finally {
    rmSync(badSig, { recursive: true, force: true });
  }

  const wrongKey = fixture();
  try {
    const other = createSyntheticSigner();
    const confPath = join(wrongKey, "src-tauri/tauri.conf.json");
    const conf = JSON.parse(readFileSync(confPath, "utf8"));
    conf.plugins.updater.pubkey = other.pubkey;
    writeFileSync(confPath, JSON.stringify(conf));
    assert.notEqual(run(wrongKey).status, 0);
  } finally {
    rmSync(wrongKey, { recursive: true, force: true });
  }
});

test("missing platforms, missing updater metadata and mismatched source or signing state cannot be released", () => {
  for (const change of [
    "missing",
    "revision",
    "dirty",
    "signed",
    "filename",
    "noUpdater",
  ]) {
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
        if (change === "noUpdater") delete manifest.updater;
        writeFileSync(path, JSON.stringify(manifest));
      }
      assert.notEqual(run(root).status, 0, change);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("actual Tauri CLI signature verifies the payload and rejects tampered bytes or version", () => {
  const root = mkdtempSync(join(tmpdir(), "peek-tauri-signer-test-"));
  const tauriCli = resolve("node_modules/@tauri-apps/cli/tauri.js");
  try {
    const keyPath = join(root, "ephemeral.key");
    const password = "ephemeral-test-password";
    const generated = spawnSync(
      process.execPath,
      [tauriCli, "signer", "generate", "--ci", "-w", keyPath, "-p", password],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(generated.status, 0, generated.stderr);

    const payloadPath = join(root, "payload.bin");
    const payload = Buffer.from("peek-desktop synthetic updater payload");
    writeFileSync(payloadPath, payload);

    const signed = spawnSync(
      process.execPath,
      [
        tauriCli,
        "signer",
        "sign",
        "-f",
        keyPath,
        "-p",
        password,
        "--app-version",
        "2.3.4",
        payloadPath,
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(signed.status, 0, signed.stderr);

    const pubkey = readFileSync(`${keyPath}.pub`, "utf8").trim();
    const signature = readFileSync(`${payloadPath}.sig`, "utf8").trim();
    verifyUpdaterSignature(payload, signature, pubkey, "2.3.4");

    assert.throws(() =>
      verifyUpdaterSignature(
        Buffer.concat([payload, Buffer.from("!")]),
        signature,
        pubkey,
        "2.3.4",
      ),
    );
    assert.throws(() =>
      verifyUpdaterSignature(payload, signature, pubkey, "9.9.9"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
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
