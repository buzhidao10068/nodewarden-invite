import { accessToken, CreationError, createInvite } from "./nodewarden.js";
import { isDuplicate, review } from "./review.js";
import { beijingDay, decrypt, digest, encrypt, isLocal, json, readBody, secureMatches, verifyTurnstile } from "./security.js";
import { failDefiniteCreation, finishBeforeCreation, load, markUncertain, reserve, saveInvite, takeRate } from "./store.js";
import { dailyLimit, expiryHours, type Application, type Env, type Invite } from "./types.js";

export async function applicationResponse(application: Application, env: Env): Promise<Response> {
  const common = { applicationId: application.id, status: application.status };
  if (application.status === "succeeded" && application.encrypted_invite) {
    const invite = await decrypt<Invite>(application.encrypted_invite, application.id, env);
    const expired = Date.parse(invite.expiresAt) <= Date.now();
    return json({ ...common, inviteLink: invite.inviteLink, expiresAt: invite.expiresAt, expired,
      message: expired ? "此邀请码已到期。每个来源只能成功领取一次。" : "审核通过，请在有效期内完成注册。邀请码仅可使用一次。" });
  }
  if (application.status === "failed") return json({ ...common, retryable: true, message: application.reason ?? "服务暂不可用，可稍后重新申请。" }, 503);
  if (application.status === "rejected") return json({ ...common, message: `未通过审核：${application.reason ?? "申请不符合要求"}` }, 403);
  const uncertain = application.status === "uncertain" || application.status === "creating";
  return json({ ...common, message: uncertain ? "发码结果正在确认，请保留申请回执并稍后查询。请勿重新申请。" : "正在审核，请保留申请回执并稍后查询。" }, 202);
}

export async function statusRequest(request: Request, id: string, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await readBody(request); } catch { return json({ message: "请求格式无效。" }, 400); }
  if (typeof body.receipt !== "string" || !/^[a-f0-9]{64}$/.test(body.receipt)) return json({ message: "申请不存在或回执无效。" }, 404);
  const application = await load(id, env);
  if (!application || !await secureMatches(await digest(`receipt:${body.receipt}`, env.HASH_SALT), application.receipt_hash)) {
    return json({ message: "申请不存在或回执无效。" }, 404);
  }
  return applicationResponse(application, env);
}

export async function dailyStatus(env: Env): Promise<Response> {
  const day = beijingDay();
  // The first reservation fixes today's quota. A rolling deployment must not
  // make the public status disagree with the quota trigger already in D1.
  const quota = await env.DB.prepare("SELECT quota_limit FROM nw_daily_quota WHERE day = ?")
    .bind(day).first<{ quota_limit: number }>();
  const limit = quota?.quota_limit ?? dailyLimit(env);
  const result = await env.DB.prepare("SELECT COUNT(*) AS count FROM nw_quota_reservations WHERE day = ?").bind(day).first<{ count: number }>();
  const available = Math.max(0, limit - (result?.count ?? 0));
  return json({ day, limit, available, exhausted: available === 0, timeZone: "Asia/Shanghai" });
}

export async function handleApplication(request: Request, env: Env): Promise<Response> {
  let input: Record<string, unknown>;
  try { input = await readBody(request); } catch { return json({ message: "请求格式无效或内容过大。" }, 400); }
  const id = input.applicationId;
  const receipt = input.receipt;
  const text = typeof input.application === "string" ? input.application.trim() : "";
  const fingerprint = typeof input.fingerprint === "string" ? input.fingerprint.toLowerCase() : "";
  if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id) ||
      typeof receipt !== "string" || !/^[a-f0-9]{64}$/.test(receipt) || !/^[a-f0-9]{64}$/.test(fingerprint) || [...text].length < 100 || [...text].length > 5000) {
    return json({ message: "申请须为 100–5000 个字符，并包含有效的设备标识和申请回执。" }, 400);
  }
  const receiptHash = await digest(`receipt:${receipt}`, env.HASH_SALT);
  const existing = await load(id, env);
  if (existing) {
    if (!await secureMatches(receiptHash, existing.receipt_hash)) return json({ message: "申请回执无效。" }, 403);
    return applicationResponse(existing, env);
  }
  const ip = request.headers.get("CF-Connecting-IP") || (isLocal(request, env) ? "127.0.0.1" : "");
  if (!ip) return json({ message: "无法识别来源 IP。" }, 400);
  const ipHash = await digest(`ip:${ip}`, env.HASH_SALT);
  // A service-wide budget also protects against distributed IPs. D1 remains the authority.
  if (!await takeRate("apply-ip", ipHash, 5, env) || !await takeRate("apply-global", "all", 20, env)) return json({ message: "提交过于频繁，请稍后再试。" }, 429);
  try {
    if (!await verifyTurnstile(input.turnstileToken, ip, request, env)) return json({ message: "人机验证失败，请刷新验证后重试。" }, 403);
  } catch { return json({ message: "人机验证服务暂不可用。" }, 503); }
  const fingerprintHash = await digest(`fingerprint:${fingerprint}`, env.HASH_SALT);
  const now = new Date().toISOString();
  const application: Application = { id, receipt_hash: receiptHash, ip_hash: ipHash, fingerprint_hash: fingerprintHash,
    day: beijingDay(), application_text: text, status: "reviewing", ai_approved: null, reason: null, error_code: null,
    encrypted_invite: null, invite_code_hash: null, expires_at: null, issue_started_at: null, resolve_after: null, created_at: now, updated_at: now };
  try { await reserve(application, env); } catch (error) {
    const raced = await load(id, env);
    if (raced && await secureMatches(receiptHash, raced.receipt_hash)) return applicationResponse(raced, env);
    const message = error instanceof Error ? error.message : "";
    if (message.includes("nw_daily_quota_exhausted")) return json({ message: "今日发放名额已满，请明天再来。" }, 429);
    if (/UNIQUE constraint failed: nw_(daily_attempts|eligibility)/.test(message)) {
      return json({ message: "该 IP 或设备今日已申请、正在处理，或曾成功领取邀请码。" }, 429);
    }
    throw error;
  }
  let decision;
  try {
    if (await isDuplicate(text, env)) {
      await finishBeforeCreation(id, "rejected", "申请与已通过内容过于相似，请独立说明个人需求。", "duplicate", env);
      return applicationResponse((await load(id, env))!, env);
    }
    decision = await review(text, env);
  } catch {
    await finishBeforeCreation(id, "failed", "审核服务暂不可用，本次不计入申请次数。", "review_unavailable", env);
    return applicationResponse((await load(id, env))!, env);
  }
  if (!decision.approved) {
    await finishBeforeCreation(id, "rejected", decision.reason, "review_rejected", env);
    return applicationResponse((await load(id, env))!, env);
  }
  let token: string;
  try { token = await accessToken(env); } catch {
    await finishBeforeCreation(id, "failed", "发码服务暂不可用，本次不计入申请次数。", "authentication_failed", env);
    return applicationResponse((await load(id, env))!, env);
  }
  const started = new Date();
  // CAS is the only gateway to the non-idempotent upstream creation call.
  const claimed = await env.DB.prepare(`UPDATE nw_applications SET status = 'creating', ai_approved = 1, reason = ?, issue_started_at = ?, resolve_after = ?, updated_at = ?
    WHERE id = ? AND status = 'reviewing'`).bind(decision.reason, started.toISOString(),
    new Date(started.getTime() + expiryHours(env) * 3600000 + 600000).toISOString(), started.toISOString(), id).run();
  if (claimed.meta.changes !== 1) return applicationResponse((await load(id, env))!, env);
  let invite: Invite;
  try { invite = await createInvite(token, env); } catch (error) {
    if (error instanceof CreationError && error.definite) await failDefiniteCreation(id, env);
    else await markUncertain(id, env);
    return applicationResponse((await load(id, env))!, env);
  }
  try {
    const encrypted = await encrypt(invite, id, env);
    const codeHash = await digest(`invite:${invite.code}`, env.HASH_SALT);
    // Retry persistence only. Never retry creation, even when the response was lost.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (await saveInvite(id, encrypted, codeHash, invite.expiresAt, env)) return applicationResponse((await load(id, env))!, env);
      } catch { /* a subsequent read/write may confirm a committed result */ }
    }
  } catch { /* leave the reservation for an authenticated administrator to reconcile */ }
  await markUncertain(id, env);
  return applicationResponse((await load(id, env))!, env);
}
