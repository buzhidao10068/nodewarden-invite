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
  /** web: session API, api: Bearer API, both: enables both. Defaults to both. */
  ADMIN_ACCESS_MODE?: string;
  ALLOW_INSECURE_LOCAL_DEV?: string;
}

// Creation states are retained for records from the previous automatic version.
export type Status = "reviewing" | "rejected" | "failed" | "creating" | "uncertain" | "succeeded";
export interface Application {
  id: string;
  email: string | null;
  email_hash: string | null;
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
