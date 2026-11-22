const RESPONSE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const SORTS = new Set(["id", "name", "price_asc", "price_desc"]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: RESPONSE_HEADERS });
}

function cleanFilter(value, maxLength = 80) {
  return String(value || "").trim().slice(0, maxLength);
}

function escapeLike(value) {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function encodeCursor(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(value, sort) {
  if (!value) return null;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0));
    const cursor = JSON.parse(new TextDecoder().decode(bytes));
    if (!cursor || cursor.sort !== sort || typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 64) return undefined;
    if (sort === "name" && typeof cursor.name !== "string") return undefined;
    if (sort === "price_asc" || sort === "price_desc") {
      if (![0, 1].includes(cursor.priceIsNull)) return undefined;
      if (cursor.priceIsNull === 0 && !Number.isSafeInteger(cursor.price)) return undefined;
    }
    return cursor;
  } catch {
    return undefined;
  }
}

function cursorForRow(sort, row) {
  const id = String(row.product_id || row.id || "");
  if (sort === "name") return encodeCursor({ sort, name: row.name, id });
  if (sort === "price_asc" || sort === "price_desc") {
    return encodeCursor({
      sort,
      priceIsNull: row.sale_price_piasters == null ? 1 : 0,
      price: row.sale_price_piasters == null ? null : Number(row.sale_price_piasters),
      id,
    });
  }
  return encodeCursor({ sort: "id", id });
}

function orderBy(sort) {
  if (sort === "name") return "name COLLATE NOCASE ASC, product_id ASC";
  if (sort === "price_asc") return "price_is_null ASC, sale_price_piasters ASC, product_id ASC";
  if (sort === "price_desc") return "price_is_null ASC, sale_price_piasters DESC, product_id ASC";
  return "product_id ASC";
}

function cursorClause(sort, cursor) {
  if (!cursor) return { sql: "", values: [] };
  if (sort === "name") {
    return {
      sql: "WHERE (name COLLATE NOCASE > ? OR (name COLLATE NOCASE = ? AND product_id > ?))",
      values: [cursor.name, cursor.name, cursor.id],
    };
  }
  if (sort === "price_asc" || sort === "price_desc") {
    if (cursor.priceIsNull === 1) return { sql: "WHERE (price_is_null > 1 OR (price_is_null = 1 AND product_id > ?))", values: [cursor.id] };
    const comparison = sort === "price_asc" ? ">" : "<";
    return {
      sql: `WHERE (price_is_null > 0 OR (price_is_null = 0 AND (sale_price_piasters ${comparison} ? OR (sale_price_piasters = ? AND product_id > ?))))`,
      values: [cursor.price, cursor.price, cursor.id],
    };
  }
  return { sql: "WHERE product_id > ?", values: [cursor.id] };
}

function parseFilters(url) {
  const rawYear = cleanFilter(url.searchParams.get("year"), 4);
  const year = rawYear ? Number(rawYear) : null;
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2100)) return { error: "Invalid vehicle year." };
  return {
    search: cleanFilter(url.searchParams.get("q")),
    brand: cleanFilter(url.searchParams.get("brand")),
    category: cleanFilter(url.searchParams.get("category")),
    condition: cleanFilter(url.searchParams.get("condition")),
    model: cleanFilter(url.searchParams.get("model")),
    year,
  };
}

async function handlePublicCatalog(url, env) {
  const rawLimit = Number(url.searchParams.get("limit") || 24);
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 24;
  const sort = cleanFilter(url.searchParams.get("sort"), 16) || "id";
  if (!SORTS.has(sort)) return json({ error: "Invalid catalog sort." }, 400);
  const cursor = decodeCursor(url.searchParams.get("cursor") || "", sort);
  if (cursor === undefined) return json({ error: "Invalid catalog cursor." }, 400);
  const filters = parseFilters(url);
  if (filters.error) return json({ error: filters.error }, 400);
  const pattern = escapeLike(filters.search);
  const pageCursor = cursorClause(sort, cursor);

  const result = await env.DB.prepare(`
    WITH matching_products AS (
      SELECT pc.product_id
      FROM public_catalog pc
      WHERE (? = '' OR pc.part_name_ar LIKE ? ESCAPE '\\'
        OR COALESCE(pc.part_name_en,'') LIKE ? ESCAPE '\\'
        OR COALESCE(pc.part_code,'') LIKE ? ESCAPE '\\'
        OR pc.vehicle_model LIKE ? ESCAPE '\\'
        OR pc.vehicle_brand_ar LIKE ? ESCAPE '\\'
        OR pc.vehicle_brand_en LIKE ? ESCAPE '\\'
        OR COALESCE(pc.category_name_ar,'') LIKE ? ESCAPE '\\')
        AND (? = '' OR pc.vehicle_brand_en = ?)
        AND (? = '' OR COALESCE(pc.category_name_ar,'') = ?)
        AND (? = '' OR COALESCE(pc.condition,'') = ?)
        AND (? = '' OR pc.vehicle_model = ?)
        AND (? IS NULL OR (COALESCE(pc.year_from,1900) <= ? AND COALESCE(pc.year_to,2100) >= ?))
        AND pc.sale_price_piasters IS NOT NULL
      GROUP BY pc.product_id
    ), catalog AS (
      SELECT pc.product_id,
        MAX(pc.part_name_ar) AS name,
        MAX(pc.part_name_en) AS name_en,
        MAX(pc.condition) AS condition,
        MAX(pc.part_code) AS part_code,
        MAX(pc.sale_price_piasters) AS sale_price_piasters,
        MAX(pc.category_name_ar) AS category,
        CASE WHEN MAX(pc.sale_price_piasters) IS NULL THEN 1 ELSE 0 END AS price_is_null
      FROM public_catalog pc
      JOIN matching_products matched ON matched.product_id = pc.product_id
      GROUP BY pc.product_id
    ), page AS (
      SELECT * FROM catalog ${pageCursor.sql}
      ORDER BY ${orderBy(sort)} LIMIT ?
    )
    SELECT page.product_id AS id, page.name, page.name_en, page.condition, page.part_code,
      page.sale_price_piasters, page.category,
      (SELECT CASE WHEN EXISTS (
        SELECT 1 FROM inventory_balances ib
        WHERE ib.product_id=page.product_id AND ib.quantity > 0
      ) THEN 1 ELSE 0 END) AS in_stock,
      (SELECT json_group_array(json_object(
        'brand_ar', fit.vehicle_brand_ar, 'brand_en', fit.vehicle_brand_en,
        'model', fit.vehicle_model, 'year_from', fit.year_from, 'year_to', fit.year_to
      )) FROM public_catalog fit WHERE fit.product_id=page.product_id) AS fitments
    FROM page ORDER BY ${orderBy(sort)}
  `).bind(
    filters.search, pattern, pattern, pattern, pattern, pattern, pattern, pattern,
    filters.brand, filters.brand,
    filters.category, filters.category,
    filters.condition, filters.condition,
    filters.model, filters.model,
    filters.year, filters.year, filters.year,
    ...pageCursor.values, limit + 1,
  ).all();

  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(row => ({
    id: String(row.id || ""),
    name: String(row.name || ""),
    name_en: row.name_en == null ? null : String(row.name_en),
    condition: row.condition == null ? null : String(row.condition),
    part_code: row.part_code == null ? null : String(row.part_code),
    sale_price_piasters: row.sale_price_piasters == null ? null : Number(row.sale_price_piasters),
    category: row.category == null ? null : String(row.category),
    in_stock: row.in_stock === true || Number(row.in_stock) === 1,
    fitments: JSON.parse(row.fitments || "[]").map(fitment => ({
      brand_ar: String(fitment.brand_ar || ""),
      brand_en: String(fitment.brand_en || ""),
      model: String(fitment.model || ""),
      year_from: fitment.year_from == null ? null : Number(fitment.year_from),
      year_to: fitment.year_to == null ? null : Number(fitment.year_to),
    })),
  }));
  return json({
    data: page,
    pagination: {
      limit,
      has_more: hasMore,
      next_cursor: hasMore ? cursorForRow(sort, rows[limit - 1]) : null,
    },
  });
}

async function handlePublicCatalogMeta(env) {
  const [brands, categories, conditions, models] = await Promise.all([
    env.DB.prepare(`
      SELECT vehicle_brand_en AS name_en, vehicle_brand_ar AS name_ar,
        COUNT(DISTINCT product_id) AS product_count
      FROM public_catalog GROUP BY vehicle_brand_en, vehicle_brand_ar ORDER BY vehicle_brand_en
    `).all(),
    env.DB.prepare(`
      SELECT DISTINCT category_name_ar AS name
      FROM public_catalog WHERE category_name_ar IS NOT NULL AND trim(category_name_ar) <> ''
      ORDER BY name
    `).all(),
    env.DB.prepare(`
      SELECT DISTINCT condition AS name
      FROM public_catalog WHERE condition IS NOT NULL AND trim(condition) <> ''
      ORDER BY name
    `).all(),
    env.DB.prepare(`
      SELECT DISTINCT vehicle_brand_en AS brand, vehicle_model AS model
      FROM public_catalog ORDER BY brand, model
    `).all(),
  ]);
  return json({
    brands: (brands.results || []).map(item => ({
      name_en: String(item.name_en || ""),
      name_ar: String(item.name_ar || ""),
      product_count: Number(item.product_count || 0),
    })),
    categories: (categories.results || []).map(item => ({ name: String(item.name || "") })),
    conditions: (conditions.results || []).map(item => ({ name: String(item.name || "") })),
    models: (models.results || []).map(item => ({ brand: String(item.brand || ""), model: String(item.model || "") })),
  });
}

export { handlePublicCatalog, handlePublicCatalogMeta, decodeCursor, encodeCursor, parseFilters };
