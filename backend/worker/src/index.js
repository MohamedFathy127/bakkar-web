import { handleInventoryAdmin } from "./inventory.js";
import { handleExcelImport } from "./excel-import.js";

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
const PASSWORD_ITERATIONS = 100000;
const ADMIN_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>إدارة مخزون بكار</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f3ef;color:#242424;font-family:Tahoma,Arial,sans-serif}
main{max-width:980px;margin:48px auto;padding:20px}.panel{background:#fff;border:1px solid #e5e0d8;border-radius:16px;padding:24px;margin:16px 0;box-shadow:0 8px 28px #00000008}
h1{font-size:25px;margin:0 0 8px}p{color:#666;line-height:1.7}label{display:block;margin:14px 0 6px;font-size:14px}
input,select{width:100%;padding:13px;border:1px solid #d7d1c8;border-radius:9px;font:inherit;background:#fff}
.formgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.panel .panel{box-shadow:none;background:#fffdfa}
button{border:0;border-radius:9px;background:#292929;color:white;padding:12px 20px;font:inherit;cursor:pointer;margin-top:16px}
button.secondary{background:#eee;color:#222}button:disabled{opacity:.5}
.notice{padding:12px;border-radius:9px;background:#f5f0e6;margin-top:14px;white-space:pre-wrap}
.hidden{display:none}.muted{font-size:13px;color:#777}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:right;padding:11px;border-bottom:1px solid #eee;font-size:14px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.brand{font-weight:bold;color:#8c2727}
.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:12px;margin:14px 0}
.metric{background:linear-gradient(145deg,#fff,#fffaf5);border:1px solid #e9e1d7;border-radius:14px;padding:17px;min-width:0}
.metric span{display:block;color:#746d66;font-size:13px;margin-bottom:9px}.metric strong{display:block;font-size:23px;color:#292522;overflow-wrap:anywhere}
.metric small{display:block;color:#8c2727;margin-top:6px;font-size:12px}
.analytics-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.analytics-grid .panel{margin:0;padding:18px}
.bar-row{margin:13px 0}.bar-meta{display:flex;justify-content:space-between;gap:10px;font-size:13px;margin-bottom:7px}.bar-track{height:9px;background:#eee8e1;border-radius:99px;overflow:hidden}.bar-fill{height:100%;background:#8c2727;border-radius:99px}
.section-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.action-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.action-row button{margin-top:8px}
@media(max-width:640px){main{margin:12px auto;padding:10px}.panel{padding:16px}th,td{font-size:12px;padding:8px}}

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
<section id="dashboard" class="panel hidden">
<h2>مرحبًا <span id="who"></span></h2>
<p>إدارة المنتجات والأرصدة وحركة المخزون. أي تعديل هنا يُحفظ في قاعدة البيانات.</p>
<div id="adminMsg" class="notice hidden"></div>
<div id="duplicateReview" class="panel hidden"></div>
<div class="section-head"><h3>نظرة عامة على المخزون</h3><span class="muted">مؤشرات مباشرة من قاعدة بيانات الموقع</span></div>
<div id="analyticsCards" class="metric-grid"><div class="metric">جارٍ تحليل البيانات...</div></div>
<div class="analytics-grid">
 <section class="panel"><h3>توزيع المخزون حسب المكان</h3><div id="analyticsLocations" class="muted">جارٍ التحميل...</div></section>
 <section class="panel"><h3>توزيع القطع حسب الماركة</h3><div id="analyticsBrands" class="muted">جارٍ التحميل...</div></section>
 <section class="panel"><h3>حركة المخزون خلال آخر 30 يومًا</h3><div id="analyticsMovements" class="muted">جارٍ التحميل...</div></section>
 <section class="panel"><h3>جودة البيانات</h3><div id="analyticsQuality" class="muted">جارٍ التحميل...</div></section>
</div>
<section class="panel"><h3>آخر عمليات استيراد Excel</h3><div id="analyticsImports" class="muted">جارٍ التحميل...</div></section>
<h3>إضافة قطعة</h3>
<form id="productForm" class="panel">
<label>اسم القطعة بالعربي *</label><input id="partName" required maxlength="160">
<label>اسم القطعة بالإنجليزي</label><input id="partNameEn" maxlength="160">
<label>كود القطعة</label><input id="partCode" maxlength="80">
<label>الحالة</label><input id="condition" placeholder="جديد / استيراد / مستعمل" maxlength="40">
<div class="formgrid">
<div><label>سعر البيع (جنيه)</label><input id="salePrice" type="number" min="0" step="0.01"></div>
<div><label>سعر الشراء (جنيه)</label><input id="purchasePrice" type="number" min="0" step="0.01"></div>
</div>
<h4>توافق السيارة (اختياري)</h4>
<div class="formgrid">
<div><label>الماركة</label><select id="brandId"><option value="">اختر الماركة</option></select></div>
<div><label>الموديل</label><input id="vehicleModel" maxlength="80" placeholder="مثال: Elantra"></div>
<div><label>من سنة</label><input id="yearFrom" type="number" min="1900" max="2100"></div>
<div><label>إلى سنة</label><input id="yearTo" type="number" min="1900" max="2100"></div>
</div>
<label>حالة التوافق</label><select id="fitmentStatus"><option value="pending">يحتاج تأكيد</option><option value="confirmed">مؤكد</option><option value="unconfirmed">غير مؤكد</option></select>
<label><input id="isPublic" type="checkbox" style="width:auto"> إظهار القطعة في الموقع العام (يتطلب توافقًا مؤكدًا)</label>
<button id="saveProductBtn" type="submit">حفظ القطعة</button><button id="cancelEditBtn" class="secondary hidden" type="button">إلغاء التعديل</button>
</form>
<h3>المخازن</h3>
<form id="locationForm" class="panel">
<label>اسم المخزن أو مكان التخزين</label><input id="locationName" maxlength="80" required>
<button type="submit">إضافة مكان تخزين</button>
<div id="locations" class="muted"></div>
</form>
<h3>استيراد وتصدير Excel</h3>
<section class="panel">
<p>استورد ملف برنامج المخزن بعد مراجعة الصفوف، أو صدّر نسخة Excel محدثة من بيانات الموقع.</p>
<div class="action-row"><button id="exportExcelBtn" type="button" class="secondary">تصدير المخزون إلى Excel</button><span id="exportExcelMsg" class="muted"></span></div>
<p>ارفع ملف XLSX لمعاينة الصفوف أولًا. لن يتغير المخزون إلا بعد اختيار قرار لكل صف والضغط على اعتماد.</p>
<input id="excelFile" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
<button id="previewExcelBtn" type="button">رفع الملف ومعاينة الصفوف</button>
<button id="resumeExcelBtn" type="button" class="secondary">فتح معاينة سابقة</button>
<div id="excelImportMsg" class="notice hidden"></div>
<div id="excelImportSummary"></div>
<div id="excelImportRows"></div>
<button id="applyExcelBtn" type="button" class="hidden">اعتماد القرارات المحددة</button>
</section>
<h3>تسجيل حركة مخزون</h3>
<form id="movementForm" class="panel">
<label>القطعة</label><select id="movementProduct" required><option value="">اختر القطعة</option></select>
<label>المخزن</label><select id="movementLocation" required><option value="">اختر المخزن</option></select>
<div id="availableStock" class="notice">اختر القطعة والمخزن لعرض الرصيد المتاح.</div>
<label>نوع الحركة</label><select id="movementType"><option value="in">إضافة للمخزون</option><option value="out">صرف من المخزون</option></select>
<label>الكمية</label><input id="movementQuantity" type="number" min="1" max="1000000" step="1" required>
<label>السبب أو الملاحظة</label><input id="movementReason" maxlength="240">
<label>مرجع (اختياري)</label><input id="movementReference" maxlength="100">
<button type="submit">تسجيل الحركة</button>
</form>
<h3>المنتجات المسجلة</h3><div id="products">جارٍ التحميل...</div>
<h3>آخر حركات المخزون</h3><div id="movements">جارٍ التحميل...</div>
</section>
<script>
const $=id=>document.getElementById(id);
let editingProductId=null,editingVersion=null,editingFitments=[],editingCategoryId=null,editingAliases="",editingNotes="";
function clearProductEdit(){editingProductId=null;editingVersion=null;editingFitments=[];editingCategoryId=null;editingAliases="";editingNotes="";$("productForm").reset();$("saveProductBtn").textContent="حفظ القطعة";$("cancelEditBtn").classList.add("hidden");$("duplicateReview").classList.add("hidden")}
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{"content-type":"application/json",...(opts.headers||{})},credentials:"same-origin"});const d=await r.json().catch(()=>({error:"استجابة غير مفهومة"}));if(!r.ok){const e=Error(d.error||"حدث خطأ");e.status=r.status;e.code=d.code;e.data=d;throw e}return d}
function message(id,s){$(id).textContent=s;$(id).classList.remove("hidden")}
function show(which){["login","setup","dashboard"].forEach(x=>$(x).classList.toggle("hidden",x!==which));$("logout").classList.toggle("hidden",which!=="dashboard")}
async function refresh(){try{const d=await api("/api/admin/me");$("who").textContent=d.user.email;show("dashboard");await loadAdmin()}catch(e){show("login")}}
async function openExistingProductForReview(id){
 try{
  const result=await api("/api/admin/products/"+id);const p=result.data;
  editingProductId=p.id;editingVersion=Number(p.version);editingFitments=(p.fitments||[]).map(f=>({brand_id:f.brand_id,model:f.model,year_from:f.year_from,year_to:f.year_to,compatibility_status:f.compatibility_status}));
  editingCategoryId=p.category_id||null;editingAliases=p.aliases||"";editingNotes=p.internal_notes||"";
  $("partName").value=p.part_name_ar||"";$("partNameEn").value=p.part_name_en||"";$("partCode").value=p.part_code||"";$("condition").value=p.condition||"";
  $("salePrice").value=p.sale_price_piasters==null?"":(Number(p.sale_price_piasters)/100).toFixed(2);
  $("purchasePrice").value=p.purchase_price_piasters==null?"":(Number(p.purchase_price_piasters)/100).toFixed(2);
  const f=editingFitments[0];$("brandId").value=f?.brand_id||"";$("vehicleModel").value=f?.model||"";$("yearFrom").value=f?.year_from||"";$("yearTo").value=f?.year_to||"";$("fitmentStatus").value=f?.compatibility_status||"pending";$("isPublic").checked=Boolean(p.is_public);
  $("saveProductBtn").textContent="حفظ التعديلات";$("cancelEditBtn").classList.remove("hidden");
  message("adminMsg","تم فتح السجل الموجود. قارن بياناتك الجديدة بالتفاصيل المعروضة، ثم عدّل الحقول المطلوبة واحفظ. لم يتم دمج أو نقل أي مخزون تلقائيًا.");
  $("productForm").scrollIntoView({behavior:"smooth",block:"start"});
 }catch(e){message("adminMsg",e.message)}
}
function buildProductPayload(){
 let fitments=editingProductId?[...editingFitments]:[];
 if($("brandId").value||$("vehicleModel").value){
  const f={brand_id:$("brandId").value,model:$("vehicleModel").value,year_from:$("yearFrom").value||null,year_to:$("yearTo").value||null,compatibility_status:$("fitmentStatus").value};
  if(fitments.length)fitments[0]=f;else fitments.push(f);
 }
 const sale=egpToPiasters("salePrice"),purchase=egpToPiasters("purchasePrice");
 if(sale===undefined||purchase===undefined)throw Error("راجع الأسعار.");
 const payload={part_name_ar:$("partName").value,part_name_en:$("partNameEn").value,part_code:$("partCode").value,condition:$("condition").value,sale_price_piasters:sale,purchase_price_piasters:purchase,fitments,is_public:$("isPublic").checked,category_id:editingCategoryId,aliases:editingAliases,internal_notes:editingNotes};
 if(editingProductId)payload.version=editingVersion;
 return payload;
}
function showDuplicateReview(candidates,payload){
 $("duplicateReview").classList.remove("hidden");
 const money=v=>v==null?"غير محدد":(Number(v)/100).toFixed(2)+" جنيه";
 const fitments=p=>(p.fitments||[]).map(f=>[f.brand_name_ar,f.model,f.year_from||"؟",f.year_to||"؟"].join(" / ")).join("، ")||"لا يوجد توافق مسجل";
 const proposedFitments=(payload.fitments||[]).map(f=>[f.brand_id,f.model,f.year_from||"؟",f.year_to||"؟",f.compatibility_status].join(" / ")).join("، ")||"لم يتم تحديد توافق";
 $("duplicateReview").innerHTML='<h3>تنبيه: احتمال وجود قطعة مكررة</h3><p>وجدنا سجلات بنفس اسم القطعة أو كودها. راجع البيانات الجديدة مقابل كل سجل قبل اتخاذ القرار.</p>'+
 '<div class="panel"><strong>البيانات الجديدة التي أدخلتها</strong><p>الاسم: '+escapeHtml(payload.part_name_ar)+'</p><p>الحالة: '+escapeHtml(payload.condition||"غير محددة")+' | الكود: '+escapeHtml(payload.part_code||"غير مسجل")+'</p><p>سعر البيع: '+money(payload.sale_price_piasters)+' | الشراء: '+money(payload.purchase_price_piasters)+'</p><p>التوافق: '+escapeHtml(proposedFitments)+'</p></div>'+
 candidates.map(x=>'<div class="panel"><strong>السجل الموجود: '+escapeHtml(x.part_name_ar)+'</strong><p>الحالة: '+escapeHtml(x.condition||"غير محددة")+' | الكود: '+escapeHtml(x.part_code||"غير مسجل")+'</p><p>الرصيد الحالي: '+Number(x.total_quantity||0)+' قطعة</p><p>سعر البيع: '+money(x.sale_price_piasters)+' | الشراء: '+money(x.purchase_price_piasters)+'</p><p>توافق السيارات: '+escapeHtml(fitments(x))+'</p><button type="button" class="secondary sameProductBtn" data-id="'+escapeHtml(x.id)+'">نفس القطعة — افتح السجل للمراجعة</button></div>').join("")+
 '<p>لو كل النتائج دي قطع مختلفة فعلًا، أكد إنشاء سجل مستقل.</p><button type="button" id="confirmSeparateProduct">قطعة مختلفة — إنشاء سجل جديد</button>';
 document.querySelectorAll(".sameProductBtn").forEach(btn=>btn.onclick=()=>openExistingProductForReview(btn.dataset.id));
 $("confirmSeparateProduct").onclick=async()=>{
  try{
   const confirmed={...payload,duplicate_decision:"different",duplicate_confirmed_ids:candidates.map(x=>x.id)};
   await api("/api/admin/products",{method:"POST",body:JSON.stringify(confirmed)});
   clearProductEdit();message("adminMsg","تم إنشاء قطعة مستقلة بعد تأكيدك أنها مختلفة.");await loadAdmin();
  }catch(e){if(e.code==="possible_duplicate"&&e.data?.candidates)showDuplicateReview(e.data.candidates,payload);else message("adminMsg",e.message)}
 };
}
async function refreshAvailableStock(){
 const productId=$("movementProduct").value,locationId=$("movementLocation").value;
 if(!productId||!locationId){$("availableStock").textContent="اختر القطعة والمخزن لعرض الرصيد المتاح.";return}
 try{const b=await api("/api/admin/stock-balance?product_id="+encodeURIComponent(productId)+"&location_id="+encodeURIComponent(locationId));$("availableStock").textContent="الرصيد المتاح في هذا المخزن: "+b.quantity+" قطعة";}
 catch(e){$("availableStock").textContent=e.message}
}
function egpToPiasters(id){const v=$(id).value;if(v==="")return null;const n=Number(v);return Number.isFinite(n)&&n>=0?Math.round(n*100):undefined}
let currentImportBatchId=null,currentImportRows=[];
function importMessage(value){$("excelImportMsg").textContent=value;$("excelImportMsg").classList.remove("hidden")}
function renderImportRows(rows,batch){
 currentImportRows=rows||[];
 $("excelImportSummary").textContent=batch?("الملف: "+batch.filename+" — إجمالي الصفوف: "+batch.total_rows+" — الحالة: "+batch.status):"";
 $("excelImportRows").innerHTML=currentImportRows.map(r=>{
  const item=r.item||{},issues=r.issues||[],candidates=r.candidates||[];
  const exactDuplicate=issues.some(x=>x.startsWith("يوجد صف مطابق تمامًا"));
  const invalid=!item.part_name_ar||item.part_name_ar.length>160||(item.year_from!==null&&item.year_to!==null&&item.year_to<item.year_from);
  const needsReview=issues.length>0||candidates.length>0||invalid;
  const locked=exactDuplicate||invalid||r.status!=="preview";
  const choices=locked?'<option value="skip">تخطي هذا الصف</option>':
   '<option value="">اختر قرارًا لهذا الصف</option><option value="create">إنشاء قطعة جديدة</option>'+
   candidates.map(c=>{
    const fitments=(c.fitments||[]).map(f=>[f.brand_name_ar,f.model,f.year_from??"؟",f.year_to??"؟"].join(" / ")).join("، ")||"لا يوجد توافق مسجل";
    return '<option value="match:'+escapeHtml(c.id)+'">مطابقة وتحديث: '+escapeHtml(c.part_name_ar)+' — '+escapeHtml(c.condition||"الحالة غير محددة")+' — بيع '+(c.sale_price_piasters==null?"—":(Number(c.sale_price_piasters)/100).toFixed(2))+' ج.م — شراء '+(c.purchase_price_piasters==null?"—":(Number(c.purchase_price_piasters)/100).toFixed(2))+' ج.م — '+escapeHtml(fitments)+' — رصيد '+Number(c.total_quantity||0)+'</option>';
   }).join("")+
   '<option value="skip">تخطي هذا الصف</option>';
  const warning=issues.length?issues.join(" • "):"لا توجد تحذيرات";
  const state=r.status==="preview"?"بانتظار قرارك":r.status==="applied"?"تم الاعتماد":r.status==="skipped"?"تم التخطي":"تعذر الاعتماد";
  return '<div class="panel excel-row" data-row="'+Number(r.row_number)+'"><strong>صف '+Number(r.row_number)+' — '+escapeHtml(item.part_name_ar||"اسم القطعة غير موجود")+'</strong>'+
   '<p>الماركة: '+escapeHtml(item.brand_raw||"—")+' | الموديل: '+escapeHtml(item.model_raw||"—")+' | السنوات: '+escapeHtml(item.year_from??"—")+' إلى '+escapeHtml(item.year_to??"—")+'</p>'+
   '<p>الكمية: '+escapeHtml(item.quantity??"—")+' | المخزن: '+escapeHtml(item.location_raw||"غير محدد")+' | الكود: '+escapeHtml(item.part_code||"—")+'</p>'+
   '<p>البيع: '+escapeHtml(item.sale_price_piasters==null?"غير محدد":(Number(item.sale_price_piasters)/100).toFixed(2)+" ج.م")+' | الشراء: '+escapeHtml(item.purchase_price_piasters==null?"غير محدد":(Number(item.purchase_price_piasters)/100).toFixed(2)+" ج.م")+' | الحالة: '+escapeHtml(item.condition||"—")+'</p>'+
   '<p>ملاحظات الملف: '+escapeHtml(item.notes||"لا توجد")+'</p>'+
   '<p>مراجعة: '+escapeHtml(warning)+' | الحالة: '+escapeHtml(state)+'</p>'+
   (r.status==="preview"&&needsReview?'<label>مطلوب مراجعة — اختر القرار</label><select class="excel-decision" data-row="'+Number(r.row_number)+'">'+choices+'</select>':
    r.status==="preview"?'<p class="success">سليم — سيتم إدراجه تلقائيًا عند الاعتماد</p>':'')+'</div>';
 }).join("");
 $("applyExcelBtn").classList.toggle("hidden",!currentImportBatchId||!currentImportRows.some(r=>r.status==="preview"));
}
async function loadImportBatch(batchId){
 const result=await api("/api/admin/imports/"+encodeURIComponent(batchId));
 currentImportBatchId=result.batch.id;
 renderImportRows(result.rows,result.batch);
 importMessage("تم فتح المعاينة المحفوظة. راجع الصفوف التي ما زالت بانتظار قرار.");
}
$("previewExcelBtn").onclick=async()=>{
 const file=$("excelFile").files?.[0];if(!file){importMessage("اختر ملف XLSX أولًا.");return}
 try{
  $("previewExcelBtn").disabled=true;importMessage("جارٍ قراءة ملف Excel محليًا...");
  if(!file.name.toLowerCase().endsWith(".xlsx")||file.size<4||file.size>2*1024*1024)throw Error("اختر ملف XLSX لا يتجاوز 2 ميجابايت.");
  const XLSX=await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
  const workbook=XLSX.read(await file.arrayBuffer(),{type:"array",cellFormula:false,cellHTML:false,cellStyles:false,bookVBA:false,sheetRows:102});
  const sheetName=workbook.SheetNames?.[0];if(!sheetName)throw Error("الملف لا يحتوي على ورقة عمل.");
  const rows=XLSX.utils.sheet_to_json(workbook.Sheets[sheetName],{header:1,raw:false,defval:null,blankrows:false});
  if(!rows.length)throw Error("ورقة العمل فارغة.");
  const data=await api("/api/admin/imports/preview",{method:"POST",body:JSON.stringify({filename:file.name,rows})});
  currentImportBatchId=data.batch_id;
  renderImportRows(data.rows,{filename:data.filename,total_rows:data.total_rows,status:"preview"});
  importMessage("تمت قراءة الملف وإنشاء المعاينة دون تعديل المنتجات أو الأرصدة. راجع التحذيرات واختر قرارًا لكل صف.");
 }catch(e){
  if(e.data?.existing_batch?.id){try{await loadImportBatch(e.data.existing_batch.id);importMessage(e.message+" تم فتح المعاينة السابقة.");}catch(inner){importMessage(inner.message)}}else importMessage(e.message)
 }finally{$("previewExcelBtn").disabled=false}
};
$("resumeExcelBtn").onclick=async()=>{
 const id=prompt("أدخل رقم دفعة المعاينة المحفوظة:");if(!id)return;
 try{await loadImportBatch(id.trim())}catch(e){importMessage(e.message)}
};
$("applyExcelBtn").onclick=async()=>{
 try{
  const decisions={};
  for(const r of currentImportRows.filter(x=>x.status==="preview")){
   const select=document.querySelector('.excel-decision[data-row="'+Number(r.row_number)+'"]');
   if(!select)continue;
   if(!select.value)throw Error("راجع الصف واختر قرارًا له. الصف "+r.row_number);
   decisions[String(r.row_number)]=select.value;
  }
  if(!confirm("هل راجعت كل الصفوف وتريد تنفيذ القرارات؟\n\nعند مطابقة قطعة موجودة: سيتم تحديث الحقول غير الفارغة من ملف Excel (الاسم والحالة والكود والأسعار والملاحظات)، مع الاحتفاظ بالقيم القديمة في الخانات الفارغة. الصفر قيمة فعلية.\n\nالكمية في الملف ستصبح الرصيد المستهدف للمخزن المحدد، وليست كمية تضاف فوق الرصيد الحالي. توافقات السيارات الجديدة ستظل بحاجة إلى تأكيد."))return;
  $("applyExcelBtn").disabled=true;
  const result=await api("/api/admin/imports/"+encodeURIComponent(currentImportBatchId)+"/apply",{method:"POST",body:JSON.stringify({decisions})});
  const locations=(result.report?.by_location||[]).map(x=>x.location_name+": "+x.product_count+" أصناف / "+x.total_quantity+" قطعة").join("؛ ")||"لا توجد أرصدة مسجلة";
  importMessage("نتيجة التنفيذ: إنشاء "+result.created+"، مطابقة "+result.matched+"، تخطي "+result.skipped+"، تعذر "+result.failed+"، متبقي "+result.pending+".\\nتوزيع المخزون: "+locations+".\\nمنتجات بلا توافق سيارة: "+Number(result.report?.products_without_fitment||0)+".");
  await loadImportBatch(currentImportBatchId);await loadAdmin();
 }catch(e){importMessage(e.message)}finally{$("applyExcelBtn").disabled=false}
};
async function loadAdmin(){
 const [p,m,h,a]=await Promise.all([api("/api/admin/products"),api("/api/admin/meta"),api("/api/admin/stock-movements?limit=12"),api("/api/admin/analytics")]);
 $("brandId").innerHTML='<option value="">اختر الماركة</option>'+m.brands.map(x=>'<option value="'+escapeHtml(x.id)+'">'+escapeHtml(x.name_ar)+'</option>').join("");
 $("movementProduct").innerHTML='<option value="">اختر القطعة</option>'+p.data.map(x=>'<option value="'+escapeHtml(x.id)+'">'+escapeHtml(x.part_name_ar)+' — '+escapeHtml(x.condition||"الحالة غير محددة")+' — رصيد إجمالي: '+Number(x.total_quantity||0)+' — #'+escapeHtml(x.id.slice(0,8))+'</option>').join("");
 $("movementLocation").innerHTML='<option value="">اختر المخزن</option>'+m.locations.filter(x=>x.active).map(x=>'<option value="'+escapeHtml(x.id)+'">'+escapeHtml(x.name)+'</option>').join("");
 $("locations").textContent=m.locations.length?m.locations.map(x=>x.name+(x.active?"":" (غير نشط)")).join(" • "):"لم تتم إضافة أماكن تخزين بعد.";
 $("products").innerHTML=p.data.length?'<table><thead><tr><th>القطعة</th><th>الحالة</th><th>الرصيد</th><th>سعر البيع</th><th>إجراء</th></tr></thead><tbody>'+p.data.map(x=>'<tr><td>'+escapeHtml(x.part_name_ar)+'</td><td>'+escapeHtml(x.condition||"—")+'</td><td>'+Number(x.total_quantity||0)+'</td><td>'+(x.sale_price_piasters==null?"—":(Number(x.sale_price_piasters)/100).toFixed(2)+" ج.م")+'</td><td><button class="secondary editBtn" data-id="'+escapeHtml(x.id)+'">تعديل</button> <button class="secondary archiveBtn" data-id="'+escapeHtml(x.id)+'" data-version="'+Number(x.version)+'">أرشفة</button></td></tr>').join("")+'</tbody></table>':"لا توجد منتجات مسجلة حتى الآن.";
 $("movements").innerHTML=h.data.length?'<table><thead><tr><th>القطعة</th><th>المخزن</th><th>الحركة</th><th>الكمية</th><th>الرصيد بعدها</th></tr></thead><tbody>'+h.data.map(x=>'<tr><td>'+escapeHtml(x.part_name_ar)+'</td><td>'+escapeHtml(x.location_name)+'</td><td>'+({in:"إضافة",out:"صرف",adjustment:"تسوية"}[x.movement_type]||x.movement_type)+'</td><td>'+Number(x.quantity_delta)+'</td><td>'+Number(x.balance_after)+'</td></tr>').join("")+'</tbody></table>':"لا توجد حركات مخزون حتى الآن.";
 document.querySelectorAll(".editBtn").forEach(btn=>btn.onclick=()=>openExistingProductForReview(btn.dataset.id));
 document.querySelectorAll(".archiveBtn").forEach(btn=>btn.onclick=async()=>{if(!confirm("أرشفة القطعة؟ ستختفي من الكتالوج العام مع الاحتفاظ بسجلها."))return;try{await api("/api/admin/products/"+btn.dataset.id,{method:"DELETE",body:JSON.stringify({version:Number(btn.dataset.version)})});message("adminMsg","تمت أرشفة القطعة.");await loadAdmin()}catch(e){message("adminMsg",e.message)}});
}
$("productForm").onsubmit=async e=>{e.preventDefault();try{
 const payload=buildProductPayload();
 if(editingProductId){
  await api("/api/admin/products/"+editingProductId,{method:"PUT",body:JSON.stringify(payload)});
  message("adminMsg","تم تحديث القطعة.");
 }else{
  const check=await api("/api/admin/products/duplicate-check",{method:"POST",body:JSON.stringify(payload)});
  if(check.candidates?.length){showDuplicateReview(check.candidates,payload);return}
  await api("/api/admin/products",{method:"POST",body:JSON.stringify(payload)});
  message("adminMsg","تم حفظ القطعة.");
 }
 clearProductEdit();await loadAdmin();
 }catch(e){if(e.code==="possible_duplicate"&&e.data?.candidates)showDuplicateReview(e.data.candidates,buildProductPayload());else message("adminMsg",e.message)}
};
$("cancelEditBtn").onclick=clearProductEdit;
$("locationForm").onsubmit=async e=>{e.preventDefault();try{await api("/api/admin/locations",{method:"POST",body:JSON.stringify({name:$("locationName").value})});$("locationForm").reset();message("adminMsg","تمت إضافة مكان التخزين.");await loadAdmin()}catch(e){message("adminMsg",e.message)}};
$("movementProduct").onchange=refreshAvailableStock;$("movementLocation").onchange=refreshAvailableStock;
$("movementForm").onsubmit=async e=>{e.preventDefault();const q=Number($("movementQuantity").value);if(!Number.isSafeInteger(q)||q<1){message("adminMsg","أدخل كمية صحيحة.");return}
 const type=$("movementType").value;try{
  if(type==="out"){
   const current=await api("/api/admin/stock-balance?product_id="+encodeURIComponent($("movementProduct").value)+"&location_id="+encodeURIComponent($("movementLocation").value));
   if(q>current.quantity){message("adminMsg","الرصيد المتاح في هذا المخزن "+current.quantity+" قطعة فقط. تأكد أنك اخترت سجل القطعة الصحيح.");return}
  }
  await api("/api/admin/stock-movements",{method:"POST",body:JSON.stringify({product_id:$("movementProduct").value,location_id:$("movementLocation").value,movement_type:type,quantity_delta:type==="out"?-q:q,reason:$("movementReason").value,reference:$("movementReference").value})});
  $("movementForm").reset();$("availableStock").textContent="اختر القطعة والمخزن لعرض الرصيد المتاح.";message("adminMsg","تم تسجيل حركة المخزون.");await loadAdmin();
 }catch(e){message("adminMsg",e.message);await refreshAvailableStock()}
};
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
async function safeStringEqual(left, right) {
  const [a, b] = await Promise.all([sha256(String(left)), sha256(String(right))]);
  return crypto.subtle.timingSafeEqual(decodeBase64(a), decodeBase64(b));
}
function safeHashEqual(left, right) {
  const a = decodeBase64(left), b = decodeBase64(right);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}
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
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  const type = request.headers.get("Content-Type") || "";
  return Boolean(env.ALLOWED_ORIGIN && origin && origin === new URL(request.url).origin &&
    (!fetchSite || fetchSite === "same-origin") && /^application\/json(?:\s*;|\s*$)/i.test(type));
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
    const parsed = await readJsonBody(request, 2048);
    if (parsed.error) return json({ error: parsed.error }, 400);
    const body = parsed.body;
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const setupKeyValid = await safeStringEqual(body.setup_key || "", env.BOOTSTRAP_SECRET);
    if (email !== env.OWNER_EMAIL.toLowerCase() || !setupKeyValid) return json({ error: "Invalid setup credentials." }, 403);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128) return json({ error: "Enter a valid email and a 12–128 character password." }, 400);
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
    const parsed = await readJsonBody(request, 2048);
    if (parsed.error) return json({ error: parsed.error }, 400);
    const body = parsed.body;
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length > 128) return json({ error: "Invalid email or password." }, 400);
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const attemptKey = await sha256(email + ":" + clientIp);
    const ipKey = await sha256("login-ip:" + clientIp);
    const [attempt, ipAttempt] = await Promise.all([
      env.DB.prepare("SELECT attempts,window_started_at FROM login_attempts WHERE attempt_key=?").bind(attemptKey).first(),
      env.DB.prepare("SELECT attempts,window_started_at FROM login_ip_attempts WHERE ip_hash=?").bind(ipKey).first()
    ]);
    const withinWindow = attempt && (Date.now() - Date.parse(attempt.window_started_at)) < 15 * 60 * 1000;
    const ipWithinWindow = ipAttempt && (Date.now() - Date.parse(ipAttempt.window_started_at)) < 15 * 60 * 1000;
    if (withinWindow && attempt.attempts >= 5) return json({ error: "Too many attempts for this account. Try again in 15 minutes." }, 429);
    if (ipWithinWindow && ipAttempt.attempts >= 20) return json({ error: "Too many attempts from this network. Try again in 15 minutes." }, 429);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM login_attempts WHERE window_started_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')"),
      env.DB.prepare("DELETE FROM login_ip_attempts WHERE window_started_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')"),
      env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')")
    ]);
    const credential = await env.DB.prepare(`
      SELECT c.password_salt,c.password_hash,c.iterations,a.email
      FROM admin_credentials c JOIN staff_accounts a ON a.email=c.email COLLATE NOCASE
      WHERE c.email=? COLLATE NOCASE AND a.active=1 AND a.role='owner' LIMIT 1
    `).bind(email).first();
    const salt = credential ? decodeBase64(credential.password_salt) : new Uint8Array(16);
    const iterations = credential ? credential.iterations : PASSWORD_ITERATIONS;
    const candidate = await derivePassword(password, salt, iterations);
    const valid = Boolean(credential && safeHashEqual(candidate, credential.password_hash));
    if (!valid) {
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO login_attempts(attempt_key,attempts,window_started_at,updated_at) VALUES(?,1,?,?) ON CONFLICT(attempt_key) DO UPDATE SET attempts=CASE WHEN login_attempts.window_started_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes') THEN login_attempts.attempts+1 ELSE 1 END,window_started_at=CASE WHEN login_attempts.window_started_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes') THEN login_attempts.window_started_at ELSE excluded.window_started_at END,updated_at=excluded.updated_at").bind(attemptKey,now,now),
        env.DB.prepare("INSERT INTO login_ip_attempts(ip_hash,attempts,window_started_at,updated_at) VALUES(?,1,?,?) ON CONFLICT(ip_hash) DO UPDATE SET attempts=CASE WHEN login_ip_attempts.window_started_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes') THEN login_ip_attempts.attempts+1 ELSE 1 END,window_started_at=CASE WHEN login_ip_attempts.window_started_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes') THEN login_ip_attempts.window_started_at ELSE excluded.window_started_at END,updated_at=excluded.updated_at").bind(ipKey,now,now)
      ]);
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
        p.purchase_price_piasters,p.is_public,p.version,p.created_at,p.updated_at,COALESCE(SUM(ib.quantity),0) AS total_quantity
      FROM products p LEFT JOIN inventory_balances ib ON ib.product_id=p.id
      WHERE p.archived_at IS NULL GROUP BY p.id ORDER BY p.updated_at DESC,p.id ASC LIMIT ?
    `).bind(limit).all();
    return json({ data: result.results || [] });
  }
  if (path === "/api/admin/analytics" && request.method === "GET") {
    const [productStats, stockStats, locations, brands, movements, imports] = await Promise.all([
      env.DB.prepare(`
        SELECT COUNT(*) AS active_products,
          SUM(CASE WHEN is_public=1 THEN 1 ELSE 0 END) AS public_products,
          SUM(CASE WHEN part_code IS NULL OR trim(part_code)='' THEN 1 ELSE 0 END) AS missing_codes,
          SUM(CASE WHEN sale_price_piasters IS NULL THEN 1 ELSE 0 END) AS missing_sale_prices,
          SUM(CASE WHEN purchase_price_piasters IS NULL THEN 1 ELSE 0 END) AS missing_purchase_prices,
          SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM product_fitments f WHERE f.product_id=p.id) THEN 1 ELSE 0 END) AS without_fitment,
          SUM(CASE WHEN EXISTS (SELECT 1 FROM product_fitments f WHERE f.product_id=p.id AND f.compatibility_status='pending') THEN 1 ELSE 0 END) AS with_pending_fitment
        FROM products p WHERE archived_at IS NULL
      `).first(),
      env.DB.prepare(`
        SELECT COALESCE(SUM(ib.quantity),0) AS total_units,
          COALESCE(SUM(ib.quantity * COALESCE(p.purchase_price_piasters,0)),0) AS estimated_purchase_value_piasters,
          COALESCE(SUM(ib.quantity * COALESCE(p.sale_price_piasters,0)),0) AS estimated_sale_value_piasters,
          SUM(CASE WHEN p.purchase_price_piasters IS NULL AND ib.quantity>0 THEN 1 ELSE 0 END) AS balances_without_purchase_price
        FROM inventory_balances ib JOIN products p ON p.id=ib.product_id
        WHERE p.archived_at IS NULL
      `).first(),
      env.DB.prepare(`
        SELECT l.id,l.name,COUNT(DISTINCT p.id) AS product_count,
          COALESCE(SUM(CASE WHEN p.id IS NOT NULL THEN ib.quantity ELSE 0 END),0) AS total_units
        FROM locations l LEFT JOIN inventory_balances ib ON ib.location_id=l.id
        LEFT JOIN products p ON p.id=ib.product_id AND p.archived_at IS NULL
        WHERE l.active=1 GROUP BY l.id,l.name ORDER BY total_units DESC,l.name
      `).all(),
      env.DB.prepare(`
        SELECT b.id,b.name_ar,COUNT(q.product_id) AS product_count,
          COALESCE(SUM(q.total_quantity),0) AS total_units
        FROM brands b
        LEFT JOIN (
          SELECT DISTINCT f.brand_id,p.id AS product_id,
            COALESCE((SELECT SUM(ib.quantity) FROM inventory_balances ib WHERE ib.product_id=p.id),0) AS total_quantity
          FROM product_fitments f JOIN products p ON p.id=f.product_id
          WHERE p.archived_at IS NULL
        ) q ON q.brand_id=b.id
        GROUP BY b.id,b.name_ar ORDER BY product_count DESC,b.name_ar
      `).all(),
      env.DB.prepare(`
        SELECT movement_type,COUNT(*) AS movement_count,
          COALESCE(SUM(ABS(quantity_delta)),0) AS units
        FROM stock_movements
        WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')
        GROUP BY movement_type ORDER BY movement_type
      `).all(),
      env.DB.prepare(`
        SELECT filename,status,total_rows,created_count,updated_count,skipped_count,error_count,created_at,applied_at
        FROM import_batches ORDER BY created_at DESC LIMIT 8
      `).all(),
    ]);
    return json({
      overview: productStats || {},
      stock: stockStats || {},
      by_location: locations.results || [],
      by_brand: brands.results || [],
      movements_30d: movements.results || [],
      recent_imports: imports.results || [],
    });
  }
  if (path === "/api/admin/export-data" && request.method === "GET") {
    const [count, result] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS total FROM products WHERE archived_at IS NULL").first(),
      env.DB.prepare(`
        SELECT p.id,p.part_name_ar,p.condition,p.part_code,p.sale_price_piasters,
          p.purchase_price_piasters,p.internal_notes,
          COALESCE((
            SELECT json_group_array(json_object(
              'brand_name_ar',b.name_ar,'model',f.model,'year_from',f.year_from,
              'year_to',f.year_to,'compatibility_status',f.compatibility_status
            ))
            FROM product_fitments f JOIN brands b ON b.id=f.brand_id
            WHERE f.product_id=p.id
          ),'[]') AS fitments_json,
          COALESCE((
            SELECT json_group_array(json_object(
              'location_id',l.id,'location_name',l.name,'quantity',ib.quantity
            ))
            FROM inventory_balances ib JOIN locations l ON l.id=ib.location_id
            WHERE ib.product_id=p.id
            ORDER BY l.name
          ),'[]') AS balances_json
        FROM products p WHERE p.archived_at IS NULL
        ORDER BY p.updated_at DESC,p.id ASC LIMIT 10000
      `).all(),
    ]);
    const rows = (result.results || []).map(row => ({
      ...row,
      fitments: JSON.parse(row.fitments_json || "[]"),
      balances: JSON.parse(row.balances_json || "[]"),
    }));
    return json({ total: Number(count?.total || 0), exported: rows.length, truncated: rows.length < Number(count?.total || 0), data: rows });
  }
  const importResponse = await handleExcelImport(request, url, env, session);
  if (importResponse) return importResponse;
  const inventoryResponse = await handleInventoryAdmin(request, url, env, session);
  if (inventoryResponse) return inventoryResponse;
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
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.sheetjs.com; connect-src 'self' https://cdn.sheetjs.com; base-uri 'none'; frame-ancestors 'none'",
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
