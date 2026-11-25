import { readFileSync } from "node:fs";

export const REPOSITORY_URL = "https://github.com/lx8s8/peek-desktop";
export const UPDATER_ENDPOINT = `${REPOSITORY_URL}/releases/latest/download/latest.json`;

export function versions(root = process.cwd()) {
  const json = (name) => JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
  const version = json("package.json").version;
  const tauri = json("src-tauri/tauri.conf.json");
  const cargo = readFileSync(`${root}/src-tauri/Cargo.toml`, "utf8").match(
    /^version\s*=\s*"([^"]+)"/m,
  )?.[1];
  if (
    !/^\d+\.\d+\.\d+$/.test(version) ||
    cargo !== version ||
    tauri.version !== version
  )
    throw Error("package.json、Cargo.toml 和 Tauri 必须使用相同的 x.y.z 版本");
  if (
    tauri.identifier !== "local.peek.desktop" ||
    tauri.bundle.publisher !== "kasen"
  )
    throw Error("应用标识或发布者发生变化，请先确认已有凭据和工作区的兼容性");

  const updater = tauri.plugins?.updater;
  let updaterPubkey = null;
  if (updater !== undefined) {
    if (
      typeof updater.pubkey !== "string" ||
      !updater.pubkey.trim() ||
      updater.requireSignedVersion !== true ||
      !Array.isArray(updater.endpoints) ||
      updater.endpoints.length !== 1 ||
      updater.endpoints[0] !== UPDATER_ENDPOINT
    ) {
      throw Error("Tauri updater 配置无效，请核对公钥、版本签名要求与清单地址");
    }
    updaterPubkey = updater.pubkey.trim();
  }

  return { version, identifier: tauri.identifier, updaterPubkey };
}

// 默认清除所有代码签名与更新签名环境变量；仅在显式开启 updater 时透传更新签名密钥。
export function signing(
  platform,
  mode,
  source = process.env,
  { updater = false } = {},
) {
  if (mode !== "unsigned") throw Error("当前打包模式固定为 unsigned");
  if (!["darwin", "win32"].includes(platform))
    throw Error("安装包需要在 macOS 或 Windows 构建");

  const stripPattern = updater
    ? /^(APPLE_|WINDOWS_CERTIFICATE)/
    : /^(APPLE_|WINDOWS_CERTIFICATE|TAURI_SIGNING_)/;
  const env = Object.fromEntries(
    Object.entries(source).filter(([key]) => !stripPattern.test(key)),
  );

  if (
    updater &&
    !env.TAURI_SIGNING_PRIVATE_KEY &&
    !env.TAURI_SIGNING_PRIVATE_KEY_PATH
  ) {
    throw Error("启用应用内更新产物时必须提供 TAURI_SIGNING_PRIVATE_KEY");
  }

  const platformBundle =
    platform === "darwin"
      ? { macOS: { signingIdentity: "-" } }
      : { windows: { certificateThumbprint: null, signCommand: null } };

  return {
    env,
    config: {
      bundle: {
        ...platformBundle,
        createUpdaterArtifacts: updater,
      },
    },
  };
}
