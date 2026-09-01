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

export interface ProvisionResult {
  dbName: string;
  dbUser: string;
  password: string;
  host: string;
  port: number;
}

/**
 * Provisions a per-customer cloud database and records its encrypted config.
 * Shared by the CLI (`npm run provision-cloud`) and POST /api/cloud-customers.
 * Idempotent: re-running reuses the existing database and user.
 */
export async function provisionCloudDatabase(
  productKey: string,
  opts: { rotatePassword?: boolean } = {}
): Promise<ProvisionResult> {
  // Validate the admin connection settings up front. An unresolved Railway
  // variable reference (e.g. CLOUD_PROVISION_PORT left as the literal text
  // "${{MySQL.MYSQLPORT}}" because the service is not named MySQL) otherwise
  // reaches mysqldump as NaN and surfaces as the opaque
  // "Unknown suffix 'N' used for variable 'port'".
  const rawHost = (process.env.CLOUD_PROVISION_HOST || '').trim();
  const rawPort = (process.env.CLOUD_PROVISION_PORT || '').trim();
  const rawUser = (process.env.CLOUD_PROVISION_USER || '').trim();

  const unresolved = (v: string) => v.includes('${{') || v.includes('}}');
  for (const [name, value] of [
    ['CLOUD_PROVISION_HOST', rawHost],
    ['CLOUD_PROVISION_PORT', rawPort],
    ['CLOUD_PROVISION_USER', rawUser],
  ] as const) {
    if (unresolved(value)) {
      throw new Error(
        `${name} still contains an unresolved Railway reference (${value}). ` +
        `Check the referenced service name matches exactly, or set a literal value.`
      );
    }
  }

  const port = rawPort ? Number(rawPort) : 3306;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`CLOUD_PROVISION_PORT is not a valid port number (got "${rawPort}").`);
  }

  const admin = {
    host: rawHost,
    port,
    user: rawUser,
    password: process.env.CLOUD_PROVISION_PASSWORD,
  };
  if (!admin.host || !admin.user) throw new Error('Set CLOUD_PROVISION_HOST/PORT/USER/PASSWORD (Railway admin creds).');

  const refDb = process.env.CLOUD_PROVISION_REF_DB || 'verdix'; // reference schema source (local master)

  const license = await getLicenseByProductKey(productKey);
  if (!license) throw new Error(`No license found for product key ${productKey}`);

  const { dbName, dbUser } = deriveTenantNames(license.id);
  const existing = await getCloudConfig(license.id);
  const rotate = !!opts.rotatePassword;
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
  //
  // Both calls are bounded by a timeout. Without one, a slow link to the database
  // makes the HTTP request hang with no explanation — cloning ~83 tables over
  // Railway's PUBLIC proxy took over ten minutes in testing, while the internal
  // network is quick. If these time out, check that CLOUD_PROVISION_HOST uses
  // Railway's internal reference (${{MySQL.MYSQLHOST}}) rather than the public
  // *.proxy.rlwy.net hostname.
  //
  // NOTE: `--set-gtid-purged=OFF` is deliberately absent. It only suppresses GTID
  // statements, which a `--no-data` clone does not emit, and it is rejected
  // outright by MariaDB clients — which is what most distro "mysql-client"
  // packages actually install.
  const STEP_TIMEOUT_MS = Number(process.env.CLOUD_PROVISION_TIMEOUT_MS || 240000);

  console.log(`Loading schema from '${refDb}' into '${dbName}' ...`);
  const dump = spawnSync('mysqldump', [
    '-h', admin.host, '-P', String(admin.port), '-u', admin.user,
    '--no-data', '--skip-add-locks', refDb,
  ], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: STEP_TIMEOUT_MS, env: { ...process.env, MYSQL_PWD: admin.password } });
  if (dump.signal === 'SIGTERM') {
    throw new Error(
      `mysqldump timed out after ${STEP_TIMEOUT_MS / 1000}s reading '${refDb}'. ` +
      `If CLOUD_PROVISION_HOST is a public *.proxy.rlwy.net address, switch it to the internal one.`
    );
  }
  if (dump.status !== 0) throw new Error('mysqldump failed: ' + (dump.error?.message || dump.stderr?.toString() || 'unknown'));

  const load = spawnSync('mysql', [
    '-h', admin.host, '-P', String(admin.port), '-u', admin.user,
    dbName,
  ], { input: dump.stdout, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: STEP_TIMEOUT_MS, env: { ...process.env, MYSQL_PWD: admin.password } });
  if (load.signal === 'SIGTERM') {
    throw new Error(
      `schema load timed out after ${STEP_TIMEOUT_MS / 1000}s writing '${dbName}'. ` +
      `If CLOUD_PROVISION_HOST is a public *.proxy.rlwy.net address, switch it to the internal one.`
    );
  }
  if (load.status !== 0) throw new Error('schema load failed: ' + (load.error?.message || load.stderr?.toString() || 'unknown'));

  await upsertCloudConfig(license.id, {
    host: admin.host, port: admin.port, name: dbName, user: dbUser, password,
  });
  await addLicenseFeature(license.id, 'cloud-sync');

  return { dbName, dbUser, password, host: admin.host, port: admin.port };
}

async function main() {
  const productKey = (arg('license') || '').trim();
  if (!productKey) throw new Error('Usage: cloud:provision -- --license VRDX-XXXX-XXXX-XXXX');
  const res = await provisionCloudDatabase(productKey, { rotatePassword: flag('rotate-password') });
  console.log(`\n✅ Provisioned cloud DB for ${productKey}`);
  console.log(`   database: ${res.dbName}`);
  console.log(`   user:     ${res.dbUser}`);
  console.log(`   feature 'cloud-sync' added to the license.`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('\n❌', e.message, '\n'); process.exit(1); });
}
