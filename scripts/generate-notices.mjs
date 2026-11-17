import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

function jsonCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw Error(`${command} 依赖清单读取失败`);
  return JSON.parse(result.stdout);
}
if (!process.env.npm_execpath) throw Error("请通过 pnpm notices:generate 运行");
const node = Object.values(
  jsonCommand(process.execPath, [
    process.env.npm_execpath,
    "licenses",
    "list",
    "--prod",
    "--json",
  ]),
).flat();
const rust = new Map();
for (const target of [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
]) {
  for (const pkg of jsonCommand("cargo", [
    "metadata",
    "--locked",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--format-version",
    "1",
    "--filter-platform",
    target,
  ]).packages)
    if (pkg.source) rust.set(pkg.id, pkg);
}
const fallback = JSON.parse(
  readFileSync("third-party/license-sources.json", "utf8"),
);
const packages = new Map();
for (const pkg of rust.values())
  packages.set(`rust:${pkg.name}@${pkg.version}`, {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    authors: pkg.authors.join(", "),
    directory: dirname(pkg.manifest_path),
    source: `https://crates.io/crates/${pkg.name}/${pkg.version}`,
  });
for (const pkg of node)
  for (const directory of pkg.paths) {
    const info = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    const author =
      typeof info.author === "string" ? info.author : (info.author?.name ?? "");
    packages.set(`node:${info.name}@${info.version}`, {
      name: info.name,
      version: info.version,
      license: pkg.license,
      authors: author,
      directory,
      source: `https://www.npmjs.com/package/${info.name}/v/${info.version}`,
    });
  }
const pattern = /^(licen[cs]es?|copying|copyright|notice)([._-].*)?$/i;
const texts = new Map();
const records = [];
function collect(directory, depth = 0) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isFile() && (depth > 0 || pattern.test(entry.name)))
      return [path];
    if (entry.isDirectory() && depth < 2 && pattern.test(entry.name))
      return collect(path, depth + 1);
    return [];
  });
}
let metadataOnly = 0;
for (const [key, pkg] of [...packages].sort(([a], [b]) =>
  a.localeCompare(b, "en"),
)) {
  let files = collect(pkg.directory).map((file) => ({
    file,
    source: pkg.source,
  }));
  if (!files.length && fallback[key])
    files = fallback[key].map((item) => ({
      file: join("third-party", item.file),
      source: item.source,
    }));
  const refs = [];
  for (const item of files) {
    if (!existsSync(item.file)) throw Error(`许可文件缺失：${key}`);
    const body = readFileSync(item.file, "utf8")
      .replace(/[ \t]+$/gm, "")
      .trim();
    const id = createHash("sha256").update(body).digest("hex").slice(0, 16);
    if (!texts.has(id)) texts.set(id, { body, source: item.source });
    refs.push(`[许可](#license-${id})`);
  }
  if (!refs.length) metadataOnly++;
  const clean = (text) =>
    String(text ?? "")
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ");
  records.push(
    `| ${clean(key)} | ${clean(pkg.license)} | ${clean(pkg.authors)} | [源码 / 包](${pkg.source}) | ${refs.join(" · ") || "包内许可声明"} |`,
  );
}
const lines = [
  "# 第三方软件声明",
  "",
  "本文件记录锁定版本的 Rust 组件和前端生产依赖，包含部分构建工具；实际安装包使用其中与平台相关的组件。组件未在本项目中修改。",
  "",
  "许可原文来自已发布的软件包或 third-party 中记录的固定上游提交。少数包只提供许可标识，表格保留其公开作者、许可声明和对应源码地址。",
  "",
  "| 组件 | 许可 | 上游作者 | 来源 | 许可文本 |",
  "| --- | --- | --- | --- | --- |",
  ...records,
  "",
];
for (const [id, { body, source }] of texts) {
  const fence = "`".repeat(
    Math.max(3, ...(body.match(/`+/g) ?? []).map((text) => text.length + 1)),
  );
  lines.push(
    `## license-${id}`,
    "",
    `来源：${source}`,
    "",
    fence + "text",
    body,
    fence,
    "",
  );
}
writeFileSync("THIRD_PARTY_NOTICES.md", lines.join("\n"));
console.log(
  `已记录 ${packages.size} 个组件、${texts.size} 份许可文本，${metadataOnly} 项使用包内许可声明`,
);
