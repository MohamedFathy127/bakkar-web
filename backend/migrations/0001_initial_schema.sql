-- Bakkar Inventory / Cloudflare D1
-- Initial schema only. Apply only to a newly created, empty D1 database.
PRAGMA foreign_keys = ON;

CREATE TABLE brands (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name_ar TEXT NOT NULL UNIQUE,
  name_en TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  part_name_ar TEXT NOT NULL,
  part_name_en TEXT,
  category_id TEXT REFERENCES categories(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  condition TEXT,
  part_code TEXT,
  aliases TEXT,
  internal_notes TEXT,
  sale_price_piasters INTEGER CHECK (sale_price_piasters IS NULL OR sale_price_piasters >= 0),
  purchase_price_piasters INTEGER CHECK (purchase_price_piasters IS NULL OR purchase_price_piasters >= 0),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0,1)),
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE product_fitments (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  model TEXT NOT NULL,
  year_from INTEGER CHECK (year_from IS NULL OR (year_from >= 1900 AND year_from <= 2100)),
  year_to INTEGER CHECK (year_to IS NULL OR (year_to >= 1900 AND year_to <= 2100)),
  compatibility_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (compatibility_status IN ('pending','confirmed','unconfirmed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (year_from IS NULL OR year_to IS NULL OR year_to >= year_from),
  UNIQUE(product_id, brand_id, model, year_from, year_to)
);

CREATE TABLE inventory_balances (
  product_id TEXT NOT NULL REFERENCES products(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (product_id, location_id)
);

CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  movement_group_id TEXT,
  movement_type TEXT NOT NULL
    CHECK (movement_type IN ('in','out','adjustment','transfer_in','transfer_out')),
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reason TEXT,
  reference TEXT,
  actor_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (movement_type IN ('in','transfer_in') AND quantity_delta > 0) OR
    (movement_type IN ('out','transfer_out') AND quantity_delta < 0) OR
    movement_type = 'adjustment'
  )
);

CREATE TABLE staff_accounts (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('owner','staff')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  actor_email TEXT NOT NULL,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  file_sha256 TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'preview'
    CHECK (status IN ('preview','applied','rejected','failed')),
  total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  created_count INTEGER NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  updated_count INTEGER NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  applied_at TEXT
);

CREATE INDEX idx_products_part_name_ar ON products(part_name_ar);
CREATE INDEX idx_products_part_code ON products(part_code);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_public ON products(is_public, archived_at);
CREATE INDEX idx_fitments_brand_model ON product_fitments(brand_id, model);
CREATE INDEX idx_fitments_product ON product_fitments(product_id);
CREATE INDEX idx_inventory_location ON inventory_balances(location_id);
CREATE INDEX idx_movements_product_created ON stock_movements(product_id, created_at DESC);
CREATE INDEX idx_movements_location_created ON stock_movements(location_id, created_at DESC);
CREATE INDEX idx_audit_entity_created ON audit_log(entity_type, entity_id, created_at DESC);

-- Public catalog projection intentionally excludes purchase price, internal notes,
-- exact stock balances, staff accounts, imports, and audit history.
CREATE VIEW public_catalog AS
SELECT
  p.id AS product_id,
  p.part_name_ar,
  p.part_name_en,
  p.condition,
  p.part_code,
  p.sale_price_piasters,
  c.name_ar AS category_name_ar,
  c.name_en AS category_name_en,
  b.name_ar AS vehicle_brand_ar,
  b.name_en AS vehicle_brand_en,
  f.model AS vehicle_model,
  f.year_from,
  f.year_to,
  f.compatibility_status
FROM products p
JOIN product_fitments f ON f.product_id = p.id
JOIN brands b ON b.id = f.brand_id
LEFT JOIN categories c ON c.id = p.category_id
WHERE p.is_public = 1
  AND p.archived_at IS NULL;

-- Movements are append-only. Corrections must be represented by a compensating
-- movement rather than rewriting historical stock records.
CREATE TRIGGER stock_movements_no_update
BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements are append-only');
END;

CREATE TRIGGER stock_movements_no_delete
BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements are append-only');
END;
