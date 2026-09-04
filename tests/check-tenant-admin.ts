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

  await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await conn.query(`CREATE DATABASE \`${DB}\``);
  // Column shapes copied from the live master.
  await conn.query(`CREATE TABLE \`${DB}\`.users (
    uid VARCHAR(255) NOT NULL PRIMARY KEY, username VARCHAR(100) NOT NULL,
    display_name VARCHAR(255), photo_url VARCHAR(500), disabled TINYINT(1) DEFAULT 0,
    creation_time TIMESTAMP NULL, created_at TIMESTAMP NULL, updated_at TIMESTAMP NULL,
    password VARCHAR(255) NOT NULL, user_type VARCHAR(50))`);
  await conn.query(`CREATE TABLE \`${DB}\`.user_permissions (
    id VARCHAR(50) NOT NULL PRIMARY KEY, user_uid VARCHAR(255) NOT NULL,
    permission VARCHAR(100) NOT NULL, created_at TIMESTAMP NULL, updated_at TIMESTAMP NULL,
    UNIQUE KEY uq_user_perm (user_uid, permission))`);

  let failed = false;
  const fail = (m: string) => { console.error('FAIL: ' + m); failed = true; };

  const admin = await createTenantAdmin(conn, DB);

  if (!admin.username) fail('no username returned');
  if (!admin.password || admin.password.length < 12) fail(`weak/missing password: "${admin.password}"`);

  const [rows]: any = await conn.query(
    `SELECT uid, username, password, user_type, disabled FROM \`${DB}\`.users WHERE username = ?`,
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
    `SELECT permission FROM \`${DB}\`.user_permissions WHERE user_uid = ?`, [rows[0]?.uid]
  );
  if (perms.length !== 13) fail(`expected 13 permissions, got ${perms.length}`);
  const names = perms.map((p: any) => p.permission);
  for (const required of ['access_pos', 'manage_users', 'view_dashboard', 'manage_settings']) {
    if (!names.includes(required)) fail(`missing permission "${required}"`);
  }

  // Idempotent: a second call must not throw or duplicate.
  await createTenantAdmin(conn, DB);
  const [after]: any = await conn.query(`SELECT COUNT(*) n FROM \`${DB}\`.users`);
  if (after[0].n !== 1) fail(`re-run created a second admin: ${after[0].n} users`);

  await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await conn.end();
  console.log(failed ? '❌ FAILED' : '✅ PASS');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
