-- Fix outbound movements with an existing balance.
-- The attempted INSERT row must satisfy inventory_balances.quantity >= 0
-- before SQLite resolves the primary-key conflict into an UPDATE.
DROP TRIGGER IF EXISTS stock_movement_apply_after_insert;

CREATE TRIGGER stock_movement_apply_after_insert
AFTER INSERT ON stock_movements
BEGIN
  INSERT INTO inventory_balances(product_id, location_id, quantity, updated_at)
  VALUES (NEW.product_id, NEW.location_id, MAX(NEW.quantity_delta, 0), NEW.created_at)
  ON CONFLICT(product_id, location_id) DO UPDATE SET
    quantity = inventory_balances.quantity + NEW.quantity_delta,
    updated_at = NEW.created_at;
END;
