// Owner-only inventory management routes for Bakkar.
import { handleExcelImport } from "./excel-import.js";
// All writes are same-origin, validated, versioned, and audit logged.

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: HEADERS });
}

async function bodyJson(request, maxBytes = 8192) {
  const type = request.headers.get("Content-Type") || "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(type)) return { error: "Content-Type must be application/json." };
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > maxBytes) return { error: "Request body is too large." };
  if (!request.body) return { error: "Request body is required." };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { error: "Request body is too large." };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? { value }
      : { error: "Request body must be a JSON object." };
  } catch {
    return { error: "Invalid JSON body." };
  }
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return Boolean(
    origin &&
    origin === new URL(request.url).origin &&
    (!fetchSite || fetchSite === "same-origin")
  );
}

function cleanText(value, max, required = false) {
  if (value === undefined || value === null) return required ? null : "";
  if (typeof value !== "string") return null;
  const text = value.trim();
  if ((required && !text) || text.length > max) return null;
  return text;
}

function nullableMoney(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function validateFitments(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 30) return null;
  const rows = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const brandId = cleanText(item.brand_id, 64, true);
    const model = cleanText(item.model, 80, true);
    const yearFrom = item.year_from === "" || item.year_from == null ? null : Number(item.year_from);
    const yearTo = item.year_to === "" || item.year_to == null ? null : Number(item.year_to);
    const status = item.compatibility_status || "pending";
    if (!brandId || !model ||
        (yearFrom !== null && (!Number.isInteger(yearFrom) || yearFrom < 1900 || yearFrom > 2100)) ||
        (yearTo !== null && (!Number.isInteger(yearTo) || yearTo < 1900 || yearTo > 2100)) ||
        (yearFrom !== null && yearTo !== null && yearTo < yearFrom) ||
        !["pending", "confirmed", "unconfirmed"].includes(status)) return null;
    rows.push({ id: crypto.randomUUID(), brandId, model, yearFrom, yearTo, status });
  }
  return rows;
}

function validateProduct(input) {
  const partName = cleanText(input.part_name_ar, 160, true);
  const partNameEn = cleanText(input.part_name_en, 160);
  const condition = cleanText(input.condition, 40);
  const partCode = cleanText(input.part_code, 80);
  const aliases = cleanText(input.aliases, 1000);
  const notes = cleanText(input.internal_notes, 2000);
  const categoryId = input.category_id == null || input.category_id === "" ? null : cleanText(input.category_id, 64, true);
  const sale = nullableMoney(input.sale_price_piasters);
  const purchase = nullableMoney(input.purchase_price_piasters);
  const fitments = validateFitments(input.fitments);
  if (!partName || partNameEn === null || condition === null || partCode === null ||
      aliases === null || notes === null || (input.category_id && !categoryId) ||
      sale === undefined || purchase === undefined || fitments === null) return null;
  const isPublic = input.is_public === true || input.is_public === 1;
  if (isPublic && (!fitments.length || fitments.some(f => f.status !== "confirmed"))) return null;
  return {
    partName, partNameEn: partNameEn || null, condition: condition || null,
    partCode: partCode || null, aliases: aliases || null, notes: notes || null,
    categoryId, sale, purchase, isPublic: isPublic ? 1 : 0, fitments,
  };
}

function normalizePartKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ar")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[ـ\s\-_/.,،؛:()[\]{}]+/g, "")
    .trim();
}

async function findPossibleDuplicates(db, product) {
  const rows = await db.prepare(`
    SELECT p.id, p.part_name_ar, p.part_name_en, p.part_code, p.condition,
      p.sale_price_piasters, p.purchase_price_piasters, p.version,
      COALESCE(SUM(ib.quantity), 0) AS total_quantity
    FROM products p
    LEFT JOIN inventory_balances ib ON ib.product_id = p.id
    WHERE p.archived_at IS NULL
    GROUP BY p.id
    ORDER BY p.updated_at DESC
    LIMIT 500
  `).all();
  const nameKey = normalizePartKey(product.partName);
  const codeKey = normalizePartKey(product.partCode);
  const candidates = (rows.results || []).filter(row =>
    (nameKey && normalizePartKey(row.part_name_ar) === nameKey) ||
    (codeKey && normalizePartKey(row.part_code) === codeKey)
  ).slice(0, 10);
  if (!candidates.length) return [];
  const ids = candidates.map(x => x.id);
  const placeholders = ids.map(() => "?").join(",");
  const fitments = await db.prepare(`
    SELECT f.product_id, f.brand_id, b.name_ar AS brand_name_ar, f.model,
      f.year_from, f.year_to, f.compatibility_status
    FROM product_fitments f JOIN brands b ON b.id=f.brand_id
    WHERE f.product_id IN (${placeholders})
    ORDER BY f.product_id, b.name_ar, f.model
  `).bind(...ids).all();
  const byProduct = new Map();
  for (const f of fitments.results || []) {
    if (!byProduct.has(f.product_id)) byProduct.set(f.product_id, []);
    byProduct.get(f.product_id).push(f);
  }
  return candidates.map(x => ({ ...x, fitments: byProduct.get(x.id) || [] }));
}

async function referencesValid(db, product) {
  if (product.categoryId) {
    const category = await db.prepare("SELECT id FROM categories WHERE id=? AND active=1 LIMIT 1")
      .bind(product.categoryId).first();
    if (!category) return false;
  }
  const brandIds = [...new Set(product.fitments.map(f => f.brandId))];
  if (brandIds.length) {
    const placeholders = brandIds.map(() => "?").join(",");
    const result = await db.prepare(`SELECT id FROM brands WHERE id IN (${placeholders})`)
      .bind(...brandIds).all();
    if ((result.results || []).length !== brandIds.length) return false;
  }
  const seen = new Set();
  for (const f of product.fitments) {
    const key = [f.brandId, f.model, f.yearFrom ?? "", f.yearTo ?? ""].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function productSnapshot(p) {
  return JSON.stringify({
    part_name_ar: p.partName, part_name_en: p.partNameEn, condition: p.condition,
    part_code: p.partCode, aliases: p.aliases, category_id: p.categoryId,
    sale_price_piasters: p.sale, purchase_price_piasters: p.purchase,
    is_public: p.isPublic, fitments: p.fitments,
  });
}

async function writeFitments(db, productId, fitments) {
  return fitments.map(f => db.prepare(`
    INSERT INTO product_fitments
      (id, product_id, brand_id, model, year_from, year_to, compatibility_status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(f.id, productId, f.brandId, f.model, f.yearFrom, f.yearTo, f.status));
}

async function handleInventoryAdmin(request, url, env, session) {
  const importResponse = await handleExcelImport(request, url, env, session);
  if (importResponse) return importResponse;

  const path = url.pathname;
  const method = request.method;

  if (path === "/api/admin/stock-balance" && method === "GET") {
    const productId = url.searchParams.get("product_id") || "";
    const locationId = url.searchParams.get("location_id") || "";
    if (!productId || !locationId) return reply({ error: "اختر القطعة والمخزن." }, 400);
    const row = await env.DB.prepare("SELECT quantity FROM inventory_balances WHERE product_id=? AND location_id=?")
      .bind(productId, locationId).first();
    return reply({ quantity: Number(row?.quantity || 0) });
  }

  if (path === "/api/admin/meta" && method === "GET") {
    const [brands, categories, locations] = await Promise.all([
      env.DB.prepare("SELECT id, name_ar, name_en, slug FROM brands ORDER BY name_ar").all(),
      env.DB.prepare("SELECT id, name_ar, name_en FROM categories WHERE active=1 ORDER BY sort_order, name_ar").all(),
      env.DB.prepare("SELECT id, name, active FROM locations ORDER BY name").all(),
    ]);
    return reply({
      brands: brands.results || [],
      categories: categories.results || [],
      locations: locations.results || [],
    });
  }

  const detailMatch = path.match(/^\/api\/admin\/products\/([0-9a-f-]{36})$/i);
  if (detailMatch && method === "GET") {
    const id = detailMatch[1];
    const product = await env.DB.prepare(`
      SELECT p.*, COALESCE((SELECT SUM(quantity) FROM inventory_balances WHERE product_id=p.id),0) AS total_quantity
      FROM products p WHERE p.id=? AND p.archived_at IS NULL LIMIT 1
    `).bind(id).first();
    if (!product) return reply({ error: "Product not found." }, 404);
    const [fitments, balances] = await Promise.all([
      env.DB.prepare(`
        SELECT f.id, f.brand_id, b.name_ar AS brand_ar, b.name_en AS brand_en,
          f.model, f.year_from, f.year_to, f.compatibility_status
        FROM product_fitments f JOIN brands b ON b.id=f.brand_id
        WHERE f.product_id=? ORDER BY b.name_ar, f.model
      `).bind(id).all(),
      env.DB.prepare(`
        SELECT ib.location_id, l.name AS location_name, ib.quantity
        FROM inventory_balances ib JOIN locations l ON l.id=ib.location_id
        WHERE ib.product_id=? ORDER BY l.name
      `).bind(id).all(),
    ]);
    return reply({ data: { ...product, fitments: fitments.results || [], balances: balances.results || [] } });
  }

  if (path === "/api/admin/products/duplicate-check" && method === "POST") {
    if (!sameOrigin(request)) return reply({ error: "Invalid request origin." }, 403);
    const parsed = await bodyJson(request);
    if (parsed.error) return reply({ error: parsed.error }, 400);
    const product = validateProduct(parsed.value);
    if (!product) return reply({ error: "راجع بيانات القطعة قبل فحص التكرار." }, 400);
    const candidates = await findPossibleDuplicates(env.DB, product);
    return reply({ candidates });
  }

  if (path === "/api/admin/products" && method === "POST") {
    if (!sameOrigin(request)) return reply({ error: "Invalid request origin." }, 403);
    const parsed = await bodyJson(request);
    if (parsed.error) return reply({ error: parsed.error }, 400);
    const product = validateProduct(parsed.value);
    if (!product) return reply({ error: "راجع بيانات القطعة والتوافق والأسعار." }, 400);
    if (!await referencesValid(env.DB, product)) return reply({ error: "الماركة أو التصنيف غير موجود، أو يوجد توافق مكرر." }, 400);
    const possibleDuplicates = await findPossibleDuplicates(env.DB, product);
    const confirmedIds = Array.isArray(parsed.value.duplicate_confirmed_ids)
      ? parsed.value.duplicate_confirmed_ids.filter(x => typeof x === "string")
      : [];
    if (possibleDuplicates.length &&
        (parsed.value.duplicate_decision !== "different" ||
         possibleDuplicates.some(x => !confirmedIds.includes(x.id)))) {
      return reply({ code: "possible_duplicate", error: "وجدنا قطعًا محتملة بنفس الاسم أو الكود. راجعها قبل إنشاء سجل جديد.", candidates: possibleDuplicates }, 409);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const statements = [
      env.DB.prepare(`
        INSERT INTO products
          (id, part_name_ar, part_name_en, category_id, condition, part_code, aliases,
           internal_notes, sale_price_piasters, purchase_price_piasters, is_public, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, product.partName, product.partNameEn, product.categoryId, product.condition,
        product.partCode, product.aliases, product.notes, product.sale, product.purchase,
        product.isPublic, now, now),
      ...await writeFitments(env.DB, id, product.fitments),
      env.DB.prepare(`
        INSERT INTO audit_log (id, entity_type, entity_id, action, after_json, actor_email)
        VALUES (?, 'product', ?, 'created', ?, ?)
      `).bind(crypto.randomUUID(), id, productSnapshot(product), session.email),
    ];
    await env.DB.batch(statements);
    return reply({ ok: true, id, version: 1 }, 201);
  }

  if (detailMatch && method === "PUT") {
    if (!sameOrigin(request)) return reply({ error: "Invalid request origin." }, 403);
    const id = detailMatch[1];
    const parsed = await bodyJson(request);
    if (parsed.error) return reply({ error: parsed.error }, 400);
    const input = parsed.value;
    const expectedVersion = Number(input.version);
    const product = validateProduct(input);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || !product) {
      return reply({ error: "راجع البيانات ورقم إصدار القطعة." }, 400);
    }
    if (!await referencesValid(env.DB, product)) return reply({ error: "الماركة أو التصنيف غير موجود، أو يوجد توافق مكرر." }, 400);
    const now = new Date().toISOString();
    const statements = [
      env.DB.prepare(`
        UPDATE products SET part_name_ar=?, part_name_en=?, category_id=?, condition=?,
          part_code=?, aliases=?, internal_notes=?, sale_price_piasters=?, purchase_price_piasters=?,
          is_public=?, version=version+1, updated_at=?
        WHERE id=? AND version=? AND archived_at IS NULL
      `).bind(product.partName, product.partNameEn, product.categoryId, product.condition,
        product.partCode, product.aliases, product.notes, product.sale, product.purchase,
        product.isPublic, now, id, expectedVersion),
      env.DB.prepare(`
        DELETE FROM product_fitments WHERE product_id=?
          AND EXISTS (SELECT 1 FROM products WHERE id=? AND version=? AND updated_at=?)
      `).bind(id, id, expectedVersion + 1, now),
      ...product.fitments.map(f => env.DB.prepare(`
        INSERT INTO product_fitments
          (id, product_id, brand_id, model, year_from, year_to, compatibility_status)
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM products WHERE id=? AND version=? AND updated_at=?)
      `).bind(f.id, id, f.brandId, f.model, f.yearFrom, f.yearTo, f.status, id, expectedVersion + 1, now)),
      env.DB.prepare(`
        INSERT INTO audit_log (id, entity_type, entity_id, action, after_json, actor_email)
        SELECT ?, 'product', ?, 'updated', ?, ?
        WHERE EXISTS (SELECT 1 FROM products WHERE id=? AND version=? AND updated_at=?)
      `).bind(crypto.randomUUID(), id, productSnapshot(product), session.email, id, expectedVersion + 1, now),
    ];
    const results = await env.DB.batch(statements);
    if (!results[0]?.meta?.changes) return reply({ error: "القطعة اتعدلت بالفعل أو لم تعد موجودة. حدّث الصفحة وحاول مرة أخرى." }, 409);
    return reply({ ok: true, id, version: expectedVersion + 1 });
  }

  if (detailMatch && method === "DELETE") {
    if (!sameOrigin(request)) return reply({ error: "Invalid request origin." }, 403);
    const id = detailMatch[1];
    const parsed = await bodyJson(request, 2048);
    if (parsed.error) return reply({ error: parsed.error }, 400);
    const version = Number(parsed.value.version);
    if (!Number.isInteger(version) || version < 1) return reply({ error: "Missing product version." }, 400);
    const now = new Date().toISOString();
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE products SET archived_at=?, is_public=0, version=version+1, updated_at=?
        WHERE id=? AND version=? AND archived_at IS NULL
      `).bind(now, now, id, version),
      env.DB.prepare(`
        INSERT INTO audit_log (id, entity_type, entity_id, action, before_json, actor_email)
        SELECT ?, 'product', ?, 'archived', json_object('version', ?), ?
        WHERE EXISTS (SELECT 1 FROM products WHERE id=? AND version=? AND archived_at=?)
      `).bind(crypto.randomUUID(), id, version, session.email, id, version + 1, now),
    ]);
    if (!results[0]?.meta?.changes) return reply({ error: "القطعة اتعدلت بالفعل أو لم تعد موجودة." }, 409);
    return reply({ ok: true, archived: true });
  }

  if (path === "/api/admin/locations" && method === "POST") {
    if (!sameOrigin(request)) return reply({ error: "Invalid request origin." }, 403);
    const parsed = await bodyJson(request, 2048);
    if (parsed.error) return reply({ error: parsed.error }, 400);
    const name = cleanText(parsed.value.name, 80, true);
    if (!name) return reply({ error: "اسم المخزن مطلوب (حتى 80 حرفًا)." }, 400);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO locations(id,name,active,created_at,updated_at) VALUES(?,?,1,?,?)").bind(id, name, now, now),
        env.DB.prepare("INSERT INTO audit_log(id,entity_type,entity_id,action,after_json,actor_email) VALUES(?, 'location', ?, 'created', ?, ?)").bind(crypto.randomUUID(), id, JSON.stringify({ name }), session.email),
      ]);
    } catch {
      return reply({ error: "اسم المخزن مستخدم بالفعل أو البيانات غير صالحة." }, 409);
    }
    return reply({ ok: true, id }, 201);
  }

  if (path === "/api/admin/stock-movements" && method === "GET") {
    const productId = url.searchParams.get("product_id");
    const rawLimit = Number(url.searchParams.get("limit") || 50);
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
    const rows = await env.DB.prepare(`
      SELECT sm.id, sm.product_id, p.part_name_ar, sm.location_id, l.name AS location_name,
        sm.movement_type, sm.quantity_delta, sm.balance_after, sm.reason, sm.reference,
        sm.actor_email, sm.created_at
      FROM stock_movements sm
      JOIN products p ON p.id=sm.product_id
      JOIN locations l ON l.id=sm.location_id
      WHERE (? IS NULL OR sm.product_id=?)
      ORDER BY sm.created_at DESC, sm.id DESC LIMIT ?
    `).bind(productId, productId, limit).all();
    return reply({ data: rows.results || [] });
  }

  if (path === "/api/admin/stock-movements" && method === "POST") {
    if (!sameOrigin(request)) return reply({ error: "Invalid request origin." }, 403);
    const parsed = await bodyJson(request, 4096);
    if (parsed.error) return reply({ error: parsed.error }, 400);
    const input = parsed.value;
    const productId = cleanText(input.product_id, 64, true);
    const locationId = cleanText(input.location_id, 64, true);
    const type = input.movement_type;
    const delta = Number(input.quantity_delta);
    const reason = cleanText(input.reason, 240);
    const reference = cleanText(input.reference, 100);
    if (!productId || !locationId || !["in", "out", "adjustment"].includes(type) ||
        !Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 1000000 ||
        (type === "in" && delta < 0) || (type === "out" && delta > 0) ||
        reason === null || reference === null) {
      return reply({ error: "راجع نوع الحركة والكمية والمخزن." }, 400);
    }

    const movementId = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      const results = await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO stock_movements
            (id, product_id, location_id, movement_group_id, movement_type, quantity_delta,
             balance_after, reason, reference, actor_email, created_at)
          SELECT ?, ?, ?, ?, ?, ?,
            COALESCE((SELECT quantity FROM inventory_balances
              WHERE product_id=? AND location_id=?), 0) + ?,
            ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM products WHERE id=? AND archived_at IS NULL)
            AND EXISTS (SELECT 1 FROM locations WHERE id=? AND active=1)
            AND COALESCE((SELECT quantity FROM inventory_balances
              WHERE product_id=? AND location_id=?), 0) + ? >= 0
        `).bind(
          movementId, productId, locationId, crypto.randomUUID(), type, delta,
          productId, locationId, delta, reason || null, reference || null, session.email, now,
          productId, locationId, productId, locationId, delta
        ),
        env.DB.prepare(`
          INSERT INTO audit_log(id, entity_type, entity_id, action, after_json, actor_email)
          SELECT ?, 'stock_movement', ?, 'created', ?, ?
          WHERE EXISTS (SELECT 1 FROM stock_movements WHERE id=?)
        `).bind(
          crypto.randomUUID(), movementId,
          JSON.stringify({ product_id: productId, location_id: locationId, movement_type: type, quantity_delta: delta }),
          session.email, movementId
        ),
      ]);

      if (!results[0]?.meta?.changes) {
        const [product, location, balance] = await Promise.all([
          env.DB.prepare("SELECT id FROM products WHERE id=? AND archived_at IS NULL").bind(productId).first(),
          env.DB.prepare("SELECT id FROM locations WHERE id=? AND active=1").bind(locationId).first(),
          env.DB.prepare("SELECT quantity FROM inventory_balances WHERE product_id=? AND location_id=?").bind(productId, locationId).first(),
        ]);
        if (!product) return reply({ error: "القطعة غير موجودة أو مؤرشفة." }, 404);
        if (!location) return reply({ error: "المخزن غير موجود أو غير نشط." }, 404);
        return reply({
          error: "الرصيد غير كافٍ لتنفيذ الصرف.",
          available_quantity: Number(balance?.quantity || 0),
          requested_quantity: Math.abs(delta),
        }, 409);
      }
    } catch (error) {
      console.error("stock_movement_failed", {
        message: String(error?.message || error),
        movement_type: type,
        product_id: productId,
        location_id: locationId,
      });
      return reply({ error: "تعذر حفظ حركة المخزون بسبب خطأ في قاعدة البيانات. لم يتم اعتماد الحركة." }, 500);
    }
    return reply({ ok: true, movement_id: movementId }, 201);
  }

  return null;
}

export { handleInventoryAdmin };
