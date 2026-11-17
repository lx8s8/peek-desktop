import {
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { versions } from "./release-config.mjs";

const directory = "release-artifacts";
const mode = process.env.PACKAGE_MODE;
if (mode !== "unsigned") throw Error("发布模式无效");
const { version } = versions();
const expected = new Set(["macos-arm64", "macos-x64", "windows-x64"]);
const sums = [];
const files = readdirSync(directory).filter((name) =>
  /^manifest-.+\.json$/.test(name),
);
if (files.length !== expected.size) throw Error("安装包清单不齐全");
for (const name of files) {
  const manifest = JSON.parse(readFileSync(join(directory, name), "utf8"));
  if (
    !expected.delete(`${manifest.platform}-${manifest.architecture}`) ||
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
    const expectedName = `Peek-Desktop_${version}_${manifest.platform}-${manifest.architecture}-unsigned.${manifest.platform === "macos" ? "dmg" : "exe"}`;
    if (file.name !== expectedName) throw Error("安装包名称无效");
    const data = readFileSync(join(directory, file.name));
    const sha = createHash("sha256").update(data).digest("hex");
    if (data.length !== file.bytes || sha !== file.sha256)
      throw Error("安装包校验失败");
    sums.push(`${sha}  ${file.name}`);
  }
}
writeFileSync(join(directory, "SHA256SUMS.txt"), `${sums.sort().join("\n")}\n`);
const notes = readFileSync(`docs/releases/v${version}.md`, "utf8");
writeFileSync(
  join(directory, "RELEASE_NOTES.md"),
  `${notes.trim()}\n\n源码：${process.env.GITHUB_SHA}\n`,
);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
console.log("三个平台安装包的来源、版本和 SHA-256 校验通过");
