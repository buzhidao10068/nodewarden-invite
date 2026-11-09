import { digest, isLocal, json, readBody, secureMatches } from "./security.js";
import { takeRate } from "./store.js";
import { matchingTotpStep, totpSecret } from "./totp.js";
import type { Env } from "./types.js";

const SESSION_SECONDS = 8 * 60 * 60;

export function adminMode(env: Env): "web" | "api" | "both" {
  const value = env.ADMIN_ACCESS_MODE?.trim().toLowerCase();
  // Missing configuration preserves both interfaces. A typo fails closed.
  if (!value) return "both";
  if (value === "web" || value === "api" || value === "both") return value;
  throw new Error("Invalid ADMIN_ACCESS_MODE");
}

function cookieName(request: Request, env: Env): string {
  return isLocal(request, env) && new URL(request.url).protocol === "http:" ? "nw_admin_local" : "__Host-" + "nw_admin";
}

function sessionCookie(value: string, request: Request, env: Env, maxAge = SESSION_SECONDS): string {
  const secure = cookieName(request, env).startsWith("__Host-") ? "; Secure" : "";
  return `${cookieName(request, env)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

async function sessionKey(env: Env): Promise<CryptoKey> {
  // Bind sessions to both credentials. Enabling or rotating 2FA invalidates old cookies.
  const material = JSON.stringify([env.ADMIN_TOKEN, totpSecret(env)]);
  return crypto.subtle.importKey("raw", new TextEncoder().encode(material), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function makeSession(env: Env): Promise<string> {
  const payload = `${Math.floor(Date.now() / 1000) + SESSION_SECONDS}.${crypto.randomUUID()}`;
  const signature = await crypto.subtle.sign("HMAC", await sessionKey(env), new TextEncoder().encode(`nw-admin-session-v1:${payload}`));
  return `${payload}.${Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function validAdminSession(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || (new URL(request.url).protocol !== "https:" && !isLocal(request, env))) return false;
  const value = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${cookieName(request, env)}=`))?.split("=")[1];
  const match = value?.match(/^(\d{10})\.([a-f0-9-]{36})\.([a-f0-9]{64})$/);
  if (!match) return false;
  const now = Math.floor(Date.now() / 1000), expires = Number(match[1]);
  if (expires <= now || expires > now + SESSION_SECONDS) return false;
  const signature = Uint8Array.from(match[3].match(/../g)!, byte => parseInt(byte, 16));
  return crypto.subtle.verify("HMAC", await sessionKey(env), signature, new TextEncoder().encode(`nw-admin-session-v1:${match[1]}.${match[2]}`));
}

export async function authenticateAdmin(request: Request, env: Env): Promise<boolean> {
  const mode = adminMode(env);
  if (new URL(request.url).pathname.startsWith("/admin/api/")) {
    if (mode === "api") return false;
    // Cookie authentication requires an explicit same-origin request for writes.
    if (request.method !== "GET" && request.headers.get("origin") !== new URL(request.url).origin) return false;
    return validAdminSession(request, env);
  }
  if (mode === "web") return false;
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  return !!token && !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 32 && await secureMatches(token, env.ADMIN_TOKEN);
}

export async function adminSessionRoute(request: Request, env: Env): Promise<Response> {
  if (adminMode(env) === "api") return new Response("Not found", { status: 404 });
  if (new URL(request.url).protocol !== "https:" && !isLocal(request, env)) return json({ message: "管理员登录需要 HTTPS。" }, 403);
  if (request.method === "GET") return await validAdminSession(request, env) ? json({ authenticated: true }) : json({ message: "请登录管理员账户。" }, 401);
  if (!["POST", "DELETE"].includes(request.method)) return new Response("Not found", { status: 404 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return json({ message: "请求来源无效。" }, 403);
  if (request.method === "DELETE") {
    const response = json({ message: "已退出登录。" });
    response.headers.set("set-cookie", sessionCookie("", request, env, 0));
    return response;
  }
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return json({ message: "管理员登录尚未配置。" }, 503);
  const ip = request.headers.get("CF-Connecting-IP") || (isLocal(request, env) ? "local-development" : null);
  if (!ip) return json({ message: "无法验证请求来源。" }, 403);
  if (!await takeRate("admin-login-global", "global", 30, env) ||
      !await takeRate("admin-login-ip", await digest(`admin-login:${ip}`, env.HASH_SALT || env.ADMIN_TOKEN), 5, env)) {
    return json({ message: "登录尝试过于频繁，请稍后再试。" }, 429);
  }
  let body: Record<string, unknown>;
  try { body = await readBody(request); } catch { return json({ message: "请求格式无效。" }, 400); }
  const secret = totpSecret(env);
  const invalid = () => json({ message: "管理员令牌或动态验证码无效，或验证码已使用。" }, 401);
  if (typeof body.token !== "string" || !await secureMatches(body.token, env.ADMIN_TOKEN)) return invalid();
  if (secret !== null) {
    const step = await matchingTotpStep(body.totp, secret);
    if (step === null) return invalid();
    // D1 atomically consumes the time step, including concurrent logins at different edges.
    // Store its fixed minute so existing bounded rate-limit cleanup also expires these rows.
    const used = await env.DB.prepare(`INSERT INTO nw_rate_limits (bucket, subject_hash, window, count)
      VALUES ('admin-totp-used', ?, ?, 1) ON CONFLICT(bucket, subject_hash, window) DO NOTHING RETURNING count`)
      .bind(await digest(`admin-totp-step:${step}`, secret), Math.floor(step / 2)).first();
    if (!used) return invalid();
  }
  const response = json({ authenticated: true });
  response.headers.set("set-cookie", sessionCookie(await makeSession(env), request, env));
  return response;
}
