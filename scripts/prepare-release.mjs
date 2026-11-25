import {
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { REPOSITORY_URL, versions } from "./release-config.mjs";
import { verifyUpdaterSignature } from "./updater-signature.mjs";

const directory = "release-artifacts";
const mode = process.env.PACKAGE_MODE;
if (mode !== "unsigned") throw Error("发布模式无效");
const { version, updaterPubkey } = versions();
if (!updaterPubkey)
  throw Error("正式发布需要在 src-tauri/tauri.conf.json 中配置更新公钥");
const expected = new Set(["macos-arm64", "macos-x64", "windows-x64"]);
const sums = [];
const recorded = new Set();
const platforms = {};
const files = readdirSync(directory).filter((name) =>
  /^manifest-.+\.json$/.test(name),
);
if (files.length !== expected.size) throw Error("安装包清单不齐全");

const updaterTargets = {
  "macos-arm64": "darwin-aarch64",
  "macos-x64": "darwin-x86_64",
  "windows-x64": "windows-x86_64",
};

for (const name of files) {
  const manifest = JSON.parse(readFileSync(join(directory, name), "utf8"));
  const key = `${manifest.platform}-${manifest.architecture}`;
  if (
    !expected.delete(key) ||
    manifest.version !== version ||
    manifest.mode !== mode ||
    manifest.profile !== "release" ||
    manifest.dirty ||
    manifest.revision !== process.env.GITHUB_SHA
  )
    throw Error("安装包的平台、版本、源码或构建模式不一致");
  if (manifest.signed !== false || manifest.notarized !== false)
    throw Error("安装包声明与无证书模式不符");
  if (manifest.files?.length !== 1) throw Error("安装包清单数量无效");
  for (const file of manifest.files) {
    const expectedName = `Peek-Desktop_${version}_${key}-unsigned.${manifest.platform === "macos" ? "dmg" : "exe"}`;
    if (file.name !== expectedName) throw Error("安装包名称无效");
    const data = readFileSync(join(directory, file.name));
    const sha = createHash("sha256").update(data).digest("hex");
    if (data.length !== file.bytes || sha !== file.sha256)
      throw Error("安装包校验失败");
    sums.push(`${sha}  ${file.name}`);
    recorded.add(file.name);
  }

  // 校验各平台的应用内更新包与 Minisign 签名，并汇总生成 latest.json。
  const updater = manifest.updater;
  const expectedTarget = updaterTargets[key];
  const expectedUpdaterFile =
    manifest.platform === "macos"
      ? `Peek-Desktop_${version}_${key}-unsigned.app.tar.gz`
      : `Peek-Desktop_${version}_${key}-unsigned.exe`;
  if (
    !updater ||
    updater.target !== expectedTarget ||
    updater.file !== expectedUpdaterFile ||
    updater.signatureFile !== `${expectedUpdaterFile}.sig`
  ) {
    throw Error(`缺少或无效的更新产物声明：${key}`);
  }
  const updaterData = readFileSync(join(directory, updater.file));
  const updaterSha = createHash("sha256").update(updaterData).digest("hex");
  if (updaterData.length !== updater.bytes || updaterSha !== updater.sha256) {
    throw Error(`更新包校验失败：${updater.file}`);
  }
  const signature = readFileSync(
    join(directory, updater.signatureFile),
    "utf8",
  ).trim();
  verifyUpdaterSignature(updaterData, signature, updaterPubkey, version);

  const entry = {
    signature,
    url: `${REPOSITORY_URL}/releases/download/v${version}/${updater.file}`,
  };
  platforms[expectedTarget] = entry;
  if (expectedTarget === "windows-x86_64") {
    platforms["windows-x86_64-nsis"] = entry;
  }
  if (!recorded.has(updater.file)) {
    sums.push(`${updaterSha}  ${updater.file}`);
    recorded.add(updater.file);
  }
}

const notes = readFileSync(`docs/releases/v${version}.md`, "utf8").trim();
const latestManifest = {
  version,
  notes,
  platforms: Object.fromEntries(
    Object.entries(platforms).sort(([a], [b]) => a.localeCompare(b, "en")),
  ),
};
const latestJson = `${JSON.stringify(latestManifest, null, 2)}\n`;
writeFileSync(join(directory, "latest.json"), latestJson);
const latestSha = createHash("sha256")
  .update(Buffer.from(latestJson, "utf8"))
  .digest("hex");
sums.push(`${latestSha}  latest.json`);

writeFileSync(join(directory, "SHA256SUMS.txt"), `${sums.sort().join("\n")}\n`);
writeFileSync(
  join(directory, "RELEASE_NOTES.md"),
  `${notes}\n\n源码：${process.env.GITHUB_SHA}\n`,
);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
console.log("三个平台安装包、签名更新归档、latest.json 与 SHA-256 校验通过");
