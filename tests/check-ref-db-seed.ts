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
    await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await conn.query(`CREATE DATABASE \`${db}\``);
  }
  // Source has two of the seed tables plus one the destination lacks entirely.
  await conn.query(`CREATE TABLE \`${SRC}\`.user_types (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100) NOT NULL)`);
  await conn.query(`CREATE TABLE \`${SRC}\`.payment_methods (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100))`);
  await conn.query(`CREATE TABLE \`${SRC}\`.license_state (id INT PRIMARY KEY, signed_license TEXT)`);
  await conn.query(`INSERT INTO \`${SRC}\`.user_types VALUES ('r1','Super Admin'),('r2','Cashier')`);
  await conn.query(`INSERT INTO \`${SRC}\`.payment_methods VALUES ('p1','Cash')`);
  // Destination starts with only user_types, no rows.
  await conn.query(`CREATE TABLE \`${DST}\`.user_types (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100) NOT NULL)`);

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

  const [rows]: any = await conn.query(`SELECT COUNT(*) n FROM \`${DST}\`.user_types`);
  if (rows[0].n !== 2) fail(`destination user_types should hold 2 rows, has ${rows[0].n}`);

  // Idempotent: a second run inserts nothing new and does not throw.
  await copySeedRows(conn, SRC, DST);
  const [again]: any = await conn.query(`SELECT COUNT(*) n FROM \`${DST}\`.user_types`);
  if (again[0].n !== 2) fail(`re-run duplicated rows: now ${again[0].n}`);

  for (const db of [SRC, DST]) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await conn.end();
  console.log(failed ? '❌ FAILED' : '✅ PASS');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
