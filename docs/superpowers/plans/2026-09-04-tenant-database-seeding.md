# Tenant Database Seeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a database created by **Create Cloud Customer** immediately usable — seeded with operational lookup data and one working admin login.

**Architecture:** A one-time script repairs and populates `verdix_ref` (the reference database provisioning clones from). Provisioning then copies nine lookup tables server-side with `INSERT IGNORE ... SELECT` and creates a bcrypt-hashed admin user. Credentials return in the API response and render in the dashboard.

**Tech Stack:** TypeScript, `tsx` (no build step), `mysql2/promise`, `bcryptjs`. No test framework — tests are standalone `tsx` scripts under `tests/`, matching the existing `check-*.ts` convention.

**Spec:** `docs/superpowers/specs/2026-09-04-tenant-database-seeding-design.md`

## Global Constraints

- **Repo:** `d:/VERDIX_POS/verdix-license-server`. No changes in the POS repo.
- **Never run against the live licence DB.** The repo `.env` points `LICENSE_DB_*` at production (`metro.proxy.rlwy.net`). Use `./staging.sh` for every test.
- **The nine seed tables, in this exact order** (parents before children, matching FK dependencies): `migrations`, `user_types`, `user_type_permissions`, `payment_methods`, `units_of_measure`, `tax_rates`, `payment_term_types`, `accounts`, `sales_areas`.
- **Live master (read-only source for Part 1):** host `reseau.proxy.rlwy.net`, port `25746`, user `root`, database `verdix`. Password comes from the `MYSQL_PUBLIC_URL` variable on the `MySQL` service in the `Vendix_Pos` Railway project — never hardcode it in a committed file; read it from an env var.
- **Provisioning admin connection:** `CLOUD_PROVISION_HOST/PORT/USER/PASSWORD`, already set. Reference DB name comes from `CLOUD_PROVISION_REF_DB` (currently `verdix_ref`).
- **All MySQL connections to Railway proxies need** `ssl: { rejectUnauthorized: false }`, matching the existing code in `provision-cloud.ts`.
- **Admin permission set** (13, copied verbatim from the live master's `mock-admin-01`): `access_pos`, `manage_approval_settings`, `manage_customers`, `manage_inventory`, `manage_products`, `manage_purchases`, `manage_settings`, `manage_suppliers`, `manage_users`, `view_approvals`, `view_dashboard`, `view_reports`, `view_sales`.
- **Admin role name:** `Super Admin` — the `users.user_type` column stores the role *name*, not its id (verified: `mock-admin-01` has `user_type = 'Super Admin'`).

---

### Task 1: Shared seed-table constant

**Files:**
- Create: `src/seed-tables.ts`
- Test: `tests/check-seed-tables.ts`

**Interfaces:**
- Produces: `export const SEED_TABLES: readonly string[]` — the nine table names in FK-safe order. Consumed by Tasks 2 and 3.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/check-seed-tables.ts
import { SEED_TABLES } from '../src/seed-tables';

const expected = [
  'migrations', 'user_types', 'user_type_permissions', 'payment_methods',
  'units_of_measure', 'tax_rates', 'payment_term_types', 'accounts', 'sales_areas',
];

let failed = false;
if (SEED_TABLES.length !== 9) {
  console.error(`FAIL: expected 9 tables, got ${SEED_TABLES.length}`);
  failed = true;
}
for (let i = 0; i < expected.length; i++) {
  if (SEED_TABLES[i] !== expected[i]) {
    console.error(`FAIL: position ${i} expected "${expected[i]}", got "${SEED_TABLES[i]}"`);
    failed = true;
  }
}
// user_types must precede user_type_permissions (FK dependency).
if (SEED_TABLES.indexOf('user_types') > SEED_TABLES.indexOf('user_type_permissions')) {
  console.error('FAIL: user_types must come before user_type_permissions');
  failed = true;
}
console.log(failed ? '❌ FAILED' : '✅ PASS');
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/check-seed-tables.ts`
Expected: FAIL — `Cannot find module '../src/seed-tables'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/seed-tables.ts
/**
 * Lookup tables copied into every newly provisioned tenant database.
 *
 * Order matters: rows are inserted in this sequence, so a parent table must
 * precede any table holding a foreign key onto it (user_types before
 * user_type_permissions). `migrations` is first and is not lookup data — it
 * marks the tenant schema as fully migrated, so `npm run migrate` in the POS
 * does not try to replay all 118 migrations against a schema that already has
 * them.
 *
 * Deliberately excludes products, suppliers, customers and every transactional
 * table: a new tenant starts empty of business records.
 */
export const SEED_TABLES: readonly string[] = [
  'migrations',
  'user_types',
  'user_type_permissions',
  'payment_methods',
  'units_of_measure',
  'tax_rates',
  'payment_term_types',
  'accounts',
  'sales_areas',
] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx tests/check-seed-tables.ts`
Expected: `✅ PASS`

- [ ] **Step 5: Commit**

```bash
git add src/seed-tables.ts tests/check-seed-tables.ts
git commit -m "feat(provisioning): define the tenant seed table set

Nine tables copied into every new tenant, ordered so parents precede
children. migrations is included so a tenant is not mistaken for
unmigrated and made to replay 118 migrations over an existing schema.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: One-time `verdix_ref` repair and populate

**Files:**
- Create: `src/seed-ref-db.ts`
- Modify: `package.json` (add script entry)
- Test: `tests/check-ref-db-seed.ts`

**Interfaces:**
- Consumes: `SEED_TABLES` from Task 1.
- Produces: `export async function repairRefSchema(conn, refDb, masterDb): Promise<string[]>` — clones tables the master has that the reference lacks; returns the names it created. `export async function copySeedRows(conn, fromDb, toDb): Promise<Record<string, number>>` — copies `SEED_TABLES` rows; returns table→rows-inserted. Task 3 reuses `copySeedRows`.

`repairRefSchema` and `copySeedRows` both take an already-open `mysql.Connection` so the caller owns connection lifetime and the functions stay testable against staging.

**Two different copy mechanisms, deliberately.** `copySeedRows` is a same-server
`INSERT ... SELECT` — both databases must live on one MySQL instance. That holds for
provisioning (Task 3), where the reference and tenant databases are neighbours. It does **not**
hold for this script's `main()`, where the live POS master (`reseau.proxy.rlwy.net`) and the
reference database (`metro.proxy.rlwy.net`) are on separate servers. `main()` therefore reads rows
out of the master and writes them into the reference database over two connections, which is why
it does not call `copySeedRows`. `copySeedRows` is exported here because Task 3 needs it and this
is where it belongs; the tests exercise both paths.

- [ ] **Step 1: Write the failing test**

This test runs against two throwaway local databases, so it never touches production.

```typescript
// tests/check-ref-db-seed.ts
import mysql from 'mysql2/promise';
import { repairRefSchema, copySeedRows } from '../src/seed-ref-db';

const SRC = 'verdix_seedtest_src';
const DST = 'verdix_seedtest_dst';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.LICENSE_DB_HOST || '127.0.0.1',
    port: Number(process.env.LICENSE_DB_PORT || 3306),
    user: process.env.LICENSE_DB_USER || 'root',
    password: process.env.LICENSE_DB_PASSWORD,
    multipleStatements: true,
  });

  // Fresh fixtures.
  for (const db of [SRC, DST]) {
    await conn.query(`DROP DATABASE IF EXISTS \\`${db}\\``);
    await conn.query(`CREATE DATABASE \\`${db}\\``);
  }
  // Source has two of the seed tables plus one the destination lacks entirely.
  await conn.query(`CREATE TABLE \\`${SRC}\\`.user_types (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100) NOT NULL)`);
  await conn.query(`CREATE TABLE \\`${SRC}\\`.payment_methods (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100))`);
  await conn.query(`CREATE TABLE \\`${SRC}\\`.license_state (id INT PRIMARY KEY, signed_license TEXT)`);
  await conn.query(`INSERT INTO \\`${SRC}\\`.user_types VALUES ('r1','Super Admin'),('r2','Cashier')`);
  await conn.query(`INSERT INTO \\`${SRC}\\`.payment_methods VALUES ('p1','Cash')`);
  // Destination starts with only user_types, no rows.
  await conn.query(`CREATE TABLE \\`${DST}\\`.user_types (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100) NOT NULL)`);

  let failed = false;
  const fail = (m: string) => { console.error('FAIL: ' + m); failed = true; };

  // repairRefSchema clones the tables the destination is missing.
  const created = await repairRefSchema(conn, DST, SRC);
  if (!created.includes('license_state')) fail(`expected license_state to be created, got [${created}]`);
  if (!created.includes('payment_methods')) fail(`expected payment_methods to be created, got [${created}]`);
  if (created.includes('user_types')) fail('user_types already existed; must not be recreated');

  // copySeedRows copies rows for the seed tables that exist.
  const counts = await copySeedRows(conn, SRC, DST);
  if (counts.user_types !== 2) fail(`expected 2 user_types rows, got ${counts.user_types}`);
  if (counts.payment_methods !== 1) fail(`expected 1 payment_methods row, got ${counts.payment_methods}`);

  const [rows]: any = await conn.query(`SELECT COUNT(*) n FROM \\`${DST}\\`.user_types`);
  if (rows[0].n !== 2) fail(`destination user_types should hold 2 rows, has ${rows[0].n}`);

  // Idempotent: a second run inserts nothing new and does not throw.
  await copySeedRows(conn, SRC, DST);
  const [again]: any = await conn.query(`SELECT COUNT(*) n FROM \\`${DST}\\`.user_types`);
  if (again[0].n !== 2) fail(`re-run duplicated rows: now ${again[0].n}`);

  for (const db of [SRC, DST]) await conn.query(`DROP DATABASE IF EXISTS \\`${db}\\``);
  await conn.end();
  console.log(failed ? '❌ FAILED' : '✅ PASS');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./staging.sh psql -e "SELECT 1"` first to confirm local MySQL is reachable, then:
`npx tsx tests/check-ref-db-seed.ts`
Expected: FAIL — `Cannot find module '../src/seed-ref-db'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/seed-ref-db.ts
/**
 * One-time repair and populate for the provisioning reference database.
 * ----------------------------------------------------------------------------
 * `provisionCloudDatabase` clones `CLOUD_PROVISION_REF_DB` into each new tenant,
 * so whatever that database holds is what every customer starts with. As of
 * 2026-09-04 it held 83 tables and zero rows, was missing `license_state`, and
 * had an empty `migrations` table against the live master's 118 — which is why
 * a provisioned customer could not log in.
 *
 * This script is run by an operator, not by the server. After it runs, the
 * reference database is the source of truth: provisioning never reads customer
 * data. Changing a default later means editing the reference database.
 *
 *   npm run seed-ref-db
 *
 * Both `repairRefSchema` and `copySeedRows` take an open connection with
 * `multipleStatements` enabled and require both databases to live on the same
 * MySQL instance — the same constraint that makes `CREATE TABLE ... LIKE`
 * viable in provisioning, so nothing crosses the network.
 */
import mysql from 'mysql2/promise';
import { SEED_TABLES } from './seed-tables';

/**
 * Clone any base table `masterDb` has that `refDb` lacks, SAME-SERVER, via
 * `CREATE TABLE ... LIKE`. Returns the names created. Foreign keys are not
 * copied: `CREATE TABLE ... LIKE` omits them, and provisioning recreates them
 * per-tenant from the reference database's own definitions.
 *
 * `main()` below does not use this — the live master and the reference database
 * sit on different servers there, so it ships DDL across with SHOW CREATE TABLE
 * instead. This export exists for same-server callers and for the tests.
 */
export async function repairRefSchema(
  conn: mysql.Connection,
  refDb: string,
  masterDb: string
): Promise<string[]> {
  const [masterTables] = await conn.query<any[]>(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`, [masterDb]
  );
  const [refTables] = await conn.query<any[]>(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`, [refDb]
  );
  const have = new Set(refTables.map((r) => r.TABLE_NAME));
  const created: string[] = [];

  await conn.query('SET FOREIGN_KEY_CHECKS=0');
  try {
    for (const t of masterTables) {
      const name = t.TABLE_NAME;
      if (have.has(name)) continue;
      await conn.query(
        `CREATE TABLE IF NOT EXISTS \`${refDb}\`.\`${name}\` LIKE \`${masterDb}\`.\`${name}\``
      );
      created.push(name);
    }
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS=1');
  }
  return created;
}

/**
 * Copy SEED_TABLES rows from `fromDb` into `toDb`, server-side. Returns
 * table -> rows inserted. `INSERT IGNORE` makes re-runs a no-op rather than a
 * duplicate-key failure. A seed table absent from either database is skipped
 * rather than treated as an error, so this stays usable against a partially
 * repaired reference database.
 */
export async function copySeedRows(
  conn: mysql.Connection,
  fromDb: string,
  toDb: string
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  await conn.query('SET FOREIGN_KEY_CHECKS=0');
  try {
    for (const table of SEED_TABLES) {
      const [exists] = await conn.query<any[]>(
        `SELECT TABLE_SCHEMA FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA IN (?, ?) AND TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'`,
        [fromDb, toDb, table]
      );
      if (exists.length < 2) continue; // missing on one side — skip

      const [res]: any = await conn.query(
        `INSERT IGNORE INTO \`${toDb}\`.\`${table}\` SELECT * FROM \`${fromDb}\`.\`${table}\``
      );
      counts[table] = res.affectedRows ?? 0;
    }
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS=1');
  }
  return counts;
}

async function main() {
  const refDb = process.env.CLOUD_PROVISION_REF_DB || 'verdix_ref';
  const masterHost = process.env.SEED_MASTER_HOST;
  const masterDb = process.env.SEED_MASTER_DB || 'verdix';

  if (!masterHost) {
    console.error(
      '\n❌ Set SEED_MASTER_HOST/PORT/USER/PASSWORD to the live POS master database.\n' +
      '   These are read once to populate the reference database and are not stored.\n'
    );
    process.exit(1);
  }

  // The master and the reference database are on DIFFERENT servers, so rows are
  // read out of the master and written into the reference database. This is the
  // one place data crosses the network; provisioning itself never does.
  const master = await mysql.createConnection({
    host: masterHost,
    port: Number(process.env.SEED_MASTER_PORT || 3306),
    user: process.env.SEED_MASTER_USER || 'root',
    password: process.env.SEED_MASTER_PASSWORD,
    database: masterDb,
  });
  const ref = await mysql.createConnection({
    host: process.env.CLOUD_PROVISION_HOST,
    port: Number(process.env.CLOUD_PROVISION_PORT || 3306),
    user: process.env.CLOUD_PROVISION_USER,
    password: process.env.CLOUD_PROVISION_PASSWORD,
    ssl: { rejectUnauthorized: false },
    multipleStatements: true,
  });

  try {
    // 1. Schema repair: mirror the master's table list into the reference DB.
    const [masterTables] = await master.query<any[]>(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`, [masterDb]
    );
    const [refTables] = await ref.query<any[]>(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`, [refDb]
    );
    const have = new Set(refTables.map((r) => r.TABLE_NAME));
    const missing = masterTables.map((r) => r.TABLE_NAME).filter((n) => !have.has(n));

    for (const name of missing) {
      const [[ddl]]: any = await master.query(`SHOW CREATE TABLE \`${masterDb}\`.\`${name}\``);
      const createSql = (ddl['Create Table'] as string).replace(
        /^CREATE TABLE `/, `CREATE TABLE \`${refDb}\`.\``
      );
      await ref.query('SET FOREIGN_KEY_CHECKS=0');
      await ref.query(createSql);
      await ref.query('SET FOREIGN_KEY_CHECKS=1');
    }
    console.log(`Schema: ${missing.length} table(s) added to '${refDb}'${missing.length ? ': ' + missing.join(', ') : ''}`);

    // 2. Row copy: read each seed table out of the master, write into the ref DB.
    await ref.query('SET FOREIGN_KEY_CHECKS=0');
    for (const table of SEED_TABLES) {
      const [rows] = await master.query<any[]>(`SELECT * FROM \`${masterDb}\`.\`${table}\``);
      if (!rows.length) { console.log(`  ${table}: 0 rows in master, skipped`); continue; }
      const cols = Object.keys(rows[0]).map((c) => `\`${c}\``).join(', ');
      const values = rows.map((r) => Object.values(r));
      await ref.query(
        `INSERT IGNORE INTO \`${refDb}\`.\`${table}\` (${cols}) VALUES ?`, [values]
      );
      console.log(`  ${table}: ${rows.length} rows`);
    }
    await ref.query('SET FOREIGN_KEY_CHECKS=1');

    console.log(`\n✅ Reference database '${refDb}' repaired and populated.`);
  } finally {
    await master.end();
    await ref.end();
  }
}

// Only run main() when invoked directly, so the exported helpers stay importable.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Add the script entry**

In `package.json`, inside `"scripts"`, after the `"provision-cloud"` line:

```json
    "seed-ref-db": "tsx src/seed-ref-db.ts",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx tests/check-ref-db-seed.ts`
Expected: `✅ PASS`

- [ ] **Step 6: Verify typecheck is clean**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/seed-ref-db.ts tests/check-ref-db-seed.ts package.json
git commit -m "feat(provisioning): script to repair and populate verdix_ref

The reference database provisioning clones from held 83 tables and zero
rows, lacked license_state, and had an empty migrations table against
the master's 118. Every tenant inherited that, which is why a
provisioned customer could not log in.

Reads the live master once for the nine seed tables; after this runs the
reference database is the source of truth and provisioning never reads
customer data.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Seed lookups during provisioning

**Files:**
- Modify: `src/provision-cloud.ts` — inside `provisionCloudDatabase`, after the FK recreation block and before `upsertCloudConfig`
- Test: `tests/check-provision-seeding.ts`

**Interfaces:**
- Consumes: `copySeedRows` from Task 2, `SEED_TABLES` from Task 1.
- Produces: `ProvisionResult` gains `seeded: Record<string, number>` — table→rows inserted. Task 4 reads it.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/check-provision-seeding.ts
import mysql from 'mysql2/promise';
import { copySeedRows } from '../src/seed-ref-db';
import { SEED_TABLES } from '../src/seed-tables';

const REF = 'verdix_provtest_ref';
const TENANT = 'verdix_provtest_tenant';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.LICENSE_DB_HOST || '127.0.0.1',
    port: Number(process.env.LICENSE_DB_PORT || 3306),
    user: process.env.LICENSE_DB_USER || 'root',
    password: process.env.LICENSE_DB_PASSWORD,
    multipleStatements: true,
  });

  for (const db of [REF, TENANT]) {
    await conn.query(`DROP DATABASE IF EXISTS \\`${db}\\``);
    await conn.query(`CREATE DATABASE \\`${db}\\``);
  }
  // Reference holds seeded lookups; tenant is a schema-only clone of it.
  await conn.query(`CREATE TABLE \\`${REF}\\`.user_types (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100))`);
  await conn.query(`CREATE TABLE \\`${REF}\\`.payment_methods (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100))`);
  await conn.query(`INSERT INTO \\`${REF}\\`.user_types VALUES ('r1','Super Admin'),('r2','Cashier')`);
  await conn.query(`INSERT INTO \\`${REF}\\`.payment_methods VALUES ('p1','Cash'),('p2','GCash')`);
  await conn.query(`CREATE TABLE \\`${TENANT}\\`.user_types LIKE \\`${REF}\\`.user_types`);
  await conn.query(`CREATE TABLE \\`${TENANT}\\`.payment_methods LIKE \\`${REF}\\`.payment_methods`);

  let failed = false;
  const fail = (m: string) => { console.error('FAIL: ' + m); failed = true; };

  const seeded = await copySeedRows(conn, REF, TENANT);
  if (seeded.user_types !== 2) fail(`user_types: expected 2, got ${seeded.user_types}`);
  if (seeded.payment_methods !== 2) fail(`payment_methods: expected 2, got ${seeded.payment_methods}`);

  const [ut]: any = await conn.query(`SELECT COUNT(*) n FROM \\`${TENANT}\\`.user_types`);
  if (ut[0].n !== 2) fail(`tenant user_types should hold 2, has ${ut[0].n}`);

  // Re-provisioning must not duplicate.
  await copySeedRows(conn, REF, TENANT);
  const [ut2]: any = await conn.query(`SELECT COUNT(*) n FROM \\`${TENANT}\\`.user_types`);
  if (ut2[0].n !== 2) fail(`re-run duplicated: now ${ut2[0].n}`);

  // A seed table present in neither database must be skipped, not throw.
  if ('tax_rates' in seeded) fail('tax_rates absent from both DBs should have been skipped');

  for (const db of [REF, TENANT]) await conn.query(`DROP DATABASE IF EXISTS \\`${db}\\``);
  await conn.end();
  console.log(failed ? '❌ FAILED' : '✅ PASS');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/check-provision-seeding.ts`
Expected: FAIL — `tax_rates absent from both DBs should have been skipped`, or a duplicate-key error, depending on whether Task 2 landed. If Task 2 is complete this test may already pass; that is fine — it is the regression guard for Step 3's wiring.

- [ ] **Step 3: Wire seeding into provisioning**

In `src/provision-cloud.ts`, add to the imports at the top:

```typescript
import { copySeedRows } from './seed-ref-db';
```

Extend the `ProvisionResult` interface with:

```typescript
  /** Lookup table -> rows inserted during seeding. */
  seeded: Record<string, number>;
```

Immediately after the `console.log(`  ${tables.length} tables, ${fks.length} foreign keys`);` line and before the `} finally {` that closes the clone block, add:

```typescript
    // Seed operational lookup data. Without this the tenant has a complete
    // schema and no rows: no roles, no permissions, no payment methods — and
    // POST /api/auth/login in the POS reads users, joins user_types, then
    // selects user_permissions, so nobody can log in.
    //
    // Same-server INSERT ... SELECT, so no rows cross the network, matching the
    // CREATE TABLE ... LIKE decision above.
    seeded = await copySeedRows(copy, refDb, dbName);
    const seededTotal = Object.values(seeded).reduce((a, b) => a + b, 0);
    console.log(`  seeded ${seededTotal} rows across ${Object.keys(seeded).length} lookup tables`);
```

Declare `seeded` alongside the other locals, before the `const copy = await mysql.createConnection(...)` line:

```typescript
  let seeded: Record<string, number> = {};
```

Then add `seeded` to the returned object at the end of the function:

```typescript
  return { dbName, dbUser, password, host: admin.host, port: admin.port, seeded };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx tests/check-provision-seeding.ts`
Expected: `✅ PASS`

- [ ] **Step 5: Verify typecheck is clean**

Run: `npm run typecheck`
Expected: no errors. If `ProvisionResult` is constructed anywhere else, add `seeded` there too.

- [ ] **Step 6: Commit**

```bash
git add src/provision-cloud.ts tests/check-provision-seeding.ts
git commit -m "feat(provisioning): seed lookup tables into new tenants

CREATE TABLE ... LIKE copies structure but no rows, so a provisioned
tenant had a complete schema and nothing in it. The POS login route
reads users, joins user_types and selects user_permissions, so an empty
tenant cannot be logged into at all.

Copies the nine seed tables server-side with INSERT IGNORE, keeping
re-provisioning idempotent the way the FK step already is.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Create the tenant admin user

**Files:**
- Create: `src/tenant-admin.ts`
- Modify: `src/provision-cloud.ts` (call it after seeding; extend `ProvisionResult`)
- Test: `tests/check-tenant-admin.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks beyond an open connection.
- Produces: `export interface TenantAdmin { username: string; password: string }` and `export async function createTenantAdmin(conn, dbName, opts?): Promise<TenantAdmin>`. `ProvisionResult` gains `admin: TenantAdmin`. Task 5 renders it.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/check-tenant-admin.ts
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { createTenantAdmin } from '../src/tenant-admin';

const DB = 'verdix_admintest';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.LICENSE_DB_HOST || '127.0.0.1',
    port: Number(process.env.LICENSE_DB_PORT || 3306),
    user: process.env.LICENSE_DB_USER || 'root',
    password: process.env.LICENSE_DB_PASSWORD,
    multipleStatements: true,
  });

  await conn.query(`DROP DATABASE IF EXISTS \\`${DB}\\``);
  await conn.query(`CREATE DATABASE \\`${DB}\\``);
  // Column shapes copied from the live master.
  await conn.query(`CREATE TABLE \\`${DB}\\`.users (
    uid VARCHAR(255) NOT NULL PRIMARY KEY, username VARCHAR(100) NOT NULL,
    display_name VARCHAR(255), photo_url VARCHAR(500), disabled TINYINT(1) DEFAULT 0,
    creation_time TIMESTAMP NULL, created_at TIMESTAMP NULL, updated_at TIMESTAMP NULL,
    password VARCHAR(255) NOT NULL, user_type VARCHAR(50))`);
  await conn.query(`CREATE TABLE \\`${DB}\\`.user_permissions (
    id VARCHAR(50) NOT NULL PRIMARY KEY, user_uid VARCHAR(255) NOT NULL,
    permission VARCHAR(100) NOT NULL, created_at TIMESTAMP NULL, updated_at TIMESTAMP NULL,
    UNIQUE KEY uq_user_perm (user_uid, permission))`);

  let failed = false;
  const fail = (m: string) => { console.error('FAIL: ' + m); failed = true; };

  const admin = await createTenantAdmin(conn, DB);

  if (!admin.username) fail('no username returned');
  if (!admin.password || admin.password.length < 12) fail(`weak/missing password: "${admin.password}"`);

  const [rows]: any = await conn.query(
    `SELECT uid, username, password, user_type, disabled FROM \\`${DB}\\`.users WHERE username = ?`,
    [admin.username]
  );
  if (rows.length !== 1) fail(`expected 1 user row, got ${rows.length}`);
  else {
    if (rows[0].user_type !== 'Super Admin') fail(`user_type should be "Super Admin", got "${rows[0].user_type}"`);
    if (rows[0].disabled !== 0) fail('user must not be disabled');
    // The stored value must be a hash, not the plaintext.
    if (rows[0].password === admin.password) fail('password stored in plaintext');
    // Mirrors what app/api/auth/login/route.ts does.
    const ok = await bcrypt.compare(admin.password, rows[0].password);
    if (!ok) fail('bcrypt.compare failed — the admin could not log in');
  }

  const [perms]: any = await conn.query(
    `SELECT permission FROM \\`${DB}\\`.user_permissions WHERE user_uid = ?`, [rows[0]?.uid]
  );
  if (perms.length !== 13) fail(`expected 13 permissions, got ${perms.length}`);
  const names = perms.map((p: any) => p.permission);
  for (const required of ['access_pos', 'manage_users', 'view_dashboard', 'manage_settings']) {
    if (!names.includes(required)) fail(`missing permission "${required}"`);
  }

  // Idempotent: a second call must not throw or duplicate.
  await createTenantAdmin(conn, DB);
  const [after]: any = await conn.query(`SELECT COUNT(*) n FROM \\`${DB}\\`.users`);
  if (after[0].n !== 1) fail(`re-run created a second admin: ${after[0].n} users`);

  await conn.query(`DROP DATABASE IF EXISTS \\`${DB}\\``);
  await conn.end();
  console.log(failed ? '❌ FAILED' : '✅ PASS');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/check-tenant-admin.ts`
Expected: FAIL — `Cannot find module '../src/tenant-admin'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tenant-admin.ts
/**
 * Creates the first administrator inside a freshly provisioned tenant database.
 * ----------------------------------------------------------------------------
 * Seeding lookup tables is not enough to make a tenant usable: the POS's
 * POST /api/auth/login reads `users`, joins `user_types`, and then selects from
 * `user_permissions`. Without a row in all three, a customer has a working
 * licence and a database they cannot enter.
 *
 * The generated password is returned in plaintext to the caller ONCE, for
 * display to the operator. Only the bcrypt hash is stored.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';

export interface TenantAdmin {
  username: string;
  /** Plaintext, for one-time display. Never persisted. */
  password: string;
}

/**
 * Permissions granted to the tenant administrator. Copied verbatim from the
 * live master's own admin account so a new tenant's admin can reach everything
 * an existing one can.
 */
const ADMIN_PERMISSIONS = [
  'access_pos',
  'manage_approval_settings',
  'manage_customers',
  'manage_inventory',
  'manage_products',
  'manage_purchases',
  'manage_settings',
  'manage_suppliers',
  'manage_users',
  'view_approvals',
  'view_dashboard',
  'view_reports',
  'view_sales',
] as const;

/**
 * `users.user_type` stores the role NAME, not its id — verified against the
 * live master, whose admin account carries user_type = 'Super Admin'.
 */
const ADMIN_ROLE_NAME = 'Super Admin';

/** Password charset excludes look-alikes; an operator retypes this by hand. */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(20);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Insert one administrator into `dbName`. Idempotent: if the username already
 * exists the existing row is left untouched and its username is returned with
 * an empty password, signalling to the caller that no new credential was
 * minted (re-provisioning must not silently rotate a working login).
 */
export async function createTenantAdmin(
  conn: mysql.Connection,
  dbName: string,
  opts: { username?: string } = {}
): Promise<TenantAdmin> {
  const username = opts.username || 'admin';

  const [existing] = await conn.query<any[]>(
    `SELECT uid FROM \`${dbName}\`.users WHERE username = ?`, [username]
  );
  if (existing.length) {
    return { username, password: '' };
  }

  const password = generatePassword();
  const hash = await bcrypt.hash(password, 10);
  const uid = crypto.randomUUID();

  await conn.query(
    `INSERT INTO \`${dbName}\`.users
       (uid, username, display_name, disabled, password, user_type, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, NOW(), NOW())`,
    [uid, username, 'Administrator', hash, ADMIN_ROLE_NAME]
  );

  const rows = ADMIN_PERMISSIONS.map((p) => [crypto.randomUUID(), uid, p]);
  await conn.query(
    `INSERT IGNORE INTO \`${dbName}\`.user_permissions (id, user_uid, permission) VALUES ?`,
    [rows]
  );

  return { username, password };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx tests/check-tenant-admin.ts`
Expected: `✅ PASS`

- [ ] **Step 5: Wire it into provisioning**

In `src/provision-cloud.ts`, add to the imports:

```typescript
import { createTenantAdmin, TenantAdmin } from './tenant-admin';
```

Extend `ProvisionResult`:

```typescript
  /** The tenant's first administrator. `password` is empty if one already existed. */
  admin: TenantAdmin;
```

After the seeding lines added in Task 3 (still inside the same `try` block, so `copy` is open):

```typescript
    // The admin lands after seeding because user_type references a role name
    // that seeding puts in place.
    admin = await createTenantAdmin(copy, dbName);
    console.log(admin.password
      ? `  admin user '${admin.username}' created`
      : `  admin user '${admin.username}' already existed, left unchanged`);
```

Declare it alongside `seeded`:

```typescript
  let admin: TenantAdmin = { username: '', password: '' };
```

And add to the return:

```typescript
  return { dbName, dbUser, password, host: admin.host, port: admin.port, seeded, admin };
```

**Careful:** the function already has a local named `admin` for the MySQL connection settings (`const admin = { host, port, user, password }`). Name the new one `tenantAdmin` instead, and return `admin: tenantAdmin`, to avoid shadowing:

```typescript
  let tenantAdmin: TenantAdmin = { username: '', password: '' };
  // ...
  tenantAdmin = await createTenantAdmin(copy, dbName);
  // ...
  return { dbName, dbUser, password, host: admin.host, port: admin.port, seeded, admin: tenantAdmin };
```

- [ ] **Step 6: Verify typecheck is clean**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/tenant-admin.ts tests/check-tenant-admin.ts src/provision-cloud.ts
git commit -m "feat(provisioning): create an admin user in each new tenant

Seeded lookups still leave a tenant unenterable: the POS login route
needs a row in users, a matching user_types role, and user_permissions
rows. This mints one admin with a generated password, stores only the
bcrypt hash, and returns the plaintext once for display.

Idempotent — re-provisioning leaves an existing admin untouched rather
than rotating a working login.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Surface credentials in the API response and dashboard

**Files:**
- Modify: `src/server.ts:588-600` (the `data.env` block inside `POST /api/cloud-customers`)
- Modify: `public/dashboard.html` (cloud-customer result area)
- Modify: `public/app.js:737` (the `submitCloudCustomer` result handler)

**Interfaces:**
- Consumes: `ProvisionResult.admin` and `.seeded` from Tasks 3 and 4.
- Produces: response gains `data.admin = { username, password }` and `data.seeded`.

- [ ] **Step 1: Extend the API response**

In `src/server.ts`, inside the `if (prov && data.token.ok) {` block, after the existing `data.env = {...}` assignment, add:

```typescript
          // Shown once. The plaintext password is never stored, and is empty
          // when provisioning found an admin already present.
          data.admin = prov.admin;
          data.seeded = prov.seeded;
```

- [ ] **Step 2: Verify the endpoint returns it**

Run the server against staging and post a provisioning request:

```bash
./staging.sh server
```

In another terminal, log in and call the endpoint (or use the dashboard). Confirm the JSON response contains an `admin` object with `username` and `password`, and a `seeded` object with table counts.

Expected: `"admin":{"username":"admin","password":"<20 chars>"}` present.

- [ ] **Step 3: Render it in the dashboard**

In `public/dashboard.html`, inside the cloud-customer modal's result area (the element `submitCloudCustomer` writes into), add a container after the existing env block:

```html
        <div id="cc-admin-block" style="display:none">
          <h4>Administrator login</h4>
          <p class="muted">Shown once — copy it now. Only the hash is stored.</p>
          <pre id="cc-admin"></pre>
        </div>
```

- [ ] **Step 4: Populate it**

In `public/app.js`, in the handler that runs after the `/api/cloud-customers` response arrives (around line 737), after the code that fills the env block, add:

```javascript
    var adminBlock = document.getElementById('cc-admin-block');
    if (res && res.data && res.data.admin && res.data.admin.password) {
      document.getElementById('cc-admin').textContent =
        'Username: ' + res.data.admin.username + '\nPassword: ' + res.data.admin.password;
      adminBlock.style.display = '';
    } else if (adminBlock) {
      adminBlock.style.display = 'none';
    }
```

- [ ] **Step 5: Verify end-to-end against staging**

With `./staging.sh server` running, create a cloud customer through the dashboard. Confirm:
- the env block renders as before
- the administrator block appears with a username and a 20-character password
- the seeded counts are present in the response

- [ ] **Step 6: Commit**

```bash
git add src/server.ts public/dashboard.html public/app.js
git commit -m "feat(dashboard): show the tenant admin login after provisioning

The generated password exists only in this response — it is bcrypt-hashed
before storage — so the dashboard has to surface it once, next to the env
block the operator is already copying.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Populate the live reference database and backfill BHAGOHCLOUD

This task runs the code from Tasks 1-5 against production. It writes to the live
reference database and one live tenant. **Nothing here is committed** — it is an
operational runbook, executed once, after Tasks 1-5 are merged.

**Files:** none modified.

- [ ] **Step 1: Confirm the reference database's current state**

```bash
cd d:/VERDIX_POS/verdix-license-server
npx tsx -e "
const mysql=require('mysql2/promise');
(async()=>{
 const c=await mysql.createConnection({host:process.env.CLOUD_PROVISION_HOST,port:+process.env.CLOUD_PROVISION_PORT,user:process.env.CLOUD_PROVISION_USER,password:process.env.CLOUD_PROVISION_PASSWORD,ssl:{rejectUnauthorized:false}});
 const [t]=await c.query(\"SELECT COUNT(*) n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='verdix_ref'\");
 const [m]=await c.query('SELECT COUNT(*) n FROM verdix_ref.migrations');
 console.log('tables:',t[0].n,'migrations rows:',m[0].n);
 await c.end();
})();"
```

Expected before: `tables: 83 migrations rows: 0`

- [ ] **Step 2: Populate the reference database**

`SEED_MASTER_PASSWORD` is the password inside the `MYSQL_PUBLIC_URL` variable on
the `MySQL` service in the `Vendix_Pos` Railway project. Read it with
`railway variables --service MySQL --kv | grep MYSQL_PUBLIC_URL` and pass it on
the command line rather than committing it.

```bash
SEED_MASTER_HOST=reseau.proxy.rlwy.net \
SEED_MASTER_PORT=25746 \
SEED_MASTER_USER=root \
SEED_MASTER_PASSWORD='<from MYSQL_PUBLIC_URL>' \
SEED_MASTER_DB=verdix \
npm run seed-ref-db
```

Expected: `license_state` added to the schema, then row counts — `migrations: 118`, `user_types: 10`, `user_type_permissions: 53`, `payment_methods: 6`, `units_of_measure: 18`, `tax_rates: 4`, `payment_term_types: 5`, `accounts: 6`, `sales_areas: 3`.

- [ ] **Step 3: Verify the reference database**

Re-run the Step 1 command.
Expected after: `tables: 84 migrations rows: 118`

- [ ] **Step 4: Backfill BHAGOHCLOUD DEMO**

Re-provisioning an existing database is the idempotent path: `CREATE TABLE IF NOT EXISTS`, duplicate-FK tolerance, and `INSERT IGNORE` mean nothing existing is disturbed.

```bash
npm run provision-cloud -- --product-key VRDX-M2BN-5326-6GBY
```

Expected: seeding and admin-creation lines in the output, ending with the generated admin credentials. **Record the password — it is shown once.**

- [ ] **Step 5: Verify the tenant is usable**

```bash
npx tsx -e "
const mysql=require('mysql2/promise');
(async()=>{
 const c=await mysql.createConnection({host:process.env.CLOUD_PROVISION_HOST,port:+process.env.CLOUD_PROVISION_PORT,user:process.env.CLOUD_PROVISION_USER,password:process.env.CLOUD_PROVISION_PASSWORD,ssl:{rejectUnauthorized:false}});
 const db='verdix_c_b028b2324f';
 for(const t of ['users','user_types','user_permissions','payment_methods','units_of_measure','tax_rates','migrations']){
  const [r]=await c.query('SELECT COUNT(*) n FROM \`'+db+'\`.\`'+t+'\`');
  console.log(t.padEnd(22), r[0].n);
 }
 await c.end();
})();"
```

Expected: `users: 1`, `user_types: 10`, `user_permissions: 13`, `payment_methods: 6`, `units_of_measure: 18`, `tax_rates: 4`, `migrations: 118`.

- [ ] **Step 6: Confirm the admin can actually log in**

Point a POS instance at the tenant database (or run a bcrypt comparison against the stored hash, as `tests/check-tenant-admin.ts` does) and sign in with the recorded credentials.

Expected: login succeeds and the dashboard renders.

- [ ] **Step 7: Leave OBUTA alone**

OBUTA's hosted POS runs on `DB_NAME=verdix` at `mysql-fal.railway.internal`, not on its provisioned tenant `verdix_c_d88a15f0b7`. Do not backfill or re-provision it — seeding a database it does not use achieves nothing, and re-provisioning is only safe because it is empty. Migrating OBUTA onto the tenant model is a separate data migration.

---

## Verification

After Tasks 1-5, all three test scripts pass against staging:

```bash
./staging.sh migrate            # ensure the staging DB exists
npx tsx tests/check-seed-tables.ts
npx tsx tests/check-ref-db-seed.ts
npx tsx tests/check-provision-seeding.ts
npx tsx tests/check-tenant-admin.ts
npm run typecheck
```

All must print `✅ PASS` (and typecheck must be silent) before Task 6 touches production.
