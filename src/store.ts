import type { Application, Env } from "./types.js";

export const applicationColumns = `a.id, e.email, e.email_hash, a.ip_hash, a.fingerprint_hash, a.day, a.application_text, a.status,
  a.reason, a.error_code, a.encrypted_invite, a.invite_code_hash, a.expires_at, a.issue_started_at, a.resolve_after, a.created_at, a.updated_at`;
export const applicationJoin = "nw_applications a LEFT JOIN nw_application_emails e ON e.application_id = a.id";
export const load = (id: string, env: Env) => env.DB.prepare(`SELECT ${applicationColumns} FROM ${applicationJoin} WHERE a.id = ?`)
  .bind(id).first<Application>();
export const loadByEmail = (hash: string, env: Env) => env.DB.prepare(`SELECT ${applicationColumns} FROM ${applicationJoin}
  WHERE e.email_hash = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`).bind(hash).first<Application>();

export async function takeRate(bucket: string, subject: string, limit: number, env: Env): Promise<boolean> {
  const window = Math.floor(Date.now() / 60000);
  // Indexed, bounded cleanup on requests; no scheduled task.
  if (bucket.endsWith("-global")) await env.DB.prepare(`DELETE FROM nw_rate_limits WHERE rowid IN
    (SELECT rowid FROM nw_rate_limits WHERE window < ? ORDER BY window LIMIT 200)`)
    .bind(window - 60).run();
  const row = await env.DB.prepare(`INSERT INTO nw_rate_limits (bucket, subject_hash, window, count) VALUES (?, ?, ?, 1)
    ON CONFLICT(bucket, subject_hash, window) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`)
    .bind(bucket, subject, window, limit).first<{ count: number }>();
  return row !== null;
}

export async function reserve(application: Application, env: Env): Promise<void> {
  // All inserts roll back if an email, IP or device already holds eligibility.
  const { id, ip_hash: ip, fingerprint_hash: fingerprint, day, created_at: now } = application;
  await env.DB.batch([
    // receipt_hash is an unused compatibility column in existing databases.
    env.DB.prepare("INSERT INTO nw_applications (id, receipt_hash, ip_hash, fingerprint_hash, day, application_text, status, created_at, updated_at) VALUES (?, '', ?, ?, ?, ?, 'reviewing', ?, ?)")
      .bind(id, ip, fingerprint, day, application.application_text, now, now),
    env.DB.prepare("INSERT INTO nw_application_emails (application_id, email, email_hash, active_email_hash) VALUES (?, ?, ?, ?)")
      .bind(id, application.email, application.email_hash, application.email_hash),
    env.DB.prepare("INSERT INTO nw_daily_attempts (kind, subject_hash, day, application_id) VALUES ('ip', ?, ?, ?)").bind(ip, day, id),
    env.DB.prepare("INSERT INTO nw_daily_attempts (kind, subject_hash, day, application_id) VALUES ('fingerprint', ?, ?, ?)").bind(fingerprint, day, id),
    env.DB.prepare("INSERT INTO nw_eligibility (kind, subject_hash, application_id) VALUES ('ip', ?, ?)").bind(ip, id),
    env.DB.prepare("INSERT INTO nw_eligibility (kind, subject_hash, application_id) VALUES ('fingerprint', ?, ?)").bind(fingerprint, id),
  ]);
}

export async function finishReview(id: string, status: "rejected" | "failed", reason: string, code: string, env: Env): Promise<boolean> {
  const predicate = "SELECT id FROM nw_applications WHERE id = ? AND status = 'reviewing'";
  const results = await env.DB.batch([
    env.DB.prepare(`DELETE FROM nw_eligibility WHERE application_id IN (${predicate})`).bind(id),
    env.DB.prepare(`UPDATE nw_application_emails SET active_email_hash = NULL WHERE application_id IN (${predicate})`).bind(id),
    ...(status === "failed" ? [env.DB.prepare(`DELETE FROM nw_daily_attempts WHERE application_id IN (${predicate})`).bind(id)] : []),
    env.DB.prepare("UPDATE nw_applications SET status = ?, reason = ?, error_code = ?, updated_at = ? WHERE id = ? AND status = 'reviewing'")
      .bind(status, reason, code, new Date().toISOString(), id),
  ]);
  return results[results.length - 1].meta.changes === 1;
}

// Only used to reconcile invitations issued by the previous automatic version.
export async function saveInvite(id: string, encrypted: string, codeHash: string, expiresAt: string, env: Env): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE nw_applications SET status = 'succeeded', encrypted_invite = ?, invite_code_hash = ?, expires_at = ?,
    error_code = NULL, updated_at = ? WHERE id = ? AND status IN ('creating','uncertain')
    AND NOT EXISTS (SELECT 1 FROM nw_applications WHERE invite_code_hash = ? AND id <> ?)`)
    .bind(encrypted, codeHash, expiresAt, new Date().toISOString(), id, codeHash, id).run();
  if (result.meta.changes === 1) return true;
  const saved = await load(id, env);
  return saved?.status === "succeeded" && saved.invite_code_hash === codeHash;
}
