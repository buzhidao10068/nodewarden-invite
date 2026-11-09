import { applicationResponse } from "./applications.js";
import { banUser, findInvite, revokeInvite } from "./nodewarden.js";
import { decrypt, digest, encrypt, json, readBody, secureMatches } from "./security.js";
import { load, saveInvite } from "./store.js";
import type { Env, Invite } from "./types.js";

const audit = (id: string, action: string, env: Env) => env.DB.prepare("INSERT INTO nw_admin_audit (id, application_id, action, created_at) VALUES (?, ?, ?, ?)")
  .bind(crypto.randomUUID(), id, action, new Date().toISOString());

export async function adminRoute(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token || !env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || !await secureMatches(token, env.ADMIN_TOKEN)) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  if (url.pathname === "/internal/applications" && request.method === "GET") {
    const offset = Math.max(0, Math.min(1000000, Number(url.searchParams.get("offset")) || 0));
    const rows = await env.DB.prepare(`SELECT id, day, status, reason, error_code, expires_at, issue_started_at, resolve_after, created_at, updated_at
      FROM nw_applications ORDER BY created_at DESC, id LIMIT 50 OFFSET ?`).bind(Math.floor(offset)).all();
    return json({ data: rows.results, nextOffset: offset + rows.results.length });
  }
  const match = url.pathname.match(/^\/internal\/applications\/([a-f0-9-]{36})(?:\/(recover|release|revoke|ban))?$/i);
  if (!match) return new Response("Not found", { status: 404 });
  const application = await load(match[1], env);
  if (!application) return json({ message: "申请不存在。" }, 404);
  if (!match[2] && request.method === "GET") {
    let upstream: Invite | null = null;
    if (application.encrypted_invite) {
      const saved = await decrypt<Invite>(application.encrypted_invite, application.id, env);
      upstream = await findInvite(saved.code, env);
    }
    // Plain invitation data is available only to the authenticated administrator.
    const { receipt_hash: _receipt, encrypted_invite: _encrypted, ...details } = application;
    return json({ application: details, upstream });
  }
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  let body: Record<string, unknown>;
  try { body = await readBody(request); } catch { return json({ message: "请求格式无效。" }, 400); }
  const action = match[2];
  if (action === "recover") {
    if (!["creating", "uncertain"].includes(application.status) || typeof body.code !== "string" || !/^[a-f0-9]{40}$/.test(body.code)) {
      return json({ message: "仅可为待核对的申请关联一个已人工确认的邀请码。" }, 409);
    }
    const invite = await findInvite(body.code, env);
    // The upstream has no correlation/idempotency key. Never guess by nearest timestamp.
    if (!invite || !application.issue_started_at || Date.parse(invite.createdAt) < Date.parse(application.issue_started_at) - 60000 ||
        Date.parse(invite.createdAt) > Date.parse(application.issue_started_at) + 600000) {
      return json({ message: "邀请码不存在或创建时间不在本申请的发码时段内。" }, 409);
    }
    if (body.confirm !== "INVITE_BELONGS_TO_THIS_APPLICATION") return json({ message: "需明确确认邀请码归属。" }, 400);
    await audit(application.id, "recover_requested", env).run();
    if (!await saveInvite(application.id, await encrypt(invite, application.id, env), await digest(`invite:${invite.code}`, env.HASH_SALT), invite.expiresAt, env)) {
      return json({ message: "申请状态已变化，请重新查询。" }, 409);
    }
    await audit(application.id, "recover_completed", env).run();
    return applicationResponse((await load(application.id, env))!, env);
  }
  if (action === "release") {
    const reviewing = application.status === "reviewing";
    const ambiguous = ["creating", "uncertain"].includes(application.status);
    const after = reviewing ? Date.parse(application.created_at) + 120000 : Date.parse(application.resolve_after ?? "");
    if ((!reviewing && !ambiguous) || !Number.isFinite(after) || Date.now() < after) return json({ message: "申请仍在处理或尚未到可核对时间，不能释放。" }, 409);
    if (body.confirm !== "NO_USABLE_INVITE_REMAINS") return json({ message: "先检查 NodeWarden，撤销可能创建的码并确认未被使用，再明确确认释放。已使用的码应恢复关联。" }, 400);
    const predicate = "SELECT id FROM nw_applications WHERE id = ? AND status = ? AND updated_at = ?";
    const args = [application.id, application.status, application.updated_at];
    const results = await env.DB.batch([
      env.DB.prepare(`DELETE FROM nw_eligibility WHERE application_id IN (${predicate})`).bind(...args),
      env.DB.prepare(`DELETE FROM nw_daily_attempts WHERE application_id IN (${predicate})`).bind(...args),
      env.DB.prepare(`DELETE FROM nw_quota_reservations WHERE application_id IN (${predicate})`).bind(...args),
      env.DB.prepare("UPDATE nw_applications SET status = 'failed', error_code = 'admin_released', reason = '管理员已核对并释放，可重新申请。', updated_at = ? WHERE id = ? AND status = ? AND updated_at = ?")
        .bind(new Date().toISOString(), ...args),
      audit(application.id, "release_requested", env),
    ]);
    return results[3].meta.changes === 1 ? json({ message: "已释放资格和配额。" }) : json({ message: "申请状态已变化，请重新查询。" }, 409);
  }
  if ((action === "revoke" || action === "ban") && application.encrypted_invite) {
    const saved = await decrypt<Invite>(application.encrypted_invite, application.id, env);
    const invite = await findInvite(saved.code, env);
    if (action === "revoke") {
      if (invite?.usedBy) return json({ message: "邀请码已经使用；如需处理注册用户，请调用封禁操作。" }, 409);
      await audit(application.id, "revoke_requested", env).run();
      await revokeInvite(saved.code, env);
    } else {
      if (!invite?.usedBy || body.confirm !== "BAN_REGISTERED_USER") return json({ message: "需要已注册用户的关联记录及封禁确认。" }, 409);
      await audit(application.id, "ban_requested", env).run();
      await banUser(invite.usedBy, env);
    }
    await audit(application.id, `${action}_completed`, env).run();
    return json({ message: action === "revoke" ? "已执行邀请码删除，领取限制继续保留。删除操作不会封禁已经注册的用户；如与注册同时发生，请核对 NodeWarden 用户与审计日志。" : "已封禁关联的 NodeWarden 用户。" });
  }
  return json({ message: "当前状态不支持此操作。" }, 409);
}
