/**
 * Bakkar Inventory API
 * Public routes expose only the approved public_catalog view.
 * Admin routes fail closed until Cloudflare Access and staff allow-list are configured.
 */

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJwtPart(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

async function verifyAccessJwt(request, env) {
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");

  if (!teamDomain || !audience) {
    return { ok: false, status: 503, error: "Admin authentication is not configured yet." };
  }
  if (!token) {
    return { ok: false, status: 401, error: "Cloudflare Access authentication is required." };
  }

  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Malformed token");

    const header = decodeJwtPart(parts[0]);
    const claims = decodeJwtPart(parts[1]);
    if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported token");

    const issuer = `https://${teamDomain}`;
    if (claims.iss !== issuer) throw new Error("Invalid issuer");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw new Error("Invalid audience");

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("Expired token");
    if (typeof claims.nbf === "number" && claims.nbf > now + 60) throw new Error("Token not active");

    const certsResponse = await fetch(`${issuer}/cdn-cgi/access/certs`);
    if (!certsResponse.ok) throw new Error("Could not load Access signing keys");
    const certs = await certsResponse.json();
    const jwk = certs.keys?.find((key) => key.kid === header.kid);
    if (!jwk) throw new Error("Signing key not found");

    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      base64UrlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) throw new Error("Invalid signature");
    if (typeof claims.email !== "string" || !claims.email.includes("@")) {
      throw new Error("Email claim is missing");
    }
    return { ok: true, email: claims.email.toLowerCase() };
  } catch {
    return { ok: false, status: 401, error: "Invalid or expired Access session." };
  }
}

async function requireStaff(request, env) {
  const identity = await verifyAccessJwt(request, env);
  if (!identity.ok) return identity;

  const staff = await env.DB.prepare(
    "SELECT email, role FROM staff_accounts WHERE email = ? COLLATE NOCASE AND active = 1 LIMIT 1",
  ).bind(identity.email).first();

  if (!staff) {
    return { ok: false, status: 403, error: "This account is not authorized for Bakkar inventory." };
  }
  return { ok: true, email: staff.email, role: staff.role };
}

async function handleCatalog(url, env) {
  const rawLimit = Number(url.searchParams.get("limit") || 24);
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 24;
  const cursor = url.searchParams.get("cursor");
  const search = (url.searchParams.get("q") || "").trim().slice(0, 80);
  const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;

  const result = await env.DB.prepare(`
    SELECT
      pc.product_id AS id,
      MAX(pc.part_name_ar) AS name,
      MAX(pc.part_name_en) AS name_en,
      MAX(pc.condition) AS condition,
      MAX(pc.part_code) AS part_code,
      MAX(pc.sale_price_piasters) AS sale_price_piasters,
      MAX(pc.category_name_ar) AS category,
      json_group_array(json_object(
        'brand_ar', pc.vehicle_brand_ar,
        'brand_en', pc.vehicle_brand_en,
        'model', pc.vehicle_model,
        'year_from', pc.year_from,
        'year_to', pc.year_to
      )) AS fitments
    FROM public_catalog pc
    WHERE
      (? = '' OR pc.part_name_ar LIKE ? ESCAPE '\\'
        OR COALESCE(pc.part_code, '') LIKE ? ESCAPE '\\'
        OR pc.vehicle_model LIKE ? ESCAPE '\\'
        OR pc.vehicle_brand_ar LIKE ? ESCAPE '\\')
      AND (? IS NULL OR pc.product_id > ?)
    GROUP BY pc.product_id
    ORDER BY pc.product_id ASC
    LIMIT ?
  `).bind(search, pattern, pattern, pattern, pattern, cursor, cursor, limit + 1).all();

  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map((row) => ({
    ...row,
    fitments: JSON.parse(row.fitments || "[]"),
  }));
  return json({
    data: page,
    pagination: {
      limit,
      has_more: hasMore,
      next_cursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    },
  });
}

async function handleAdmin(request, url, env) {
  const staff = await requireStaff(request, env);
  if (!staff.ok) return json({ error: staff.error }, staff.status);

  if (url.pathname === "/api/admin/me" && request.method === "GET") {
    return json({ user: { email: staff.email, role: staff.role } });
  }

  if (url.pathname === "/api/admin/products" && request.method === "GET") {
    const rawLimit = Number(url.searchParams.get("limit") || 50);
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
    const result = await env.DB.prepare(`
      SELECT
        p.id, p.part_name_ar, p.part_name_en, p.condition, p.part_code,
        p.sale_price_piasters, p.purchase_price_piasters, p.is_public,
        p.created_at, p.updated_at,
        COALESCE(SUM(ib.quantity), 0) AS total_quantity
      FROM products p
      LEFT JOIN inventory_balances ib ON ib.product_id = p.id
      WHERE p.archived_at IS NULL
      GROUP BY p.id
      ORDER BY p.updated_at DESC, p.id ASC
      LIMIT ?
    `).bind(limit).all();
    return json({ data: result.results || [] });
  }

  return json({ error: "Route not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = getCorsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        const check = await env.DB.prepare("SELECT 1 AS ok").first();
        return json({ status: check?.ok === 1 ? "ok" : "degraded", service: "bakkar-inventory-api" }, 200, cors);
      }

      if (url.pathname === "/api/catalog" && request.method === "GET") {
        const response = await handleCatalog(url, env);
        for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
        return response;
      }

      if (url.pathname.startsWith("/api/admin/")) {
        const response = await handleAdmin(request, url, env);
        for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
        return response;
      }

      return json({ error: "Not found." }, 404, cors);
    } catch (error) {
      console.error(JSON.stringify({
        message: "API request failed",
        path: url.pathname,
        error: error instanceof Error ? error.message : "Unknown error",
      }));
      return json({ error: "Internal server error." }, 500, cors);
    }
  },
};
