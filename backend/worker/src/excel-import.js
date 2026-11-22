const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 500;
const HEADERS = [
  "الماركة", "اسم القطعة", "موديل السيارة", "من سنة", "إلى سنة",
  "الكمية", "سعر البيع (ج.م)", "سعر الشراء (ج.م)", "الحالة",
  "مكان التخزين", "كود القطعة", "ملاحظات",
];

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function normalize(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("ar")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي")
    .replace(/[ـ\s\-_/.,،؛:()[\]{}]+/g, "");
}
function textValue(value) {
  if (value === null || value === undefined) return null;
  const valueText = String(value).trim();
  return valueText === "" ? null : valueText;
}
function numberValue(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const normalized = String(value).replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
  const cleaned = normalized.replace(/[,،]/g, "").replace(/[^0-9.+-]/g, "");
  const match = cleaned.match(/[-+]?[0-9]+(?:[.][0-9]+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function moneyPiasters(value) {
  const parsed = numberValue(value);
  if (parsed === null) return null;
  if (parsed === undefined || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER / 100) return undefined;
  return Math.round(parsed * 100);
}
function integerValue(value) {
  const parsed = numberValue(value);
  if (parsed === null) return null;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
function yearValue(value) {
  const raw = textValue(value);
  if (!raw || raw === "***" || raw === "—" || raw === "-") return null;
  const parsed = numberValue(raw);
  return Number.isInteger(parsed) && parsed >= 1900 && parsed <= 2100 ? parsed : undefined;
}
async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(x => x.toString(16).padStart(2, "0")).join("");
}
function rowToObject(row) {
  return Object.fromEntries(HEADERS.map((header, index) => [header, row[index] ?? null]));
}
async function findCandidates(db, item, cachedProducts = null) {
  if (!item.part_name_ar && !item.part_code) return [];
  const all = cachedProducts
    ? { results: cachedProducts }
    : await db.prepare(`
      SELECT p.id, p.part_name_ar, p.part_code, p.condition,
        COALESCE(SUM(ib.quantity),0) AS total_quantity
      FROM products p LEFT JOIN inventory_balances ib ON ib.product_id=p.id
      WHERE p.archived_at IS NULL
      GROUP BY p.id ORDER BY p.updated_at DESC LIMIT 500
    `).all();
  const nameKey = normalize(item.part_name_ar);
  const codeKey = normalize(item.part_code);
  return (all.results || []).filter(p =>
    (nameKey && normalize(p.part_name_ar) === nameKey) ||
    (codeKey && normalize(p.part_code) === codeKey)
  ).slice(0, 10);
}
async function parseRows(db, rows) {
  const [brandsResult, locationsResult, productsResult] = await Promise.all([
    db.prepare("SELECT id,name_ar,name_en FROM brands").all(),
    db.prepare("SELECT id,name,active FROM locations").all(),
    db.prepare(`
      SELECT p.id, p.part_name_ar, p.part_code, p.condition,
        COALESCE(SUM(ib.quantity),0) AS total_quantity
      FROM products p LEFT JOIN inventory_balances ib ON ib.product_id=p.id
      WHERE p.archived_at IS NULL
      GROUP BY p.id ORDER BY p.updated_at DESC LIMIT 500
    `).all(),
  ]);
  const brands = brandsResult.results || [];
  const locations = locationsResult.results || [];
  const cachedProducts = productsResult.results || [];
  const output = [];
  const seenRows = new Set();
  for (let index = 1; index < rows.length; index++) {
    const raw = rowToObject(rows[index] || []);
    if (Object.values(raw).every(v => textValue(v) === null)) continue;
    const issues = [];
    const item = {
      part_name_ar: textValue(raw["اسم القطعة"]),
      brand_raw: textValue(raw["الماركة"]),
      model_raw: textValue(raw["موديل السيارة"]),
      year_from: yearValue(raw["من سنة"]),
      year_to: yearValue(raw["إلى سنة"]),
      quantity: integerValue(raw["الكمية"]),
      sale_price_piasters: moneyPiasters(raw["سعر البيع (ج.م)"]),
      purchase_price_piasters: moneyPiasters(raw["سعر الشراء (ج.م)"]),
      condition: textValue(raw["الحالة"]),
      location_raw: textValue(raw["مكان التخزين"]),
      part_code: textValue(raw["كود القطعة"]),
      notes: textValue(raw["ملاحظات"]),
    };
    if (!item.part_name_ar) issues.push("اسم القطعة غير موجود؛ لا يمكن إنشاء سجل بدون اسم.");
    if (item.quantity === undefined) { issues.push("الكمية غير صالحة؛ ستظل غير محددة ولن يتم تعديل الرصيد."); item.quantity = null; }
    if (item.sale_price_piasters === undefined) { issues.push("سعر البيع غير صالح؛ سيظل فارغًا حتى مراجعته."); item.sale_price_piasters = null; }
    if (item.purchase_price_piasters === undefined) { issues.push("سعر الشراء غير صالح؛ سيظل فارغًا حتى مراجعته."); item.purchase_price_piasters = null; }
    if (item.year_from === undefined || item.year_to === undefined) {
      issues.push("إحدى سنوات التوافق غير صالحة؛ تم ترك سنة التوافق فارغة.");
      if (item.year_from === undefined) item.year_from = null;
      if (item.year_to === undefined) item.year_to = null;
    }
    if (item.condition && item.condition.length > 40) { issues.push("الحالة أطول من الحد المسموح؛ تم ترك خانة الحالة فارغة."); item.condition = null; }
    if (item.part_name_ar && item.part_name_ar.length > 160) issues.push("اسم القطعة أطول من الحد المسموح (160 حرفًا).");
    if (item.part_code && item.part_code.length > 80) { issues.push("كود القطعة أطول من الحد المسموح؛ تم تركه فارغًا."); item.part_code = null; }
    if (item.notes && item.notes.length > 2000) { issues.push("الملاحظات أطول من الحد المسموح؛ حُفظ النص الأصلي في بيانات المعاينة فقط."); item.notes = null; }
    const brandKey = normalize(item.brand_raw);
    const brand = brands.find(b => normalize(b.name_ar) === brandKey || normalize(b.name_en) === brandKey);
    item.brand_id = brand?.id || null;
    if (item.brand_raw && !brand) issues.push("الماركة غير معروفة في قاعدة البيانات؛ لن يتم إنشاء توافق سيارة تلقائيًا.");
    item.model = item.model_raw && !["***", "—", "-"].includes(item.model_raw) ? item.model_raw : null;
    if (item.model_raw === "***") issues.push("موديل السيارة مكتوب ***؛ تم ترك التوافق غير محدد.");
    if (item.model && item.model.length > 80) { issues.push("موديل السيارة أطول من الحد المسموح؛ تم ترك التوافق غير محدد."); item.model = null; }
    if (item.model && !item.brand_id) issues.push("يوجد موديل بدون ماركة معروفة؛ لم يتم إنشاء توافق سيارة.");
    const locationKey = normalize(item.location_raw);
    const location = locations.find(l => l.active && normalize(l.name) === locationKey);
    item.location_id = location?.id || null;
    if (item.location_raw && !location) issues.push("مكان التخزين غير موجود أو غير نشط؛ لن يتم تعديل الرصيد.");
    if (item.quantity === null) issues.push("الكمية فارغة؛ سيتم حفظ القطعة بدون حركة مخزون.");
    if (item.location_raw === null) issues.push("مكان التخزين فارغ؛ سيتم حفظ القطعة بدون حركة مخزون.");
    if (item.part_code === null) issues.push("كود القطعة غير مسجل.");
    if (item.sale_price_piasters === null) issues.push("سعر البيع غير مسجل؛ سيظل فارغًا وليس صفرًا.");
    if (item.purchase_price_piasters === null) issues.push("سعر الشراء غير مسجل؛ سيظل فارغًا وليس صفرًا.");
    const candidates = await findCandidates(db, item, cachedProducts);
    // Only flag a true duplicate identity in the same location. A reused part
    // code or name alone is not enough: different models/years/conditions may
    // represent distinct stock records.
    const rowFingerprint = JSON.stringify([
      normalize(item.brand_raw), normalize(item.part_name_ar), normalize(item.model_raw),
      item.year_from ?? null, item.year_to ?? null, normalize(item.condition),
      normalize(item.part_code), normalize(item.location_raw),
    ]);
    if (rowFingerprint !== '["","","",null,null,"","",""]' && seenRows.has(rowFingerprint)) {
      issues.push("يوجد صف مطابق تمامًا لنفس القطعة والتوافق والحالة والكود وفي نفس المخزن؛ راجع الصفين قبل الاستيراد.");
    }
    if (rowFingerprint !== '["","","",null,null,"","",""]') seenRows.add(rowFingerprint);
    if (candidates.length) issues.push("احتمال تكرار: راجع السجلات الموجودة واختر المطابقة أو إنشاء سجل مستقل.");
    output.push({ row_number: index + 1, raw, item, issues, candidates });
  }
  return output;
}

async function handleExcelImport(request, url, env, session) {
  const path = url.pathname;
  const method = request.method;
  if (path === "/api/admin/imports/preview" && method === "POST") {
    const origin = request.headers.get("Origin");
    const fetchSite = request.headers.get("Sec-Fetch-Site");
    if (!origin || origin !== new URL(request.url).origin || (fetchSite && fetchSite !== "same-origin")) {
      return reply({ error: "Invalid request origin." }, 403);
    }
    const parsed = await readJsonBody(request, MAX_FILE_BYTES + 64 * 1024);
    if (parsed.error) return reply({ error: parsed.error }, 400);
    const filename = String(parsed.body.filename || "inventory.xlsx").replace(/[\\/\\0-\\x1f]/g, "_").slice(0, 120);
    const sheetRows = parsed.body.rows;
    if (!/\\.xlsx$/i.test(filename)) return reply({ error: "النسخة الحالية تقبل ملفات Excel بصيغة .xlsx فقط." }, 400);
    if (!Array.isArray(sheetRows) || !sheetRows.length) return reply({ error: "ورقة العمل فارغة أو بياناتها غير صالحة." }, 400);
    if (sheetRows.length - 1 > MAX_ROWS) return reply({ error: "الملف يتجاوز الحد الأقصى وهو 500 صف." }, 413);
    const actualHeaders = (sheetRows[0] || []).map(x => normalize(x));
    const expectedHeaders = HEADERS.map(normalize);
    const missing = HEADERS.filter((header, i) => actualHeaders[i] !== expectedHeaders[i]);
    const extraHeaders = actualHeaders.slice(HEADERS.length).some(value => value !== "");
    const extraData = sheetRows.slice(1).some(row => (row || []).slice(HEADERS.length).some(value => textValue(value) !== null));
    if (missing.length || extraHeaders || extraData) return reply({ error: "عناوين الأعمدة أو بياناتها لا تطابق قالب بكار المكوّن من 12 عمودًا.", expected_headers: HEADERS, actual_headers: sheetRows[0] || [] }, 400);
    const rows = await parseRows(env.DB, sheetRows);
    if (!rows.length) return reply({ error: "لم يتم العثور على صفوف بيانات." }, 400);
    // Hash worksheet data rather than workbook metadata, so identical inventory
    // rows cannot be staged twice under a different filename or formatting.
    const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(sheetRows)));
    const batchId = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await env.DB.prepare("INSERT INTO import_batches(id,filename,file_sha256,status,total_rows,created_by,created_at) VALUES(?,?,?,'preview',?,?,?)")
        .bind(batchId, filename, hash, rows.length, session.email, now).run();
      for (let offset = 0; offset < rows.length; offset += 40) {
        const chunk = rows.slice(offset, offset + 40);
        const statements = chunk.map(row => env.DB.prepare(`
          INSERT INTO import_batch_rows(id,batch_id,row_number,raw_json,normalized_json,issues_json,status,created_at)
          VALUES(?,?,?,?,?,?,'preview',?)
        `).bind(crypto.randomUUID(), batchId, row.row_number, JSON.stringify(row.raw), JSON.stringify(row.item), JSON.stringify(row.issues), now));
        await env.DB.batch(statements);
      }
    } catch (error) {
      const existing = await env.DB.prepare("SELECT id,status,filename FROM import_batches WHERE file_sha256=? LIMIT 1").bind(hash).first();
      if (existing) return reply({ error: "تم رفع هذا الملف من قبل. استخدم المعاينة الموجودة بدل إعادة استيراده.", existing_batch: existing }, 409);
      console.error("excel_import_stage_failed", String(error?.message || error));
      return reply({ error: "تعذر حفظ معاينة الاستيراد." }, 500);
    }
    return reply({
      batch_id: batchId, filename, total_rows: rows.length,
      warning_rows: rows.filter(r => r.issues.length).length,
      duplicate_rows: rows.filter(r => r.candidates.length).length,
      rows: rows.map(r => ({ row_number: r.row_number, item: r.item, issues: r.issues, candidates: r.candidates })),
    }, 201);
  }

  const batchMatch = path.match(/^\/api\/admin\/imports\/([0-9a-f-]{36})$/i);
  if (batchMatch && method === "GET") {
    const batch = await env.DB.prepare("SELECT id,filename,status,total_rows,created_count,updated_count,skipped_count,error_count,created_at,applied_at FROM import_batches WHERE id=?")
      .bind(batchMatch[1]).first();
    if (!batch) return reply({ error: "دفعة الاستيراد غير موجودة." }, 404);
    const [rows, products] = await Promise.all([
      env.DB.prepare("SELECT row_number,raw_json,normalized_json,issues_json,status,applied_product_id FROM import_batch_rows WHERE batch_id=? ORDER BY row_number")
        .bind(batch.id).all(),
      env.DB.prepare(`
        SELECT p.id, p.part_name_ar, p.part_code, p.condition,
          COALESCE(SUM(ib.quantity),0) AS total_quantity
        FROM products p LEFT JOIN inventory_balances ib ON ib.product_id=p.id
        WHERE p.archived_at IS NULL
        GROUP BY p.id ORDER BY p.updated_at DESC LIMIT 500
      `).all(),
    ]);
    const cachedProducts = products.results || [];
    const mapped = await Promise.all((rows.results || []).map(async r => {
      const item = JSON.parse(r.normalized_json);
      return {
        row_number: r.row_number, raw: JSON.parse(r.raw_json), item,
        issues: JSON.parse(r.issues_json), status: r.status, product_id: r.applied_product_id,
        candidates: r.status === "preview" ? await findCandidates(env.DB, item, cachedProducts) : [],
      };
    }));
    return reply({ batch, rows: mapped });
  }

  const applyMatch = path.match(/^\/api\/admin\/imports\/([0-9a-f-]{36})\/apply$/i);
  if (applyMatch && method === "POST") {
    const origin = request.headers.get("Origin");
    const fetchSite = request.headers.get("Sec-Fetch-Site");
    if (!origin || origin !== new URL(request.url).origin || (fetchSite && fetchSite !== "same-origin")) {
      return reply({ error: "Invalid request origin." }, 403);
    }
    const type = request.headers.get("Content-Type") || "";
    if (!/^application\/json(?:\s*;|\s*$)/i.test(type)) return reply({ error: "Content-Type must be application/json." }, 400);
    const rawBody = await request.text();
    if (rawBody.length > 64 * 1024) return reply({ error: "بيانات الاعتماد كبيرة جدًا." }, 413);
    let body;
    try { body = JSON.parse(rawBody); } catch { return reply({ error: "بيانات الاعتماد غير صالحة." }, 400); }
    const decisions = body?.decisions;
    if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) return reply({ error: "قرارات الصفوف مطلوبة." }, 400);
    const batchId = applyMatch[1];
    const batch = await env.DB.prepare("SELECT id,status FROM import_batches WHERE id=?").bind(batchId).first();
    if (!batch) return reply({ error: "دفعة الاستيراد غير موجودة." }, 404);
    if (batch.status === "applied") return reply({ error: "تم اعتماد هذه الدفعة بالفعل." }, 409);
    const rowsResult = await env.DB.prepare("SELECT * FROM import_batch_rows WHERE batch_id=? AND status='preview' ORDER BY row_number").bind(batchId).all();
    const rows = rowsResult.results || [];
    if (!rows.length) return reply({ error: "لا توجد صفوف معلقة في هذه الدفعة." }, 409);
    for (const row of rows) {
      const choice = decisions[String(row.row_number)];
      if (typeof choice !== "string" || !["skip", "create"].includes(choice) && !choice.startsWith("match:")) {
        return reply({ error: "يجب اختيار قرار صحيح لكل صف قبل الاعتماد.", row_number: row.row_number }, 400);
      }
    }
    let created = 0, matched = 0, skipped = 0, failed = 0;
    for (const row of rows) {
      const choice = decisions[String(row.row_number)];
      if (typeof choice !== "string" || !choice) return reply({ error: "يجب اختيار قرار لكل صف قبل الاعتماد.", row_number: row.row_number }, 400);
      if (choice === "skip") {
        await env.DB.prepare("UPDATE import_batch_rows SET status='skipped',applied_at=? WHERE id=? AND status='preview'")
          .bind(new Date().toISOString(), row.id).run();
        skipped++;
        continue;
      }
      const item = JSON.parse(row.normalized_json);
      const issues = JSON.parse(row.issues_json);
      if (issues.some(issue => issue.startsWith("يوجد صف مطابق تمامًا"))) { failed++; continue; }
      if (!item.part_name_ar || item.part_name_ar.length > 160 ||
          (item.year_from !== null && item.year_to !== null && item.year_to < item.year_from)) {
        failed++;
        continue;
      }
      let productId;
      let action;
      if (choice === "create") {
        productId = crypto.randomUUID();
        action = "created";
      } else if (choice.startsWith("match:")) {
        productId = choice.slice(6);
        const existing = await env.DB.prepare("SELECT id FROM products WHERE id=? AND archived_at IS NULL").bind(productId).first();
        if (!existing) { failed++; continue; }
        const candidates = await findCandidates(env.DB, item);
        if (!candidates.some(c => c.id === productId)) { failed++; continue; }
        action = "matched";
      } else {
        return reply({ error: "قرار صف غير معروف.", row_number: row.row_number }, 400);
      }
      const now = new Date().toISOString();
      const statements = [];
      if (action === "created") {
        const notes = [item.notes, item.brand_raw ? "الماركة من ملف الاستيراد: " + item.brand_raw : "", item.model_raw && !item.model ? "موديل السيارة كما ورد: " + item.model_raw : ""].filter(Boolean).join("\n").slice(0, 2000) || null;
        statements.push(env.DB.prepare(`
          INSERT INTO products(id,part_name_ar,condition,part_code,internal_notes,sale_price_piasters,purchase_price_piasters,is_public,version,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,0,1,?,?)
        `).bind(productId, item.part_name_ar, item.condition, item.part_code, notes,
          item.sale_price_piasters, item.purchase_price_piasters, now, now));
        if (item.brand_id && item.model) {
          statements.push(env.DB.prepare(`
            INSERT INTO product_fitments(id,product_id,brand_id,model,year_from,year_to,compatibility_status,created_at,updated_at)
            VALUES(?,?,?,?,?,?,'pending',?,?)
          `).bind(crypto.randomUUID(), productId, item.brand_id, item.model, item.year_from, item.year_to, now, now));
        }
      }
      if (item.location_id && item.quantity !== null) {
        statements.push(env.DB.prepare(`
          INSERT INTO stock_movements
            (id,product_id,location_id,movement_group_id,movement_type,quantity_delta,balance_after,reason,reference,actor_email,created_at)
          SELECT ?,?,?,?,
            CASE WHEN ? > COALESCE((SELECT quantity FROM inventory_balances WHERE product_id=? AND location_id=?),0)
              THEN 'in' ELSE 'adjustment' END,
            ? - COALESCE((SELECT quantity FROM inventory_balances WHERE product_id=? AND location_id=?),0),
            ?,?,?,?,?
          WHERE ? <> COALESCE((SELECT quantity FROM inventory_balances WHERE product_id=? AND location_id=?),0)
        `).bind(
          crypto.randomUUID(), productId, item.location_id, crypto.randomUUID(),
          item.quantity, productId, item.location_id,
          item.quantity, productId, item.location_id,
          item.quantity, "تسوية الرصيد حسب ملف Excel بعد اعتماد المالك",
          batchId + ":" + row.row_number, session.email, now,
          item.quantity, productId, item.location_id
        ));
      }
      statements.push(env.DB.prepare(`
        INSERT INTO audit_log(id,entity_type,entity_id,action,after_json,actor_email,created_at)
        VALUES(?,?,?,?,?,?,?)
      `).bind(crypto.randomUUID(), "product", productId, "excel_import_" + action,
        JSON.stringify({ batch_id: batchId, row_number: row.row_number, target_quantity: item.quantity, location_id: item.location_id }), session.email, now));
      statements.push(env.DB.prepare("UPDATE import_batch_rows SET status='applied',applied_action=?,applied_product_id=?,applied_at=? WHERE id=? AND status='preview'")
        .bind(action, productId, now, row.id));
      try {
        await env.DB.batch(statements);
        if (action === "created") created++; else matched++;
      } catch (error) {
        console.error("excel_import_row_failed", { row_number: row.row_number, error: String(error?.message || error) });
        failed++;
      }
    }
    const pending = await env.DB.prepare("SELECT COUNT(*) AS count FROM import_batch_rows WHERE batch_id=? AND status='preview'").bind(batchId).first();
    const complete = Number(pending?.count || 0) === 0;
    await env.DB.prepare(`
      UPDATE import_batches SET status=?,
        created_count=(SELECT COUNT(*) FROM import_batch_rows WHERE batch_id=? AND applied_action='created'),
        updated_count=(SELECT COUNT(*) FROM import_batch_rows WHERE batch_id=? AND applied_action='matched'),
        skipped_count=(SELECT COUNT(*) FROM import_batch_rows WHERE batch_id=? AND status='skipped'),
        error_count=?, applied_at=?
      WHERE id=?
    `).bind(complete ? "applied" : "preview", batchId, batchId, batchId, failed,
      complete ? new Date().toISOString() : null, batchId).run();
    return reply({ ok: true, created, matched, skipped, failed, pending: Number(pending?.count || 0), complete });
  }
  return null;
}

export { handleExcelImport };
