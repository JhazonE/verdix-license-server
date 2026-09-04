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
