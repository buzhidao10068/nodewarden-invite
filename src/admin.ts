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
    const offset = Math.floor(Math.max(0, Math.min(1000000, Number(url.searchParams.get("offset")) || 0)));
    const rows = await env.DB.prepare(`SELECT a.id, e.email, a.day, a.status, a.reason, a.error_code, a.expires_at, a.created_at, a.updated_at
      FROM nw_applications a LEFT JOIN nw_application_emails e ON e.application_id = a.id
      ORDER BY a.created_at DESC, a.id LIMIT 50 OFFSET ?`).bind(offset).all();
    return json({ data: rows.results, nextOffset: offset + rows.results.length });
  }
  const match = url.pathname.match(/^\/internal\/applications\/([a-f0-9-]{36})(?:\/(sent|reject|recover|release|revoke|ban))?$/i);
  if (!match) return new Response("Not found", { status: 404 });
  const application = await load(match[1], env);
  if (!application) return json({ message: "申请不存在。" }, 404);
  if (!match[2] && request.method === "GET") {
    let upstream: Invite | null = null;
    if (application.encrypted_invite) {
      const saved = await decrypt<Invite>(application.encrypted_invite, application.id, env);
      upstream = await findInvite(saved.code, env);
    }
    const { encrypted_invite: _encrypted, email_hash: _email, ...details } = application;
    return json({ application: details, upstream });
  }
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  let body: Record<string, unknown>;
  try { body = await readBody(request); } catch { return json({ message: "请求格式无效。" }, 400); }
  const action = match[2];
  if (action === "sent" || action === "reject") {
    if (application.status !== "reviewing" || !application.email) return json({ message: "仅可处理带邮箱的待审核申请。" }, 409);
    let invite: Invite | null = null;
    if (action === "sent") {
      if (body.confirm !== "INVITATION_EMAIL_SENT") return json({ message: "请先手动发送邀请邮件，再确认已发送。" }, 400);
      if (body.code !== undefined) {
        if (typeof body.code !== "string" || !/^[a-f0-9]{40}$/.test(body.code)) return json({ message: "邀请码格式无效。" }, 400);
        invite = await findInvite(body.code, env);
        if (!invite) return json({ message: "未找到要关联的邀请码。" }, 409);
        const assigned = await env.DB.prepare("SELECT id FROM nw_applications WHERE invite_code_hash = ? AND id <> ?")
          .bind(await digest(`invite:${invite.code}`, env.HASH_SALT), application.id).first();
        if (assigned) return json({ message: "邀请码已关联其他申请。" }, 409);
      }
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if ([...reason].length > 500) return json({ message: "管理员备注不能超过 500 个字符。" }, 400);
    const predicate = "SELECT id FROM nw_applications WHERE id = ? AND status = 'reviewing' AND updated_at = ?";
    const args = [application.id, application.updated_at];
    const results = await env.DB.batch([
      ...(action === "reject" ? [
        env.DB.prepare(`DELETE FROM nw_eligibility WHERE application_id IN (${predicate})`).bind(...args),
        env.DB.prepare(`UPDATE nw_application_emails SET active_email_hash = NULL WHERE application_id IN (${predicate})`).bind(...args),
      ] : []),
      env.DB.prepare(`UPDATE nw_applications SET status = ?, reason = ?, error_code = ?, encrypted_invite = ?, invite_code_hash = ?,
        expires_at = ?, updated_at = ? WHERE id = ? AND status = 'reviewing' AND updated_at = ?`)
        .bind(action === "sent" ? "succeeded" : "rejected", reason || null, action === "reject" ? "admin_rejected" : null,
          invite ? await encrypt(invite, application.id, env) : null, invite ? await digest(`invite:${invite.code}`, env.HASH_SALT) : null,
          invite?.expiresAt ?? null, new Date().toISOString(), ...args),
      audit(application.id, `${action}_requested`, env),
    ]);
    return results[results.length - 2].meta.changes === 1 ? applicationResponse((await load(application.id, env))!) : json({ message: "申请状态已变化，请重新查询。" }, 409);
  }
  if (action === "recover") {
    if (!["creating", "uncertain"].includes(application.status) || typeof body.code !== "string" || !/^[a-f0-9]{40}$/.test(body.code)) {
      return json({ message: "仅可为旧版待核对的申请关联一个已人工确认的邀请码。" }, 409);
    }
    const invite = await findInvite(body.code, env);
    if (!invite || !application.issue_started_at || Date.parse(invite.createdAt) < Date.parse(application.issue_started_at) - 60000 ||
        Date.parse(invite.createdAt) > Date.parse(application.issue_started_at) + 600000) return json({ message: "邀请码不存在或创建时间不在本申请的发码时段内。" }, 409);
    if (body.confirm !== "INVITE_BELONGS_TO_THIS_APPLICATION") return json({ message: "需要明确确认邀请码归属。" }, 400);
    await audit(application.id, "recover_requested", env).run();
    if (!await saveInvite(application.id, await encrypt(invite, application.id, env), await digest(`invite:${invite.code}`, env.HASH_SALT), invite.expiresAt, env)) {
      return json({ message: "申请状态已变化或邀请码已被关联，请重新查询。" }, 409);
    }
    await audit(application.id, "recover_completed", env).run();
    return applicationResponse((await load(application.id, env))!);
  }
  if (action === "release") {
    const reviewing = application.status === "reviewing";
    const ambiguous = ["creating", "uncertain"].includes(application.status);
    const after = reviewing ? Date.parse(application.created_at) + 120000 : Date.parse(application.resolve_after ?? "");
    if ((!reviewing && !ambiguous) || !Number.isFinite(after) || Date.now() < after) return json({ message: "尚未到可核对时间，不能释放。" }, 409);
    if (body.confirm !== "NO_USABLE_INVITE_REMAINS") return json({ message: "请先核对未发送邮件、无可用或已使用的邀请码，再确认释放。" }, 400);
    const predicate = "SELECT id FROM nw_applications WHERE id = ? AND status = ? AND updated_at = ?";
    const args = [application.id, application.status, application.updated_at];
    const results = await env.DB.batch([
      env.DB.prepare(`DELETE FROM nw_eligibility WHERE application_id IN (${predicate})`).bind(...args),
      env.DB.prepare(`DELETE FROM nw_daily_attempts WHERE application_id IN (${predicate})`).bind(...args),
      env.DB.prepare(`UPDATE nw_application_emails SET active_email_hash = NULL WHERE application_id IN (${predicate})`).bind(...args),
      env.DB.prepare("UPDATE nw_applications SET status = 'failed', error_code = 'admin_released', reason = '管理员已核对并释放，可重新申请。', updated_at = ? WHERE id = ? AND status = ? AND updated_at = ?")
        .bind(new Date().toISOString(), ...args),
      audit(application.id, "release_requested", env),
    ]);
    return results[3].meta.changes === 1 ? json({ message: "已释放申请资格，可重新申请。" }) : json({ message: "申请状态已变化，请重新查询。" }, 409);
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
    return json({ message: action === "revoke" ? "已执行邀请码删除，领取限制继续保留。" : "已封禁关联的 NodeWarden 用户。" });
  }
  return json({ message: "当前状态不支持此操作。" }, 409);
}
