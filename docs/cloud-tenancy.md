# Cloud tenancy: how a hosted customer's database is laid out

How **Create Cloud Customer** provisions a database, which databases exist on the shared MySQL
instance and what each is for, and the two places the current layout departs from the model. Read
this before changing provisioning, before moving a customer between databases, and before pointing
anything new at `verdix`.

## The model

Each hosted customer gets their own database on the licence server's MySQL instance
(`metro.proxy.rlwy.net:35275`), named `verdix_c_<10 hex chars>` — derived from the licence id, so
the name is stable across re-provisioning. A per-tenant MySQL user (`u_<same hex>`) is granted
rights on that database alone.

`provisionCloudDatabase()` in `src/provision-cloud.ts` runs four steps against a new tenant:

1. Create the database and its user.
2. Clone the schema from the reference database with `CREATE TABLE ... LIKE`, then recreate foreign
   keys (which `LIKE` does not copy).
3. Seed nine lookup tables from the reference database — `src/seed-tables.ts` holds the list and its
   FK-safe order.
4. Create one administrator with a generated password, bcrypt-hashed before storage.

Steps 2-4 are all idempotent (`CREATE TABLE IF NOT EXISTS`, duplicate-FK tolerance, `INSERT IGNORE`),
so re-running provisioning against an existing tenant is the supported way to backfill or repair it.
Re-running never rotates an existing admin's password, and it reconciles that admin's permissions.

## The databases on that instance

| Database | Role |
|---|---|
| `verdix_license` | The licence server's own data — licences, customers, activations, cloud configs. |
| `verdix_ref` | **The reference database.** Curated schema + seed rows that every new tenant is cloned from. `CLOUD_PROVISION_REF_DB` points here; `DEFAULT_REF_DB` in `src/seed-tables.ts` is the fallback. |
| `verdix_c_*` | One per hosted customer. |

`verdix_ref` is maintained by `npm run seed-ref-db` (`src/seed-ref-db.ts`), which reads the POS master
once to refresh the schema and re-copy the nine seed tables. It is an operator command, not something
the server runs.

## Two departures from the model

### 1. OBUTA STORE does not use its tenant database

OBUTA has a `cloud_configs` row pointing at `verdix_c_d88a15f0b7`, and that database was provisioned
— but its POS has never connected to it. The Railway `Verdix` service in the `Vendix_Pos` project
runs with `DB_NAME=verdix` on `mysql-fal.railway.internal`, a **different MySQL instance** holding
~15,600 products and real sales.

This is deliberate for now, not an oversight to tidy up on sight. It is also why the seeding gap
below went unnoticed for so long: provisioning ran for OBUTA, produced an empty database, and nobody
noticed because nothing ever read it.

**Do not "fix" this by re-provisioning OBUTA.** Seeding a database it does not use accomplishes
nothing, and re-provisioning is only safe on an empty database. Moving OBUTA onto the tenant model is
a data migration of a live store — needs a downtime window, a backup, and a rollback plan — and it is
blocked on the entanglement below.

### 2. The POS master is doing two jobs at once

`verdix` on `reseau.proxy.rlwy.net:25746` is simultaneously:

- OBUTA's live production database, and
- the source `seed-ref-db` reads to refresh `verdix_ref`.

Those roles conflict. The seed tables are lookup data that happens to be the same for every store,
so copying them out of a live store works today — but it means a customer's production database is
load-bearing for onboarding every future customer.

**This is what blocks the OBUTA migration.** Move OBUTA onto a tenant database and `verdix` stops
being a general master; the next `seed-ref-db` run would read one customer's tenant data as the
template for the next customer. Untangle it first: give the seed data a home that is not a
customer's database — a dedicated master, or committed fixtures — and the migration becomes
ordinary.

Until then `verdix_ref` is the buffer: provisioning reads only from `verdix_ref`, never from
`verdix`, so the coupling is confined to the operator command.

## Running provisioning by hand

Provisioning needs `CLOUD_PROVISION_HOST/PORT/USER/PASSWORD`, `CLOUD_PROVISION_REF_DB`, **and**
`CLOUD_CONFIG_SECRET` (which encrypts the tenant DB password before it is stored). The local `.env`
ships these blank — the real values live only on the `verdix-license-server` Railway service:

```bash
railway variables --service verdix-license-server --kv
```

**`npm run provision-cloud` is not the right entry point for a new customer.** Its `main()` prints
only the database name and user — never the generated admin password, which is not stored anywhere
and cannot be regenerated (a later run finds the existing admin and returns an empty password). Use
the dashboard's Create Cloud Customer, which surfaces the credential, or call
`provisionCloudDatabase()` directly and read `res.admin.password` from the result. The CLI's flag is
`--license`, not `--product-key`.

## Related

- `docs/superpowers/specs/2026-09-04-tenant-database-seeding-design.md` — why seeding exists and what
  it covers.
- `docs/superpowers/plans/2026-09-04-tenant-database-seeding.md` — the runbook, including the
  one-time `verdix_ref` populate.
