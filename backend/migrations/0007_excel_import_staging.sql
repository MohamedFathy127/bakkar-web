-- Staged Excel imports. Raw rows are retained for audit and never applied automatically.
CREATE TABLE import_batch_rows (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT,
  row_number INTEGER NOT NULL CHECK (row_number > 0),
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  normalized_json TEXT NOT NULL CHECK (json_valid(normalized_json)),
  issues_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(issues_json)),
  status TEXT NOT NULL DEFAULT 'preview'
    CHECK (status IN ('preview','applied','skipped','failed')),
  applied_action TEXT CHECK (applied_action IS NULL OR applied_action IN ('created','matched')),
  applied_product_id TEXT REFERENCES products(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  applied_at TEXT,
  UNIQUE(batch_id, row_number)
);

CREATE INDEX idx_import_batch_rows_batch ON import_batch_rows(batch_id, row_number);
