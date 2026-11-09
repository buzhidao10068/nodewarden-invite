import { secureMatches } from "./security.js";
import type { Env } from "./types.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeSecret(secret: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Z2-7]{32,128}$/.test(secret) || ![0, 2, 4, 5, 7].includes(secret.length % 8)) throw new Error("Invalid ADMIN_TOTP_SECRET");
  const bytes: number[] = [];
  let buffer = 0, bits = 0;
  for (const character of secret) {
    buffer = (buffer << 5) | ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) throw new Error("Invalid ADMIN_TOTP_SECRET padding");
  return Uint8Array.from(bytes);
}

export function totpSecret(env: Env): string | null {
  if (env.ADMIN_TOTP_SECRET === undefined) return null;
  const normalized = env.ADMIN_TOTP_SECRET.replace(/\s/g, "").toUpperCase();
  decodeSecret(normalized); // A configured but malformed secret must never disable 2FA.
  return normalized;
}

// RFC 6238: HMAC-SHA1, six digits, 30 seconds, one step of clock tolerance.
export async function matchingTotpStep(code: unknown, secret: string, now = Date.now()): Promise<number | null> {
  const key = await crypto.subtle.importKey("raw", decodeSecret(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  if (typeof code !== "string" || !/^[0-9]{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  let matched: number | null = null;
  for (const offset of [0, -1, 1]) {
    const step = current + offset;
    if (step < 0) continue;
    const counter = new Uint8Array(8);
    new DataView(counter.buffer).setBigUint64(0, BigInt(step));
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
    const position = signature[signature.length - 1] & 15;
    const number = ((signature[position] & 127) << 24) | (signature[position + 1] << 16) | (signature[position + 2] << 8) | signature[position + 3];
    const expected = (number % 1000000).toString().padStart(6, "0");
    const equal = await secureMatches(code, expected);
    if (equal && matched === null) matched = step;
  }
  return matched;
}
