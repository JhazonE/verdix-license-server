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
 * Both `repairRefSchema` and `copySeedRows` take an open connection and
 * require both databases to live on the same MySQL instance — the same
 * constraint that makes `CREATE TABLE ... LIKE` viable in provisioning, so
 * nothing crosses the network. Neither helper issues multiple statements in
 * a single call, so `multipleStatements` is not required for them.
 */
import mysql from 'mysql2/promise';
import { SEED_TABLES, DEFAULT_REF_DB } from './seed-tables';

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

/** One column the reference database is missing, with the DDL to add it. */
export interface MissingColumn {
  name: string;
  /** Column definition taken from the master, e.g. "DECIMAL(12,4) NULL". */
  definition: string;
  /** Column it sits after in the master, so ordering is preserved. */
  after: string | null;
}

/** Per-table column drift between the reference database and the master. */
export interface TableDrift {
  table: string;
  missing: MissingColumn[];
}

/**
 * Report columns the master has that `refDb` lacks, for tables BOTH databases
 * already have.
 *
 * This exists because comparing table NAMES is not enough. A migration that
 * adds a column to an existing table leaves the table list identical, so the
 * schema repair below found nothing to do and reported success while the
 * reference database stayed stale. That is how `verdix_ref` fell 19 migrations
 * behind without anyone noticing, and why a provisioned tenant was missing
 * `sale_items.selling_unit_factor` — provisioning clones the reference
 * database, so a gap here reaches every customer created afterwards.
 *
 * Only ADDITIVE drift is reported. A column present in the reference but not in
 * the master is left alone: dropping it could destroy tenant data, and the
 * reference database is allowed to run ahead of a master that is still one
 * customer's production database (see docs/cloud-tenancy.md).
 *
 * Both databases must live on the same server as seen by `conn`.
 */
export async function diffColumns(
  conn: mysql.Connection,
  refDb: string,
  masterDb: string
): Promise<TableDrift[]> {
  const columnsOf = async (db: string) => {
    const [rows] = await conn.query<any[]>(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION`, [db]
    );
    const byTable = new Map<string, any[]>();
    for (const r of rows) {
      if (!byTable.has(r.TABLE_NAME)) byTable.set(r.TABLE_NAME, []);
      byTable.get(r.TABLE_NAME)!.push(r);
    }
    return byTable;
  };

  const [masterCols, refCols] = await Promise.all([columnsOf(masterDb), columnsOf(refDb)]);
  const drift: TableDrift[] = [];

  for (const [table, mCols] of masterCols) {
    const rCols = refCols.get(table);
    if (!rCols) continue; // table absent from ref entirely — the table-level repair owns that
    const refHas = new Set(rCols.map((c) => c.COLUMN_NAME));

    const missing: MissingColumn[] = [];
    for (let i = 0; i < mCols.length; i++) {
      const c = mCols[i];
      if (refHas.has(c.COLUMN_NAME)) continue;

      // Nullability and default reproduce the master's definition. A NOT NULL
      // column with no default cannot be added to a table that already holds
      // rows, so it is relaxed to NULL rather than failing the repair.
      const parts = [c.COLUMN_TYPE];
      const autoInc = /auto_increment/i.test(c.EXTRA || '');
      if (c.IS_NULLABLE === 'NO' && c.COLUMN_DEFAULT === null && !autoInc) {
        parts.push('NULL');
      } else {
        parts.push(c.IS_NULLABLE === 'NO' ? 'NOT NULL' : 'NULL');
        if (c.COLUMN_DEFAULT !== null) {
          // CURRENT_TIMESTAMP and numeric literals are expressions, not strings.
          const d = String(c.COLUMN_DEFAULT);
          const bare = /^(CURRENT_TIMESTAMP(\(\d*\))?|NULL|\d+(\.\d+)?)$/i.test(d);
          parts.push(`DEFAULT ${bare ? d : conn.escape(d)}`);
        }
      }
      if (/on update/i.test(c.EXTRA || '')) parts.push(c.EXTRA);

      // Preserve position: the nearest earlier master column the ref also has.
      let after: string | null = null;
      for (let j = i - 1; j >= 0; j--) {
        if (refHas.has(mCols[j].COLUMN_NAME)) { after = mCols[j].COLUMN_NAME; break; }
      }

      missing.push({ name: c.COLUMN_NAME, definition: parts.join(' '), after });
    }

    if (missing.length) drift.push({ table, missing });
  }

  return drift;
}

/**
 * Apply the additive column drift `diffColumns` reports to `refDb`.
 * Returns "table.column" for each column added. Idempotent: a second run finds
 * no drift and applies nothing.
 */
export async function repairRefColumns(
  conn: mysql.Connection,
  refDb: string,
  masterDb: string
): Promise<string[]> {
  const drift = await diffColumns(conn, refDb, masterDb);
  const applied: string[] = [];

  for (const { table, missing } of drift) {
    // One ALTER per table: MySQL rewrites the table once, not once per column.
    const clauses = missing.map((c) =>
      `ADD COLUMN \`${c.name}\` ${c.definition}` + (c.after ? ` AFTER \`${c.after}\`` : '')
    );
    await conn.query(`ALTER TABLE \`${refDb}\`.\`${table}\` ${clauses.join(', ')}`);
    for (const c of missing) applied.push(`${table}.${c.name}`);
  }

  return applied;
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
  const refDb = process.env.CLOUD_PROVISION_REF_DB || DEFAULT_REF_DB;
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

    await ref.query('SET FOREIGN_KEY_CHECKS=0');
    try {
      for (const name of missing) {
        const [[ddl]]: any = await master.query(`SHOW CREATE TABLE \`${masterDb}\`.\`${name}\``);
        const original = ddl['Create Table'] as string;
        const prefix = /^CREATE TABLE `/;
        if (!prefix.test(original)) {
          throw new Error(`SHOW CREATE TABLE for '${name}' did not start with the expected "CREATE TABLE \`" prefix — refusing to rewrite it blindly`);
        }
        const createSql = original.replace(prefix, `CREATE TABLE \`${refDb}\`.\``);
        await ref.query(createSql);
      }
    } finally {
      await ref.query('SET FOREIGN_KEY_CHECKS=1');
    }
    console.log(`Schema: ${missing.length} table(s) added to '${refDb}'${missing.length ? ': ' + missing.join(', ') : ''}`);

    // 1b. Column repair on tables BOTH databases already have.
    //
    // Step 1 only adds MISSING TABLES. A migration that adds a column to an
    // existing table leaves the table list identical, so step 1 reports
    // "0 table(s) added" and the reference database silently stays stale —
    // which is exactly how it fell 19 migrations behind and shipped tenants
    // without `sale_items.selling_unit_factor`.
    //
    // `diffColumns` takes ONE connection, but here the master and the
    // reference database are on different servers, so the master's column
    // metadata is read separately and compared in this process. Only additive
    // drift is applied; a column the reference has and the master does not is
    // left alone (dropping it could destroy tenant data).
    const columnsOf = async (c: mysql.Connection, db: string) => {
      const [rows] = await c.query<any[]>(
        `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
           FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ?
          ORDER BY TABLE_NAME, ORDINAL_POSITION`, [db]
      );
      const byTable = new Map<string, any[]>();
      for (const r of rows) {
        if (!byTable.has(r.TABLE_NAME)) byTable.set(r.TABLE_NAME, []);
        byTable.get(r.TABLE_NAME)!.push(r);
      }
      return byTable;
    };

    const [mCols, rCols] = await Promise.all([
      columnsOf(master, masterDb),
      columnsOf(ref, refDb),
    ]);

    const addedColumns: string[] = [];
    await ref.query('SET FOREIGN_KEY_CHECKS=0');
    try {
      for (const [table, cols] of mCols) {
        const refCols = rCols.get(table);
        if (!refCols) continue; // newly created above, already matches the master
        const refHas = new Set(refCols.map((c) => c.COLUMN_NAME));
        const clauses: string[] = [];

        for (let i = 0; i < cols.length; i++) {
          const c = cols[i];
          if (refHas.has(c.COLUMN_NAME)) continue;

          const parts = [c.COLUMN_TYPE];
          const autoInc = /auto_increment/i.test(c.EXTRA || '');
          if (c.IS_NULLABLE === 'NO' && c.COLUMN_DEFAULT === null && !autoInc) {
            parts.push('NULL'); // cannot add NOT NULL without a default to a populated table
          } else {
            parts.push(c.IS_NULLABLE === 'NO' ? 'NOT NULL' : 'NULL');
            if (c.COLUMN_DEFAULT !== null) {
              const d = String(c.COLUMN_DEFAULT);
              const bare = /^(CURRENT_TIMESTAMP(\(\d*\))?|NULL|\d+(\.\d+)?)$/i.test(d);
              parts.push(`DEFAULT ${bare ? d : ref.escape(d)}`);
            }
          }
          if (/on update/i.test(c.EXTRA || '')) parts.push(c.EXTRA);

          let after: string | null = null;
          for (let j = i - 1; j >= 0; j--) {
            if (refHas.has(cols[j].COLUMN_NAME)) { after = cols[j].COLUMN_NAME; break; }
          }

          clauses.push(
            `ADD COLUMN \`${c.COLUMN_NAME}\` ${parts.join(' ')}` + (after ? ` AFTER \`${after}\`` : '')
          );
          addedColumns.push(`${table}.${c.COLUMN_NAME}`);
        }

        if (clauses.length) {
          await ref.query(`ALTER TABLE \`${refDb}\`.\`${table}\` ${clauses.join(', ')}`);
        }
      }
    } finally {
      await ref.query('SET FOREIGN_KEY_CHECKS=1');
    }
    console.log(`Columns: ${addedColumns.length} added to existing table(s)${addedColumns.length ? ': ' + addedColumns.join(', ') : ''}`);

    // 2. Row copy: read each seed table out of the master, write into the ref DB.
    await ref.query('SET FOREIGN_KEY_CHECKS=0');
    try {
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
    } finally {
      await ref.query('SET FOREIGN_KEY_CHECKS=1');
    }

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
