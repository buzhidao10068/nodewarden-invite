-- Dedicated invitation database; preserves existing applications and legacy columns.
-- Reapply this entire file when upgrading from the previous automatic version.
CREATE TABLE IF NOT EXISTS nw_applications (
  id TEXT PRIMARY KEY,
  receipt_hash TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL,
  fingerprint_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  application_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reviewing','rejected','failed','creating','uncertain','succeeded')),
  reason TEXT,
  error_code TEXT,
  encrypted_invite TEXT,
  invite_code_hash TEXT UNIQUE,
  expires_at TEXT,
  issue_started_at TEXT,
  resolve_after TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS nw_applications_status ON nw_applications(status, created_at);
CREATE INDEX IF NOT EXISTS nw_applications_dedup ON nw_applications(status, id);

-- A separate table makes the upgrade repeatable without altering legacy rows.
CREATE TABLE IF NOT EXISTS nw_application_emails (
  application_id TEXT PRIMARY KEY REFERENCES nw_applications(id),
  email TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  active_email_hash TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS nw_application_emails_hash ON nw_application_emails(email_hash);

CREATE TABLE IF NOT EXISTS nw_daily_attempts (
  kind TEXT NOT NULL CHECK(kind IN ('ip','fingerprint')),
  subject_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  application_id TEXT NOT NULL REFERENCES nw_applications(id),
  PRIMARY KEY(kind, subject_hash, day)
);
CREATE TABLE IF NOT EXISTS nw_eligibility (
  kind TEXT NOT NULL CHECK(kind IN ('ip','fingerprint')),
  subject_hash TEXT NOT NULL,
  application_id TEXT NOT NULL REFERENCES nw_applications(id),
  PRIMARY KEY(kind, subject_hash)
);
CREATE INDEX IF NOT EXISTS nw_eligibility_application ON nw_eligibility(application_id);

-- Retire only the old daily issuance accounting. Application history is kept.
DROP TRIGGER IF EXISTS nw_enforce_quota;
DROP TABLE IF EXISTS nw_quota_reservations;
DROP TABLE IF EXISTS nw_daily_quota;

CREATE TABLE IF NOT EXISTS nw_rate_limits (
  bucket TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(bucket, subject_hash, window)
);
CREATE INDEX IF NOT EXISTS nw_rate_limits_window ON nw_rate_limits(window);
CREATE TABLE IF NOT EXISTS nw_admin_audit (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES nw_applications(id),
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);
