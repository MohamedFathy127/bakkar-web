# Bakkar Inventory API

A separate Cloudflare Worker API for the Bakkar inventory system.

## Architecture

- Cloudflare Pages continues to serve the existing public website. Visitors do not need accounts or login.
- This Worker is the API boundary; browser clients never connect directly to D1.
- Cloudflare D1 is the source of truth for products, stock and audit history.
- The public catalog reads only approved public fields. It never returns purchase prices, internal notes, exact stock balances or staff records.
- The private administration interface is served at `/admin` on this Worker hostname. Only the owner signs in there; the public Pages website remains unchanged.
- Admin sessions use random opaque tokens stored as SHA-256 hashes in D1 and an HttpOnly, Secure, SameSite=Strict cookie scoped to `/api/admin`. Passwords are salted and derived with PBKDF2-HMAC-SHA256 using 210,000 iterations. Cloudflare Access is not required.

## Deployment status

The Worker is separately deployed at:

- `https://bakkar-inventory-api.mohamedfathy12127.workers.dev`
- Health: `/api/health`
- Public catalog: `/api/catalog`
- Private admin: `/admin`

The code in this branch is not automatically proof of what is currently deployed. Do not deploy it until the migration and secrets are configured and the owner approves deployment.

## Current routes

| Method | Route | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | Public | Checks API-to-D1 connectivity |
| GET | `/api/catalog` | Public | Approved public catalog with bounded results and cursor pagination |
| GET | `/admin` | Public page; data requires sign-in | Standalone owner login and admin dashboard |
| GET | `/api/admin/status` | Public, setup state only | Indicates whether initial owner setup is needed |
| POST | `/api/admin/setup` | Same-origin + bootstrap secret | Creates the first owner once |
| POST | `/api/admin/login` | Same-origin | Authenticates the owner and creates a session |
| POST | `/api/admin/logout` | Authenticated browser session + same-origin | Revokes the current session |
| GET | `/api/admin/me` | Owner session | Returns the signed-in identity |
| GET | `/api/admin/products` | Owner session | Lists internal products and total stock |

No product-write or stock-movement routes are enabled yet. The dashboard is deliberately read-only at this stage.

## Required setup (not yet performed)

1. Review and apply `backend/migrations/0002_admin_auth.sql` to the existing `bakkar-inventory` D1 database exactly once. Do not rerun it after successful application.
2. Apply `backend/migrations/0003_login_ip_throttle.sql` once to the isolated test D1 database before deploying the hardened test Worker. Do not apply it to production without a separate approval.
3. Configure Worker secrets/variables in the Cloudflare dashboard:
   - `OWNER_EMAIL`: the exact owner email approved for the initial account.
   - `BOOTSTRAP_SECRET`: a long, random, one-time setup secret (at least 32 random characters). Store it as a Worker secret, never in Git.
3. Deploy this branch only after explicit approval and after confirming the existing production Worker will not be overwritten unexpectedly.
5. Visit the test Worker `/admin`, initialize the owner once, then remove the `BOOTSTRAP_SECRET` secret from Worker settings. The owner account cannot be initialized a second time through this endpoint.
6. Test login, wrong-password behavior, rate limits, logout, expiry and anonymous public catalog access.

Do not put the owner email, bootstrap secret, password, session token or other credentials in this repository. Never ask the user to paste secrets into chat.

## Security notes and limitations

- Admin cookies are scoped to this Worker hostname, so the administration UI is served from the same origin. The public Pages site does not share or require this session.
- State-changing authentication requests require a same-origin `Origin`, a same-origin Fetch Metadata value when supplied, and JSON content type. Authentication request bodies are size-limited and validated before parsing. The session cookie is HttpOnly, Secure and SameSite=Strict.
- Login attempts are throttled per email+IP (five failures per 15-minute window) and per IP across accounts (20 failures per 15-minute window). Expired throttle records and old expired sessions are opportunistically cleaned during login. This D1-backed limit is a basic safeguard, not a substitute for an edge rate-limiting service against distributed attacks.
- Password hashes use PBKDF2-HMAC-SHA256 with a unique random salt and 100,000 iterations. Stored hashes are compared with `crypto.subtle.timingSafeEqual`; unknown accounts still incur a dummy derivation to reduce account-enumeration timing differences. Passwords are never stored in plaintext.
- Sessions expire after eight hours; logout deletes the server-side session.
- Public output is allow-listed and excludes purchase prices, internal notes, exact inventory balances, staff records, import records and audit history.
- SQL values use prepared statements. Errors returned to clients are generic; detailed failures are written to Worker logs.
- CORS is restricted to the public Pages origin for the public catalog. CORS is not an authentication mechanism.
- No admin write routes are enabled. Product creation, edits, imports and stock movements require separate reviewed endpoints with transactional audit logging.

## Local development

Install a current Node.js LTS and Wrangler, then run from this directory:

```bash
npm install
npx wrangler dev
```

Use synthetic test data locally. Do not point local development at production D1 for routine testing.

## Learning notes

- **Worker**: the server-side program that receives HTTP requests and talks to D1.
- **D1**: the managed SQL database and source of truth.
- **Session cookie**: a browser-held random token that is HttpOnly; only its hash is stored in D1.
- **PBKDF2**: a password-based key derivation function that makes offline guessing more expensive.
- **Bootstrap secret**: a temporary secret used only once to create the first owner account.
- **Prepared statement**: SQL with placeholders, keeping user input separate from SQL code.
