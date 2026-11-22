# Bakkar Inventory API

A separate Cloudflare Worker API for the Bakkar inventory system.

## Architecture

- Cloudflare Pages continues to serve the existing public website.
- This Worker is the API boundary; browser clients never connect directly to D1.
- Cloudflare D1 is the source of truth for products, stock and audit history.
- The public catalog reads only from the `public_catalog` projection's underlying approved fields. It never returns purchase prices, internal notes, exact stock balances or staff records.
- Admin endpoints fail closed. They require a valid Cloudflare Access JWT and an active email in `staff_accounts`.

## Deployment status\n\nThe Worker is deployed separately from Pages and is available at:\n\n- `https://bakkar-inventory-api.mohamedfathy12127.workers.dev`\n- Health: `/api/health`\n- Public catalog: `/api/catalog`\n\nThe `workers.dev` endpoint is enabled for API testing. It does not change the existing Pages website or its production branch.\n\n## Current routes

| Method | Route | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | Public | Checks API-to-D1 connectivity |
| GET | `/api/catalog` | Public | Approved public catalog with bounded results and cursor pagination |
| GET | `/api/admin/me` | Cloudflare Access + staff allow-list | Returns the authenticated staff identity and role |
| GET | `/api/admin/products` | Cloudflare Access + staff allow-list | Lists internal products and total stock |

Admin routes intentionally return 503 until Access configuration is supplied, 401 for missing/invalid Access identity, and 403 when the verified email is not allow-listed.

## Required admin configuration (not yet set)

Set these as Worker secrets/variables only after creating a Cloudflare Access self-hosted application for the API hostname:

- `ACCESS_TEAM_DOMAIN`: Access team hostname, e.g. `your-team.cloudflareaccess.com` (no scheme).
- `ACCESS_AUD`: the Access application's audience tag.

Do not put tokens, private keys or credentials in this repository. Add authorized staff emails to `staff_accounts` only after confirming the exact email and role with the owner.

## Local development

Install a current Node.js LTS and Wrangler, then run from this directory:

```bash
npm install --save-dev wrangler
npx wrangler dev
```

The local D1 binding is local by default. Do not enable remote D1 access for routine development. Use synthetic test data.

## Deployment

```bash
npx wrangler deploy
```

The repository config binds the existing D1 database. Do not run migrations from this directory unless a reviewed migration file is intentionally added.

## Security notes

- SQL values are passed through prepared statements; user input is never concatenated into SQL syntax.
- Public output is explicitly allow-listed and does not expose internal stock or purchase data.
- Admin identity is verified cryptographically (RS256, issuer, audience, expiry and key ID) against Cloudflare Access signing keys, then checked against the database allow-list.
- No admin write routes are enabled yet. Product creation and stock changes will be added with transactional audit logging and tested against synthetic data before importing the real workbook.
- Errors returned to clients are generic; detailed failures are written as structured Worker logs.
- CORS allows only the configured website origin. CORS is not an authentication mechanism.

## Learning notes

- **Worker**: the server-side program that receives HTTP requests and talks to D1.
- **Binding**: a secure connection supplied by Cloudflare between this Worker and D1.
- **D1**: the managed SQL database and source of truth.
- **JWT**: a signed identity token. The Worker verifies its signature and claims; it does not trust a user-supplied email header.
- **Allow-list**: the explicit set of staff accounts allowed to use the admin API.
- **Prepared statement**: SQL with placeholders, keeping user input separate from SQL code.
- **Cursor pagination**: returns a bounded page and a pointer to the next page instead of loading every record at once.
