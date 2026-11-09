import type { Env, Invite } from "./types.js";
const sessions = new WeakMap<Env, { expiresAt: number; token: Promise<string> }>();

export async function accessToken(env: Env): Promise<string> {
  const base = new URL(env.NODEWARDEN_URL);
  if (base.protocol !== "https:" || base.href.slice(8).split("/")[0].includes("@") || base.search || base.hash || base.pathname !== "/" ||
      !env.NODEWARDEN_CLIENT_ID?.startsWith("user.") || !env.NODEWARDEN_CLIENT_SECRET || !env.NODEWARDEN_MASTER_PASSWORD_HASH) {
    throw new Error("Missing NodeWarden administrator configuration");
  }
  const cached = sessions.get(env);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const entry = { expiresAt: Date.now() + 30000, token: Promise.resolve("") };
  entry.token = (async () => {
    const response = await fetch(new URL("/identity/connect/token", env.NODEWARDEN_URL), {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "api", client_id: env.NODEWARDEN_CLIENT_ID, client_secret: env.NODEWARDEN_CLIENT_SECRET }),
    });
    if (!response.ok) throw new Error("NodeWarden authentication failed");
    const result = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof result.access_token !== "string" || !result.access_token || typeof result.expires_in !== "number" || result.expires_in < 1) {
      throw new Error("Invalid NodeWarden token response");
    }
    entry.expiresAt = Date.now() + Math.max(0, result.expires_in - 60) * 1000;
    return result.access_token;
  })();
  sessions.set(env, entry);
  try { return await entry.token; } catch (error) { if (sessions.get(env) === entry) sessions.delete(env); throw error; }
}

function parseInvite(value: unknown, env: Env): Invite {
  const invite = value as Partial<Invite> | null;
  if (!invite || typeof invite.code !== "string" || !/^[a-f0-9]{40}$/.test(invite.code) ||
      typeof invite.expiresAt !== "string" || !Number.isFinite(Date.parse(invite.expiresAt)) ||
      typeof invite.createdAt !== "string" || !Number.isFinite(Date.parse(invite.createdAt)) ||
      typeof invite.status !== "string" || (invite.usedBy != null && typeof invite.usedBy !== "string")) {
    throw new Error("Invalid NodeWarden invitation response");
  }
  // Construct the link from the configured origin, never trust an upstream link's host.
  return { code: invite.code, inviteLink: `${new URL(env.NODEWARDEN_URL).origin}/?invite=${encodeURIComponent(invite.code)}`,
    expiresAt: invite.expiresAt, createdAt: invite.createdAt, status: invite.status, usedBy: invite.usedBy ?? null };
}

async function adminRequest(path: string, method: string, env: Env): Promise<Response> {
  const send = async (token: string) => fetch(new URL(path, env.NODEWARDEN_URL), {
    method, redirect: "manual", signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(method === "GET" ? {} : { body: JSON.stringify({ masterPasswordHash: env.NODEWARDEN_MASTER_PASSWORD_HASH, ...(method === "PUT" ? { status: "banned" } : {}) }) }),
  });
  let response = await send(await accessToken(env));
  // Reads, revocation, and setting banned are safe to retry after authentication rejection.
  if (response.status === 401) { sessions.delete(env); response = await send(await accessToken(env)); }
  if (!response.ok && !(method === "DELETE" && response.status === 404)) throw new Error("NodeWarden administrator request failed");
  return response;
}
export async function findInvite(code: string, env: Env): Promise<Invite | null> {
  const response = await adminRequest("/api/admin/invites?includeInactive=true", "GET", env);
  const result = await response.json() as { data?: unknown[]; continuationToken?: unknown };
  if (!Array.isArray(result.data) || result.continuationToken) throw new Error("Unsupported NodeWarden invitation list");
  const value = result.data.find((item) => (item as { code?: unknown } | null)?.code === code);
  return value ? parseInvite(value, env) : null;
}
export async function revokeInvite(code: string, env: Env): Promise<void> {
  await adminRequest(`/api/admin/invites/${encodeURIComponent(code)}`, "DELETE", env);
}
export async function banUser(userId: string, env: Env): Promise<void> {
  await adminRequest(`/api/admin/users/${encodeURIComponent(userId)}/status`, "PUT", env);
}
