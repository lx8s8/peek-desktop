// Minisign 的 ED 签名格式：BLAKE2b-512 文件摘要 + Ed25519 签名，以及覆盖可信注释的全局签名。
// 在打包与发布聚合阶段均执行校验，防止异常或被篡改的产物进入正式发布。
import { createHash, createPublicKey, verify } from "node:crypto";

function decodeBase64(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 8192 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw Error("更新签名编码无效");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw Error("更新签名编码无效");
  }
  return bytes;
}

export function verifyUpdaterSignature(payload, signature, publicKey, version) {
  const keyLines = decodeBase64(publicKey)
    .toString("utf8")
    .trimEnd()
    .split(/\r?\n/);
  const lines = decodeBase64(signature)
    .toString("utf8")
    .trimEnd()
    .split(/\r?\n/);
  if (
    keyLines.length !== 2 ||
    !keyLines[0].startsWith("untrusted comment: ") ||
    lines.length !== 4 ||
    !lines[0].startsWith("untrusted comment: ") ||
    !lines[2].startsWith("trusted comment: ")
  ) {
    throw Error("更新签名格式无效");
  }
  const key = decodeBase64(keyLines[1]);
  const fileSig = decodeBase64(lines[1]);
  const globalSig = decodeBase64(lines[3]);
  if (
    key.length !== 42 ||
    key.subarray(0, 2).toString() !== "Ed" ||
    fileSig.length !== 74 ||
    fileSig.subarray(0, 2).toString() !== "ED" ||
    globalSig.length !== 64 ||
    !key.subarray(2, 10).equals(fileSig.subarray(2, 10))
  ) {
    throw Error("更新签名身份不匹配");
  }
  const trusted = lines[2].slice("trusted comment: ".length);
  const versions = trusted
    .split("\t")
    .filter((field) => field.startsWith("version:"))
    .map((field) => field.slice("version:".length));
  if (versions.length !== 1 || versions[0] !== version) {
    throw Error("更新签名绑定的版本号不一致");
  }
  const ed25519 = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      key.subarray(10),
    ]),
    format: "der",
    type: "spki",
  });
  const digest = createHash("blake2b512").update(payload).digest();
  if (
    !verify(null, digest, ed25519, fileSig.subarray(10)) ||
    !verify(
      null,
      Buffer.concat([fileSig.subarray(10), Buffer.from(trusted)]),
      ed25519,
      globalSig,
    )
  ) {
    throw Error("更新签名校验失败");
  }
}
