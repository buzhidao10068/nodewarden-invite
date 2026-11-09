import { dailyLimit, type Application, type Env } from "./types.js";

export const load = (id: string, env: Env) => env.DB.prepare("SELECT * FROM nw_applications WHERE id = ?").bind(id).first<Application>();

export async function takeRate(bucket: string, subject: string, limit: number, env: Env): Promise<boolean> {
  const window = Math.floor(Date.now() / 60000);
  // Opportunistic bounded cleanup, with an indexed lookup; no scheduled task.
  if (bucket === "apply-global") await env.DB.prepare(`DELETE FROM nw_rate_limits WHERE rowid IN
    (SELECT rowid FROM nw_rate_limits WHERE window < ? ORDER BY window LIMIT 200)`)
    .bind(window - 60).run();
  const row = await env.DB.prepare(`INSERT INTO nw_rate_limits (bucket, subject_hash, window, count) VALUES (?, ?, ?, 1)
    ON CONFLICT(bucket, subject_hash, window) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`)
    .bind(bucket, subject, window, limit).first<{ count: number }>();
  return row !== null;
}

export async function reserve(application: Application, env: Env): Promise<void> {
  // Every statement rolls back if any uniqueness check or the quota trigger fails.
  const { id, ip_hash: ip, fingerprint_hash: fingerprint, day, created_at: now } = application;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO nw_applications (id, receipt_hash, ip_hash, fingerprint_hash, day, application_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'reviewing', ?, ?)")
      .bind(id, application.receipt_hash, ip, fingerprint, day, application.application_text, now, now),
    env.DB.prepare("INSERT INTO nw_daily_attempts (kind, subject_hash, day, application_id) VALUES ('ip', ?, ?, ?)").bind(ip, day, id),
    env.DB.prepare("INSERT INTO nw_daily_attempts (kind, subject_hash, day, application_id) VALUES ('fingerprint', ?, ?, ?)").bind(fingerprint, day, id),
    env.DB.prepare("INSERT INTO nw_eligibility (kind, subject_hash, application_id) VALUES ('ip', ?, ?)").bind(ip, id),
    env.DB.prepare("INSERT INTO nw_eligibility (kind, subject_hash, application_id) VALUES ('fingerprint', ?, ?)").bind(fingerprint, id),
    env.DB.prepare("INSERT INTO nw_daily_quota (day, quota_limit) VALUES (?, ?) ON CONFLICT(day) DO NOTHING").bind(day, dailyLimit(env)),
    env.DB.prepare("INSERT INTO nw_quota_reservations (application_id, day) VALUES (?, ?)").bind(id, day),
  ]);
}

export async function finishBeforeCreation(id: string, status: "rejected" | "failed", reason: string, code: string, env: Env): Promise<void> {
  // Only reviewing applications can release reservations automatically.
  const predicate = "SELECT id FROM nw_applications WHERE id = ? AND status = 'reviewing'";
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM nw_eligibility WHERE application_id IN (${predicate})`).bind(id),
    env.DB.prepare(`DELETE FROM nw_quota_reservations WHERE application_id IN (${predicate})`).bind(id),
    ...(status === "failed" ? [env.DB.prepare(`DELETE FROM nw_daily_attempts WHERE application_id IN (${predicate})`).bind(id)] : []),
    env.DB.prepare("UPDATE nw_applications SET status = ?, reason = ?, error_code = ?, ai_approved = ?, updated_at = ? WHERE id = ? AND status = 'reviewing'")
      .bind(status, reason, code, status === "rejected" ? 0 : null, new Date().toISOString(), id),
  ]);
}

export async function failDefiniteCreation(id: string, env: Env): Promise<void> {
  const predicate = "SELECT id FROM nw_applications WHERE id = ? AND status = 'creating'";
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM nw_eligibility WHERE application_id IN (${predicate})`).bind(id),
    env.DB.prepare(`DELETE FROM nw_quota_reservations WHERE application_id IN (${predicate})`).bind(id),
    env.DB.prepare(`DELETE FROM nw_daily_attempts WHERE application_id IN (${predicate})`).bind(id),
    env.DB.prepare("UPDATE nw_applications SET status = 'failed', error_code = 'upstream_rejected', reason = '发码服务暂不可用，可稍后重新申请。', updated_at = ? WHERE id = ? AND status = 'creating'")
      .bind(new Date().toISOString(), id),
  ]);
}

export async function markUncertain(id: string, env: Env): Promise<void> {
  await env.DB.prepare("UPDATE nw_applications SET status = 'uncertain', error_code = 'creation_unknown', updated_at = ? WHERE id = ? AND status = 'creating'")
    .bind(new Date().toISOString(), id).run();
}

export async function saveInvite(id: string, encrypted: string, codeHash: string, expiresAt: string, env: Env): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE nw_applications SET status = 'succeeded', encrypted_invite = ?, invite_code_hash = ?, expires_at = ?,
    error_code = NULL, updated_at = ? WHERE id = ? AND status IN ('creating','uncertain')
    AND NOT EXISTS (SELECT 1 FROM nw_applications WHERE invite_code_hash = ? AND id <> ?)`)
    .bind(encrypted, codeHash, expiresAt, new Date().toISOString(), id, codeHash, id).run();
  if (result.meta.changes === 1) return true;
  const saved = await load(id, env);
  return saved?.status === "succeeded" && saved.invite_code_hash === codeHash;
}
