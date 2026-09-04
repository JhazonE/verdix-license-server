/**
 * Creates the first administrator inside a freshly provisioned tenant database.
 * ----------------------------------------------------------------------------
 * Seeding lookup tables is not enough to make a tenant usable: the POS's
 * POST /api/auth/login reads `users`, joins `user_types`, and then selects from
 * `user_permissions`. Without a row in all three, a customer has a working
 * licence and a database they cannot enter.
 *
 * The generated password is returned in plaintext to the caller ONCE, for
 * display to the operator. Only the bcrypt hash is stored.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';

export interface TenantAdmin {
  username: string;
  /** Plaintext, for one-time display. Never persisted. */
  password: string;
}

/**
 * Permissions granted to the tenant administrator. Copied verbatim from the
 * live master's own admin account so a new tenant's admin can reach everything
 * an existing one can.
 */
const ADMIN_PERMISSIONS = [
  'access_pos',
  'manage_approval_settings',
  'manage_customers',
  'manage_inventory',
  'manage_products',
  'manage_purchases',
  'manage_settings',
  'manage_suppliers',
  'manage_users',
  'view_approvals',
  'view_dashboard',
  'view_reports',
  'view_sales',
] as const;

/**
 * `users.user_type` stores the role NAME, not its id — verified against the
 * live master, whose admin account carries user_type = 'Super Admin'.
 */
const ADMIN_ROLE_NAME = 'Super Admin';

/** Password charset excludes look-alikes; an operator retypes this by hand. */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(20);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Insert one administrator into `dbName`. Idempotent: if the username already
 * exists the existing row is left untouched and its username is returned with
 * an empty password, signalling to the caller that no new credential was
 * minted (re-provisioning must not silently rotate a working login).
 */
export async function createTenantAdmin(
  conn: mysql.Connection,
  dbName: string,
  opts: { username?: string } = {}
): Promise<TenantAdmin> {
  const username = opts.username || 'admin';

  const [existing] = await conn.query<any[]>(
    `SELECT uid FROM \`${dbName}\`.users WHERE username = ?`, [username]
  );
  if (existing.length) {
    return { username, password: '' };
  }

  const password = generatePassword();
  const hash = await bcrypt.hash(password, 10);
  const uid = crypto.randomUUID();

  await conn.query(
    `INSERT INTO \`${dbName}\`.users
       (uid, username, display_name, disabled, password, user_type, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, NOW(), NOW())`,
    [uid, username, 'Administrator', hash, ADMIN_ROLE_NAME]
  );

  const rows = ADMIN_PERMISSIONS.map((p) => [crypto.randomUUID(), uid, p]);
  await conn.query(
    `INSERT IGNORE INTO \`${dbName}\`.user_permissions (id, user_uid, permission) VALUES ?`,
    [rows]
  );

  return { username, password };
}
