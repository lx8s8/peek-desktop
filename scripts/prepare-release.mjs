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
if (!["preview", "signed"].includes(mode)) throw Error("发布模式无效");
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
  if (
    mode === "signed" &&
    (!manifest.signed || (manifest.platform === "macos" && !manifest.notarized))
  )
    throw Error("正式安装包缺少签名或公证");
  if (manifest.files?.length !== 1) throw Error("安装包清单数量无效");
  for (const file of manifest.files) {
    if (!/^Peek-Desktop_[\w.\-]+\.(dmg|exe)$/.test(file.name))
      throw Error("安装包名称无效");
    const data = readFileSync(join(directory, file.name));
    const sha = createHash("sha256").update(data).digest("hex");
    if (data.length !== file.bytes || sha !== file.sha256)
      throw Error("安装包校验失败");
    sums.push(`${sha}  ${file.name}`);
  }
}
writeFileSync(join(directory, "SHA256SUMS.txt"), `${sums.sort().join("\n")}\n`);
writeFileSync(
  join(directory, "RELEASE_NOTES.md"),
  `Peek Desktop ${version}\n\nmacOS 提供 Apple Silicon 和 Intel DMG，Windows 提供 x64 NSIS 安装包。\n\n${mode === "preview" ? "此版本为预览包：macOS 使用 ad-hoc 签名、未公证，Windows 未签名。适合开发验证。" : "macOS 已完成 Developer ID 签名和公证，Windows 已校验 Authenticode 签名。"}\n\n安装与升级说明：https://github.com/lx8s8/peek-desktop/blob/main/docs/桌面发布.md\n\n源码：${process.env.GITHUB_SHA}\n\n下载后可使用 SHA256SUMS.txt 核对文件。\n`,
);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
console.log("三个平台安装包的来源、版本和 SHA-256 校验通过");
