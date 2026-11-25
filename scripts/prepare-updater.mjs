// 从 GitHub Actions Secret 读取更新签名身份并写入环境变量；绝不打印或上传私钥。
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const source = process.env.PEEK_DESKTOP_UPDATER;
if (!source) {
  throw Error("正式发布需要配置 Actions Secret: PEEK_DESKTOP_UPDATER");
}
const { privateKey, password } = JSON.parse(source);
if (
  typeof privateKey !== "string" ||
  !privateKey.trim() ||
  typeof password !== "string"
) {
  throw Error("PEEK_DESKTOP_UPDATER 配置格式无效");
}
if (!process.env.GITHUB_ENV) {
  throw Error("此脚本仅限在 CI 环境中运行");
}

for (const value of [privateKey, password]) {
  if (!value) continue;
  const escaped = value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  console.log(`::add-mask::${escaped}`);
  for (const line of value.split(/\r?\n/)) {
    if (line) console.log(`::add-mask::${line}`);
  }
}

for (const [name, value] of Object.entries({
  TAURI_SIGNING_PRIVATE_KEY: privateKey,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
})) {
  const delimiter = `PEEK_UPDATER_${randomBytes(16).toString("hex")}`;
  appendFileSync(
    process.env.GITHUB_ENV,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
  );
}
