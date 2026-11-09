-- NodeWarden invitation distributor. New names leave legacy NodeLoc tables untouched.
-- Run against a NEW D1 database. This file can be applied more than once.
CREATE TABLE IF NOT EXISTS nw_applications (
  id TEXT PRIMARY KEY,
  receipt_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  fingerprint_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  application_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reviewing','rejected','failed','creating','uncertain','succeeded')),
  ai_approved INTEGER CHECK(ai_approved IN (0,1)),
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
CREATE INDEX IF NOT EXISTS nw_applications_approved ON nw_applications(ai_approved, id);

CREATE TABLE IF NOT EXISTS nw_daily_attempts (
  kind TEXT NOT NULL CHECK(kind IN ('ip','fingerprint')),
  subject_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  application_id TEXT NOT NULL REFERENCES nw_applications(id),
  PRIMARY KEY(kind, subject_hash, day)
);
-- Held during review/creation, including across midnight; retained forever after success.
CREATE TABLE IF NOT EXISTS nw_eligibility (
  kind TEXT NOT NULL CHECK(kind IN ('ip','fingerprint')),
  subject_hash TEXT NOT NULL,
  application_id TEXT NOT NULL REFERENCES nw_applications(id),
  PRIMARY KEY(kind, subject_hash)
);
CREATE INDEX IF NOT EXISTS nw_eligibility_application ON nw_eligibility(application_id);

CREATE TABLE IF NOT EXISTS nw_daily_quota (
  day TEXT PRIMARY KEY,
  quota_limit INTEGER NOT NULL CHECK(quota_limit >= 1)
);
CREATE TABLE IF NOT EXISTS nw_quota_reservations (
  application_id TEXT PRIMARY KEY REFERENCES nw_applications(id),
  day TEXT NOT NULL REFERENCES nw_daily_quota(day)
);
CREATE INDEX IF NOT EXISTS nw_reservations_day ON nw_quota_reservations(day);
CREATE TRIGGER IF NOT EXISTS nw_enforce_quota
BEFORE INSERT ON nw_quota_reservations
WHEN (SELECT COUNT(*) FROM nw_quota_reservations WHERE day = NEW.day) >=
     (SELECT quota_limit FROM nw_daily_quota WHERE day = NEW.day)
BEGIN
  SELECT RAISE(ABORT, 'nw_daily_quota_exhausted');
END;

-- Fixed minute windows bound verification/AI costs; records expire logically, without Cron.
CREATE TABLE IF NOT EXISTS nw_rate_limits (
  bucket TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(bucket, subject_hash, window)
);
CREATE TABLE IF NOT EXISTS nw_admin_audit (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES nw_applications(id),
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS nw_rate_limits_window ON nw_rate_limits(window);
