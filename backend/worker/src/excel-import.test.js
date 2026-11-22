import test from "node:test";
import assert from "node:assert/strict";
import {
  normalize, textValue, numberValue, moneyPiasters, integerValue, yearValue,
  rowFingerprint, likelyBrandModelMismatch, otherLocationsMentioned, findDuplicateMatchedTargets,
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
