export interface Env {
  DB: D1Database;
  NODEWARDEN_URL: string;
  NODEWARDEN_CLIENT_ID: string;
  NODEWARDEN_CLIENT_SECRET: string;
  NODEWARDEN_MASTER_PASSWORD_HASH: string;
  DATA_ENCRYPTION_KEY: string;
  HASH_SALT: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  ADMIN_TOKEN?: string;
  DAILY_INVITE_LIMIT?: string;
  INVITE_EXPIRES_IN_HOURS?: string;
  ALLOW_INSECURE_LOCAL_DEV?: string;
}

export type Status = "reviewing" | "rejected" | "failed" | "creating" | "uncertain" | "succeeded";
export interface Application {
  id: string;
  receipt_hash: string;
  ip_hash: string;
  fingerprint_hash: string;
  day: string;
  application_text: string;
  status: Status;
  reason: string | null;
  error_code: string | null;
  encrypted_invite: string | null;
  invite_code_hash: string | null;
  expires_at: string | null;
  issue_started_at: string | null;
  resolve_after: string | null;
  created_at: string;
  updated_at: string;
}
export interface Invite {
  code: string;
  inviteLink: string;
  expiresAt: string;
  createdAt: string;
  status: string;
  usedBy: string | null;
}

export function integer(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error("Invalid numeric configuration");
  return parsed;
}
export const dailyLimit = (env: Env) => integer(env.DAILY_INVITE_LIMIT, 3, 10000);
export const expiryHours = (env: Env) => integer(env.INVITE_EXPIRES_IN_HOURS, 1, 720);
