-- Preserve the original unique import hash while allowing the same workbook
-- to be imported again after a previous batch has been applied.
ALTER TABLE import_batches ADD COLUMN content_sha256 TEXT;

UPDATE import_batches
SET content_sha256 = file_sha256
WHERE content_sha256 IS NULL;

CREATE INDEX idx_import_batches_content_sha256
  ON import_batches(content_sha256, created_at);
