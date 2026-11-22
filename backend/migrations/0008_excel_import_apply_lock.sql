-- Concurrency guard for owner-approved import application.
-- Expired locks are recoverable after an interrupted Worker execution.
ALTER TABLE import_batches ADD COLUMN apply_token TEXT;
ALTER TABLE import_batches ADD COLUMN apply_lock_expires_at TEXT;
CREATE INDEX idx_import_batches_apply_lock
  ON import_batches(status, apply_lock_expires_at);
