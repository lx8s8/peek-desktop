import { versions } from "./release-config.mjs";
const { version, identifier } = versions();
const tag = process.argv[2];
if (tag && tag !== `v${version}`) throw Error(`发布标签必须为 v${version}`);
console.log(`版本 ${version} · 标识 ${identifier} · 发布者 kasen`);
