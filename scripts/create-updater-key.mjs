// 生成仓库外保存的更新签名密钥对，私密文件绝不进入 Git 仓库。
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
let directory = join(homedir(), ".config", "peek-desktop", "updater");
let force = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir") directory = resolve(args[++i]);
  else if (args[i] === "--force") force = true;
  else throw Error("未知参数，仅支持 --dir <目录> 与 --force");
}

mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);

const keyPath = join(directory, "updater.key");
const pubPath = `${keyPath}.pub`;
const secretPath = join(directory, "github-updater-secret.json");

if (!force && (existsSync(keyPath) || existsSync(secretPath))) {
  throw Error(
    `更新签名密钥已存在于 ${directory}。为保持已发布版本的升级兼容性，请复用现有密钥，或明确传入 --force 覆盖未发布密钥。`,
  );
}

const password = randomBytes(36).toString("base64url");
const tauriCli = resolve("node_modules/@tauri-apps/cli/tauri.js");
const result = spawnSync(
  process.execPath,
  [
    tauriCli,
    "signer",
    "generate",
    "--ci",
    ...(force ? ["--force"] : []),
    "-w",
    keyPath,
    "-p",
    password,
  ],
  { encoding: "utf8", stdio: "pipe" },
);

if (result.error || result.status !== 0) {
  throw Error(`生成更新签名密钥失败（退出码：${result.status ?? "未启动"}）`);
}

const privateKey = readFileSync(keyPath, "utf8").trim();
const publicKey = readFileSync(pubPath, "utf8").trim();
if (!privateKey || !publicKey) {
  throw Error("生成的密钥文件内容为空");
}

writeFileSync(secretPath, JSON.stringify({ privateKey, password }), {
  mode: 0o600,
});
chmodSync(keyPath, 0o600);
chmodSync(pubPath, 0o644);
chmodSync(secretPath, 0o600);

console.log(`已生成更新签名身份：${directory}`);
console.log(
  `公钥（写入 src-tauri/tauri.conf.json 的 plugins.updater.pubkey）：`,
);
console.log(publicKey);
console.log(
  `GitHub Actions Secret 文件（PEEK_DESKTOP_UPDATER）：${secretPath}`,
);
