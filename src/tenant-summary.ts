/**
 * Read-only inspection of a provisioned tenant database.
 * ----------------------------------------------------------------------------
 * Backs the dashboard's cloud-details view: after onboarding, an operator needs
 * to see whether a customer's database actually got seeded and who its
 * administrator is.
 *
 * Deliberately never returns a password. `users.password` holds a bcrypt hash
 * and the plaintext is not stored anywhere, so no amount of reading can recover
 * it — the view says so rather than implying a lookup exists.
 *
 * Connects as the tenant's own scoped user, not with admin credentials: this is
 * a read of one customer's database, and using their user means the query
 * cannot reach past it.
 */
import mysql from 'mysql2/promise';
import { SEED_TABLES } from './seed-tables';

export interface TenantAdminSummary {
  username: string;
  displayName: string | null;
  userType: string | null;
  disabled: boolean;
  createdAt: Date | null;
  permissionCount: number;
}

export interface TenantSummary {
  /** Null when the tenant has no user rows at all — an unseeded database. */
  admin: TenantAdminSummary | null;
  /** Seed table -> row count present in the tenant. */
  seeded: Record<string, number>;
}

export interface TenantConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  name: string;
}

export async function readTenantSummary(cfg: TenantConnection): Promise<TenantSummary> {
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.name,
    ssl: { rejectUnauthorized: false },
    connectTimeout: 10000,
  });

  try {
    const seeded: Record<string, number> = {};
    for (const table of SEED_TABLES) {
      try {
        const [rows] = await conn.query<any[]>(`SELECT COUNT(*) AS n FROM \`${table}\``);
        seeded[table] = rows[0].n;
      } catch {
        // A table missing from this tenant is information, not an error: it
        // means the clone predates that table. Report it as absent.
        seeded[table] = -1;
      }
    }

    // The first non-disabled user, preferring an admin-ish role. A freshly
    // provisioned tenant has exactly one; an older store may have several, and
    // the operator only needs to know a login exists.
    const [users] = await conn.query<any[]>(
      `SELECT uid, username, display_name, user_type, disabled, created_at
         FROM users
        ORDER BY (user_type = 'Super Admin') DESC, disabled ASC, created_at ASC
        LIMIT 1`
    );

    let admin: TenantAdminSummary | null = null;
    if (users.length) {
      const u = users[0];
      const [perms] = await conn.query<any[]>(
        `SELECT COUNT(*) AS n FROM user_permissions WHERE user_uid = ?`, [u.uid]
      );
      admin = {
        username: u.username,
        displayName: u.display_name ?? null,
        userType: u.user_type ?? null,
        disabled: !!u.disabled,
        createdAt: u.created_at ?? null,
        permissionCount: perms[0].n,
      };
    }

    return { admin, seeded };
  } finally {
    await conn.end();
  }
}
