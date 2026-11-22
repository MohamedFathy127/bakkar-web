/**
 * Bakkar Inventory API
 * Public catalog is anonymous. Admin UI is served on this Worker origin and
 * uses an HttpOnly, SameSite=Strict session cookie (no Cloudflare Access).
 */

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const SESSION_SECONDS = 60 * 60 * 8;
const PASSWORD_ITERATIONS = 210000;
const ADMIN_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>إدارة مخزون بكار</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f3ef;color:#242424;font-family:Tahoma,Arial,sans-serif}
main{max-width:980px;margin:48px auto;padding:20px}.panel{background:#fff;border:1px solid #e5e0d8;border-radius:16px;padding:24px;margin:16px 0;box-shadow:0 8px 28px #00000008}
h1{font-size:25px;margin:0 0 8px}p{color:#666;line-height:1.7}label{display:block;margin:14px 0 6px;font-size:14px}
input{width:100%;padding:13px;border:1px solid #d7d1c8;border-radius:9px;font:inherit}
button{border:0;border-radius:9px;background:#292929;color:white;padding:12px 20px;font:inherit;cursor:pointer;margin-top:16px}
button.secondary{background:#eee;color:#222}button:disabled{opacity:.5}
.notice{padding:12px;border-radius:9px;background:#f5f0e6;margin-top:14px;white-space:pre-wrap}
.hidden{display:none}.muted{font-size:13px;color:#777}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:right;padding:11px;border-bottom:1px solid #eee;font-size:14px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.brand{font-weight:bold;color:#8c2727}
</style></head><body><main>
<header><div><div class="brand">بكار لقطع غيار السيارات</div><h1>إدارة المخزون</h1><p>هذه لوحة خاصة بالإدارة فقط. الموقع العام لا يحتاج إلى تسجيل دخول.</p></div><button id="logout" class="secondary hidden">تسجيل الخروج</button></header>
<section id="login" class="panel"><h2>تسجيل دخول المالك</h2>
<label>البريد الإلكتروني</label><input id="email" type="email" autocomplete="username" placeholder="البريد المسجل للمالك">
<label>كلمة المرور</label><input id="password" type="password" autocomplete="current-password" placeholder="كلمة المرور">
<button id="loginBtn">دخول</button><div id="loginMsg" class="notice hidden"></div></section>
<section id="setup" class="panel hidden"><h2>تهيئة حساب المالك لأول مرة</h2><p>تظهر هذه الخطوة فقط قبل إنشاء حساب المالك. أدخل مفتاح التهيئة الذي سيتم ضبطه سرًا في إعدادات Worker، وليس كلمة مرور حسابك.</p>
<label>البريد الإلكتروني للمالك</label><input id="setupEmail" type="email" autocomplete="username">
<label>مفتاح التهيئة المؤقت</label><input id="setupKey" type="password" autocomplete="off">
<label>كلمة مرور جديدة (12 حرفًا على الأقل)</label><input id="setupPassword" type="password" autocomplete="new-password">
<button id="setupBtn">إنشاء حساب المالك</button><div id="setupMsg" class="notice hidden"></div></section>
<section id="dashboard" class="panel hidden"><h2>مرحبًا <span id="who"></span></h2><p>تم تسجيل الدخول بنجاح. هذه نسخة أولية للوحة الإدارة؛ وظائف تعديل المنتجات وحركات المخزون لم تُفعّل بعد.</p><h3>المنتجات المسجلة</h3><div id="products">جارٍ التحميل...</div></section>
<script>
const $=id=>document.getElementById(id);
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{"content-type":"application/json",...(opts.headers||{})},credentials:"same-origin"});const d=await r.json().catch(()=>({error:"استجابة غير مفهومة"}));if(!r.ok)throw Error(d.error||"حدث خطأ");return d}
function message(id,s){$(id).textContent=s;$(id).classList.remove("hidden")}
function show(which){["login","setup","dashboard"].forEach(x=>$(x).classList.toggle("hidden",x!==which));$("logout").classList.toggle("hidden",which!=="dashboard")}
async function refresh(){try{const d=await api("/api/admin/me");$("who").textContent=d.user.email;show("dashboard");const p=await api("/api/admin/products");if(!p.data.length){$("products").textContent="لا توجد منتجات مسجلة حتى الآن."}else{$("products").innerHTML="<table><thead><tr><th>اسم القطعة</th><th>الحالة</th><th>الكمية</th></tr></thead><tbody>"+p.data.map(x=>"<tr><td>"+escapeHtml(x.part_name_ar)+"</td><td>"+escapeHtml(x.condition||"—")+"</td><td>"+Number(x.total_quantity||0)+"</td></tr>").join("")+"</tbody></table>"} }catch(e){show("login")}}
function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
$("loginBtn").onclick=async()=>{try{await api("/api/admin/login",{method:"POST",body:JSON.stringify({email:$("email").value,password:$("password").value})});$("password").value="";await refresh()}catch(e){message("loginMsg",e.message)}};
$("setupBtn").onclick=async()=>{try{await api("/api/admin/setup",{method:"POST",body:JSON.stringify({email:$("setupEmail").value,setup_key:$("setupKey").value,password:$("setupPassword").value})});$("setupKey").value="";$("setupPassword").value="";await refresh()}catch(e){message("setupMsg",e.message)}};
$("logout").onclick=async()=>{try{await api("/api/admin/logout",{method:"POST",body:"{}"})}finally{show("login")}};
(async()=>{try{const s=await api("/api/admin/status");if(s.needs_setup)show("setup");else await refresh()}catch(e){show("login")}})();
</script></main></body></html>`;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}
function decodeBase64(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
async function derivePassword(password, salt, iterations = PASSWORD_ITERATIONS) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, 256);
  return base64Url(new Uint8Array(bits));
}
function cookieValue(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const part = raw.split(";").map(x => x.trim()).find(x => x.startsWith(name + "="));
  return part ? part.slice(name.length + 1) : null;
}
function sessionCookie(value, maxAge) {
  return `bakkar_admin_session=${value}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
function requireSameOrigin(request, env) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin === new URL(request.url).origin && env.ALLOWED_ORIGIN);
}
async function getSession(request, env) {
  const token = cookieValue(request, "bakkar_admin_session");
  if (!token) return null;
  const tokenHash = await sha256(token);
  const session = await env.DB.prepare(`
    SELECT s.email, s.expires_at, a.role
    FROM admin_sessions s JOIN staff_accounts a ON a.email = s.email COLLATE NOCASE
    WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND a.active = 1 AND a.role = 'owner'
    LIMIT 1
  `).bind(tokenHash).first();
  return session || null;
}
async function handleCatalog(url, env) {
  const rawLimit = Number(url.searchParams.get("limit") || 24);
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 24;
  const cursor = url.searchParams.get("cursor");
  const search = (url.searchParams.get("q") || "").trim().slice(0, 80);
  const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const result = await env.DB.prepare(`
    SELECT pc.product_id AS id, MAX(pc.part_name_ar) AS name, MAX(pc.part_name_en) AS name_en,
      MAX(pc.condition) AS condition, MAX(pc.part_code) AS part_code,
      MAX(pc.sale_price_piasters) AS sale_price_piasters, MAX(pc.category_name_ar) AS category,
      json_group_array(json_object('brand_ar',pc.vehicle_brand_ar,'brand_en',pc.vehicle_brand_en,
        'model',pc.vehicle_model,'year_from',pc.year_from,'year_to',pc.year_to)) AS fitments
    FROM public_catalog pc
    WHERE (? = '' OR pc.part_name_ar LIKE ? ESCAPE '\\' OR COALESCE(pc.part_code,'') LIKE ? ESCAPE '\\'
      OR pc.vehicle_model LIKE ? ESCAPE '\\' OR pc.vehicle_brand_ar LIKE ? ESCAPE '\\')
      AND (? IS NULL OR pc.product_id > ?)
    GROUP BY pc.product_id ORDER BY pc.product_id ASC LIMIT ?
  `).bind(search, pattern, pattern, pattern, pattern, cursor, cursor, limit + 1).all();
  const rows = result.results || [], hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(row => ({ ...row, fitments: JSON.parse(row.fitments || "[]") }));
  return json({ data: page, pagination: { limit, has_more: hasMore, next_cursor: hasMore ? page[page.length - 1]?.id ?? null : null } });
}
async function handleAdmin(request, url, env) {
  const path = url.pathname;
  if (path === "/api/admin/status" && request.method === "GET") {
    const owner = await env.DB.prepare("SELECT email FROM staff_accounts WHERE role='owner' AND active=1 LIMIT 1").first();
    return json({ needs_setup: !owner });
  }
  if (path === "/api/admin/setup" && request.method === "POST") {
    if (!requireSameOrigin(request, env)) return json({ error: "Invalid request origin." }, 403);
    if (!env.OWNER_EMAIL || !env.BOOTSTRAP_SECRET) return json({ error: "Owner setup is not configured. Set OWNER_EMAIL and BOOTSTRAP_SECRET first." }, 503);
    const existing = await env.DB.prepare("SELECT email FROM staff_accounts WHERE role='owner' LIMIT 1").first();
    if (existing) return json({ error: "Owner account has already been initialized." }, 409);
    const body = await request.json();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (email !== env.OWNER_EMAIL.toLowerCase() || body.setup_key !== env.BOOTSTRAP_SECRET) return json({ error: "Invalid setup credentials." }, 403);
    if (password.length < 12 || password.length > 128) return json({ error: "Password must be 12–128 characters." }, 400);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derivePassword(password, salt);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO staff_accounts(email,role,active) VALUES(?, 'owner', 1)").bind(email),
      env.DB.prepare("INSERT INTO admin_credentials(email,password_salt,password_hash,iterations) VALUES(?,?,?,?)").bind(email, base64Url(salt), hash, PASSWORD_ITERATIONS),
      env.DB.prepare("INSERT INTO audit_log(id,entity_type,entity_id,action,after_json,actor_email) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(),"staff",email,"owner_initialized",JSON.stringify({email,role:"owner"}),email),
    ]);
    return createSession(email, env);
  }
  if (path === "/api/admin/login" && request.method === "POST") {
    if (!requireSameOrigin(request, env)) return json({ error: "Invalid request origin." }, 403);
    const body = await request.json();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email || password.length > 128) return json({ error: "Invalid email or password." }, 400);
    const attemptKey = await sha256(email + ":" + (request.headers.get("CF-Connecting-IP") || "unknown"));
    const attempt = await env.DB.prepare("SELECT attempts, window_started_at FROM login_attempts WHERE attempt_key=?").bind(attemptKey).first();
    const withinWindow = attempt && (Date.now() - Date.parse(attempt.window_started_at)) < 15 * 60 * 1000;
    if (withinWindow && attempt.attempts >= 5) return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
    const credential = await env.DB.prepare(`
      SELECT c.password_salt,c.password_hash,c.iterations,a.email
      FROM admin_credentials c JOIN staff_accounts a ON a.email=c.email COLLATE NOCASE
      WHERE c.email=? COLLATE NOCASE AND a.active=1 LIMIT 1
    `).bind(email).first();
    let valid = false;
    if (credential && password) {
      const candidate = await derivePassword(password, decodeBase64(credential.password_salt), credential.iterations);
      valid = candidate === credential.password_hash;
    }
    if (!valid) {
      if (withinWindow) await env.DB.prepare("UPDATE login_attempts SET attempts=attempts+1 WHERE attempt_key=?").bind(attemptKey).run();
      else await env.DB.prepare("INSERT INTO login_attempts(attempt_key,attempts,window_started_at) VALUES(?,1,?) ON CONFLICT(attempt_key) DO UPDATE SET attempts=1,window_started_at=excluded.window_started_at").bind(attemptKey,new Date().toISOString()).run();
      return json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة." }, 401);
    }
    await env.DB.prepare("DELETE FROM login_attempts WHERE attempt_key=?").bind(attemptKey).run();
    return createSession(credential.email, env);
  }
  if (path === "/api/admin/logout" && request.method === "POST") {
    if (!requireSameOrigin(request, env)) return json({ error: "Invalid request origin." }, 403);
    const token = cookieValue(request, "bakkar_admin_session");
    if (token) await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }
  const session = await getSession(request, env);
  if (!session) return json({ error: "Authentication required." }, 401);
  if (path === "/api/admin/me" && request.method === "GET") return json({ user: { email: session.email, role: session.role } });
  if (path === "/api/admin/products" && request.method === "GET") {
    const rawLimit = Number(url.searchParams.get("limit") || 50);
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
    const result = await env.DB.prepare(`
      SELECT p.id,p.part_name_ar,p.part_name_en,p.condition,p.part_code,p.sale_price_piasters,
        p.purchase_price_piasters,p.is_public,p.created_at,p.updated_at,COALESCE(SUM(ib.quantity),0) AS total_quantity
      FROM products p LEFT JOIN inventory_balances ib ON ib.product_id=p.id
      WHERE p.archived_at IS NULL GROUP BY p.id ORDER BY p.updated_at DESC,p.id ASC LIMIT ?
    `).bind(limit).all();
    return json({ data: result.results || [] });
  }
  return json({ error: "Route not found." }, 404);
}
async function createSession(email, env) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  await env.DB.prepare("INSERT INTO admin_sessions(token_hash,email,expires_at) VALUES(?,?,?)").bind(tokenHash,email,expiresAt).run();
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(token, SESSION_SECONDS) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = (() => {
      const origin = request.headers.get("Origin");
      if (!origin || origin !== env.ALLOWED_ORIGIN) return {};
      return { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,OPTIONS",
        "access-control-allow-headers": "Content-Type", "access-control-max-age": "86400", "vary": "Origin" };
    })();
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === "/admin" && request.method === "GET") return new Response(ADMIN_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" }
      });
      if (url.pathname === "/api/health" && request.method === "GET") {
        const check = await env.DB.prepare("SELECT 1 AS ok").first();
        return json({ status: check?.ok === 1 ? "ok" : "degraded", service: "bakkar-inventory-api" }, 200, cors);
      }
      if (url.pathname === "/api/catalog" && request.method === "GET") {
        const response = await handleCatalog(url, env);
        for (const [key,value] of Object.entries(cors)) response.headers.set(key,value);
        return response;
      }
      if (url.pathname.startsWith("/api/admin/")) {
        const response = await handleAdmin(request,url,env);
        for (const [key,value] of Object.entries(cors)) response.headers.set(key,value);
        return response;
      }
      return json({ error: "Not found." }, 404, cors);
    } catch (error) {
      console.error(JSON.stringify({ message:"API request failed",path:url.pathname,error:error instanceof Error?error.message:"Unknown error" }));
      return json({ error:"Internal server error." },500,cors);
    }
  }
};
