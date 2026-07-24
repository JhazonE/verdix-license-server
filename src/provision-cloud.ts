/**
 * Provisions a per-customer cloud database on Railway and records its config.
 *
 *   npm run cloud:provision -- --license VRDX-XXXX-XXXX-XXXX [--rotate-password]
 *
 * Uses admin MySQL creds (CLOUD_PROVISION_*) to create the DB + a scoped user,
 * loads the POS schema from a reference DB via mysqldump --no-data, encrypts and
 * stores the connection in cloud_configs, and adds the 'cloud-sync' feature.
 * Idempotent: re-running reuses the DB/user; --rotate-password resets the pw.
 */
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import mysql from 'mysql2/promise';
import { getLicenseByProductKey, getCloudConfig, upsertCloudConfig, addLicenseFeature } from './service';

export function deriveTenantNames(licenseId: string): { dbName: string; dbUser: string } {
  const short = crypto.createHash('sha256').update(licenseId).digest('hex').slice(0, 10);
  return { dbName: `verdix_c_${short}`, dbUser: `u_${short}` };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const productKey = (arg('license') || '').trim();
  if (!productKey) throw new Error('Usage: cloud:provision -- --license VRDX-XXXX-XXXX-XXXX');

  const admin = {
    host: process.env.CLOUD_PROVISION_HOST,
    port: Number(process.env.CLOUD_PROVISION_PORT || 3306),
    user: process.env.CLOUD_PROVISION_USER,
    password: process.env.CLOUD_PROVISION_PASSWORD,
  };
  if (!admin.host || !admin.user) throw new Error('Set CLOUD_PROVISION_HOST/PORT/USER/PASSWORD (Railway admin creds).');

  const refDb = process.env.CLOUD_PROVISION_REF_DB || 'verdix'; // reference schema source (local master)

  const license = await getLicenseByProductKey(productKey);
  if (!license) throw new Error(`No license found for product key ${productKey}`);

  const { dbName, dbUser } = deriveTenantNames(license.id);
  const existing = await getCloudConfig(license.id);
  const rotate = flag('rotate-password');
  const isNewPassword = !existing || rotate;
  const password = isNewPassword
    ? crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 24)
    : existing!.password;

  // Railway's proxy requires relaxed TLS verification here, matching lib/mysql.ts's cloud pool.
  const conn = await mysql.createConnection({ ...admin, ssl: { rejectUnauthorized: false } });
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await conn.query(`CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?`, [dbUser, password]);
    if (isNewPassword) {
      await conn.query(`ALTER USER ?@'%' IDENTIFIED BY ?`, [dbUser, password]);
    }
    await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO ?@'%'`, [dbUser]);
    await conn.query(`FLUSH PRIVILEGES`);
  } finally {
    await conn.end();
  }

  // Load schema from reference DB (structure only) into the new tenant DB.
  console.log(`Loading schema from '${refDb}' into '${dbName}' ...`);
  const dump = spawnSync('mysqldump', [
    '-h', admin.host, '-P', String(admin.port), '-u', admin.user,
    '--no-data', '--skip-add-locks', '--set-gtid-purged=OFF', refDb,
  ], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, MYSQL_PWD: admin.password } });
  if (dump.status !== 0) throw new Error('mysqldump failed: ' + (dump.error?.message || dump.stderr?.toString() || 'unknown'));

  const load = spawnSync('mysql', [
    '-h', admin.host, '-P', String(admin.port), '-u', admin.user,
    dbName,
  ], { input: dump.stdout, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, MYSQL_PWD: admin.password } });
  if (load.status !== 0) throw new Error('schema load failed: ' + (load.error?.message || load.stderr?.toString() || 'unknown'));

  await upsertCloudConfig(license.id, {
    host: admin.host, port: admin.port, name: dbName, user: dbUser, password,
  });
  await addLicenseFeature(license.id, 'cloud-sync');

  console.log(`\n✅ Provisioned cloud DB for ${productKey}`);
  console.log(`   database: ${dbName}`);
  console.log(`   user:     ${dbUser}`);
  console.log(`   feature 'cloud-sync' added to the license.`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('\n❌', e.message, '\n'); process.exit(1); });
}
