import test from "node:test";
import assert from "node:assert/strict";
import {
  normalize, textValue, numberValue, moneyPiasters, integerValue, yearValue,
  rowFingerprint, likelyBrandModelMismatch, otherLocationsMentioned, findDuplicateMatchedTargets, findCandidatesForItems,
  buildMatchedProductUpdate,
} from "./excel-import.js";

test("normalizes Arabic spelling, diacritics, tatweel and separators", () => {
  assert.equal(normalize("أَكْصِدام ـ أمامي"), normalize("اكصدامامامي"));
});

test("accepts Arabic-Indic and Persian digits and Arabic decimal separator", () => {
  assert.equal(numberValue("١٢٣"), 123);
  assert.equal(numberValue("۱۲۳٫٥"), 123.5);
  assert.equal(moneyPiasters("١٢٣٫٥٠ ج.م"), 12350);
});

test("rejects ambiguous, mixed and unsafe numeric input instead of extracting a number", () => {
  assert.equal(numberValue("12 قطعة"), undefined);
  assert.equal(numberValue("1,234.50"), 1234.5);
  assert.equal(numberValue("1234,50"), 1234.5);
  assert.equal(moneyPiasters("1,234"), 123400);
  assert.equal(moneyPiasters("1,2"), 120);
  assert.equal(numberValue("1,2,3"), undefined);
  assert.equal(numberValue("Infinity"), undefined);
  assert.equal(moneyPiasters("-10"), undefined);
  assert.equal(integerValue("1.5"), undefined);
  assert.equal(integerValue(Number.MAX_SAFE_INTEGER + 1), undefined);
});

test("keeps blank values distinct from invalid values and explicit zero", () => {
  assert.equal(textValue("   "), null);
  assert.equal(numberValue(""), null);
  assert.equal(moneyPiasters("0"), 0);
  assert.equal(moneyPiasters(""), null);
  assert.equal(moneyPiasters("bad"), undefined);
});

test("treats placeholders as unknown years and validates year bounds", () => {
  assert.equal(yearValue("***"), null);
  assert.equal(yearValue("—"), null);
  assert.equal(yearValue("2024"), 2024);
  assert.equal(yearValue("1899"), undefined);
  assert.equal(yearValue("2024/2025"), undefined);
});

test("duplicate fingerprint distinguishes different models and locations", () => {
  const base = {
    brand_raw: "Hyundai", part_name_ar: "فانوس", model_raw: "Venue",
    year_from: 2020, year_to: 2024, condition: "استيراد",
    part_code: "ABC-1", location_raw: "مخزن العبور",
  };
  assert.equal(rowFingerprint(base), rowFingerprint({ ...base, part_name_ar: "فانوس" }));
  assert.notEqual(rowFingerprint(base), rowFingerprint({ ...base, model_raw: "Accent" }));
  assert.notEqual(rowFingerprint(base), rowFingerprint({ ...base, location_raw: "مخزون المحل" }));
});

test("flags only the known Hyundai/Kia versus SsangYong Actyon-family mismatch", () => {
  assert.equal(likelyBrandModelMismatch({ name_en: "Hyundai" }, "اكتيون"), true);
  assert.equal(likelyBrandModelMismatch({ name_en: "Kia" }, "Actyon"), true);
  assert.equal(likelyBrandModelMismatch({ name_en: "SsangYong" }, "Actyon"), false);
  assert.equal(likelyBrandModelMismatch({ name_en: "Hyundai" }, "Venue"), false);
});

test("detects other storage locations in notes without treating selected location as conflict", () => {
  const locations = [
    { id: "a", name: "مخزن العبور" },
    { id: "b", name: "مخزون المحل" },
    { id: "c", name: "مخزن الأزهر" },
  ];
  assert.deepEqual(
    otherLocationsMentioned("في واحد في المحل وموجود في الأزهر", locations, "a").map(x => x.id),
    ["b", "c"],
  );
  assert.deepEqual(otherLocationsMentioned("موجود في العبور", locations, "a"), []);
});

test("blocks two matched rows targeting one product/location but allows different locations", () => {
  const rows = [
    { row_number: 2, normalized_json: JSON.stringify({ location_id: "loc-a", quantity: 4 }) },
    { row_number: 3, normalized_json: JSON.stringify({ location_id: "loc-a", quantity: 7 }) },
    { row_number: 4, normalized_json: JSON.stringify({ location_id: "loc-b", quantity: 2 }) },
  ];
  const sameTarget = new Map([[2, "match:product-1"], [3, "match:product-1"], [4, "match:product-1"]]);
  assert.deepEqual(findDuplicateMatchedTargets(rows, sameTarget), [2, 3]);
  const separateTargets = new Map([[2, "match:product-1"], [4, "match:product-1"]]);
  assert.equal(findDuplicateMatchedTargets(rows, separateTargets), null);
  const skipped = new Map([[2, "skip"], [3, "match:product-1"], [4, "match:product-1"]]);
  assert.equal(findDuplicateMatchedTargets(rows, skipped), null);
});

test("candidate lookups are batched in groups of 40 and merge normalized recent candidates", async () => {
  const batchSizes = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) { return { sql, values }; },
      };
    },
    async batch(statements) {
      batchSizes.push(statements.length);
      return statements.map(() => ({ results: [] }));
    },
  };
  const items = [
    { part_name_ar: "اكصدام", part_code: null },
    ...Array.from({ length: 85 }, (_, i) => ({ part_name_ar: "قطعة " + i, part_code: null })),
  ];
  const cached = [{
    id: "older-normalized-match",
    part_name_ar: "أَكْصِدام",
    part_code: null,
    fitments_json: JSON.stringify([{ brand_name_ar: "هيونداي", model: "Venue" }]),
  }];
  const candidates = await findCandidatesForItems(db, items, cached);
  assert.deepEqual(batchSizes, [40, 40, 6]);
  assert.equal(candidates.length, 86);
  assert.equal(candidates[0][0].id, "older-normalized-match");
  assert.equal(candidates[0][0].fitments[0].model, "Venue");
});

test("matched Excel rows update non-empty source fields while preserving blanks and explicit zero", () => {
  const existing = {
    part_name_ar: "فانوس قديم",
    condition: "استيراد",
    part_code: "OLD-1",
    sale_price_piasters: 125000,
    purchase_price_piasters: 80000,
    internal_notes: "ملاحظة موجودة",
  };
  const updated = buildMatchedProductUpdate(existing, {
    part_name_ar: "فانوس جديد",
    condition: null,
    part_code: null,
    sale_price_piasters: 0,
    purchase_price_piasters: null,
    notes: null,
  });
  assert.deepEqual(updated, {
    part_name_ar: "فانوس جديد",
    condition: "استيراد",
    part_code: "OLD-1",
    sale_price_piasters: 0,
    purchase_price_piasters: 80000,
    internal_notes: "ملاحظة موجودة",
  });
});

test("matched Excel rows replace only supplied notes and keep empty spreadsheet fields non-destructive", () => {
  const existing = {
    part_name_ar: "قطعة",
    condition: "جديد",
    part_code: "A-1",
    sale_price_piasters: null,
    purchase_price_piasters: null,
    internal_notes: "ملاحظة قديمة",
  };
  const updated = buildMatchedProductUpdate(existing, {
    part_name_ar: "قطعة",
    condition: "استيراد",
    part_code: "B-2",
    sale_price_piasters: null,
    purchase_price_piasters: 0,
    notes: "ملاحظة من برنامج المخزن",
  });
  assert.equal(updated.condition, "استيراد");
  assert.equal(updated.part_code, "B-2");
  assert.equal(updated.purchase_price_piasters, 0);
  assert.equal(updated.internal_notes, "ملاحظة من برنامج المخزن");
  assert.equal(updated.sale_price_piasters, null);
});
