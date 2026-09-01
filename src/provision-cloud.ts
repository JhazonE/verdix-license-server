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

  // Clone the reference schema into the new tenant database — SERVER-SIDE.
  //
  // This deliberately does NOT shell out to `mysqldump | mysql`. That approach
  // streams the whole schema out to this process and back again, one round trip
  // per table; over Railway's proxy it took more than ten minutes for ~83 tables
  // and routinely timed out. `CREATE TABLE ... LIKE` runs entirely inside MySQL,
  // so nothing crosses the network: the same 83 tables clone in about five
  // seconds. It also removes the dependency on client binaries being present in
  // the container at all.
  //
  // Both databases live on the same server (that is what makes this possible),
  // which holds for this deployment: tenant databases are created on the same
  // MySQL instance as the reference database.
  console.log(`Cloning schema from '${refDb}' into '${dbName}' ...`);
  const copy = await mysql.createConnection({ ...admin, ssl: { rejectUnauthorized: false }, multipleStatements: true });
  try {
    // FK checks off while cloning: tables arrive in arbitrary order, so a child
    // table may be created before its parent.
    await copy.query('SET FOREIGN_KEY_CHECKS=0');

    const [tables] = await copy.query<any[]>(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`, [refDb]
    );
    if (!tables.length) {
      throw new Error(
        `Reference database '${refDb}' has no tables. Check CLOUD_PROVISION_REF_DB points at a database holding the POS schema.`
      );
    }
    for (const t of tables) {
      await copy.query(`CREATE TABLE IF NOT EXISTS \`${dbName}\`.\`${t.TABLE_NAME}\` LIKE \`${refDb}\`.\`${t.TABLE_NAME}\``);
    }

    // `CREATE TABLE ... LIKE` copies columns and indexes but NOT foreign keys,
    // so they are recreated from the reference database's own definitions.
    const [fks] = await copy.query<any[]>(
      `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.REFERENCED_TABLE_NAME,
              GROUP_CONCAT(CONCAT('\`', k.COLUMN_NAME, '\`') ORDER BY k.ORDINAL_POSITION) AS cols,
              GROUP_CONCAT(CONCAT('\`', k.REFERENCED_COLUMN_NAME, '\`') ORDER BY k.ORDINAL_POSITION) AS ref_cols,
              r.DELETE_RULE, r.UPDATE_RULE
         FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
         JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
          AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
        GROUP BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.REFERENCED_TABLE_NAME, r.DELETE_RULE, r.UPDATE_RULE`,
      [refDb]
    );
    for (const f of fks) {
      try {
        await copy.query(
          `ALTER TABLE \`${dbName}\`.\`${f.TABLE_NAME}\`
             ADD CONSTRAINT \`${f.CONSTRAINT_NAME}\` FOREIGN KEY (${f.cols})
             REFERENCES \`${dbName}\`.\`${f.REFERENCED_TABLE_NAME}\` (${f.ref_cols})
             ON DELETE ${f.DELETE_RULE} ON UPDATE ${f.UPDATE_RULE}`
        );
      } catch (e: any) {
        // Re-running provisioning finds the constraint already present; that is
        // the idempotent path, not a failure.
        if (!/Duplicate (foreign key|key name)|already exists/i.test(e.message || '')) throw e;
      }
    }

    await copy.query('SET FOREIGN_KEY_CHECKS=1');
    console.log(`  ${tables.length} tables, ${fks.length} foreign keys`);
  } finally {
    await copy.end();
  }

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
