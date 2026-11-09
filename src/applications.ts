import { isDuplicate } from "./dedup.js";
import { beijingDay, digest, isLocal, json, readBody, verifyTurnstile } from "./security.js";
import { finishReview, load, loadByEmail, reserve, takeRate } from "./store.js";
import type { Application, Env } from "./types.js";

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || /[^\x21-\x7e]/.test(email)) return null;
  const parts = email.split("@");
  if (parts.length !== 2 || parts[0].length > 64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(parts[0]) ||
      parts[0].startsWith(".") || parts[0].endsWith(".") || parts[0].includes("..")) return null;
  const labels = parts[1].split(".");
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return email;
}

// Email is a lookup key, not proof of mailbox ownership. Never expose text,
// application IDs, administrator notes, invitation codes or registration links.
export function applicationResponse(application: Application): Response {
  const messages = {
    reviewing: "申请已提交，等待管理员人工审核。审核通过后，管理员会通过邮件发送邀请码，请留意收件箱和垃圾邮件。",
    succeeded: "邀请已处理，请留意管理员发送的邮件。如未收到，请联系管理员。",
    rejected: "申请未通过审核。",
    failed: "申请处理失败，可以重新提交申请。",
    creating: "历史申请正在核对，请联系管理员。",
    uncertain: "历史申请正在核对，请联系管理员。",
  };
  return json({ status: application.status, message: messages[application.status] });
}

function sourceIp(request: Request, env: Env): string {
  return request.headers.get("CF-Connecting-IP") || (isLocal(request, env) ? "127.0.0.1" : "");
}

export async function statusRequest(request: Request, env: Env): Promise<Response> {
  const ip = sourceIp(request, env);
  if (!ip) return json({ message: "无法识别来源 IP。" }, 400);
  const hash = await digest(`ip:${ip}`, env.HASH_SALT);
  if (!await takeRate("status-ip", hash, 10, env) || !await takeRate("status-global", "all", 60, env)) {
    return json({ message: "查询过于频繁，请稍后再试。" }, 429);
  }
  let body: Record<string, unknown>;
  try { body = await readBody(request); } catch { return json({ message: "请求格式无效。" }, 400); }
  const email = normalizeEmail(body.email);
  if (!email) return json({ message: "请填写有效的邮箱地址。" }, 400);
  const application = await loadByEmail(await digest(`email:${email}`, env.HASH_SALT), env);
  return application ? applicationResponse(application) : json({ status: "not_found", message: "暂未查询到申请，请核对填写的邮箱。" });
}

export async function handleApplication(request: Request, env: Env): Promise<Response> {
  let input: Record<string, unknown>;
  try { input = await readBody(request); } catch { return json({ message: "请求格式无效或内容过大。" }, 400); }
  const id = input.applicationId;
  const email = normalizeEmail(input.email);
  const text = typeof input.application === "string" ? input.application.trim() : "";
  const fingerprint = typeof input.fingerprint === "string" ? input.fingerprint.toLowerCase() : "";
  if (!email) return json({ message: "请填写有效的邮箱地址。" }, 400);
  if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id) ||
      !/^[a-f0-9]{64}$/.test(fingerprint) || [...text].length < 1 || [...text].length > 5000) {
    return json({ message: "申请说明须为 1–5000 个字符，并包含有效的设备标识。" }, 400);
  }
  const ip = sourceIp(request, env);
  if (!ip) return json({ message: "无法识别来源 IP。" }, 400);
  const ipHash = await digest(`ip:${ip}`, env.HASH_SALT);
  if (!await takeRate("apply-ip", ipHash, 5, env) || !await takeRate("apply-global", "all", 20, env)) return json({ message: "提交过于频繁，请稍后再试。" }, 429);
  try {
    if (!await verifyTurnstile(input.turnstileToken, ip, request, env)) return json({ message: "人机验证失败，请刷新验证后重试。" }, 403);
  } catch { return json({ message: "人机验证服务暂不可用。" }, 503); }
  const emailHash = await digest(`email:${email}`, env.HASH_SALT);
  const existing = await load(id, env);
  if (existing) return existing.email_hash === emailHash ? applicationResponse(existing) : json({ message: "申请标识已使用，请刷新页面后重试。" }, 409);
  const now = new Date().toISOString();
  const application: Application = { id, email, email_hash: emailHash, ip_hash: ipHash,
    fingerprint_hash: await digest(`fingerprint:${fingerprint}`, env.HASH_SALT), day: beijingDay(), application_text: text,
    status: "reviewing", reason: null, error_code: null, encrypted_invite: null, invite_code_hash: null, expires_at: null,
    issue_started_at: null, resolve_after: null, created_at: now, updated_at: now };
  try { await reserve(application, env); } catch (error) {
    const raced = await load(id, env);
    if (raced?.email_hash === emailHash) return applicationResponse(raced);
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE constraint failed: nw_application_emails")) return json({ message: "该邮箱已有待审核或已发送邀请的申请，请使用邮箱查询状态。" }, 409);
    if (/UNIQUE constraint failed: nw_(daily_attempts|eligibility)/.test(message)) {
      return json({ message: "该 IP 或设备今日已申请、正在处理，或曾成功领取邀请码。" }, 429);
    }
    throw error;
  }
  try {
    if (await isDuplicate(text, env)) {
      if (!await finishReview(id, "rejected", "申请内容与已有发码记录过于相似。", "duplicate", env)) {
        return applicationResponse((await load(id, env))!);
      }
      return json({ status: "rejected", message: "申请内容与已有记录过于相似，请独立填写申请说明。" }, 403);
    }
  } catch {
    if (!await finishReview(id, "failed", "申请检查暂不可用。", "duplicate_check_unavailable", env)) {
      return applicationResponse((await load(id, env))!);
    }
    return json({ status: "failed", message: "申请检查暂不可用，请稍后重新提交。" }, 503);
  }
  // New applications remain in review. Administrators create and email invites manually.
  return applicationResponse((await load(id, env))!);
}
