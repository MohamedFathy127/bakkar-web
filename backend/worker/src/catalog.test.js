import test from "node:test";
import assert from "node:assert/strict";
import { handlePublicCatalog, handlePublicCatalogMeta, encodeCursor, decodeCursor, parseFilters } from "./catalog.js";
import { catalogQuery, escapeHtml, fitsVehicle, formatYears, mapCatalogProduct } from "../../../catalog-client.mjs";
import worker from "./index.js";

function mockDatabase(results) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, values: [] };
      calls.push(call);
      return {
        bind(...values) {
          call.values = values;
          return { all: async () => ({ results: results.shift() || [] }) };
        },
        all: async () => ({ results: results.shift() || [] }),
      };
    },
  };
}

test("catalog filters trim and bound user input and reject invalid years", () => {
  const filters = parseFilters(new URL("https://api.example/api/catalog?q=%20brake%20&brand=Kia&year=2024"));
  assert.deepEqual(filters, { search: "brake", brand: "Kia", category: "", condition: "", model: "", year: 2024 });
  assert.equal(parseFilters(new URL("https://api.example/api/catalog?year=2200")).error, "Invalid vehicle year.");
});

test("catalog cursors are encoded for a specific sort and reject invalid data", () => {
  const cursor = encodeCursor({ sort: "price_asc", priceIsNull: 0, price: 0, id: "product-1" });
  assert.deepEqual(decodeCursor(cursor, "price_asc"), { sort: "price_asc", priceIsNull: 0, price: 0, id: "product-1" });
  assert.equal(decodeCursor(cursor, "name"), undefined);
  assert.equal(decodeCursor("not/a/cursor", "id"), undefined);
});

test("public catalog filters through the public projection, pages, and returns only approved fields", async () => {
  const db = mockDatabase([[
    {
      id: "product-1", name: "مساعد خلفي", name_en: "Rear shock", condition: "جديدة",
      part_code: "R-1", sale_price_piasters: 0, category: "عفشة", in_stock: 1,
      fitments: JSON.stringify([{ brand_ar: "كيا", brand_en: "Kia", model: "Sportage", year_from: 2020, year_to: 2024 }]),
      purchase_price_piasters: 9000, internal_notes: "private", quantity: 7,
    },
    { id: "product-2", name: "مساعد", fitments: "[]", in_stock: 0 },
  ]]);
  const response = await handlePublicCatalog(new URL("https://api.example/api/catalog?q=R-1&brand=Kia&year=2022&limit=1"), { DB: db });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.length, 1);
  assert.equal(body.pagination.has_more, true);
  assert.equal(typeof body.pagination.next_cursor, "string");
  assert.equal(decodeCursor(body.pagination.next_cursor, "id").id, "product-1");
  assert.equal(body.data[0].sale_price_piasters, 0);
  assert.equal(body.data[0].in_stock, true);
  assert.equal(body.data[0].fitments[0].model, "Sportage");
  assert.equal("purchase_price_piasters" in body.data[0], false);
  assert.equal("internal_notes" in body.data[0], false);
  assert.equal("quantity" in body.data[0], false);
  assert.match(db.calls[0].sql, /FROM public_catalog/);
  assert.match(db.calls[0].sql, /sale_price_piasters IS NOT NULL/);
  assert.doesNotMatch(db.calls[0].sql, /SELECT\s+(?:p\.\*|purchase_price_piasters|internal_notes)/i);
  assert.ok(db.calls[0].values.includes("%R-1%"));
});

test("Worker public catalog route keeps CORS and public data allowlists, while admin data stays owner-only", async () => {
  const db = mockDatabase([[
    {
      id: "public-1", name: "مساعد", name_en: "Shock", condition: "جديدة", part_code: "A-1",
      sale_price_piasters: 120000, category: "عفشة", in_stock: 1,
      fitments: JSON.stringify([{ brand_ar: "كيا", brand_en: "Kia", model: "Sportage", year_from: 2020, year_to: 2024 }]),
    },
  ]]);
  const env = { DB: db, ALLOWED_ORIGIN: "https://bakkar-web.pages.dev" };
  const publicResponse = await worker.fetch(new Request("https://api.example/api/catalog", {
    headers: { Origin: "https://bakkar-web.pages.dev" },
  }), env);
  const publicBody = await publicResponse.json();
  assert.equal(publicResponse.headers.get("access-control-allow-origin"), "https://bakkar-web.pages.dev");
  assert.equal(publicBody.data[0].purchase_price_piasters, undefined);
  assert.equal(publicBody.data[0].internal_notes, undefined);

  const adminResponse = await worker.fetch(new Request("https://api.example/api/admin/products"), env);
  assert.equal(adminResponse.status, 401);
  assert.deepEqual(await adminResponse.json(), { error: "Authentication required." });
});

test("login IP rate limit rejects before password verification", async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          calls.push({ sql, values });
          return {
            first: async () => sql.includes("login_ip_attempts")
              ? { attempts: 20, window_started_at: new Date().toISOString() }
              : null,
          };
        },
      };
    },
    async batch() { throw new Error("rate limit should return before writes"); },
  };
  const response = await worker.fetch(new Request("https://api.example/api/admin/login", {
    method: "POST",
    headers: { Origin: "https://api.example", "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1" },
    body: JSON.stringify({ email: "owner@example.test", password: "synthetic-password" }),
  }), { DB: db, ALLOWED_ORIGIN: "https://bakkar-web.pages.dev" });
  assert.equal(response.status, 429);
  assert.equal(calls.length, 2);
});

test("catalog rejects malformed cursors and invalid sort values before querying D1", async () => {
  const db = mockDatabase([]);
  const badSort = await handlePublicCatalog(new URL("https://api.example/api/catalog?sort=internal_notes"), { DB: db });
  assert.equal(badSort.status, 400);
  const badCursor = await handlePublicCatalog(new URL("https://api.example/api/catalog?cursor=not/a/cursor"), { DB: db });
  assert.equal(badCursor.status, 400);
  assert.equal(db.calls.length, 0);
});

test("catalog metadata exposes published brand, category, condition, and model options only", async () => {
  const db = mockDatabase([
    [{ name_en: "Kia", name_ar: "كيا", product_count: 2, internal_notes: "private" }],
    [{ name: "عفشة", purchase_price_piasters: 2 }],
    [{ name: "جديدة" }],
    [{ brand: "Kia", model: "Sportage", quantity: 4 }],
  ]);
  const response = await handlePublicCatalogMeta({ DB: db });
  const body = await response.json();
  assert.deepEqual(body.brands, [{ name_en: "Kia", name_ar: "كيا", product_count: 2 }]);
  assert.deepEqual(body.categories, [{ name: "عفشة" }]);
  assert.deepEqual(body.conditions, [{ name: "جديدة" }]);
  assert.deepEqual(body.models, [{ brand: "Kia", model: "Sportage" }]);
  assert.equal(JSON.stringify(body).includes("private"), false);
  assert.equal(JSON.stringify(body).includes("purchase_price"), false);
  assert.ok(db.calls.every(call => /sale_price_piasters IS NOT NULL/.test(call.sql)));
});

test("client mapping keeps zero prices, hides unknown/private fields, and matches any confirmed fitment", () => {
  const product = mapCatalogProduct({
    id: "uuid-1", name: "مساعد", name_en: "Shock", part_code: "A-1", category: "عفشة",
    sale_price_piasters: 0, in_stock: true, purchase_price_piasters: 999, internal_notes: "private",
    fitments: [
      { brand_en: "Kia", brand_ar: "كيا", model: "Sportage", year_from: 2020, year_to: 2024, compatibility_status: "pending" },
      { brand_en: "Hyundai", brand_ar: "هيونداي", model: "Tucson", year_from: null, year_to: null },
    ],
  });
  assert.equal(product.price, 0);
  assert.equal(product.fitments.length, 2);
  assert.equal("purchase_price_piasters" in product, false);
  assert.equal("internal_notes" in product, false);
  assert.equal(fitsVehicle(product, { brand: "Kia", model: "Sportage", year: 2022 }), true);
  assert.equal(fitsVehicle(product, { brand: "Kia", model: "Sportage", year: 2019 }), false);
  assert.equal(formatYears({ y1: null, y2: null }), "سنة غير محددة");
});

test("client query encodes filters and HTML output escapes database content", () => {
  const query = new URLSearchParams(catalogQuery({ q: "A&B", brand: "Kia", year: 2023 }, { limit: 10, sort: "name", cursor: "token" }));
  assert.equal(query.get("q"), "A&B");
  assert.equal(query.get("brand"), "Kia");
  assert.equal(query.get("year"), "2023");
  assert.equal(query.get("cursor"), "token");
  assert.equal(escapeHtml(`<img src=x onerror='bad'>`), "&lt;img src=x onerror=&#39;bad&#39;&gt;");
});
