// 仓库凭证的静态加密。
//
// 仓库的账号密码 / API Key 与本仓别的机密不同：它必须能被 agent【真用到】（clone/push 要原文），
// 所以不能只存摘要；但也绝不能明文落盘（状态文件 / PostgreSQL 行 / 备份 里到处都是）。
// 做法：AES-256-GCM 密封，只在投递给认领派发的 agent 那一刻解开。
//
// 密钥来源二选一：环境变量 AIMAC_CREDENTIAL_KEY（32 字节，64 位 hex 或 base64），
// 否则运行时目录下自动生成 credential.key（0600）。密文里带 keyId：换了密钥之后旧密文解不开，
// 要如实抛 credential_key_mismatch，而不是悄悄回空让派发在 agent 那头以"没配凭证"失败。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY_FILE = "credential.key";
let cached = null;

function parseKey(raw) {
  const text = String(raw || "").trim();
  const key = /^[0-9a-f]{64}$/iu.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  if (key.length !== 32) throw new Error("credential_key_invalid:密钥必须是 32 字节（64 位 hex 或 base64）");
  return key;
}

export function credentialKey(runtimeDir) {
  if (cached) return cached;
  let key;
  if (process.env.AIMAC_CREDENTIAL_KEY) {
    key = parseKey(process.env.AIMAC_CREDENTIAL_KEY);
  } else {
    const path = join(runtimeDir, KEY_FILE);
    if (existsSync(path)) {
      key = parseKey(readFileSync(path, "utf8"));
    } else {
      key = randomBytes(32);
      mkdirSync(runtimeDir, {recursive: true});
      writeFileSync(path, `${key.toString("hex")}\n`, {mode: 0o600});
    }
  }
  cached = {key, keyId: createHash("sha256").update(key).digest("hex").slice(0, 12)};
  return cached;
}

// 测试用：换运行时目录 / 换密钥时清掉缓存。产品代码不该调它。
export function resetCredentialKeyCache() {
  cached = null;
}

export function isSealed(value) {
  return Boolean(value && typeof value === "object" && value.v === 1 && typeof value.data === "string" && value.iv && value.tag && value.keyId);
}

export function sealSecret(plain, runtimeDir) {
  const {key, keyId} = credentialKey(runtimeDir);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return {v: 1, alg: "aes-256-gcm", keyId, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64")};
}

export function openSecret(sealed, runtimeDir) {
  if (!isSealed(sealed)) return null;
  const {key, keyId} = credentialKey(runtimeDir);
  if (sealed.keyId !== keyId) throw new Error("credential_key_mismatch:这份凭证是用另一把密钥密封的（密钥换过或运行时目录换过），解不开——重新在项目设置里填一次凭证");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
}
