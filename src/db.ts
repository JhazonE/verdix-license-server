/**
 * License Server database layer.
 * ----------------------------------------------------------------------------
 * Dedicated MySQL connection for the License Management System. Kept SEPARATE
 * from the POS database so license/customer data lives on its own.
 *
 * Connection resolution (env), with sensible fallbacks to the POS's existing
 * Railway cloud config so it works out of the box:
 *   LICENSE_DB_HOST / _PORT / _USER / _PASSWORD / _NAME
 *   → falls back to CLOUD_DB_*  (Railway)
 *   → falls back to DB_*        (local MySQL)
 *
 * Set LICENSE_DB_NAME to a dedicated database, e.g. "verdix_license".
 */
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const useSsl =
  (process.env.LICENSE_DB_SSL || (process.env.LICENSE_DB_HOST ? '' : process.env.CLOUD_DB_HOST ? 'true' : '')) === 'true';

let pool: mysql.Pool | null = null;

export function getPool(): mysql.Pool {
  if (pool) return pool;

  const host =
    process.env.LICENSE_DB_HOST || process.env.CLOUD_DB_HOST || process.env.DB_HOST || 'localhost';
  const port = parseInt(
    process.env.LICENSE_DB_PORT || process.env.CLOUD_DB_PORT || process.env.DB_PORT || '3306',
    10
  );
  const user =
    process.env.LICENSE_DB_USER || process.env.CLOUD_DB_USER || process.env.DB_USER || 'root';
  const password =
    process.env.LICENSE_DB_PASSWORD ??
    process.env.CLOUD_DB_PASSWORD ??
    process.env.DB_PASSWORD ??
    '';
  const database = process.env.LICENSE_DB_NAME || 'verdix_license';

  pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  return pool;
}

export async function query<T = any>(sql: string, params?: any[]): Promise<T> {
  const [rows] = await getPool().query(sql, params);
  return rows as T;
}

export async function withTransaction<T>(
  cb: (conn: mysql.PoolConnection) => Promise<T>
): Promise<T> {
  const conn = await getPool().getConnection();
  await conn.beginTransaction();
  try {
    const r = await cb(conn);
    await conn.commit();
    return r;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Ensures the target database exists, then creates it if missing. Must connect
 * without a database selected first. Safe to call repeatedly.
 */
export async function ensureDatabase(): Promise<void> {
  const dbName = process.env.LICENSE_DB_NAME || 'verdix_license';
  const host =
    process.env.LICENSE_DB_HOST || process.env.CLOUD_DB_HOST || process.env.DB_HOST || 'localhost';
  const port = parseInt(
    process.env.LICENSE_DB_PORT || process.env.CLOUD_DB_PORT || process.env.DB_PORT || '3306',
    10
  );
  const user =
    process.env.LICENSE_DB_USER || process.env.CLOUD_DB_USER || process.env.DB_USER || 'root';
  const password =
    process.env.LICENSE_DB_PASSWORD ??
    process.env.CLOUD_DB_PASSWORD ??
    process.env.DB_PASSWORD ??
    '';

  const admin = await mysql.createConnection({
    host,
    port,
    user,
    password,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await admin.end();
  }
}
