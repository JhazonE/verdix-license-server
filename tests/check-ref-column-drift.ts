// tests/check-ref-column-drift.ts
//
// The bug this pins down: seed-ref-db's schema repair compared only table
// NAMES, so a column added to an existing table never reached the reference
// database. It reported "0 table(s) added" and exited 0 while the reference
// stayed stale — which is how verdix_ref fell 19 migrations behind unnoticed,
// and why a provisioned tenant was missing sale_items.selling_unit_factor.
import mysql from 'mysql2/promise';
import { diffColumns, repairRefColumns } from '../src/seed-ref-db';

const MASTER = 'verdix_drifttest_master';
const REF = 'verdix_drifttest_ref';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.LICENSE_DB_HOST || '127.0.0.1',
    port: Number(process.env.LICENSE_DB_PORT || 3306),
    user: process.env.LICENSE_DB_USER || 'root',
    password: process.env.LICENSE_DB_PASSWORD,
    multipleStatements: true,
  });

  for (const db of [MASTER, REF]) {
    await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await conn.query(`CREATE DATABASE \`${db}\``);
  }

  // The real shape of the problem: both databases have `sale_items`, but the
  // master has since gained the three selling-unit columns from migration 120.
  await conn.query(`CREATE TABLE \`${MASTER}\`.sale_items (
    id VARCHAR(50) PRIMARY KEY, quantity DECIMAL(12,4),
    selling_unit_id VARCHAR(100) NULL, selling_unit_name VARCHAR(100) NULL,
    selling_unit_factor DECIMAL(12,4) NULL)`);
  await conn.query(`CREATE TABLE \`${REF}\`.sale_items (
    id VARCHAR(50) PRIMARY KEY, quantity DECIMAL(12,4))`);
  // A table that matches exactly must be left alone.
  await conn.query(`CREATE TABLE \`${MASTER}\`.payment_methods (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100))`);
  await conn.query(`CREATE TABLE \`${REF}\`.payment_methods (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100))`);

  let failed = false;
  const fail = (m: string) => { console.error('FAIL: ' + m); failed = true; };

  // --- diffColumns must SEE the drift (the old code could not) ---
  const drift = await diffColumns(conn, REF, MASTER);
  const si = drift.find((d) => d.table === 'sale_items');
  if (!si) fail('diffColumns missed sale_items drift entirely');
  else {
    const names = si.missing.map((c) => c.name).sort();
    const want = ['selling_unit_factor', 'selling_unit_id', 'selling_unit_name'];
    if (JSON.stringify(names) !== JSON.stringify(want))
      fail(`expected ${want.join(',')}; got ${names.join(',')}`);
  }
  if (drift.some((d) => d.table === 'payment_methods'))
    fail('payment_methods matches exactly and must not be reported as drifted');

  // --- repairRefColumns must APPLY it ---
  const applied = await repairRefColumns(conn, REF, MASTER);
  if (applied.length !== 3) fail(`expected 3 columns applied, got ${applied.length}`);

  const [cols]: any = await conn.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA=? AND TABLE_NAME='sale_items'`, [REF]);
  const have = new Set(cols.map((c: any) => c.COLUMN_NAME));
  for (const c of ['selling_unit_id', 'selling_unit_name', 'selling_unit_factor'])
    if (!have.has(c)) fail(`ref.sale_items still lacks ${c} after repair`);

  // --- the repair must be idempotent ---
  const second = await repairRefColumns(conn, REF, MASTER);
  if (second.length !== 0) fail(`re-run should apply nothing, applied ${second.length}`);
  const after = await diffColumns(conn, REF, MASTER);
  if (after.length !== 0) fail(`drift should be gone, still reports ${after.length} table(s)`);

  for (const db of [MASTER, REF]) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await conn.end();
  console.log(failed ? '❌ FAILED' : '✅ PASS');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
