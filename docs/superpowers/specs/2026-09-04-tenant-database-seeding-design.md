# Tenant Database Seeding for Create Cloud Customer

**Date:** 2026-09-04
**Repo:** `verdix-license-server`
**Status:** approved design, ready for implementation planning

## Problem

`provisionCloudDatabase()` in `src/provision-cloud.ts` clones the reference schema with
`CREATE TABLE ... LIKE`, which copies columns and indexes but **no rows**. Foreign keys are
recreated separately. Nothing ever inserts data.

Verified against production on 2026-09-04:

- `verdix_ref` holds 83 tables and **zero rows in every one of them**
- the 9 existing `verdix_c_*` tenant databases are in the same state
- `verdix_ref.migrations` has **0 rows**, while the live `verdix` master has 118
- `verdix_ref` is missing `license_state` (the only table the live master has that it lacks)

The consequence: a customer created through **Create Cloud Customer** gets a database they
cannot log into. `POST /api/auth/login` in the POS reads `users`, joins `user_types`, and then
selects from `user_permissions` — all three are empty. Even past the login screen, the POS has no
payment methods, units of measure, or tax rates.

This is the second half of the Create Cloud Customer failure. The first half — every issued
`LICENSE_KEY` failing signature verification — was a signing-key divergence, fixed 2026-09-04 by
rotating the licence server's `LICENSE_PRIVATE_KEY` env var. Seeding is what remains.

## Scope

**In scope:** operational lookup data plus one working admin login, so a newly provisioned tenant
is immediately usable as a clean new store.

**Out of scope:** products, suppliers, customers, and all transactional data. A new tenant starts
empty of business records by design.

**Backfill:** one existing tenant needs it. There are exactly two cloud customers, and both their
tenant databases are empty (83 tables, zero rows in `users`, `user_types`, `user_permissions`,
`payment_methods`, `products`):

| Customer | Tenant DB | Needs backfill |
|---|---|---|
| BHAGOHCLOUD DEMO | `verdix_c_b028b2324f` | **yes** — nothing else to fall back on |
| OBUTA STORE | `verdix_c_d88a15f0b7` | no — see below |

OBUTA's hosted POS does **not** use its provisioned tenant database. Its Railway service points at
`DB_NAME=verdix` on `mysql-fal.railway.internal`, which holds real production data (~15k products,
102 sales). Its `cloud_configs` row points at a tenant database it has never touched. That is why
this seeding bug went unnoticed: provisioning ran, and its output was never used.

Backfill needs no separate code path. Because Part 2 is idempotent, re-running provisioning against
BHAGOHCLOUD's existing database seeds it without disturbing the schema.

**Out of scope:** the other 7 `verdix_c_*` databases have no `cloud_configs` row and belong to no
customer. Also out of scope: migrating OBUTA from `verdix` onto the tenant model — that is a data
migration, not seeding.

## Design

### Part 1 — Repair and populate `verdix_ref` (one-time, manual)

A new script, `src/seed-ref-db.ts`, run once by an operator. It does two things the current
`verdix_ref` needs:

**1a. Bring the schema up to date.** Clone any table the live master has that `verdix_ref` lacks
(currently just `license_state`), using the same `CREATE TABLE ... LIKE` + FK recreation approach
already proven in `provision-cloud.ts`.

**1b. Copy the seed rows.** Nine tables, with row counts observed in the live master:

| Table | Rows | Why |
|---|---|---|
| `migrations` | 118 | Marks the schema as fully migrated. Without it a tenant looks unmigrated and `npm run migrate` would attempt all 118 migrations against a schema that already has them. |
| `user_types` | 10 | Roles. The login route joins against this. |
| `user_type_permissions` | 53 | Role→permission mapping. Roles are inert without it. |
| `payment_methods` | 6 | POS checkout |
| `units_of_measure` | 18 | Product entry |
| `tax_rates` | 4 | BIR/VAT calculations |
| `payment_term_types` | 5 | Purchases, suppliers |
| `accounts` | 6 | Ledger references |
| `sales_areas` | 3 | Sales reporting |

Source is the live `verdix` master on `reseau.proxy.rlwy.net:25746`. This is a **one-time read** —
after it runs, `verdix_ref` is the source of truth and provisioning never touches customer data
again. Changing a default later means editing `verdix_ref`, not re-reading production.

The script is idempotent: `INSERT IGNORE`, safe to re-run.

### Part 2 — Seed lookups during provisioning

In `provisionCloudDatabase()`, after the schema clone and FK recreation, copy each of the nine
tables server-side:

```sql
INSERT IGNORE INTO `<tenant>`.`<table>` SELECT * FROM `verdix_ref`.`<table>`
```

Both databases live on the same MySQL instance — the same fact that makes `CREATE TABLE ... LIKE`
viable — so no rows cross the network. `INSERT IGNORE` keeps re-provisioning idempotent, matching
how the FK step already tolerates re-runs.

Foreign key checks stay off for the duration and are restored afterwards, as the clone step does,
since insert order across nine related tables is not dependency-sorted.

### Part 3 — Create the tenant admin user

After lookups are in place:

1. Generate a random password (same generator already used for the tenant DB password).
2. Hash with `bcryptjs` — already a dependency, no new package.
3. Insert one row into `users` with a `user_type` matching the admin role in the seeded
   `user_types`.
4. Insert the matching `user_permissions` rows for that user.

`user_permissions` is the table the login route actually reads — **not** `user_type_permissions`,
which only maps roles. Both are needed: the role mapping for the UI, the per-user rows for auth.

Return the username and the plaintext password in the API response, shown once alongside the env
block. It is never stored in plaintext.

### Part 4 — Surface the credentials in the dashboard

`POST /api/cloud-customers` gains an `admin` block in its response payload. `public/dashboard.html`
and `public/app.js` display it next to the existing env block, with the same copy-once framing.

## Files

| File | Change |
|---|---|
| `src/seed-ref-db.ts` | new — one-time `verdix_ref` repair + populate |
| `src/provision-cloud.ts` | add lookup seeding + admin user creation |
| `src/server.ts` | include `admin` credentials in the response |
| `public/dashboard.html` | render the admin credentials block |
| `public/app.js` | populate it |
| `package.json` | script entry for `seed-ref-db` |

No changes in the POS repo.

## Testing

`staging.sh` overrides `LICENSE_DB_*` to a throwaway local database, so provisioning can be
exercised without touching the live licence DB. Against staging:

- provision a test tenant; assert all nine tables match `verdix_ref` row counts
- assert the admin user authenticates: `bcrypt.compare` against the stored hash, mirroring what
  `app/api/auth/login/route.ts` does
- assert `user_permissions` is non-empty for that user
- re-provision the same tenant; assert no duplicate rows and no error

## Risks

**The one-time `verdix_ref` populate reads live customer data.** It reads only the nine lookup
tables — no products, no sales, no customers. It is a read; nothing writes back to `verdix`.

**`migrations` row copying couples tenants to the master's migration state.** If the master is
ahead of the tenant schema, a tenant would be marked migrated when it is not. Mitigated by doing
the schema refresh (1a) and the row copy (1b) in the same script run, so they cannot drift apart.

**Backfilling BHAGOHCLOUD reuses the provisioning path.** Re-running provisioning against a database
that already exists is the idempotent path the FK step already handles; Part 2's `INSERT IGNORE`
extends that to rows. Verify against staging before running it on the live tenant.
