# Bakkar Inventory Worker

Cloudflare Worker API and owner dashboard for Bakkar Web.

## Current release-candidate status

- The integration branch is based on current `origin/main`, preserves both feature-branch histories, restores the reliability work reverted by PR #9, integrates PR #13, and carries the Admin HTML escaping fix verified from the deployed dashboard response.
- No Pages or Worker deployment and no remote D1 migration was performed for this integration.
- As of the 22 November 2026 review, the production and test Workers used the same deployed code. Read-only requests to both `/admin` routes returned the same HTML, and its evaluated SHA-256 matched the integration source after preserving the nested JavaScript escapes.
- The production D1 was reported to contain three brands and no products or stock movements. PR #13's description reported test D1 counts of 51 products, 56 movements, one import batch, and 48 import rows; those remote counts were not queried in this turn.
- GitHub PR #13 remains a feature-branch PR and is not the release-candidate PR. A successful Pages preview does not validate Worker runtime behavior.

## Architecture

- Pages serves the public site at `https://bakkar-web.pages.dev`.
- The public site calls `https://bakkar-inventory-api.mohamedfathy12127.workers.dev` as configured in the `bakkar-api-base` meta tag.
- This Worker exposes a public catalog projection and serves owner admin UI at `/admin` on its own origin. The browser never connects to D1 directly.
- D1 is the source of truth for products, confirmed fitments, balances, append-only movements, audit history, and staged import batches.
- Production and test resource bindings are deliberately separate in `wrangler.jsonc` and `wrangler.test.jsonc`.

## Public routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | API-to-D1 health check |
| GET | `/api/catalog/meta` | Published brand, category, condition, and model filter options |
| GET | `/api/catalog` | Published products with search, compatibility filters, sale price, boolean availability, sorting, and cursor pagination |
| GET | `/admin` | Owner login and dashboard shell; data requires a session |

Public catalog responses come from `public_catalog`, include confirmed fitments only, and explicitly allowlist fields. They never return purchase price, notes, exact quantities, location balances, private records, staff data, import rows, or audit history. Availability is a boolean only.

## Owner routes

Owner APIs cover setup/login/logout/session, product create/read/update/archive, brand/category/location references, stock movements and balances, analytics, Excel export, checksummed application-data backup, and Excel preview/edit/apply. Every data route requires an active owner session. Mutations require same-origin JSON requests and server-side validation.

Login uses PBKDF2-HMAC-SHA256 password hashes, opaque hashed session tokens, an eight-hour session, account/IP and IP-wide throttles, and a Secure HttpOnly SameSite=Strict cookie. The exact login feedback and nested Admin HTML escaping fixes are covered by tests.

## Inventory and Excel guarantees

- Stock is stored per product and location. Movement triggers update balances and reject negative stock; movement history is append-only.
- Product deletion is archival so stock and audit history remain connected.
- Excel preview stages rows without changing products or stock. Owners review flagged rows before approval.
- Blank cells preserve existing matched-product values; explicit zero is retained.
- Excel quantities set target balances per selected location. A movement records the difference.
- Re-uploading a pending workbook resumes that preview. Re-uploading an applied workbook starts a new synchronization batch.
- New fitments remain pending; existing fitments are not removed; imported products remain private.
- Apply locking is recoverable. D1 writes occur in bounded atomic chunks; failed chunks stay pending.
- The JSON backup has a SHA-256 checksum but is not a native D1 dump and has no restore implementation.

## Migrations and local checks

The append-only sequence is `0001`–`0009`. `wrangler.test.jsonc` points at `../migrations` so a clean local database can exercise the full chain.

```sh
npm ci
npm test
npm exec -- wrangler d1 migrations apply bakkar-inventory-test --local --config wrangler.test.jsonc --persist-to .wrangler/local-d1 --force
npm exec -- wrangler d1 execute bakkar-inventory-test --local --config wrangler.test.jsonc --persist-to .wrangler/local-d1 --file test/fixtures/synthetic-catalog.sql
npm exec -- wrangler dev --local --config wrangler.test.jsonc --persist-to .wrangler/local-d1
npm exec -- wrangler deploy --dry-run --config wrangler.test.jsonc
```

Use a fresh local persistence path for the synthetic fixture. It contains synthetic products and a local-only owner session; never run it against remote D1. Local D1 validation does not verify the existing remote test D1 migration ledger.

## Environment and release operations

- `wrangler.jsonc` binds production D1. Do not use it for tests or local development.
- `wrangler.test.jsonc` binds test D1. `--local` is required for repository migration checks.
- `ALLOWED_ORIGIN` must match the Pages origin for public cross-origin requests.
- Owner bootstrap credentials are Worker secret bindings and stay outside source control. Never log or print their values.
- Do not deploy Workers/Pages or apply remote migrations as part of local validation. Production deployment, production migrations, and production secrets require separate approval.

## Known limitations

- The public catalog has no demo fallback. With no public products it shows an empty catalog and keeps the existing WhatsApp request path.
- The current root site does not store customer inquiry submissions; it prepares a WhatsApp message.
- No browser-driven end-to-end check against the deployed test Worker was completed in this integration turn.
- The remote test D1's current migration ledger and data counts have not been independently inspected here.
