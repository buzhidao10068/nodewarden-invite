import type { Env } from "./types.js";

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
});

export function beijingDay(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

export async function digest(value: string, salt: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}\0${value}`));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function secureMatches(candidate: string, expected: string): Promise<boolean> {
  const left = await digest(candidate, "constant-time");
  const right = await digest(expected, "constant-time");
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
async function encryptionKey(env: Env): Promise<CryptoKey> {
  const raw = bytes(env.DATA_ENCRYPTION_KEY);
  if (raw.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must contain 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(value: unknown, applicationId: string, env: Env): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(applicationId) },
    await encryptionKey(env), new TextEncoder().encode(JSON.stringify(value)));
  return `${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}
export async function decrypt<T>(value: string, applicationId: string, env: Env): Promise<T> {
  const [iv, ciphertext] = value.split(".");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv), additionalData: new TextEncoder().encode(applicationId) },
    await encryptionKey(env), bytes(ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export function isLocal(request: Request, env: Env): boolean {
  return env.ALLOW_INSECURE_LOCAL_DEV === "true" && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname);
}

export async function validateConfig(request: Request, env: Env): Promise<void> {
  if (!env.HASH_SALT || env.HASH_SALT.length < 32 || !env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) {
    throw new Error("Missing server configuration");
  }
  if (!isLocal(request, env) && (!env.TURNSTILE_SECRET || !env.TURNSTILE_SITE_KEY || !/^[a-zA-Z0-9_-]+$/.test(env.TURNSTILE_SITE_KEY))) {
    throw new Error("Turnstile is required outside local development");
  }
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  // Enforce the limit while streaming: Content-Length alone is not trustworthy.
  if (!request.body) throw new Error("Empty body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.length;
    if (total > 48000) { await reader.cancel(); throw new Error("Body too large"); }
    chunks.push(part.value);
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  const value: unknown = JSON.parse(new TextDecoder().decode(buffer));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid JSON object");
  return value as Record<string, unknown>;
}

export async function verifyTurnstile(token: unknown, ip: string, request: Request, env: Env): Promise<boolean> {
  if (isLocal(request, env) && !env.TURNSTILE_SECRET) return true;
  if (typeof token !== "string" || !token || token.length > 2048 || !env.TURNSTILE_SECRET) return false;
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  if (!response.ok) throw new Error("Turnstile unavailable");
  const result = await response.json() as { success?: boolean; hostname?: string; action?: string };
  return result.success === true && result.hostname === new URL(request.url).hostname && result.action === "apply";
}
