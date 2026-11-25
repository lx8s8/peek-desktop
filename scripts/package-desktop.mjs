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
import { verifyUpdaterSignature } from "./updater-signature.mjs";

const mode = process.argv[2] ?? "unsigned";
const options = process.argv.slice(3);
let target;
let debug = false;
let checkOnly = false;
let updater = false;
for (let i = 0; i < options.length; i++) {
  if (options[i] === "--target") target = options[++i];
  else if (options[i] === "--debug") debug = true;
  else if (options[i] === "--check") checkOnly = true;
  else if (options[i] === "--updater") updater = true;
  else throw Error("未知打包参数");
}
if (updater && debug) throw Error("调试构建不允许生成正式更新签名产物");
const allowed =
  process.platform === "darwin"
    ? ["aarch64-apple-darwin", "x86_64-apple-darwin", "universal-apple-darwin"]
    : ["x86_64-pc-windows-msvc"];
if (target !== undefined && !allowed.includes(target))
  throw Error("目标平台不受支持");
const { version, identifier, updaterPubkey } = versions();
if (updater && !updaterPubkey)
  throw Error("src-tauri/tauri.conf.json 缺少有效的 plugins.updater.pubkey");
const { env, config } = signing(process.platform, mode, process.env, {
  updater,
});
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
if (checkOnly) {
  console.log(
    `${platform}/${architecture} · ${mode}${updater ? "+updater" : ""} · ${version} · ${dirty ? "包含未提交修改" : revision.slice(0, 8)}`,
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
  if (mode === "unsigned" && !signature.includes("Signature=adhoc"))
    throw Error("无证书包签名模式不符");
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
if (platform === "macos") run("hdiutil", ["verify", installer]);
const output = resolve("release-artifacts");
mkdirSync(output, { recursive: true });
const suffix = `${platform}-${architecture}-${mode}${debug ? "-debug" : ""}`;
const filename = `Peek-Desktop_${version}_${suffix}${extension}`;
copyFileSync(installer, join(output, filename));
const data = readFileSync(join(output, filename));
const sha256 = createHash("sha256").update(data).digest("hex");

let updaterMeta = null;
if (updater) {
  if (platform === "macos") {
    const updaterTarget =
      architecture === "arm64"
        ? "darwin-aarch64"
        : architecture === "x64"
          ? "darwin-x86_64"
          : null;
    if (!updaterTarget)
      throw Error(`当前架构不支持生成更新归档：${architecture}`);
    const archiveSource = join(bundle, "macos", "Peek Desktop.app.tar.gz");
    const sigSource = `${archiveSource}.sig`;
    for (const file of [archiveSource, sigSource]) {
      if (!existsSync(file) || statSync(file).mtimeMs < started - 2000) {
        throw Error(`缺少本次构建生成的 macOS 更新产物：${file}`);
      }
    }
    const archiveName = `Peek-Desktop_${version}_${suffix}.app.tar.gz`;
    const sigName = `${archiveName}.sig`;
    copyFileSync(archiveSource, join(output, archiveName));
    copyFileSync(sigSource, join(output, sigName));
    const archiveData = readFileSync(join(output, archiveName));
    const sigText = readFileSync(join(output, sigName), "utf8").trim();
    verifyUpdaterSignature(archiveData, sigText, updaterPubkey, version);
    updaterMeta = {
      target: updaterTarget,
      file: archiveName,
      bytes: archiveData.length,
      sha256: createHash("sha256").update(archiveData).digest("hex"),
      signatureFile: sigName,
    };
  } else {
    const sigSource = `${installer}.sig`;
    if (
      !existsSync(sigSource) ||
      statSync(sigSource).mtimeMs < started - 2000
    ) {
      throw Error(`缺少本次构建生成的 Windows 更新签名：${sigSource}`);
    }
    const sigName = `${filename}.sig`;
    copyFileSync(sigSource, join(output, sigName));
    const sigText = readFileSync(join(output, sigName), "utf8").trim();
    verifyUpdaterSignature(data, sigText, updaterPubkey, version);
    updaterMeta = {
      target: "windows-x86_64",
      file: filename,
      bytes: data.length,
      sha256,
      signatureFile: sigName,
    };
  }
}

const manifest = {
  version,
  identifier,
  revision,
  dirty,
  platform,
  architecture,
  mode,
  profile,
  signed: false,
  notarized: false,
  files: [{ name: filename, bytes: data.length, sha256 }],
  ...(updaterMeta ? { updater: updaterMeta } : {}),
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
  `安装包：${join(output, filename)}${updaterMeta ? `\n更新包：${join(output, updaterMeta.file)}` : ""}\n耗时：${((Date.now() - started) / 1000).toFixed(1)} 秒`,
);
