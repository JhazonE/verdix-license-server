# Reference Database Freshness Guard

**Date:** 2026-10-12
**Repo:** `verdix-license-server`
**Status:** approved design, ready for implementation planning

## Problem

`provisionCloudDatabase()` clones `verdix_ref` into each new tenant without checking whether
`verdix_ref` is current. When it is stale, the customer gets a database whose schema is missing
whatever the POS has added since — and nothing says so. The first signal is an error in the
customer's own POS logs.

That is what happened on 2026-10-12. Tenant `verdix_c_82d2221d42` failed with:

```
Unknown column 'si.selling_unit_factor' in 'field list'   (ER_BAD_FIELD_ERROR, 1054)
```

`/api/reports/stats` was the endpoint that surfaced it, but 22 files in the POS reference
`selling_unit_factor`, including `app/api/pos/checkout/route.ts` and `lib/pos/process-sale-leg.ts`.
The customer could not sell.

Measured that day, against the POS master:

| | tables | migrations |
|---|---|---|
| `verdix` (POS master) | 85 | 141 |
| `verdix_ref` | 84 | 118 |

`verdix_ref` was **23 migrations behind**: 2 missing tables and 33 missing columns across 12
tables. Every tenant provisioned in that window inherited the gap.

### Why nothing caught it

Two independent failures, both now understood:

1. **The schema repair compared only table names.** `seed-ref-db.ts` computed its work as
   `masterTables.filter(n => !refTables.has(n))`. A migration that adds a column to an existing
   table leaves the table list identical, so the repair found nothing to do, printed
   `Schema: 0 table(s) added` and exited 0. Fixed in commit `d364340`, which added `diffColumns`
   and `repairRefColumns`.

2. **Nothing checks `verdix_ref` at provisioning time.** This is what remains, and what this
   design addresses. Fixing the repair script helps only when an operator remembers to run it.

### What this is not

The `migrations` seed row was initially suspected of deadlocking the POS migration runner — the
theory being that a tenant claiming migration 120 as executed would make `migrateUp()` skip it.
Measurement disproved this: the tenant held 118 rows, none in the 120–137 range, so the runner
would have applied them. `npm run migrate` against the tenant would have repaired the schema.
The seeding of `migrations` is not the defect.

## Scope

**In scope:** a guard that refuses to provision from a stale reference database, with a message
that names the gap and the remedy.

**Out of scope, deliberately:**

- **Driving POS migrations from the license server.** The migration runner lives in the
  `Verdix_POS` repo and reaches its database through `lib/mysql.ts`, a module-level pool keyed on
  `DB_HOST`/`DB_NAME`. `scripts/migrations/index.ts` accepts only `up`/`down` — no database
  argument — and migrations such as `120_add_selling_unit_to_line_items` resolve their target with
  `TABLE_SCHEMA = DATABASE()`. Targeting an arbitrary tenant would need a new per-database migrate
  command in that repo, and 141 migrations per tenant over the Railway proxy is untested for time.
  A separate piece of work.
- **True drift detection at provisioning time.** That requires comparing against the POS master,
  and the deployed license server cannot reach it: the master is on a different MySQL instance,
  `SEED_MASTER_*` is deliberately not stored (see `docs/cloud-tenancy.md`), and the container has
  no copy of the POS migration files. The guard works from the reference database alone.

## Design

### The contract

`verdix_ref.migrations` records how current the reference schema is. A new constant declares what
this license server expects:

```ts
// src/seed-tables.ts
export const EXPECTED_MIGRATION_COUNT = 141;
```

Read as: *a tenant cloned from `verdix_ref` is only usable by a POS at migration 141.* The
operator updates this when refreshing `verdix_ref`, in the same commit.

### The guard

In `provisionCloudDatabase()`, before any database is created, count
`verdix_ref.migrations` and compare:

- **count < expected** → throw. The reference database is behind; a tenant cloned from it now
  would be missing schema the POS requires.
- **count > expected** → warn, proceed. The reference database is ahead of this server's
  declaration, which is the benign direction: the tenant gets more schema than required. Most
  likely `EXPECTED_MIGRATION_COUNT` was not bumped after a refresh.
- **count == expected** → proceed silently.

Placement matters. The check runs **before** `CREATE DATABASE`, so a refusal leaves nothing
behind — no half-provisioned tenant, no user, no `cloud_configs` row.

The message names the gap and the remedy:

```
Reference database 'verdix_ref' is at migration 118 but this server expects 141
(23 behind). A tenant cloned from it now would be missing schema the POS
requires. Refresh it with `npm run seed-ref-db` against the POS master, then
update EXPECTED_MIGRATION_COUNT in src/seed-tables.ts.
Override with --allow-stale-ref (CLI) or ALLOW_STALE_REF=true (server).
```

### The escape hatch

`--allow-stale-ref` on the CLI, `ALLOW_STALE_REF=true` for the server. Downgrades the refusal to a
warning. Without it the guard becomes a blocker in an emergency where the operator knows the gap
is harmless. The override is logged.

### Keeping the constant honest

`seed-ref-db.ts` ends by printing the reference database's migration count next to
`EXPECTED_MIGRATION_COUNT`, and when they differ, the line to change. The refresh and the
declaration stay together because the script that invalidates the constant is the one that
reminds you.

## Components

| File | Change |
|---|---|
| `src/seed-tables.ts` | Add `EXPECTED_MIGRATION_COUNT`, documented as a contract with the POS schema. |
| `src/provision-cloud.ts` | Add `assertRefDbFresh()`; call it before `CREATE DATABASE`. Honour `--allow-stale-ref` / `ALLOW_STALE_REF`. |
| `src/seed-ref-db.ts` | Print the resulting count against the constant; name the edit when they differ. |
| `tests/check-ref-freshness.ts` | New. |
| `docs/cloud-tenancy.md` | Document the contract and the refresh-then-bump sequence. |

`assertRefDbFresh(conn, refDb, expected, opts)` takes an open connection, as `diffColumns` and
`copySeedRows` already do, so it is testable without provisioning anything.

## Data flow

```
provisionCloudDatabase(productKey)
  │
  ├─ validate CLOUD_PROVISION_* (existing)
  ├─ resolve licence (existing)
  ├─ assertRefDbFresh()  ◄── NEW: throws before anything is created
  ├─ CREATE DATABASE / CREATE USER / GRANT
  ├─ clone schema + foreign keys
  ├─ copySeedRows()
  └─ createTenantAdmin()
```

## Error handling

- **Reference database unreachable, or `migrations` absent.** Treat as a failed check and throw.
  A reference database without a `migrations` table cannot be shown current, and provisioning
  from it is what caused this bug. The message distinguishes this from being merely behind.
- **Override used.** Proceed, and log at warning level with the actual and expected counts, so the
  run's output records that the tenant was created from a reference database known to be stale.
- **Existing `getCloudConfig` / error-swallowing paths.** Untouched by this change. Noted because
  `getLicenseByProductKey` in `src/service.ts` catches connection failures and falls back to
  cache, reporting a reachable-but-misconfigured database as "No license found" — misleading, but
  a separate fix.

## Testing

`tests/check-ref-freshness.ts`, following the existing `tests/check-*.ts` shape (real MySQL via
`LICENSE_DB_*`, scratch databases created and dropped, `✅ PASS` / `❌ FAILED`, exit code):

1. **Behind → throws.** Reference with 118 rows, expected 141. Assert it throws and the message
   carries both numbers and the remedy.
2. **Current → passes.** 141 rows, expected 141. No throw.
3. **Ahead → passes.** 145 rows, expected 141. No throw; warning is acceptable.
4. **No `migrations` table → throws**, with a message distinct from case 1.
5. **Override → passes** despite being behind.

Regression: `check-ref-column-drift`, `check-ref-db-seed`, `check-provision-seeding`,
`check-seed-tables`, `check-tenant-admin` must still pass.

Note: `tests/check-cloud-provision-fn.ts` fails on `main` as of this date, before and without these
changes ("unknown product key rejects with a clear message"). Likely the `service.ts` catch
described above. Not fixed here; recorded so it is not mistaken for a regression.

## What this does and does not buy

**Does:** converts a silent failure into a loud one, at provisioning time, before a customer is
affected. The operator learns `verdix_ref` is stale when creating a customer — not from that
customer's crash logs.

**Does not:** keep `verdix_ref` current. It is still refreshed by hand, and
`EXPECTED_MIGRATION_COUNT` is still bumped by hand. Forget the bump and provisioning blocks until
you notice — the failure direction is "refuses to provision," never "ships a broken tenant."

**Does not:** catch a reference database with the right row count and the wrong schema — a
migration recorded but not applied. Detecting that needs the master, which is out of reach. The
repair in `d364340` is what keeps the two aligned when the refresh does run.

The structural fix — making the POS migration files the single source of truth, with tenants
migrating themselves — remains open. This guard does not block it, and makes its absence visible
instead of invisible.

## Related

- `docs/superpowers/specs/2026-09-04-tenant-database-seeding-design.md` — why seeding exists.
- `docs/cloud-tenancy.md` — tenancy layout and the master/reference entanglement.
- Commit `d364340` — column drift detection in `seed-ref-db.ts`.
