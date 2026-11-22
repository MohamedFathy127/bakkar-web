function text(value) {
  return typeof value === "string" ? value : "";
}

export function mapCatalogProduct(row) {
  const fitments = Array.isArray(row?.fitments)
    ? row.fitments.filter(item => item && typeof item === "object").map(item => ({
      brand: text(item.brand_en),
      brandAr: text(item.brand_ar),
      model: text(item.model),
      yearFrom: item.year_from == null ? null : Number(item.year_from),
      yearTo: item.year_to == null ? null : Number(item.year_to),
    })).filter(item => item.brand && item.model)
    : [];
  const primary = fitments[0] || {};

  return {
    id: text(row?.id),
    code: text(row?.part_code),
    ar: text(row?.name),
    en: text(row?.name_en),
    brand: primary.brand || "",
    brandAr: primary.brandAr || "",
    car: primary.model || "",
    y1: primary.yearFrom,
    y2: primary.yearTo,
    cat: text(row?.category),
    cond: text(row?.condition),
    inStock: row?.in_stock === true || row?.in_stock === 1,
    fitments,
    ok: fitments.length > 0,
  };
}

export function fitsVehicle(product, { brand = "", model = "", year = null } = {}) {
  return (product?.fitments || []).some(fitment =>
    (!brand || fitment.brand === brand) &&
    (!model || fitment.model === model) &&
    (year == null || (
      (fitment.yearFrom == null || year >= fitment.yearFrom) &&
      (fitment.yearTo == null || year <= fitment.yearTo)
    ))
  );
}

export function formatYears(product) {
  const { y1, y2 } = product || {};
  if (y1 == null && y2 == null) return "سنة غير محددة";
  if (y1 == null) return `حتى ${y2}`;
  if (y2 == null) return `من ${y1}`;
  return y1 === y2 ? String(y1) : `${y1}–${y2}`;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function catalogQuery(filters = {}, { limit = 24, cursor = "", sort = "id" } = {}) {
  const params = new URLSearchParams({ limit: String(limit), sort });
  for (const key of ["q", "brand", "category", "condition", "model", "year"]) {
    const value = filters[key];
    if (value !== undefined && value !== null && String(value).trim()) params.set(key, String(value).trim());
  }
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}
