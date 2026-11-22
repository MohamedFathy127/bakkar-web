# Bakkar Web Engineering Guide

## Architecture

- `index.html` is the public Cloudflare Pages site. It reads published catalog records from the Worker API; it must not contain sample inventory records.
- `catalog-client.mjs` contains browser-side mapping, compatibility, formatting, and escaping helpers shared with Node tests.
- `backend/worker/src/index.js` serves the owner dashboard and routes requests. `catalog.js` owns public catalog queries, `inventory.js` owns owner inventory operations, and `excel-import.js` owns staged imports and approval.
- `backend/migrations/` is the ordered D1 schema history. The Worker talks to D1 through the `DB` binding; browser code never connects to D1.
- `wrangler.jsonc` targets production resources. `wrangler.test.jsonc` targets the isolated test Worker and declares the migration directory. Use `--local` for repository validation.

## Required security rules

- Public catalog handlers must select from `public_catalog` or another reviewed public projection. Return an explicit allowlist. Never return purchase prices, internal notes, exact inventory quantities, staff/authentication records, import data, or audit rows to public callers.
- Public availability may be a boolean or documented public state; it must not reveal a count or location balance.
- Every `/api/admin/*` data operation requires a current owner session. Browser writes also require same-origin checks, JSON content types, bounded request bodies, and server-side validation.
- Passwords remain PBKDF2-derived with a random salt. Session cookies stay HttpOnly, Secure, SameSite=Strict; only token hashes are stored in D1. Never log or commit credentials, session tokens, or secret values.
- Use prepared SQL statements. Return generic API errors and keep sensitive details out of responses.
- Never use `wrangler.jsonc` for local or test D1 operations. Do not run remote migrations or deployments without explicit production approval.

## Inventory and import invariants

- Blank Excel fields preserve current values; numeric zero is an explicit value.
- Excel quantities are target balances for one product and one location. A movement records the difference; quantities are never added blindly.
- Re-uploading a pending workbook resumes the pending preview. Re-uploading an applied workbook creates a new synchronization batch.
- Existing fitments are retained. New imported fitments are pending until an owner confirms them.
- Imported products remain private. Public visibility requires explicit owner action and confirmed compatibility.
- Stock movements are append-only. Every balance change has an audit event and must preserve non-negative stock.
- Import staging and approval must remain recoverable under concurrent requests and partial failures. Do not weaken locking, row limits, validation, or approval requirements to make a test pass.
- Product removal is archival; do not hard-delete products with stock history.

## Migrations and data

- Migration numbers are sequential and append-only. Never rewrite an applied migration's historical meaning; use a new migration for corrections.
- Validate migrations from an empty local D1 database before changing schema code. Use synthetic fixtures only.
- Preserve the existing test D1 and its records. Do not reset, recreate, or import real workbook data into any database.

## Code and tests

- Keep the public site's existing Bakkar visual identity and responsive layout. Prefer small integration changes over redesigns.
- Keep JavaScript modules syntax-checkable and add focused tests for validation, privacy, cursor behavior, and business rules.
- In `backend/worker`, run `npm ci` then `npm test`. CI also syntax-checks modules, applies migrations to a fresh **local** D1, and runs a Wrangler dry-run using the test config.
- Clearly distinguish unit tests, local D1 checks, deployed test Worker checks, and production checks. A dry-run does not verify a remote Worker or D1.

## Pull requests and releases

- Work on a dedicated integration or feature branch based on the latest `origin/main`. Preserve branch history and review merge conflicts file by file.
- A release candidate is not a deployment. Do not deploy Pages/Workers, apply remote migrations, or change production secrets or D1 without separate explicit approval.
- Document test evidence and any unverified runtime behavior in the pull request.
