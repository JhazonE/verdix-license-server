# Reference Database Freshness Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `provisionCloudDatabase()` refuse to clone a reference database that is behind the migration count this server expects, so a stale `verdix_ref` fails loudly at provisioning time instead of silently shipping a tenant the POS cannot use.

**Architecture:** A new exported constant declares the expected migration count. A new `assertRefDbFresh()` helper counts `verdix_ref.migrations` and throws when it is lower, called before `CREATE DATABASE` so a refusal leaves nothing behind. An override flag keeps the guard from blocking an emergency. `seed-ref-db.ts` prints the count against the constant so the refresh reminds the operator to bump it.

**Tech Stack:** TypeScript, `mysql2/promise`, `tsx`. Tests are standalone `tsx` scripts under `tests/` that connect to a real MySQL via `LICENSE_DB_*`, create and drop scratch databases, print `✅ PASS` / `❌ FAILED`, and exit non-zero on failure. There is no test runner — each test is executed directly.

**Spec:** `docs/superpowers/specs/2026-10-12-reference-db-freshness-guard-design.md`

## Global Constraints

- Node 20 (`node:20-slim` in `Dockerfile`); `mysql2` ^3.11.0; TypeScript ^5.7.3.
- `npx tsc --noEmit` must pass after every task.
- Tests follow the existing `tests/check-*.ts` shape: no framework, real MySQL, scratch databases dropped at the end, `✅ PASS` / `❌ FAILED` final line, `process.exit(failed ? 1 : 0)`.
- Running tests locally needs `LICENSE_DB_SSL=true` exported when `LICENSE_DB_HOST` is the Railway proxy. `src/db.ts` treats a blank `LICENSE_DB_SSL` as "no TLS", and the local `.env` ships it blank, so the connection fails without it. Load env with `set -a && . ./.env && set +a && export LICENSE_DB_SSL=true`.
- Never drop or alter a column in a tenant or reference database. All repair is additive (established in commit `d364340`).
- The guard must not reach for the POS master or the POS migration files: the deployed container has neither.
- `tests/check-cloud-provision-fn.ts` already fails on `main` ("unknown product key rejects with a clear message"), before and without these changes. Do not treat it as a regression and do not fix it here.

## Review Focus

Input classes the spec implies that no task's happy path exercises. Each has its test added to the task that owns the code.

- **Reference database has no `migrations` table at all** — must throw with a message distinct from "behind", because the remedy differs (repair vs refresh). Task 1.
- **`migrations` table exists but holds 0 rows** — a freshly created empty reference; must throw as "behind", not divide-by-zero or pass. Task 1.
- **Count exceeds the expectation** — benign direction; must proceed, not throw, so a forgotten constant bump never blocks provisioning. Task 1.
- **Override requested while behind** — must proceed and still say it is stale, so the run's output records what was done. Task 2.
- **Guard throws before any database exists** — a refusal must leave no database, user, or `cloud_configs` row behind. Task 2.

---

### Task 1: The freshness check

**Files:**
- Modify: `src/seed-tables.ts` (append after `DEFAULT_REF_DB`, currently the last export)
- Modify: `src/seed-ref-db.ts` (add `assertRefDbFresh`, placed after `repairRefColumns` and before the `copySeedRows` docblock)
- Test: `tests/check-ref-freshness.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `EXPECTED_MIGRATION_COUNT: number` from `src/seed-tables.ts`
  - `assertRefDbFresh(conn: mysql.Connection, refDb: string, expected: number, opts?: { allowStale?: boolean }): Promise<{ count: number; stale: boolean }>` from `src/seed-ref-db.ts`. Throws `Error` when behind and `allowStale` is not set. Returns `{ count, stale }` otherwise; `stale` is true when `count < expected`.

- [ ] **Step 1: Write the failing test**

Create `tests/check-ref-freshness.ts`:

```typescript
// tests/check-ref-freshness.ts
//
// Pins the guard that stops provisioning from cloning a stale reference
// database. Before this guard, verdix_ref fell 23 migrations behind and every
// tenant provisioned from it was missing schema the POS requires — the first
// signal being ER_BAD_FIELD_ERROR in the customer's own POS logs.
import mysql from 'mysql2/promise';
import { assertRefDbFresh } from '../src/seed-ref-db';

const REF = 'verdix_freshtest_ref';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.LICENSE_DB_HOST || '127.0.0.1',
    port: Number(process.env.LICENSE_DB_PORT || 3306),
    user: process.env.LICENSE_DB_USER || 'root',
    password: process.env.LICENSE_DB_PASSWORD,
    ssl: process.env.LICENSE_DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    multipleStatements: true,
  });

  let failed = false;
  const fail = (m: string) => { console.error('FAIL: ' + m); failed = true; };

  const reset = async (rows: number, withTable = true) => {
    await conn.query(`DROP DATABASE IF EXISTS \`${REF}\``);
    await conn.query(`CREATE DATABASE \`${REF}\``);
    if (!withTable) return;
    await conn.query(`CREATE TABLE \`${REF}\`.migrations (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE,
      timestamp VARCHAR(50) NOT NULL, executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    for (let i = 1; i <= rows; i++) {
      await conn.query(`INSERT INTO \`${REF}\`.migrations (name, timestamp) VALUES (?, ?)`,
        [`${String(i).padStart(3, '0')}_m`, '2026-01-01_00-00-00']);
    }
  };

  // 1. Behind -> throws, naming both counts and the remedy.
  await reset(118);
  try {
    await assertRefDbFresh(conn, REF, 141);
    fail('118 rows against an expectation of 141 should have thrown');
  } catch (e: any) {
    const m = e.message || '';
    if (!m.includes('118')) fail(`message should name the actual count: ${m}`);
    if (!m.includes('141')) fail(`message should name the expected count: ${m}`);
    if (!/seed-ref-db/.test(m)) fail(`message should name the remedy: ${m}`);
    if (!/EXPECTED_MIGRATION_COUNT/.test(m)) fail(`message should name the constant: ${m}`);
  }

  // 2. Current -> passes.
  await reset(141);
  const ok = await assertRefDbFresh(conn, REF, 141);
  if (ok.count !== 141) fail(`expected count 141, got ${ok.count}`);
  if (ok.stale) fail('141 against 141 must not be stale');

  // 3. Ahead -> passes. A forgotten constant bump must never block provisioning.
  await reset(145);
  const ahead = await assertRefDbFresh(conn, REF, 141);
  if (ahead.count !== 145) fail(`expected count 145, got ${ahead.count}`);
  if (ahead.stale) fail('145 against 141 must not be stale');

  // 4. No migrations table -> throws, with a message DISTINCT from "behind",
  //    because the remedy differs: repair the reference, not refresh it.
  await reset(0, false);
  try {
    await assertRefDbFresh(conn, REF, 141);
    fail('a reference database with no migrations table should have thrown');
  } catch (e: any) {
    const m = e.message || '';
    if (!/no `?migrations`? table|migrations table/i.test(m))
      fail(`message should say the table is missing: ${m}`);
    if (/\bbehind\b/i.test(m)) fail(`missing-table message must not read as "behind": ${m}`);
  }

  // 5. Empty migrations table -> throws as behind, not a pass and not a crash.
  await reset(0);
  try {
    await assertRefDbFresh(conn, REF, 141);
    fail('an empty migrations table should have thrown');
  } catch (e: any) {
    if (!(e.message || '').includes('141')) fail(`message should name the expectation: ${e.message}`);
  }

  // 6. Override -> proceeds despite being behind, and reports it as stale.
  await reset(118);
  const forced = await assertRefDbFresh(conn, REF, 141, { allowStale: true });
  if (forced.count !== 118) fail(`expected count 118, got ${forced.count}`);
  if (!forced.stale) fail('override must still report stale: true');

  await conn.query(`DROP DATABASE IF EXISTS \`${REF}\``);
  await conn.end();
  console.log(failed ? '❌ FAILED' : '✅ PASS');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
set -a && . ./.env && set +a && export LICENSE_DB_SSL=true
npx tsx tests/check-ref-freshness.ts
```

Expected: fails with `(0 , import_seed_ref_db.assertRefDbFresh) is not a function` — the export does not exist yet.

- [ ] **Step 3: Add the constant**

Append to `src/seed-tables.ts`, after the `DEFAULT_REF_DB` export:

```typescript
/**
 * Migration count a tenant cloned from the reference database must carry.
 *
 * The contract: a tenant cloned from `DEFAULT_REF_DB` is only usable by a POS
 * at this migration. Provisioning refuses to clone a reference database below
 * it, because the tenant would be missing schema the POS requires and nothing
 * else would say so — on 2026-10-12 a customer lost the ability to sell that
 * way, with `verdix_ref` 23 migrations behind and the first signal an
 * ER_BAD_FIELD_ERROR in their own POS logs.
 *
 * Bump this in the same commit as a `npm run seed-ref-db` refresh. Forgetting
 * blocks provisioning until someone notices, which is the safe direction: the
 * failure is "refuses to provision", never "ships a broken tenant".
 */
export const EXPECTED_MIGRATION_COUNT = 141;
```

- [ ] **Step 4: Add the check**

In `src/seed-ref-db.ts`, insert after `repairRefColumns` and before the `copySeedRows` docblock:

```typescript
/**
 * Refuse to proceed when `refDb` is behind the migration count this server
 * expects. Returns the count and whether it is stale.
 *
 * Counting `migrations` rows is the only freshness signal available here: the
 * deployed licence server cannot reach the POS master (different instance,
 * `SEED_MASTER_*` deliberately unstored) and holds no copy of the POS
 * migration files. So this detects a reference database left BEHIND; it cannot
 * detect one with the right row count and the wrong schema.
 *
 * A count ABOVE the expectation passes. That direction is benign — the tenant
 * gets more schema than required — and blocking it would turn a forgotten
 * constant bump into an outage.
 */
export async function assertRefDbFresh(
  conn: mysql.Connection,
  refDb: string,
  expected: number,
  opts: { allowStale?: boolean } = {}
): Promise<{ count: number; stale: boolean }> {
  const [tables] = await conn.query<any[]>(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'migrations' AND TABLE_TYPE = 'BASE TABLE'`,
    [refDb]
  );
  if (!tables.length) {
    // Distinct from "behind": the remedy is to repair the reference database,
    // not to refresh it. A reference without this table cannot be shown current.
    throw new Error(
      `Reference database '${refDb}' has no migrations table, so its schema version cannot be ` +
      `established. Provisioning from it is what shipped tenants missing POS schema. ` +
      `Repair it with \`npm run seed-ref-db\` against the POS master.`
    );
  }

  const [[row]]: any = await conn.query(`SELECT COUNT(*) AS n FROM \`${refDb}\`.migrations`);
  const count = Number(row.n);
  const stale = count < expected;

  if (stale && !opts.allowStale) {
    throw new Error(
      `Reference database '${refDb}' is at migration ${count} but this server expects ${expected} ` +
      `(${expected - count} behind). A tenant cloned from it now would be missing schema the POS ` +
      `requires. Refresh it with \`npm run seed-ref-db\` against the POS master, then update ` +
      `EXPECTED_MIGRATION_COUNT in src/seed-tables.ts. ` +
      `Override with --allow-stale-ref (CLI) or ALLOW_STALE_REF=true (server).`
    );
  }

  return { count, stale };
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
set -a && . ./.env && set +a && export LICENSE_DB_SSL=true
npx tsx tests/check-ref-freshness.ts
npx tsc --noEmit
```

Expected: `✅ PASS`, and typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/seed-tables.ts src/seed-ref-db.ts tests/check-ref-freshness.ts
git commit -m "feat(provisioning): check the reference database's migration count

assertRefDbFresh refuses a reference database behind the count this server
expects, and distinguishes one with no migrations table at all — the remedy
differs. A count above the expectation passes: that direction is benign, and
blocking it would turn a forgotten constant bump into an outage.

Counting migrations rows is the only signal available here; the deployed
container can reach neither the POS master nor the migration files.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire the guard into provisioning

**Files:**
- Modify: `src/provision-cloud.ts` — import at line 13-16 block; guard call after the `refDb` assignment (currently line 88); `main()` at the end
- Test: `tests/check-provision-guard.ts` (create)

**Interfaces:**
- Consumes: `assertRefDbFresh` and `EXPECTED_MIGRATION_COUNT` from Task 1.
- Produces: `provisionCloudDatabase(productKey, opts)` gains `opts.allowStaleRef?: boolean`. The `ProvisionResult` interface is unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/check-provision-guard.ts`:

```typescript
// tests/check-provision-guard.ts
//
// The guard must run BEFORE anything is created, so a refusal leaves no
// database, no user and no cloud_configs row behind. A half-provisioned tenant
// is worse than none: re-running provisioning is the documented repair path and
// it assumes an empty database.
import mysql from 'mysql2/promise';
import { provisionCloudDatabase, deriveTenantNames } from '../src/provision-cloud';

const REF = 'verdix_guardtest_ref';

async function main() {
  let failed = false;
  const fail = (m: string) => { console.error('FAIL: ' + m); failed = true; };

  const conn = await mysql.createConnection({
    host: process.env.LICENSE_DB_HOST || '127.0.0.1',
    port: Number(process.env.LICENSE_DB_PORT || 3306),
    user: process.env.LICENSE_DB_USER || 'root',
    password: process.env.LICENSE_DB_PASSWORD,
    ssl: process.env.LICENSE_DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    multipleStatements: true,
  });

  // A reference database that is deliberately behind: 1 migration row.
  await conn.query(`DROP DATABASE IF EXISTS \`${REF}\``);
  await conn.query(`CREATE DATABASE \`${REF}\``);
  await conn.query(`CREATE TABLE \`${REF}\`.migrations (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE,
    timestamp VARCHAR(50) NOT NULL, executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await conn.query(`INSERT INTO \`${REF}\`.migrations (name, timestamp) VALUES ('001_m','x')`);

  // Point provisioning at that reference and at this same MySQL as admin.
  process.env.CLOUD_PROVISION_REF_DB = REF;
  process.env.CLOUD_PROVISION_HOST = process.env.LICENSE_DB_HOST || '127.0.0.1';
  process.env.CLOUD_PROVISION_PORT = String(process.env.LICENSE_DB_PORT || 3306);
  process.env.CLOUD_PROVISION_USER = process.env.LICENSE_DB_USER || 'root';
  process.env.CLOUD_PROVISION_PASSWORD = process.env.LICENSE_DB_PASSWORD;

  // A product key that does NOT exist. The guard must fire before the licence
  // lookup, so the error names the stale reference, not the missing licence.
  // This is what proves ordering without needing a real licence row.
  try {
    await provisionCloudDatabase('VRDX-GUARD-TEST-0000');
    fail('provisioning from a reference 140 migrations behind should have thrown');
  } catch (e: any) {
    const m = e.message || '';
    if (!/is at migration 1 but this server expects/.test(m)) {
      fail(`expected the staleness error, got: ${m}`);
    }
  }

  // Nothing may have been created. Derive the name the way provisioning would
  // and assert no database matching the tenant pattern appeared for this run.
  const [dbs] = await conn.query<any[]>(
    `SELECT SCHEMA_NAME s FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME LIKE 'verdix\\_c\\_%'`
  );
  const before = new Set(dbs.map((r) => r.s));
  // deriveTenantNames is exported and pure; a licence id we never provisioned
  // must not have a database.
  const { dbName } = deriveTenantNames('guard-test-never-provisioned');
  if (before.has(dbName)) fail(`${dbName} should not exist after a refused provision`);

  await conn.query(`DROP DATABASE IF EXISTS \`${REF}\``);
  await conn.end();
  console.log(failed ? '❌ FAILED' : '✅ PASS');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
set -a && . ./.env && set +a && export LICENSE_DB_SSL=true
npx tsx tests/check-provision-guard.ts
```

Expected: FAIL with `expected the staleness error, got: No license found for product key VRDX-GUARD-TEST-0000` — the guard does not exist yet, so the licence lookup runs first.

- [ ] **Step 3: Add the import**

In `src/provision-cloud.ts`, change:

```typescript
import { copySeedRows } from './seed-ref-db';
import { createTenantAdmin, TenantAdmin } from './tenant-admin';
import { DEFAULT_REF_DB } from './seed-tables';
```

to:

```typescript
import { copySeedRows, assertRefDbFresh } from './seed-ref-db';
import { createTenantAdmin, TenantAdmin } from './tenant-admin';
import { DEFAULT_REF_DB, EXPECTED_MIGRATION_COUNT } from './seed-tables';
```

- [ ] **Step 4: Widen the options type**

In `src/provision-cloud.ts`, change the signature:

```typescript
export async function provisionCloudDatabase(
  productKey: string,
  opts: { rotatePassword?: boolean } = {}
): Promise<ProvisionResult> {
```

to:

```typescript
export async function provisionCloudDatabase(
  productKey: string,
  opts: { rotatePassword?: boolean; allowStaleRef?: boolean } = {}
): Promise<ProvisionResult> {
```

- [ ] **Step 5: Call the guard before anything is created**

In `src/provision-cloud.ts`, find:

```typescript
  const refDb = process.env.CLOUD_PROVISION_REF_DB || DEFAULT_REF_DB; // reference schema source (curated by seed-ref-db.ts)
  let seeded: Record<string, number> = {};
  let tenantAdmin: TenantAdmin = { username: '', password: '' };

  const license = await getLicenseByProductKey(productKey);
```

and replace with:

```typescript
  const refDb = process.env.CLOUD_PROVISION_REF_DB || DEFAULT_REF_DB; // reference schema source (curated by seed-ref-db.ts)
  let seeded: Record<string, number> = {};
  let tenantAdmin: TenantAdmin = { username: '', password: '' };

  // Refuse a stale reference database BEFORE creating anything. Cloning one
  // produces a tenant missing schema the POS requires, and says nothing about
  // it. Checking here — ahead of the licence lookup, the CREATE DATABASE and
  // the user grant — means a refusal leaves no database, no user and no
  // cloud_configs row to clean up.
  const allowStale = !!opts.allowStaleRef || process.env.ALLOW_STALE_REF === 'true';
  const freshness = await (async () => {
    const c = await mysql.createConnection({ ...admin, ssl: { rejectUnauthorized: false } });
    try {
      return await assertRefDbFresh(c, refDb, EXPECTED_MIGRATION_COUNT, { allowStale });
    } finally {
      await c.end();
    }
  })();
  if (freshness.stale) {
    console.warn(
      `⚠️  Provisioning from a STALE reference database: '${refDb}' is at migration ` +
      `${freshness.count}, expected ${EXPECTED_MIGRATION_COUNT}. Override was in effect, so ` +
      `this tenant may be missing schema the POS requires.`
    );
  }

  const license = await getLicenseByProductKey(productKey);
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
set -a && . ./.env && set +a && export LICENSE_DB_SSL=true
npx tsx tests/check-provision-guard.ts
npx tsc --noEmit
```

Expected: `✅ PASS`, typecheck clean.

- [ ] **Step 7: Expose the override on the CLI**

In `src/provision-cloud.ts`, in `main()`, change:

```typescript
  const res = await provisionCloudDatabase(productKey, { rotatePassword: flag('rotate-password') });
```

to:

```typescript
  const res = await provisionCloudDatabase(productKey, {
    rotatePassword: flag('rotate-password'),
    allowStaleRef: flag('allow-stale-ref'),
  });
```

And update the usage line in the same function:

```typescript
  if (!productKey) throw new Error('Usage: cloud:provision -- --license VRDX-XXXX-XXXX-XXXX [--rotate-password] [--allow-stale-ref]');
```

Also update the file's header comment, changing:

```
 * Idempotent: re-running reuses the DB/user; --rotate-password resets the pw.
```

to:

```
 * Idempotent: re-running reuses the DB/user; --rotate-password resets the pw.
 * Refuses a reference DB behind EXPECTED_MIGRATION_COUNT; --allow-stale-ref
 * overrides (ALLOW_STALE_REF=true for the server).
```

- [ ] **Step 8: Verify the whole suite and typecheck**

```bash
set -a && . ./.env && set +a && export LICENSE_DB_SSL=true
npx tsc --noEmit
for t in check-ref-freshness check-provision-guard check-ref-column-drift \
         check-ref-db-seed check-provision-seeding check-seed-tables check-tenant-admin; do
  printf "%-28s " "$t"; npx tsx "tests/$t.ts" 2>&1 | tail -1
done
```

Expected: all seven `✅ PASS`. (`check-cloud-provision-fn` is excluded — it fails on `main` already; see Global Constraints.)

- [ ] **Step 9: Commit**

```bash
git add src/provision-cloud.ts tests/check-provision-guard.ts
git commit -m "feat(provisioning): refuse to clone a stale reference database

The guard runs before the licence lookup and before CREATE DATABASE, so a
refusal leaves no database, no user and no cloud_configs row behind — a
half-provisioned tenant is worse than none, since re-running provisioning is
the documented repair and it assumes an empty database.

--allow-stale-ref, or ALLOW_STALE_REF=true for the server, downgrades the
refusal to a warning that names the gap, so the guard cannot become a blocker
in an emergency.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Keep the constant honest, and document the contract

**Files:**
- Modify: `src/seed-ref-db.ts` — end of `main()`, after the final success line
- Modify: `docs/cloud-tenancy.md` — the `verdix_ref` row of the databases table, and a new subsection

**Interfaces:**
- Consumes: `EXPECTED_MIGRATION_COUNT` from Task 1.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Import the constant**

In `src/seed-ref-db.ts`, change:

```typescript
import { SEED_TABLES, DEFAULT_REF_DB } from './seed-tables';
```

to:

```typescript
import { SEED_TABLES, DEFAULT_REF_DB, EXPECTED_MIGRATION_COUNT } from './seed-tables';
```

- [ ] **Step 2: Print the count against the constant**

In `src/seed-ref-db.ts`, in `main()`, find:

```typescript
    console.log(`\n✅ Reference database '${refDb}' repaired and populated.`);
```

and replace with:

```typescript
    // The script that invalidates EXPECTED_MIGRATION_COUNT is the one that
    // should remind you to bump it, so the refresh and the declaration stay
    // together. Provisioning refuses a reference below the constant, so a
    // missed bump here surfaces as a blocked provision later.
    const [[refMig]]: any = await ref.query(`SELECT COUNT(*) AS n FROM \`${refDb}\`.migrations`);
    const refCount = Number(refMig.n);
    console.log(`\n✅ Reference database '${refDb}' repaired and populated.`);
    console.log(`   migrations: ${refCount}   EXPECTED_MIGRATION_COUNT: ${EXPECTED_MIGRATION_COUNT}`);
    if (refCount !== EXPECTED_MIGRATION_COUNT) {
      console.log(
        `\n⚠️  These disagree. Provisioning refuses a reference database below the constant.\n` +
        `   Set EXPECTED_MIGRATION_COUNT = ${refCount} in src/seed-tables.ts and commit it with this refresh.`
      );
    }
```

- [ ] **Step 3: Verify it runs and typechecks**

```bash
npx tsc --noEmit
```

Expected: clean.

Running `npm run seed-ref-db` itself needs `SEED_MASTER_*` pointing at the POS master and writes to the reference database, so it is not part of the automated check. When run by an operator, the new last lines appear as:

```
✅ Reference database 'verdix_ref' repaired and populated.
   migrations: 141   EXPECTED_MIGRATION_COUNT: 141
```

- [ ] **Step 4: Document the contract**

In `docs/cloud-tenancy.md`, change the `verdix_ref` row of the databases table:

```
| `verdix_ref` | **The reference database.** Curated schema + seed rows that every new tenant is cloned from. `CLOUD_PROVISION_REF_DB` points here; `DEFAULT_REF_DB` in `src/seed-tables.ts` is the fallback. |
```

to:

```
| `verdix_ref` | **The reference database.** Curated schema + seed rows that every new tenant is cloned from. `CLOUD_PROVISION_REF_DB` points here; `DEFAULT_REF_DB` in `src/seed-tables.ts` is the fallback. Must be at `EXPECTED_MIGRATION_COUNT` or provisioning refuses to clone it — see "Keeping the reference database current" below. |
```

Then add this subsection immediately after the databases table:

```markdown
### Keeping the reference database current

`verdix_ref` is a hand-maintained copy of a schema that evolves on its own, in the POS repo. When a
POS migration adds a column, nothing updates `verdix_ref` until an operator runs `seed-ref-db`.

That gap was invisible until 2026-10-12, when a customer could not sell: `verdix_ref` was 23
migrations behind, every tenant cloned from it was missing the columns migration 120 added, and the
first signal was `ER_BAD_FIELD_ERROR` in that customer's own POS logs. Two things now stand in the
way of a repeat:

- `seed-ref-db` compares **columns**, not just table names. Comparing names alone is what let the
  gap grow silently: a migration that adds a column to an existing table leaves the table list
  identical, so the old repair reported "0 table(s) added" and exited successfully.
- `EXPECTED_MIGRATION_COUNT` in `src/seed-tables.ts` declares the migration count a tenant needs,
  and `provisionCloudDatabase()` **refuses to clone a reference database below it** — before
  creating any database, so a refusal leaves nothing behind.

**The sequence when the POS gains migrations:**

1. `npm run seed-ref-db` with `SEED_MASTER_*` pointing at the POS master.
2. Read the count it prints at the end.
3. Set `EXPECTED_MIGRATION_COUNT` to that number and commit it with the refresh.
4. Deploy.

Skip step 3 and provisioning blocks with a message naming both numbers. That is the intended
direction: it refuses to provision rather than shipping a tenant that cannot run the POS.

`--allow-stale-ref` (CLI) or `ALLOW_STALE_REF=true` (server) overrides the refusal when the gap is
known to be harmless. The run then warns and records what it did.

**What the guard does not cover.** It counts `migrations` rows, which is the only freshness signal
available to the deployed server — that container can reach neither the POS master nor the POS
migration files. A reference database with the right row count and the wrong schema still passes.
Detecting that needs the master, and the real fix is to stop maintaining a second copy of the
schema at all: see the open question in
`docs/superpowers/specs/2026-10-12-reference-db-freshness-guard-design.md`.
```

- [ ] **Step 5: Commit**

```bash
git add src/seed-ref-db.ts docs/cloud-tenancy.md
git commit -m "docs(provisioning): tie the refresh to the constant it invalidates

seed-ref-db now prints the reference database's migration count next to
EXPECTED_MIGRATION_COUNT and names the edit when they differ, so the script
that invalidates the constant is the one that reminds you to bump it.

cloud-tenancy.md documents the contract, the refresh-then-bump sequence, and
what the guard does not cover: it counts migrations rows, so a reference with
the right count and the wrong schema still passes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification

After all three tasks:

```bash
set -a && . ./.env && set +a && export LICENSE_DB_SSL=true
npx tsc --noEmit
for t in check-ref-freshness check-provision-guard check-ref-column-drift \
         check-ref-db-seed check-provision-seeding check-seed-tables check-tenant-admin; do
  printf "%-28s " "$t"; npx tsx "tests/$t.ts" 2>&1 | tail -1
done
```

Expected: typecheck clean, seven `✅ PASS`.

Then confirm the guard fires against the real reference database. With the live
`CLOUD_PROVISION_*` exported and `EXPECTED_MIGRATION_COUNT` at 141, `verdix_ref` currently holds
141 rows, so provisioning must proceed normally. Temporarily raising the constant to 200 and
attempting a provision must produce the staleness error and create nothing — revert the constant
afterwards.

## Out of scope

- `tests/check-cloud-provision-fn.ts`, which fails on `main` already.
- The `catch` in `getLicenseByProductKey` (`src/service.ts`) that reports a connection failure as
  "No license found". It cost real debugging time this session and is worth fixing, separately.
- Making the POS migration files the single source of truth. Needs a per-database migrate command
  in the `Verdix_POS` repo; see the spec's Scope section.
