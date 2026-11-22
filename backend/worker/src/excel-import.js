const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 100;
const HEADERS = [
  "الماركة", "اسم القطعة", "موديل السيارة", "من سنة", "إلى سنة",
  "الكمية", "سعر البيع (ج.م)", "سعر الشراء (ج.م)", "الحالة",
  "مكان التخزين", "كود القطعة", "ملاحظات",
];

async function readJsonBody(request, maxBytes = 4096) {
  const type = request.headers.get("Content-Type") || "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(type)) return { error: "Content-Type must be application/json." };
  if (Number(request.headers.get("Content-Length") || 0) > maxBytes) return { error: "Request body is too large." };
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
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const raw = new TextDecoder().decode(bytes);
  try {
    const body = JSON.parse(raw);
    return body && typeof body === "object" && !Array.isArray(body) ? { body } : { error: "Invalid request body." };
  } catch { return { error: "Invalid JSON body." }; }
}

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
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const valueText = String(value).trim();
  return valueText === "" ? null : valueText;
}
function numberValue(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  let cleaned = value.normalize("NFKC")
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/٫/g, ".")
    .replace(/(?:ج\s*\.\s*م|جنيه(?:ات)?|EGP|L\s*\.\s*E|LE)/gi, "")
    .replace(/\s+/g, "");
  if (/[،,]/.test(cleaned)) {
    if (/^\d{1,3}(?:[,،]\d{3})+(?:\.\d+)?$/.test(cleaned)) {
      cleaned = cleaned.replace(/[,،]/g, "");
    } else if (/^\d+[,،]\d{1,2}$/.test(cleaned)) {
      cleaned = cleaned.replace(/[,،]/, ".");
    } else {
      return undefined;
    }
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(cleaned)) return undefined;
  const parsed = Number(cleaned);
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
function parseCandidate(row) {
  let fitments = [];
  try { fitments = typeof row.fitments_json === "string" ? JSON.parse(row.fitments_json) : (row.fitments || []); }
  catch { fitments = []; }
  return { ...row, fitments: Array.isArray(fitments) ? fitments : [] };
}
const CANDIDATE_SQL = `
  SELECT p.id, p.part_name_ar, p.part_code, p.condition,
    p.sale_price_piasters, p.purchase_price_piasters, p.internal_notes, p.version,
    COALESCE((SELECT SUM(ib.quantity) FROM inventory_balances ib WHERE ib.product_id=p.id),0) AS total_quantity,
    COALESCE((
      SELECT json_group_array(json_object(
        'brand_id',f.brand_id,'brand_name_ar',b.name_ar,'model',f.model,
        'year_from',f.year_from,'year_to',f.year_to,
        'compatibility_status',f.compatibility_status
      ))
      FROM product_fitments f JOIN brands b ON b.id=f.brand_id
      WHERE f.product_id=p.id
    ),'[]') AS fitments_json
  FROM products p
  WHERE p.archived_at IS NULL AND (
    (? <> '' AND lower(trim(p.part_name_ar))=lower(trim(?))) OR
    (? <> '' AND lower(trim(p.part_code))=lower(trim(?)))
  )
  ORDER BY p.updated_at DESC LIMIT 50
`;
async function findCandidatesForItems(db, items, cachedProducts = []) {
  const exactByItem = items.map(() => []);
  for (let offset = 0; offset < items.length; offset += 40) {
    const chunk = items.slice(offset, offset + 40);
    const statements = chunk.map(item => db.prepare(CANDIDATE_SQL).bind(
      item.part_name_ar || "", item.part_name_ar || "",
      item.part_code || "", item.part_code || ""
    ));
    const results = await db.batch(statements);
    for (let index = 0; index < chunk.length; index++) {
      exactByItem[offset + index] = (results[index]?.results || []).map(parseCandidate);
    }
  }
  const cached = (cachedProducts || []).map(parseCandidate);
  return items.map((item, index) => {
    const nameKey = normalize(item.part_name_ar);
    const codeKey = normalize(item.part_code);
    const byId = new Map();
    for (const product of [...exactByItem[index], ...cached]) {
      if ((nameKey && normalize(product.part_name_ar) === nameKey) ||
          (codeKey && normalize(product.part_code) === codeKey)) {
        byId.set(product.id, product);
      }
    }
    return [...byId.values()].slice(0, 10);
  });
}
function likelyBrandModelMismatch(brand, model) {
  if (!brand || !model) return false;
  const brandName = normalize(brand.name_en || brand.name_ar);
  const modelName = normalize(model);
  const ssangyongModels = new Set(["اكتيون", "actyon", "action", "كايرون", "kyron", "كوراندو", "korando", "ريكسون", "rexton"]);
  const isHyundaiOrKia = brandName === "hyundai" || brandName === "kia" || brandName === "كيا" || brandName === "هيونداي";
  return isHyundaiOrKia && ssangyongModels.has(modelName);
}
function otherLocationsMentioned(notes, locations, selectedLocationId) {
  const noteKey = normalize(notes);
  if (!noteKey) return [];
  return locations.filter(location => {
    if (location.id === selectedLocationId) return false;
    const full = normalize(location.name);
    const short = full.replace(/^(مخزن|مخزون)/, "");
    return (full.length >= 4 && noteKey.includes(full)) || (short.length >= 3 && noteKey.includes(short));
  });
}
function buildMatchedProductUpdate(existing, item) {
  // The inventory workbook is the source of truth for non-empty fields.
  // Empty cells never erase website data; numeric zero remains an explicit value.
  return {
    part_name_ar: item.part_name_ar || existing.part_name_ar,
    condition: item.condition ?? existing.condition,
    part_code: item.part_code ?? existing.part_code,
    sale_price_piasters: item.sale_price_piasters ?? existing.sale_price_piasters,
    purchase_price_piasters: item.purchase_price_piasters ?? existing.purchase_price_piasters,
    internal_notes: item.notes ?? existing.internal_notes,
  };
}

function rowFingerprint(item) {
  return JSON.stringify([
    normalize(item.brand_raw), normalize(item.part_name_ar), normalize(item.model_raw),
    item.year_from ?? null, item.year_to ?? null, normalize(item.condition),
    normalize(item.part_code), normalize(item.location_raw),
  ]);
}
function findDuplicateMatchedTargets(rows, rowChoices) {
  const seen = new Map();
  for (const row of rows) {
    const choice = rowChoices.get(row.row_number);
    if (typeof choice !== "string" || !choice.startsWith("match:")) continue;
    const item = JSON.parse(row.normalized_json);
    if (!item.location_id || item.quantity === null) continue;
    const key = choice.slice(6) + ":" + item.location_id;
    if (seen.has(key)) return [seen.get(key), row.row_number];
    seen.set(key, row.row_number);
  }
  return null;
}
async function parseRows(db, rows) {
  const [brandsResult, locationsResult, productsResult] = await Promise.all([
    db.prepare("SELECT id,name_ar,name_en FROM brands").all(),
    db.prepare("SELECT id,name,active FROM locations").all(),
    db.prepare(`
      SELECT p.id, p.part_name_ar, p.part_code, p.condition,
        p.sale_price_piasters, p.purchase_price_piasters, p.internal_notes, p.version,
        COALESCE(SUM(ib.quantity),0) AS total_quantity,
        COALESCE((
          SELECT json_group_array(json_object(
            'brand_id',f.brand_id,'brand_name_ar',b.name_ar,'model',f.model,
            'year_from',f.year_from,'year_to',f.year_to,
            'compatibility_status',f.compatibility_status
          ))
          FROM product_fitments f JOIN brands b ON b.id=f.brand_id
          WHERE f.product_id=p.id
        ),'[]') AS fitments_json
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
    const invalidYearInput = item.year_from === undefined || item.year_to === undefined;
    if (invalidYearInput) {
      issues.push("إحدى سنوات التوافق غير صالحة؛ تم ترك سنة التوافق فارغة ولم يتم إنشاء توافق سيارة.");
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
    if (invalidYearInput) item.model = null;
    if (item.model_raw === "***") issues.push("موديل السيارة مكتوب ***؛ تم ترك التوافق غير محدد.");
    if (item.model && item.model.length > 80) { issues.push("موديل السيارة أطول من الحد المسموح؛ تم ترك التوافق غير محدد."); item.model = null; }
    if (item.year_from !== null && item.year_to !== null && item.year_to < item.year_from) {
      issues.push("سنة البداية أكبر من سنة النهاية؛ لا يمكن إنشاء توافق سيارة لهذا الصف.");
    }
    if (item.model && !item.brand_id) issues.push("يوجد موديل بدون ماركة معروفة؛ لم يتم إنشاء توافق سيارة.");
    if (item.model && likelyBrandModelMismatch(brand, item.model)) {
      issues.push("الموديل يبدو غير متوافق مع الماركة المحددة؛ راجع الماركة والموديل قبل الاعتماد. لم يتم حفظ توافق السيارة تلقائيًا.");
      item.model = null;
    }
    const locationKey = normalize(item.location_raw);
    const location = locations.find(l => l.active && normalize(l.name) === locationKey);
    item.location_id = location?.id || null;
    if (item.location_raw && !location) issues.push("مكان التخزين غير موجود أو غير نشط؛ لن يتم تعديل الرصيد.");
    if (item.quantity === null) issues.push("الكمية فارغة؛ سيتم حفظ القطعة بدون حركة مخزون.");
    if (item.location_raw === null) issues.push("مكان التخزين فارغ؛ سيتم حفظ القطعة بدون حركة مخزون.");
    if (item.part_code === null) issues.push("كود القطعة غير مسجل؛ لم يتم إنشاء كود تلقائي.");
    const otherLocations = otherLocationsMentioned(item.notes, locations, item.location_id);
    if (otherLocations.length) {
      issues.push("الملاحظات تشير إلى مخزن آخر (" + otherLocations.map(x => x.name).join("، ") + ")؛ الكمية لن تُوزع تلقائيًا. راجع توزيعها يدويًا.");
    }
    if (item.sale_price_piasters === null) issues.push("سعر البيع غير مسجل؛ سيظل فارغًا وليس صفرًا.");
    if (item.purchase_price_piasters === null) issues.push("سعر الشراء غير مسجل؛ سيظل فارغًا وليس صفرًا.");
    // Only flag a true duplicate identity in the same location. A reused part
    // code or name alone is not enough: different models/years/conditions may
    // represent distinct stock records.
    const fingerprint = rowFingerprint(item);
    if (fingerprint !== '["","","",null,null,"","",""]' && seenRows.has(fingerprint)) {
      issues.push("يوجد صف مطابق تمامًا لنفس القطعة والتوافق والحالة والكود وفي نفس المخزن؛ راجع الصفين قبل الاستيراد.");
    }
    if (fingerprint !== '["","","",null,null,"","",""]') seenRows.add(fingerprint);
    output.push({ row_number: index + 1, raw, item, issues, candidates: [] });
  }
  const candidatesByRow = await findCandidatesForItems(db, output.map(row => row.item), cachedProducts);
  for (let index = 0; index < output.length; index++) {
    output[index].candidates = candidatesByRow[index];
    if (candidatesByRow[index].length) {
      output[index].issues.push("احتمال تكرار: راجع السجلات الموجودة واختر المطابقة أو إنشاء سجل مستقل.");
    }
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
    const parsed = await readJsonBody(request, MAX_REQUEST_BYTES);
    if (parsed.error) return reply({ error: parsed.error }, 400);
    const filename = String(parsed.body.filename || "inventory.xlsx").slice(-120);
    const sheetRows = parsed.body.rows;
    if (!filename.toLowerCase().endsWith(".xlsx")) return reply({ error: "النسخة الحالية تقبل ملفات Excel بصيغة .xlsx فقط." }, 400);
    if (!Array.isArray(sheetRows) || !sheetRows.length) return reply({ error: "ورقة العمل فارغة أو بياناتها غير صالحة." }, 400);
    if (sheetRows.length - 1 > MAX_ROWS) return reply({ error: "الملف يتجاوز الحد الأقصى وهو 100 صف." }, 413);
    if (sheetRows.some(row => !Array.isArray(row) || row.some(cell =>
      cell !== null && cell !== undefined && !["string", "number", "boolean"].includes(typeof cell)
    ))) return reply({ error: "بنية صفوف Excel غير صالحة. أعد حفظ الملف بصيغة XLSX وحاول مرة أخرى." }, 400);
    const actualHeaders = (sheetRows[0] || []).map(x => normalize(x));
    const expectedHeaders = HEADERS.map(normalize);
    const missing = HEADERS.filter((header, i) => actualHeaders[i] !== expectedHeaders[i]);
    const extraHeaders = actualHeaders.slice(HEADERS.length).some(value => value !== "");
    const extraData = sheetRows.slice(1).some(row => (row || []).slice(HEADERS.length).some(value => textValue(value) !== null));
    if (missing.length || extraHeaders || extraData) return reply({ error: "عناوين الأعمدة أو بياناتها لا تطابق قالب بكار المكوّن من 12 عمودًا.", expected_headers: HEADERS, actual_headers: sheetRows[0] || [] }, 400);
    // Hash and reject duplicate batches before running product-candidate lookups.
    const canonicalRows = sheetRows.map(row => row.map(cell =>
      typeof cell === "string" ? cell.normalize("NFKC").trim() : cell
    ));
    const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(canonicalRows)));
    const existingBatch = await env.DB.prepare("SELECT id,status,filename,created_at FROM import_batches WHERE content_sha256=? ORDER BY created_at DESC LIMIT 1").bind(hash).first();
    if (existingBatch?.status === "preview") {
      return reply({ error: "يوجد بالفعل ملف مطابق بانتظار المراجعة. تم فتح المعاينة المحفوظة بدل إنشاء دفعة مكررة.", existing_batch: existingBatch }, 409);
    }
    const rows = await parseRows(env.DB, sheetRows);
    if (!rows.length) return reply({ error: "لم يتم العثور على صفوف بيانات." }, 400);
    const batchId = crypto.randomUUID();
    const uniqueFileHash = hash + ":" + batchId;
    const now = new Date().toISOString();
    try {
      const statements = [
        env.DB.prepare("INSERT INTO import_batches(id,filename,file_sha256,content_sha256,status,total_rows,created_by,created_at) VALUES(?,?,?,?,'preview',?,?,?)")
          .bind(batchId, filename, uniqueFileHash, hash, rows.length, session.email, now),
        ...rows.map(row => env.DB.prepare(`
          INSERT INTO import_batch_rows(id,batch_id,row_number,raw_json,normalized_json,issues_json,status,created_at)
          VALUES(?,?,?,?,?,?,'preview',?)
        `).bind(crypto.randomUUID(), batchId, row.row_number, JSON.stringify(row.raw), JSON.stringify(row.item), JSON.stringify(row.issues), now)),
      ];
      // One D1 transaction: a failed staging write leaves no half-created batch.
      await env.DB.batch(statements);
    } catch (error) {
      const existing = await env.DB.prepare("SELECT id,status,filename FROM import_batches WHERE content_sha256=? ORDER BY created_at DESC LIMIT 1").bind(hash).first();
      if (existing) return reply({ error: "تم رفع هذا الملف من قبل. استخدم المعاينة الموجودة بدل إعادة استيراده.", existing_batch: existing }, 409);
      console.error("excel_import_stage_failed", String(error?.message || error));
      return reply({ error: "تعذر حفظ معاينة الاستيراد." }, 500);
    }
    return reply({
      batch_id: batchId, filename, total_rows: rows.length,
      previous_import: existingBatch ? { id: existingBatch.id, filename: existingBatch.filename, status: existingBatch.status, created_at: existingBatch.created_at } : null,
      warning_rows: rows.filter(r => r.issues.length).length,
      duplicate_rows: rows.filter(r => r.candidates.length).length,
      rows: rows.map(r => ({ row_number: r.row_number, item: r.item, issues: r.issues, candidates: r.candidates })),
    }, 201);
  }

  const rowEditMatch = path.match(/^\/api\/admin\/imports\/([0-9a-f-]{36})\/rows\/(\d+)$/i);
  if (rowEditMatch && method === "PUT") {
    const origin = request.headers.get("Origin");
    const fetchSite = request.headers.get("Sec-Fetch-Site");
    if (!origin || origin !== new URL(request.url).origin || (fetchSite && fetchSite !== "same-origin")) {
      return reply({ error: "Invalid request origin." }, 403);
    }
    const parsed = await readJsonBody(request, 12 * 1024);
    if (parsed.error) return reply({ error: parsed.error }, 400);
    const values = parsed.body?.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      return reply({ error: "بيانات التعديل غير صالحة." }, 400);
    }
    const allowed = new Set(HEADERS);
    if (Object.keys(values).some(key => !allowed.has(key))) {
      return reply({ error: "يوجد حقل غير معروف في التعديل." }, 400);
    }
    for (const value of Object.values(values)) {
      if (value !== null && value !== undefined && !["string","number","boolean"].includes(typeof value)) {
        return reply({ error: "قيم التعديل يجب أن تكون نصوصًا أو أرقامًا بسيطة." }, 400);
      }
    }
    const batchId = rowEditMatch[1];
    const rowNumber = Number(rowEditMatch[2]);
    const batch = await env.DB.prepare("SELECT id,status,apply_token,apply_lock_expires_at FROM import_batches WHERE id=?").bind(batchId).first();
    if (!batch) return reply({ error: "دفعة الاستيراد غير موجودة." }, 404);
    if (batch.status !== "preview") return reply({ error: "لا يمكن تعديل صف بعد اعتماد الدفعة." }, 409);
    if (batch.apply_token && batch.apply_lock_expires_at && batch.apply_lock_expires_at > new Date().toISOString()) {
      return reply({ error: "لا يمكن تعديل الصف أثناء تنفيذ دفعة الاستيراد." }, 409);
    }
    const existing = await env.DB.prepare("SELECT id,raw_json,status FROM import_batch_rows WHERE batch_id=? AND row_number=?")
      .bind(batchId,rowNumber).first();
    if (!existing) return reply({ error: "صف الاستيراد غير موجود." }, 404);
    if (existing.status !== "preview") return reply({ error: "لا يمكن تعديل صف تم اعتماده أو تخطيه." }, 409);
    const raw = JSON.parse(existing.raw_json);
    for (const [key,value] of Object.entries(values)) raw[key] = value;
    const parsedRows = await parseRows(env.DB,[HEADERS,HEADERS.map(header=>raw[header]??null)]);
    if (!parsedRows.length) return reply({ error: "لا يمكن حفظ صف فارغ بالكامل." }, 400);
    const updated = parsedRows[0];
    updated.row_number = rowNumber;
    await env.DB.prepare(`
      UPDATE import_batch_rows SET raw_json=?,normalized_json=?,issues_json=?
      WHERE id=? AND status='preview'
    `).bind(JSON.stringify(raw),JSON.stringify(updated.item),JSON.stringify(updated.issues),existing.id).run();
    return reply({
      row_number: rowNumber, raw, item: updated.item,
      issues: updated.issues, candidates: updated.candidates, status: "preview",
    });
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
          p.sale_price_piasters, p.purchase_price_piasters, p.internal_notes, p.version,
          COALESCE(SUM(ib.quantity),0) AS total_quantity,
          COALESCE((
            SELECT json_group_array(json_object(
              'brand_id',f.brand_id,'brand_name_ar',b.name_ar,'model',f.model,
              'year_from',f.year_from,'year_to',f.year_to,
              'compatibility_status',f.compatibility_status
            ))
            FROM product_fitments f JOIN brands b ON b.id=f.brand_id
            WHERE f.product_id=p.id
          ),'[]') AS fitments_json
        FROM products p LEFT JOIN inventory_balances ib ON ib.product_id=p.id
        WHERE p.archived_at IS NULL
        GROUP BY p.id ORDER BY p.updated_at DESC LIMIT 500
      `).all(),
    ]);
    const records = rows.results || [];
    const pendingRows = records.filter(row => row.status === "preview");
    const candidateLists = await findCandidatesForItems(
      env.DB, pendingRows.map(row => JSON.parse(row.normalized_json)), products.results || []
    );
    const candidatesByRow = new Map(pendingRows.map((row, index) => [row.row_number, candidateLists[index]]));
    const mapped = records.map(row => ({
      row_number: row.row_number, raw: JSON.parse(row.raw_json),
      item: JSON.parse(row.normalized_json), issues: JSON.parse(row.issues_json),
      status: row.status, product_id: row.applied_product_id,
      candidates: candidatesByRow.get(row.row_number) || [],
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
    const parsedBody = await readJsonBody(request, 64 * 1024);
    if (parsedBody.error) return reply({ error: parsedBody.error }, 400);
    const decisions = parsedBody.body?.decisions;
    if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) return reply({ error: "قرارات الصفوف مطلوبة." }, 400);
    const batchId = applyMatch[1];
    const batch = await env.DB.prepare("SELECT id,status,apply_token,apply_lock_expires_at FROM import_batches WHERE id=?").bind(batchId).first();
    if (!batch) return reply({ error: "دفعة الاستيراد غير موجودة." }, 404);
    if (batch.status !== "preview") return reply({ error: "هذه الدفعة ليست في حالة تسمح بالاعتماد." }, 409);
    if (batch.apply_token && batch.apply_lock_expires_at && batch.apply_lock_expires_at > new Date().toISOString()) {
      return reply({ error: "دفعة الاستيراد قيد التنفيذ بالفعل. انتظر قليلًا ثم أعد فتح المعاينة." }, 409);
    }
    const rowsResult = await env.DB.prepare("SELECT * FROM import_batch_rows WHERE batch_id=? AND status='preview' ORDER BY row_number").bind(batchId).all();
    const rows = rowsResult.results || [];
    if (!rows.length) return reply({ error: "لا توجد صفوف معلقة في هذه الدفعة." }, 409);
    const [productsResult] = await Promise.all([
      env.DB.prepare(`
        SELECT p.id, p.part_name_ar, p.part_code, p.condition,
          p.sale_price_piasters, p.purchase_price_piasters, p.internal_notes, p.version,
          COALESCE(SUM(ib.quantity),0) AS total_quantity,
          COALESCE((
            SELECT json_group_array(json_object(
              'brand_id',f.brand_id,'brand_name_ar',b.name_ar,'model',f.model,
              'year_from',f.year_from,'year_to',f.year_to,
              'compatibility_status',f.compatibility_status
            ))
            FROM product_fitments f JOIN brands b ON b.id=f.brand_id
            WHERE f.product_id=p.id
          ),'[]') AS fitments_json
        FROM products p LEFT JOIN inventory_balances ib ON ib.product_id=p.id
        WHERE p.archived_at IS NULL
        GROUP BY p.id ORDER BY p.updated_at DESC LIMIT 500
      `).all(),
    ]);
    const candidateLists = await findCandidatesForItems(
      env.DB, rows.map(row => JSON.parse(row.normalized_json)), productsResult.results || []
    );
    const candidatesByRow = new Map();
    const rowChoices = new Map();
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const item = JSON.parse(row.normalized_json);
      const issues = JSON.parse(row.issues_json);
      const candidates = candidateLists[index] || [];
      candidatesByRow.set(row.row_number, candidates);
      const supplied = decisions[String(row.row_number)];
      const cleanAutomaticRow = issues.length === 0 && candidates.length === 0;
      const choice = supplied === undefined && cleanAutomaticRow ? "create" : supplied;
      const invalidRow = !item.part_name_ar || item.part_name_ar.length > 160 ||
        (item.year_from !== null && item.year_to !== null && item.year_to < item.year_from);
      const exactDuplicate = issues.some(issue => issue.startsWith("يوجد صف مطابق تمامًا"));
      if (typeof choice !== "string" || !["skip", "create"].includes(choice) && !/^match:[0-9a-f-]{36}$/i.test(choice)) {
        return reply({ error: "يوجد صف يحتاج مراجعة. اختر إنشاء أو مطابقة أو تخطي.", row_number: row.row_number }, 400);
      }
      if ((invalidRow || exactDuplicate) && choice !== "skip") {
        return reply({ error: "هذا الصف غير صالح أو مكرر داخل الملف؛ المتاح له هو التخطي فقط.", row_number: row.row_number }, 400);
      }
      if (choice.startsWith("match:") && !candidates.some(candidate => candidate.id === choice.slice(6))) {
        return reply({ error: "السجل المختار لم يعد مطابقًا لهذا الصف أو لم يعد متاحًا. أعد فتح المعاينة واختر من النتائج الحالية.", row_number: row.row_number }, 409);
      }
      rowChoices.set(row.row_number, choice);
    }
    const conflictingRows = findDuplicateMatchedTargets(rows, rowChoices);
    if (conflictingRows) {
      return reply({
        error: "أكثر من صف يستهدف نفس القطعة الموجودة في نفس المخزن. لا يمكن جمع كمياتها تلقائيًا؛ اختر إنشاء سجلات مستقلة عند التأكد أو تخطَّ الصف المتكرر.",
        row_numbers: conflictingRows,
      }, 409);
    }
    const lockToken = crypto.randomUUID();
    const lockExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const lock = await env.DB.prepare(`
      UPDATE import_batches SET apply_token=?, apply_lock_expires_at=?
      WHERE id=? AND status='preview'
        AND (apply_token IS NULL OR apply_lock_expires_at IS NULL OR apply_lock_expires_at < ?)
    `).bind(lockToken, lockExpiry, batchId, new Date().toISOString()).run();
    if (!lock.meta?.changes) {
      const latest = await env.DB.prepare("SELECT status FROM import_batches WHERE id=?").bind(batchId).first();
      return reply({ error: latest?.status === "applied" ? "تم اعتماد هذه الدفعة بالفعل." : "دفعة الاستيراد قيد التنفيذ بالفعل. انتظر قليلًا ثم أعد فتح المعاينة." }, 409);
    }

    let created = 0, matched = 0, skipped = 0, failed = 0;
    const failureMessage = "تعذر اعتماد هذه المجموعة بسبب تعارض أو قيد في قاعدة البيانات؛ لم يتم حفظ أي صف منها. راجع البيانات ثم أعد المحاولة أو تخطَّ الصفوف.";
    const markChunkFailed = async chunk => {
      const statements = chunk.map(row => {
        const issues = JSON.parse(row.issues_json);
        if (!issues.includes(failureMessage)) issues.push(failureMessage);
        return env.DB.prepare("UPDATE import_batch_rows SET issues_json=? WHERE id=? AND status='preview'")
          .bind(JSON.stringify(issues), row.id);
      });
      try { if (statements.length) await env.DB.batch(statements); }
      catch (error) { console.error("excel_import_failure_annotation_failed", String(error?.message || error)); }
    };

    const skippedRows = rows.filter(row => rowChoices.get(row.row_number) === "skip");
    if (skippedRows.length) {
      try {
        await env.DB.batch(skippedRows.map(row => env.DB.prepare(
          "UPDATE import_batch_rows SET status='skipped',applied_at=? WHERE id=? AND status='preview'"
        ).bind(new Date().toISOString(), row.id)));
        skipped = skippedRows.length;
      } catch (error) {
        console.error("excel_import_skip_batch_failed", String(error?.message || error));
        failed += skippedRows.length;
        await markChunkFailed(skippedRows);
      }
    }

    const applyPlans = [];
    for (const row of rows) {
      const choice = rowChoices.get(row.row_number);
      if (choice === "skip") continue;
      const item = JSON.parse(row.normalized_json);
      const action = choice === "create" ? "created" : "matched";
      const productId = action === "created" ? crypto.randomUUID() : choice.slice(6);
      const candidate = action === "matched" ? candidates.find(value => value.id === productId) : null;
      applyPlans.push({ row, item, action, productId, candidate });
    }

    for (let offset = 0; offset < applyPlans.length; offset += 40) {
      const chunk = applyPlans.slice(offset, offset + 40);
      const statements = [];
      for (const plan of chunk) {
        const { row, item, action, productId } = plan;
        const now = new Date().toISOString();
        if (action === "created") {
          const notes = [
            item.notes,
            item.brand_raw ? "الماركة من ملف الاستيراد: " + item.brand_raw : "",
            item.model_raw && !item.model ? "موديل السيارة كما ورد: " + item.model_raw : "",
          ].filter(Boolean).join("\n").slice(0, 2000) || null;
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
        if (action === "matched") {
          const existing = plan.candidate;
          if (!existing) throw new Error("matched_product_candidate_missing");
          const updated = buildMatchedProductUpdate(existing, item);
          statements.push(env.DB.prepare(`
            UPDATE products SET part_name_ar=?, condition=?, part_code=?,
              sale_price_piasters=?, purchase_price_piasters=?, internal_notes=?,
              version=version+1, updated_at=?
            WHERE id=? AND version=?
          `).bind(
            updated.part_name_ar, updated.condition, updated.part_code,
            updated.sale_price_piasters, updated.purchase_price_piasters,
            updated.internal_notes, now, productId, existing.version
          ));
          if (item.brand_id && item.model) {
            statements.push(env.DB.prepare(`
              INSERT INTO product_fitments(id,product_id,brand_id,model,year_from,year_to,compatibility_status,created_at,updated_at)
              SELECT ?,?,?,?,?,?,'pending',?,?
              WHERE NOT EXISTS (
                SELECT 1 FROM product_fitments
                WHERE product_id=? AND brand_id=? AND lower(trim(model))=lower(trim(?))
                  AND year_from IS ? AND year_to IS ?
              )
            `).bind(
              crypto.randomUUID(), productId, item.brand_id, item.model,
              item.year_from, item.year_to, now, now,
              productId, item.brand_id, item.model, item.year_from, item.year_to
            ));
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
          INSERT INTO audit_log(id,entity_type,entity_id,action,before_json,after_json,actor_email,created_at)
          VALUES(?,?,?,?,?,?,?,?)
        `).bind(crypto.randomUUID(), "product", productId, "excel_import_" + action,
          action === "matched" ? JSON.stringify(plan.candidate) : null,
          JSON.stringify({
            batch_id: batchId, row_number: row.row_number,
            target_quantity: item.quantity, location_id: item.location_id,
            product_fields: action === "matched" ? buildMatchedProductUpdate(plan.candidate, item) : {
              part_name_ar: item.part_name_ar, condition: item.condition, part_code: item.part_code,
              sale_price_piasters: item.sale_price_piasters,
              purchase_price_piasters: item.purchase_price_piasters, internal_notes: item.notes
            }
          }), session.email, now));
        statements.push(env.DB.prepare("UPDATE import_batch_rows SET status='applied',applied_action=?,applied_product_id=?,applied_at=? WHERE id=? AND status='preview'")
          .bind(action, productId, now, row.id));
      }
      try {
        await env.DB.batch(statements);
        for (const plan of chunk) {
          if (plan.action === "created") created++; else matched++;
        }
      } catch (error) {
        console.error("excel_import_chunk_failed", {
          first_row: chunk[0]?.row.row_number, last_row: chunk[chunk.length - 1]?.row.row_number,
          row_count: chunk.length, error: String(error?.message || error),
        });
        failed += chunk.length;
        await markChunkFailed(chunk.map(plan => plan.row));
      }
    }

    const pending = await env.DB.prepare("SELECT COUNT(*) AS count FROM import_batch_rows WHERE batch_id=? AND status='preview'").bind(batchId).first();
    const complete = Number(pending?.count || 0) === 0;
    const [locationReport, fitmentReport] = await Promise.all([
      env.DB.prepare(`
        SELECT l.name AS location_name, COUNT(DISTINCT ib.product_id) AS product_count,
          COALESCE(SUM(ib.quantity),0) AS total_quantity
        FROM inventory_balances ib JOIN locations l ON l.id=ib.location_id
        WHERE ib.product_id IN (
          SELECT applied_product_id FROM import_batch_rows
          WHERE batch_id=? AND applied_product_id IS NOT NULL
        )
        GROUP BY l.id,l.name ORDER BY l.name
      `).bind(batchId).all(),
      env.DB.prepare(`
        SELECT COUNT(DISTINCT r.applied_product_id) AS count FROM import_batch_rows r
        WHERE r.batch_id=? AND r.status='applied' AND r.applied_product_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM product_fitments f WHERE f.product_id=r.applied_product_id)
      `).bind(batchId).first(),
    ]);
    await env.DB.prepare(`
      UPDATE import_batches SET status=?,
        created_count=(SELECT COUNT(*) FROM import_batch_rows WHERE batch_id=? AND applied_action='created'),
        updated_count=(SELECT COUNT(*) FROM import_batch_rows WHERE batch_id=? AND applied_action='matched'),
        skipped_count=(SELECT COUNT(*) FROM import_batch_rows WHERE batch_id=? AND status='skipped'),
        error_count=?, applied_at=?, apply_token=NULL, apply_lock_expires_at=NULL
      WHERE id=? AND apply_token=?
    `).bind(complete ? "applied" : "preview", batchId, batchId, batchId, failed,
      complete ? new Date().toISOString() : null, batchId, lockToken).run();
    return reply({
      ok: true, created, matched, skipped, failed,
      pending: Number(pending?.count || 0), complete,
      report: {
        by_location: locationReport.results || [],
        products_without_fitment: Number(fitmentReport?.count || 0),
      },
    });
  }
  return null;
}

export {
  handleExcelImport, normalize, textValue, numberValue, moneyPiasters,
  integerValue, yearValue, rowFingerprint, likelyBrandModelMismatch, otherLocationsMentioned, findDuplicateMatchedTargets, findCandidatesForItems,
  buildMatchedProductUpdate,
};
