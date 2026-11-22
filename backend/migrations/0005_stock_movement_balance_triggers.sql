-- Keep stock balances synchronized from the append-only movement ledger.
-- The BEFORE trigger prevents negative stock and invalid references.
-- The AFTER trigger applies every accepted movement exactly once.
CREATE TRIGGER stock_movement_validate_before_insert
BEFORE INSERT ON stock_movements
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM products
      WHERE id = NEW.product_id AND archived_at IS NULL
    ) THEN RAISE(ABORT, 'product_not_available')
  END;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM locations
      WHERE id = NEW.location_id AND active = 1
    ) THEN RAISE(ABORT, 'location_not_available')
  END;

  SELECT CASE
    WHEN COALESCE((
      SELECT quantity FROM inventory_balances
      WHERE product_id = NEW.product_id AND location_id = NEW.location_id
    ), 0) + NEW.quantity_delta < 0
    THEN RAISE(ABORT, 'insufficient_stock')
  END;
END;

CREATE TRIGGER stock_movement_apply_after_insert
AFTER INSERT ON stock_movements
BEGIN
  INSERT INTO inventory_balances(product_id, location_id, quantity, updated_at)
  VALUES (NEW.product_id, NEW.location_id, NEW.quantity_delta, NEW.created_at)
  ON CONFLICT(product_id, location_id) DO UPDATE SET
    quantity = inventory_balances.quantity + NEW.quantity_delta,
    updated_at = NEW.created_at;
END;
