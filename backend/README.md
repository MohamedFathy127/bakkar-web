# Bakkar Inventory — backend foundation

## Status

Design and schema foundation only. This branch does not deploy a Worker, create a D1 database, change the live site, or import inventory rows.

## Goals and non-negotiable constraints

- Keep the existing public site working while backend work is developed separately.
- Cloudflare D1 is the proposed system of record; the browser never connects to D1 directly.
- A Cloudflare Worker is the only API layer between the site and D1.
- Excel is an import/export and offline backup format, not a second live database.
- No paid plan, paid add-on, automatic upgrade, or billing-dependent feature may be enabled.
- Never expose purchase prices, staff data, audit data, or exact stock quantities through public endpoints.
- Preserve original spreadsheet values. Missing part codes and notes stay missing; the literal model value `***` is not guessed or normalized.
- Every inventory adjustment must create an immutable stock movement and an audit event.

## Proposed free-tier deployment

- Existing Cloudflare Pages project: keep serving the current static website.
- Separate Worker API: `api.bakkar...` or a Pages Function after validating the current Pages setup. The first implementation should be isolated from the public site's deployment.
- Cloudflare D1: relational inventory database.
- Cloudflare Access: protect the admin routes; Worker must validate the Access JWT and check the email against the staff allow-list in D1. Do not rely on a hidden admin URL.
- GitHub: source control and reviewed SQL migrations. Never commit API tokens or secrets.

No Cloudflare account resources are created by this repository change. A Cloudflare account connection / dashboard action is still needed to create the D1 database and deploy the Worker.

## Free-plan limits and operational truth

The current Cloudflare documentation lists D1 Free at 500 MB per database, 5 GB total D1 storage per account, 5 million rows read per day, and 100,000 rows written per day. Workers Free currently lists 100,000 requests per day and 10 ms CPU time per invocation. D1 Free Time Travel retention is 7 days. If free quotas are exceeded, database queries can fail until the daily reset; this is not an automatic paid overage, but it can interrupt operations. These limits can change and must be checked before launch.

D1 Time Travel is useful for short-window recovery, not a substitute for independent backups. Excel exports should be downloadable on demand and a dated backup should be kept separately by the owner. A true automated off-site backup must not be claimed until a second independent destination and its free quotas have been verified.

Cloudflare states that Workers Free will continue to include D1 for prototyping and experimentation; that does not guarantee unlimited production capacity, uninterrupted service, or that every related product stays free forever. The project must remain portable.

## Data model

- `brands`: vehicle makes (Hyundai, Kia, SsangYong). The brand on the source workbook is the vehicle make.
- `categories`: optional curated catalog category. The workbook has no category column, so imports leave this blank rather than inventing one.
- `products`: the part record and private prices. Purchase price is admin-only. Part code is indexed but deliberately not unique because the workbook has missing codes and uniqueness has not been verified.
- `product_fitments`: one or more vehicle/model/year compatibility records per product. Source rows import their literal model and years; `***` remains `***` and compatibility remains pending until reviewed.
- `locations`: the source workbook's stock locations.
- `inventory_balances`: quantity for a product at a location.
- `stock_movements`: append-only record of every receipt, sale, transfer, or adjustment.
- `staff_accounts`: allow-listed staff email and role, used only after validating Cloudflare Access identity.
- `audit_log`: who changed what and when; private.
- `import_batches`: import history and duplicate-file protection.

The first import should preserve each workbook row as its own product record. Similar-looking rows must not be merged automatically. If later confirmed to be the same part held at multiple locations, an explicit merge workflow can combine them without losing movement history.

## Excel contract

The visible sheet keeps the original Arabic columns and order:
1. الماركة
2. اسم القطعة
3. موديل السيارة
4. من سنة
5. إلى سنة
6. الكمية
7. سعر البيع (ج.م)
8. سعر الشراء (ج.م)
9. الحالة
10. مكان التخزين
11. كود القطعة
12. ملاحظات

The export adds a hidden stable `Bakkar_ID` column (or a protected mapping sheet) so a later import can update the same record. The first import of the original file has no stable IDs, so it must be reviewed and run once; later ID-less imports must go to a preview/matching screen and must never silently create duplicates or overwrite records.

Prices should be stored as integer piastres to avoid floating-point currency errors. The import/export layer converts EGP values to/from piastres. Blank values remain blank/null. Quantity must be a non-negative integer.

## API and security rules

- Public routes return an explicit field allow-list only: part names, make/model/year fitment, condition, category, part code, and optionally approved sale price. Never use `SELECT *` in public handlers.
- Public routes do not return purchase price, supplier/internal notes, exact stock quantities, staff emails, import logs, or audit history.
- Admin routes require a valid Cloudflare Access JWT, then an active `staff_accounts` row. Roles: `owner` and `staff`; only owner can manage staff and export purchase prices.
- All writes are validated server-side. Browser validation is convenience only.
- Use parameterized SQL. Never concatenate user input into SQL.
- Stock changes use atomic conditional updates and append a movement + audit row in the same D1 batch/transaction. Reject any operation that would make a balance negative.
- Use soft archival for products; do not hard-delete records with movement history.
- Add rate limits and input size limits to public enquiry routes if those are added later.

## Rollout and rollback

1. Keep this work on a feature branch.
2. Create a D1 database only after checking the Cloudflare account is on Free and no paid feature or billing requirement is introduced.
3. Apply the SQL migration to a new empty database; never run it against an existing unrelated database.
4. Test with a copy of the workbook and synthetic records first.
5. Build and test the Worker separately from the public site.
6. Back up the current site source and export the existing workbook before any production import.
7. Run a dry-run import; compare row counts, blanks, quantities, and currency totals; obtain owner review.
8. Deploy read-only catalog integration first. Enable admin writes only after authentication, audit, and restore tests pass.
9. Keep a rollback route to the existing static demo/catalog while the new backend is validated.

## Source workbook facts captured for migration planning

The workbook has 48 data rows and 12 columns. Brands: Kia 22, Hyundai 18, SsangYong 8. All 48 condition values are `استيراد`. Storage: مخزن العبور 44, مخزون المحل 3, مخزن الأزهر 1. Part code is blank in 19 rows; notes are blank in 31 rows. Five model cells contain the literal `***`. Total quantity is 266. These are source-file observations, not a verified physical stocktake.
