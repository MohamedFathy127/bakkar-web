-- Seed the vehicle brands already used by Bakkar's inventory.
-- Safe to apply more than once; IDs and slugs are stable.
INSERT OR IGNORE INTO brands (id, slug, name_ar, name_en) VALUES
  ('brand-hyundai', 'hyundai', 'هيونداي', 'Hyundai'),
  ('brand-kia', 'kia', 'كيا', 'Kia'),
  ('brand-ssangyong', 'ssangyong', 'سانج يونج', 'SsangYong');
