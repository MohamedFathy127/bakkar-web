# Bakkar Inventory API

A separate Cloudflare Worker API for the Bakkar inventory system.

## Architecture

- Cloudflare Pages continues to serve the existing public website. Visitors do not need accounts or login.
- This Worker is the API boundary; browser clients never connect directly to D1.
- Cloudflare D1 is the source of truth for products, stock and audit history.
- The public catalog reads only approved public fields. It never returns purchase prices, internal notes, exact stock balances or staff records.
- The private administration interface is served at `/admin` on this Worker hostname. Only the owner signs in there; the public Pages website remains unchanged.
- Admin sessions use random opaque tokens stored as SHA-256 hashes in D1 and an HttpOnly, Secure, SameSite=Strict cookie scoped to `/api/admin`. Passwords are salted and derived with PBKDF2-HMAC-SHA256 using 100,000 iterations (the tested Workers runtime limit). Cloudflare Access is not required.

## Deployment status

Production Worker (do not change without separate approval):

- `https://bakkar-inventory-api.mohamedfathy12127.workers.dev`

Isolated test Worker (hardened build):

- `https://bakkar-inventory-test-api.mohamedfathy12127.workers.dev`
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
| GET | `/api/admin/products/:id` | Owner session | Reads one product, vehicle fitments and per-location balances |
| POST | `/api/admin/products` | Owner session + same-origin | Creates a product and its fitments |
| PUT | `/api/admin/products/:id` | Owner session + same-origin | Updates a product using optimistic version checks |
| DELETE | `/api/admin/products/:id` | Owner session + same-origin | Archives a product; it does not hard-delete history |
| GET | `/api/admin/meta` | Owner session | Lists brands, categories and storage locations |
| POST | `/api/admin/locations` | Owner session + same-origin | Creates a storage location |
| GET | `/api/admin/stock-movements` | Owner session | Reads stock movement history |
| POST | `/api/admin/stock-movements` | Owner session + same-origin | Records an inbound, outbound or adjustment movement |

These routes are implemented on the `feature/inventory-management` branch only. They are not deployed. The existing admin dashboard still needs its product and stock-management interface wired to these routes.

## Deployment and test status

- Migrations `0001` through `0006` are applied to the isolated test D1 database only. Migration `0004` seeds Hyundai, Kia and SsangYong vehicle brands; `0005` adds movement-driven balance triggers; `0006` fixes outbound balance updates while preserving the non-negative stock constraint. Production D1 remains untouched.
- The hardened source is deployed to the isolated test Worker, bound to `bakkar-inventory-test`.
- The test Worker retains `OWNER_EMAIL`; the one-time `BOOTSTRAP_SECRET` was removed after owner setup.
- Production Worker and production D1 have not been changed.
- Remaining verification: browser/API checks for valid and invalid login, IP throttling, malformed and oversized bodies, same-origin rejection, logout, and session expiry. Do not claim these checks passed until performed.

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


## Inventory management implementation (not deployed)

- Work is isolated on `feature/inventory-management`, based on `feature/inventory-foundation`.
- Added owner-only product create/read/update/archive routes, vehicle-fitment validation, reference-data reads, storage-location creation, stock-movement creation and movement-history reads.
- Added an initial Arabic owner dashboard for those operations. Product editing preserves existing category, aliases, internal notes and additional vehicle fitments not currently exposed as editable fields.
- Product updates use a version field to reject stale edits. Product archive is soft-delete so references and audit history remain intact.
- Stock movements are the source of truth: database triggers apply each inserted movement to the balance and reject a movement that would make stock negative. Migration `0006` uses a non-negative insert placeholder before the conflict update so outbound movements do not violate the balance table CHECK constraint. The API no longer relies on connection-scoped `changes()` state across a D1 batch.
- The outbound trigger fix was verified directly against the isolated test D1: a one-unit outbound movement reduced 74 to 73, a compensating inbound test movement restored it to 74, and an attempted outbound movement of 100 was rejected as insufficient stock. These were database-level trigger tests, not browser/API end-to-end tests.
- Added `wrangler.test.jsonc` and explicit `dev:test` / `deploy:test` scripts so test commands target the isolated test D1 database, not the production database configured in `wrangler.jsonc`.
- Added a GitHub Actions syntax check for both Worker modules.
- Not yet verified: deployed runtime behavior for the new routes, atomic stock updates, concurrency behavior, or browser UI integration. Do not deploy to either Worker until syntax checks and test-environment validation are complete.
