# Bakkar Web

Bakkar's public automotive parts catalog and owner-only inventory system.

## Architecture

- Cloudflare Pages serves the static Arabic site in `index.html` and its existing visual identity.
- The public site calls the Worker URL in the `bakkar-api-base` meta tag for published products, search, fitment filters, and public availability.
- Cloudflare Worker source lives in `backend/worker/src/`. The Worker serves the private `/admin` dashboard and owner-only API.
- D1 is the inventory system of record. Schema history is in `backend/migrations/0001` through `0009`.
- Public catalog responses are allowlisted and exclude purchase prices, notes, exact stock balances, and private products. Only confirmed fitments are shown.

## Local development and tests

Use Node.js 22 or a compatible current LTS. From `backend/worker`:

```sh
npm ci
npm test
npm exec -- wrangler deploy --dry-run --config wrangler.test.jsonc
```

To validate the complete migration sequence, use a fresh local D1 persistence directory:

```sh
npm exec -- wrangler d1 migrations apply bakkar-inventory-test --local --config wrangler.test.jsonc --persist-to .wrangler/local-d1 --force
npm exec -- wrangler d1 execute bakkar-inventory-test --local --config wrangler.test.jsonc --persist-to .wrangler/local-d1 --file test/fixtures/synthetic-catalog.sql
npm exec -- wrangler dev --local --config wrangler.test.jsonc --persist-to .wrangler/local-d1
```

The fixture contains synthetic records and a local-only owner session. Do not point these commands at production or add real inventory data to the fixture. Use a new persistence directory if you need a clean local database; never reset a connected D1 database.

## Configuration

- `backend/worker/wrangler.jsonc` binds the production Worker to production D1. Do not use it for local testing or test deployments.
- `backend/worker/wrangler.test.jsonc` binds the isolated test Worker and points at `../migrations`. Add local-only variables through ignored `.dev.vars` files; never commit secret values.
- The owner bootstrap and login use Worker secret bindings. Secret names and values are managed outside source control.
- The public page's API base must match the API Worker, and Worker CORS must allow the public Pages origin.

## Database migrations

Migration order is `0001` schema, `0002` owner auth, `0003` IP login throttling, `0004` vehicle-brand seed data, `0005` movement-driven balances, `0006` outbound balance trigger correction, `0007` import staging, `0008` recoverable import lock, and `0009` repeat workbook synchronization hashes.

Treat migrations as append-only. Check the target database's migration ledger before any remote operation. This repository's routine validation applies migrations only to local D1. Production migrations are outside this release-candidate task.

## Deployment and current limits

This branch is an integration candidate. CI syntax checks and dry-run bundling do not deploy code. Production Pages, Workers, D1, and secrets must remain unchanged until a separate release approval.

The public catalog now reads published records from the API. An empty public D1 projection produces an empty catalog with the existing request flow; demo products are not used as a fallback. The downloadable JSON backup is a checksummed data snapshot, not a native D1 dump or a tested restore workflow.
