-- Add an IP-wide login throttle alongside the per-email/IP limit.
-- Apply once to the isolated test D1 database before deploying the hardened Worker.
CREATE TABLE login_ip_attempts (
  ip_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_login_ip_attempts_window ON login_ip_attempts(window_started_at);
