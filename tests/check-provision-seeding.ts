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
    await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await conn.query(`CREATE DATABASE \`${db}\``);
  }
  // Reference holds seeded lookups; tenant is a schema-only clone of it.
  await conn.query(`CREATE TABLE \`${REF}\`.user_types (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100))`);
  await conn.query(`CREATE TABLE \`${REF}\`.payment_methods (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100))`);
  await conn.query(`INSERT INTO \`${REF}\`.user_types VALUES ('r1','Super Admin'),('r2','Cashier')`);
  await conn.query(`INSERT INTO \`${REF}\`.payment_methods VALUES ('p1','Cash'),('p2','GCash')`);
  await conn.query(`CREATE TABLE \`${TENANT}\`.user_types LIKE \`${REF}\`.user_types`);
  await conn.query(`CREATE TABLE \`${TENANT}\`.payment_methods LIKE \`${REF}\`.payment_methods`);

  let failed = false;
  const fail = (m: string) => { console.error('FAIL: ' + m); failed = true; };

  const seeded = await copySeedRows(conn, REF, TENANT);
  if (seeded.user_types !== 2) fail(`user_types: expected 2, got ${seeded.user_types}`);
  if (seeded.payment_methods !== 2) fail(`payment_methods: expected 2, got ${seeded.payment_methods}`);

  const [ut]: any = await conn.query(`SELECT COUNT(*) n FROM \`${TENANT}\`.user_types`);
  if (ut[0].n !== 2) fail(`tenant user_types should hold 2, has ${ut[0].n}`);

  // Re-provisioning must not duplicate.
  await copySeedRows(conn, REF, TENANT);
  const [ut2]: any = await conn.query(`SELECT COUNT(*) n FROM \`${TENANT}\`.user_types`);
  if (ut2[0].n !== 2) fail(`re-run duplicated: now ${ut2[0].n}`);

  // A seed table present in neither database must be skipped, not throw.
  if ('tax_rates' in seeded) fail('tax_rates absent from both DBs should have been skipped');

  for (const db of [REF, TENANT]) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await conn.end();
  console.log(failed ? '❌ FAILED' : '✅ PASS');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
