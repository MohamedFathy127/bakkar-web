import test from "node:test";
import assert from "node:assert/strict";
import { handleInventoryAdmin, validateFitments, validateProduct, normalizePartKey } from "./inventory.js";

test("product validation accepts explicit zero prices and rejects public unconfirmed fitments", () => {
  const base = { part_name_ar: "مساعد", sale_price_piasters: 0, purchase_price_piasters: 0 };
  const privateProduct = validateProduct(base);
  assert.equal(privateProduct.sale, 0);
  assert.equal(privateProduct.purchase, 0);
  assert.equal(privateProduct.isPublic, 0);
  assert.equal(validateProduct({ ...base, is_public: true, fitments: [] }), null);
  assert.equal(validateProduct({
    ...base,
    is_public: true,
    fitments: [{ brand_id: "brand-1", model: "Sportage", year_from: 2020, year_to: 2024, compatibility_status: "pending" }],
  }), null);
  assert.equal(validateProduct({
    ...base,
    is_public: true,
    fitments: [{ brand_id: "brand-1", model: "Sportage", year_from: 2020, year_to: 2024, compatibility_status: "confirmed" }],
  }).isPublic, 1);
});

test("fitment validation rejects bad year bounds and duplicate text normalization is stable", () => {
  assert.equal(validateFitments([{ brand_id: "b", model: "M", year_from: 2025, year_to: 2020 }]), null);
  assert.equal(validateFitments([{ brand_id: "b", model: "M", year_from: 2200 }]), null);
  assert.equal(normalizePartKey("أكسدام ـ أمامي"), normalizePartKey("اكسدام امامي"));
});

test("stock movement writes require same-origin and keep movement plus audit in one D1 batch", async () => {
  const statements = [];
  const db = {
    prepare(sql) { return { bind(...values) { return { sql, values }; } }; },
    async batch(items) {
      statements.push(...items);
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
    },
  };
  const requestBody = { product_id: "product-1", location_id: "location-1", movement_type: "in", quantity_delta: 4 };
  const crossOrigin = await handleInventoryAdmin(new Request("https://api.example/api/admin/stock-movements", {
    method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" }, body: JSON.stringify(requestBody),
  }), new URL("https://api.example/api/admin/stock-movements"), { DB: db }, { email: "owner@example.test" });
  assert.equal(crossOrigin.status, 403);
  assert.equal(statements.length, 0);

  const response = await handleInventoryAdmin(new Request("https://api.example/api/admin/stock-movements", {
    method: "POST", headers: { Origin: "https://api.example", "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify(requestBody),
  }), new URL("https://api.example/api/admin/stock-movements"), { DB: db }, { email: "owner@example.test" });
  assert.equal(response.status, 201);
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /inventory_balances/);
  assert.match(statements[0].sql, /\+ \? >= 0/);
  assert.match(statements[1].sql, /INSERT INTO audit_log/);
});

test("stock movement rejects an invalid signed quantity before issuing database writes", async () => {
  let batchCount = 0;
  const db = { prepare(sql) { return { bind(...values) { return { sql, values }; } }; }, async batch() { batchCount++; return []; } };
  const response = await handleInventoryAdmin(new Request("https://api.example/api/admin/stock-movements", {
    method: "POST", headers: { Origin: "https://api.example", "Content-Type": "application/json" },
    body: JSON.stringify({ product_id: "p", location_id: "l", movement_type: "in", quantity_delta: -1 }),
  }), new URL("https://api.example/api/admin/stock-movements"), { DB: db }, { email: "owner@example.test" });
  assert.equal(response.status, 400);
  assert.equal(batchCount, 0);
});
