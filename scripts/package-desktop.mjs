import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { signing, versions } from "./release-config.mjs";

const mode = process.argv[2] ?? "preview";
const options = process.argv.slice(3);
let target;
let debug = false;
let checkOnly = false;
for (let i = 0; i < options.length; i++) {
  if (options[i] === "--target") target = options[++i];
  else if (options[i] === "--debug") debug = true;
  else if (options[i] === "--check") checkOnly = true;
  else throw Error("未知打包参数");
}
const allowed =
  process.platform === "darwin"
    ? ["aarch64-apple-darwin", "x86_64-apple-darwin", "universal-apple-darwin"]
    : ["x86_64-pc-windows-msvc"];
if (target !== undefined && !allowed.includes(target))
  throw Error("目标平台不受支持");
const { version, identifier } = versions();
const { env, config } = signing(process.platform, mode);
const platform = process.platform === "darwin" ? "macos" : "windows";
const architecture = target?.startsWith("universal")
  ? "universal"
  : target?.startsWith("aarch64")
    ? "arm64"
    : target
      ? "x64"
      : process.arch;
const run = (command, args, capture = false, childEnv = env) => {
  const result = spawnSync(command, args, {
    env: childEnv,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error || result.status !== 0)
    throw Error(
      `${command} 执行失败${capture ? "" : `（${result.status ?? "未启动"}）`}`,
    );
  return result.stdout?.trim() ?? "";
};
const revision = run("git", ["rev-parse", "HEAD"], true);
const dirty = run("git", ["status", "--porcelain"], true) !== "";
if (mode === "signed" && (dirty || debug))
  throw Error("正式签名包要求已提交的源码及 Release 构建");
if (checkOnly) {
  console.log(
    `${platform}/${architecture} · ${mode} · ${version} · ${dirty ? "包含未提交修改" : revision.slice(0, 8)}`,
  );
  process.exit(0);
}
const started = Date.now();
run(process.execPath, [
  resolve("node_modules/@tauri-apps/cli/tauri.js"),
  "build",
  "--ci",
  "--config",
  JSON.stringify(config),
  ...(target ? ["--target", target] : []),
  ...(debug ? ["--debug"] : []),
  "--",
  "--locked",
]);
const profile = debug ? "debug" : "release";
const bundle = resolve(
  process.env.CARGO_TARGET_DIR ?? "src-tauri/target",
  ...(target ? [target] : []),
  profile,
  "bundle",
);
const app = join(bundle, "macos", "Peek Desktop.app");
if (platform === "macos") {
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const plist = JSON.parse(
    run(
      "plutil",
      ["-convert", "json", "-o", "-", join(app, "Contents/Info.plist")],
      true,
    ),
  );
  if (
    plist.CFBundleIdentifier !== identifier ||
    plist.CFBundleShortVersionString !== version
  )
    throw Error("应用包版本或标识不符");
  const exts = (plist.CFBundleDocumentTypes ?? []).flatMap(
    (type) => type.CFBundleTypeExtensions ?? [],
  );
  if (!["peek", "peekbundle"].every((ext) => exts.includes(ext)))
    throw Error("应用包缺少文件关联");
  for (const filename of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    const bundled = readFileSync(
      join(app, "Contents/Resources/licenses", filename),
    );
    if (!bundled.equals(readFileSync(filename)))
      throw Error("应用包许可文件缺失或不一致");
  }
  const signature =
    spawnSync("codesign", ["-d", "--verbose=4", app], { encoding: "utf8" })
      .stderr ?? "";
  if (mode === "preview" && !signature.includes("Signature=adhoc"))
    throw Error("预览包签名模式不符");
  if (
    mode !== "preview" &&
    (!signature.includes("TeamIdentifier=") ||
      signature.includes("Signature=adhoc"))
  )
    throw Error("证书签名验证失败");
  if (
    mode !== "preview" &&
    !signature.includes(
      mode === "signed"
        ? "Authority=Developer ID Application:"
        : "Authority=Apple Development:",
    )
  )
    throw Error("应用包实际证书类型与签名模式不符");
  if (mode === "signed") {
    run("xcrun", ["stapler", "validate", app]);
    run("spctl", ["--assess", "--type", "execute", app]);
  }
}
const packageDirectory = join(bundle, platform === "macos" ? "dmg" : "nsis");
const extension = platform === "macos" ? ".dmg" : ".exe";
const packages = readdirSync(packageDirectory).filter(
  (name) =>
    name.endsWith(extension) &&
    statSync(join(packageDirectory, name)).mtimeMs >= started - 2000,
);
if (packages.length !== 1) throw Error("未找到本次构建生成的唯一安装包");
const installer = join(packageDirectory, packages[0]);
if (platform === "macos") {
  run("hdiutil", ["verify", installer]);
  if (mode === "signed") {
    const auth = env.APPLE_API_KEY
      ? [
          "--key",
          env.APPLE_API_KEY_PATH,
          "--key-id",
          env.APPLE_API_KEY,
          "--issuer",
          env.APPLE_API_ISSUER,
        ]
      : [
          "--apple-id",
          env.APPLE_ID,
          "--team-id",
          env.APPLE_TEAM_ID,
          "--password",
          env.APPLE_PASSWORD,
        ];
    // Tauri notarizes the app. Notarize and staple the final DMG as well.
    const result = JSON.parse(
      run(
        "xcrun",
        [
          "notarytool",
          "submit",
          installer,
          "--wait",
          "--output-format",
          "json",
          ...auth,
        ],
        true,
      ),
    );
    if (result.status !== "Accepted") throw Error("DMG 公证未通过");
    run("xcrun", ["stapler", "staple", installer]);
    run("xcrun", ["stapler", "validate", installer]);
  }
} else if (mode === "signed") {
  const executable = resolve(bundle, "..", "peek-desktop.exe");
  for (const file of [executable, installer]) {
    run(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'if ((Get-AuthenticodeSignature -LiteralPath $env:PEEK_VERIFY_FILE).Status -ne "Valid") { throw "Invalid Authenticode signature" }',
      ],
      false,
      { ...env, PEEK_VERIFY_FILE: file },
    );
  }
}
const output = resolve("release-artifacts");
mkdirSync(output, { recursive: true });
const suffix = `${platform}-${architecture}-${mode}${debug ? "-debug" : ""}`;
const filename = `Peek-Desktop_${version}_${suffix}${extension}`;
copyFileSync(installer, join(output, filename));
const data = readFileSync(join(output, filename));
const sha256 = createHash("sha256").update(data).digest("hex");
const manifest = {
  version,
  identifier,
  revision,
  dirty,
  platform,
  architecture,
  mode,
  profile,
  signed: mode !== "preview",
  notarized: platform === "macos" && mode === "signed",
  files: [{ name: filename, bytes: data.length, sha256 }],
};
writeFileSync(
  join(output, `manifest-${suffix}.json`),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
writeFileSync(
  join(output, `SHA256SUMS-${suffix}.txt`),
  `${sha256}  ${filename}\n`,
);
console.log(
  `安装包：${join(output, filename)}\n耗时：${((Date.now() - started) / 1000).toFixed(1)} 秒`,
);
