import { readFileSync } from "node:fs";

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
  return { version, identifier: tauri.identifier };
}

// Strip certificate credentials even when the shell or runner has them configured.
export function signing(platform, mode, source = process.env) {
  if (mode !== "unsigned") throw Error("当前打包模式固定为 unsigned");
  if (!["darwin", "win32"].includes(platform))
    throw Error("安装包需要在 macOS 或 Windows 构建");
  const env = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => !/^(APPLE_|WINDOWS_CERTIFICATE|TAURI_SIGNING_)/.test(key),
    ),
  );
  return {
    env,
    config: {
      bundle:
        platform === "darwin"
          ? { macOS: { signingIdentity: "-" } }
          : { windows: { certificateThumbprint: null, signCommand: null } },
    },
  };
}
