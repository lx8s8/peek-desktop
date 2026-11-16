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

const appleKeys = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY_PATH",
];
export function signing(platform, mode, source = process.env) {
  if (!["preview", "development", "signed"].includes(mode))
    throw Error("签名模式应为 preview、development 或 signed");
  const env = { ...source };
  if (!["darwin", "win32"].includes(platform))
    throw Error("安装包需要在 macOS 或 Windows 构建");
  if (platform === "win32" && mode === "development")
    throw Error("development 只用于本机 macOS 开发证书");
  if (mode === "preview") {
    for (const key of appleKeys) delete env[key];
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
  if (platform === "darwin") {
    const identity = env.APPLE_SIGNING_IDENTITY ?? "";
    if (
      !identity.startsWith(
        mode === "signed" ? "Developer ID Application:" : "Apple Development:",
      )
    )
      throw Error(
        mode === "signed"
          ? "需要 Developer ID Application 分发证书"
          : "需要显式指定 Apple Development 签名身份",
      );
    if (
      mode === "signed" &&
      !(
        (env.APPLE_API_KEY && env.APPLE_API_ISSUER && env.APPLE_API_KEY_PATH) ||
        (env.APPLE_ID && env.APPLE_PASSWORD && env.APPLE_TEAM_ID)
      )
    )
      throw Error("正式 macOS 包需要配置公证 API Key 或 Apple ID 专用密码");
    if (mode === "development")
      for (const key of appleKeys.filter(
        (key) => key !== "APPLE_SIGNING_IDENTITY",
      ))
        delete env[key];
    return {
      env,
      config: {
        bundle: { macOS: { signingIdentity: identity, hardenedRuntime: true } },
      },
    };
  }
  const thumbprint = env.WINDOWS_CERTIFICATE_THUMBPRINT;
  if (!/^[A-Fa-f0-9]{40}$/.test(thumbprint ?? ""))
    throw Error("正式 Windows 包需要证书指纹 WINDOWS_CERTIFICATE_THUMBPRINT");
  return {
    env,
    config: {
      bundle: {
        windows: {
          certificateThumbprint: thumbprint,
          digestAlgorithm: "sha256",
          timestampUrl: "http://timestamp.digicert.com",
          tsp: true,
        },
      },
    },
  };
}
