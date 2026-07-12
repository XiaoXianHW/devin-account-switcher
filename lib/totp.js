// TOTP (RFC 6238) implemented with WebCrypto (HMAC-SHA1), pyotp/GitHub compatible:
// SHA1 / 6 digits / 30s step. Mirrors the VSIX extension's totp.ts.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const OTPAUTH_SECRET_RE = /secret=([A-Z2-7=]+)/i;

/** Accept raw base32 or a full otpauth:// URI, return whitespace-stripped base32. */
export function normalizeSecret(raw) {
  let value = (raw || "").trim();
  if (!value) return "";
  if (value.toLowerCase().startsWith("otpauth://")) {
    const match = OTPAUTH_SECRET_RE.exec(value);
    if (!match) throw new Error("otpauth URI 里没找到 'secret=' 参数");
    value = match[1];
  }
  return value.replace(/ /g, "").replace(/-/g, "").toUpperCase();
}

function base32Decode(secret) {
  const clean = secret.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`非法 base32 字符：'${ch}'`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function hotp(keyBytes, counter, digits = 6) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setBigUint64(0, BigInt(counter), false);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const offset = sig[sig.length - 1] & 0x0f;
  const code =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}

async function totpAt(secret, forTime, step = 30, digits = 6) {
  const cleaned = normalizeSecret(secret);
  if (!cleaned) throw new Error("TOTP 密钥为空");
  let key;
  try {
    key = base32Decode(cleaned);
  } catch (err) {
    throw new Error(`TOTP 密钥不合法：${String(err)}`);
  }
  if (key.length === 0) throw new Error("TOTP 密钥不合法：解码后为空");
  const counter = Math.floor(forTime / step);
  return hotp(key, counter, digits);
}

/**
 * Candidate codes for `forTime` (unix seconds) and adjacent windows, to tolerate
 * mild clock skew. De-duplicated, ordered by offsets.
 */
export async function codesForTime(secret, forTime, offsetsS = [0, -30, 30]) {
  const out = [];
  for (const off of offsetsS) {
    const code = await totpAt(secret, Math.floor(forTime) + off);
    if (!out.includes(code)) out.push(code);
  }
  return out;
}
