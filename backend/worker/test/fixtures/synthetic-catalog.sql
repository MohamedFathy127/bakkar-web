-- Synthetic-only local D1 fixture. Never use against either connected database.
INSERT INTO categories(id,name_ar,name_en,sort_order,active)
VALUES('category-synthetic','عفشة','Suspension',1,1);

INSERT INTO staff_accounts(email,role,active)
VALUES('integration-owner@example.invalid','owner',1);
INSERT INTO admin_sessions(token_hash,email,expires_at)
VALUES('3IMQq02xov-In4vPwZA_-Vir24SVSplNL5uy2DwXDXg','integration-owner@example.invalid','2099-01-01T00:00:00.000Z');

INSERT INTO locations(id,name,active)
VALUES('location-synthetic','اختبار محلي',1);

INSERT INTO products(
  id,part_name_ar,part_name_en,category_id,condition,part_code,internal_notes,
  sale_price_piasters,purchase_price_piasters,is_public,created_at,updated_at
) VALUES
  ('product-public-1','مساعد خلفي','Rear shock','category-synthetic','جديدة','SYN-001','ملاحظة داخلية',0,9000,1,'2026-11-22T00:00:00.000Z','2026-11-22T00:00:00.000Z'),
  ('product-public-2','فلتر هواء','Air filter','category-synthetic','جديدة','SYN-002','ملاحظة خاصة',12500,8000,1,'2026-11-22T00:00:00.000Z','2026-11-22T00:00:00.000Z'),
  ('product-private-1','قطعة خاصة','Private part','category-synthetic','استيراد','SYN-003','لا تظهر للعامة',5000,3000,0,'2026-11-22T00:00:00.000Z','2026-11-22T00:00:00.000Z');

INSERT INTO product_fitments(id,product_id,brand_id,model,year_from,year_to,compatibility_status)
VALUES
  ('fitment-public-1','product-public-1','brand-kia','Sportage',2020,2024,'confirmed'),
  ('fitment-public-2','product-public-1','brand-hyundai','Tucson',2021,2023,'confirmed'),
  ('fitment-public-3','product-public-2','brand-kia','Sportage',2018,2022,'confirmed'),
  ('fitment-private-1','product-private-1','brand-kia','Sportage',2020,2024,'confirmed');

INSERT INTO stock_movements(
  id,product_id,location_id,movement_type,quantity_delta,balance_after,reason,actor_email,created_at
) VALUES('movement-synthetic-1','product-public-1','location-synthetic','in',4,4,'synthetic local test','test@example.invalid','2026-11-22T00:00:00.000Z');
