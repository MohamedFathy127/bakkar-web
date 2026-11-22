# Backend Architecture and Operations

## Architecture

- Cloudflare Pages serves the public site. It reads only published products from the Worker API.
- `worker/src/index.js` routes public and owner API requests and serves the private dashboard at `/admin`.
- `worker/src/catalog.js` serves catalog data from the reviewed `public_catalog` projection. `worker/src/inventory.js` handles product and stock management. `worker/src/excel-import.js` stages and applies owner-approved Excel changes.
- D1 is the system of record. The browser never connects to D1 directly.
- `worker/wrangler.jsonc` targets production resources. `worker/wrangler.test.jsonc` targets the isolated test Worker and migration directory. Use local mode for ordinary code and migration checks.

## Security and data boundaries

- Public responses contain product names, codes, sale price, category, confirmed vehicle fitments, and a non-quantitative availability state. They must not expose purchase price, internal notes, exact quantities, locations, private products, auth data, imports, or audit history.
- Owner routes require an active owner session. Writes require same-origin request validation, bounded bodies, prepared statements, and server-side validation.
- Passwords are salted and PBKDF2-derived. Session cookies are Secure, HttpOnly, SameSite=Strict, and scoped to `/api/admin`; D1 stores session hashes rather than browser tokens.
- Login attempts are limited by account/IP and by IP. Error responses remain generic.
- All stock changes are append-only movements that update balances through database triggers and are audit logged. Negative balances are rejected. Product deletion is soft archival.

## Import and inventory business rules

- Excel preview does not change products or stock. Approval requires owner decisions.
- Blank cells preserve existing product values. Zero is a valid explicit price or quantity.
- Quantity is a target balance for a product/location. The system writes a movement for the difference.
- A pending workbook upload resumes the existing batch. An applied workbook can be uploaded as a new synchronization batch.
- Existing fitments are never silently removed or confirmed. New imported fitments remain pending; imported products remain private.
- Import approvals use a recoverable lock and bounded atomic D1 chunks. Failed chunks stay pending for review or retry.
- Migration 0009 preserves the original unique batch hash and separately records the canonical workbook content hash.

## Migrations

Apply migrations in numeric order, `0001` through `0009`. They build schema/auth, login throttles, brands, movement triggers, import staging, the recoverable apply lock, and repeat workbook synchronization support. These files are historical records: add a new numbered migration for schema corrections rather than editing an applied migration.

Validate the full sequence against a fresh local D1 database:

```sh
cd backend/worker
npm ci
npm exec -- wrangler d1 migrations apply bakkar-inventory-test --local --config wrangler.test.jsonc --persist-to .wrangler/local-d1 --force
```

The command is explicitly local. Do not add `--remote` or use the production Wrangler config. To inspect an existing remote database, verify the account and test database identity first; preserve its data and migration ledger.

## Local development and tests

```sh
cd backend/worker
npm ci
npm test
npm exec -- wrangler dev --local --config wrangler.test.jsonc --persist-to .wrangler/local-d1
npm exec -- wrangler deploy --dry-run --config wrangler.test.jsonc
```

The synthetic fixture under `worker/test/fixtures/` is only for a fresh local D1 database. It includes a synthetic local session so owner API behavior can be exercised without production credentials.

## Environment configuration

- The public `bakkar-api-base` meta tag in the site must point at the intended public API Worker.
- `ALLOWED_ORIGIN` must match the public Pages origin for cross-origin public catalog requests.
- Owner bootstrap/login bindings are configured as Worker secrets outside source control. Never put secret values in `.env`, source, CI logs, docs, or chat.
- Test Worker settings and IDs stay in `wrangler.test.jsonc`; do not copy test bindings into production or vice versa.

## Deployment and recovery limitations

The integration branch and Wrangler dry-run are not deployments. Production Workers, Pages, D1, migrations, and secrets remain untouched. Any remote test Worker deployment requires an isolated test target and separate operator decision.

The dashboard's JSON backup is checksummed application data; it is not a native D1 SQL backup and has no implemented restore path. Do not claim that a restore has been tested. D1 remote migration state and existing test data still need independent verification before a future test deployment.
