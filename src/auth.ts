/**
 * Admin authentication for the LMS dashboard.
 * ----------------------------------------------------------------------------
 * - Passwords hashed with bcrypt (bcryptjs, already a project dependency).
 * - Sessions are stateless signed tokens (HMAC-SHA256) stored in an HttpOnly
 *   cookie. Tampering invalidates the signature.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query } from './db';

export interface AdminUser {
  id: string;
  username: string;
  password_hash: string;
  role: string;
}

export interface SessionPayload {
  uid: string;
  username: string;
  role: string;
  exp: number; // epoch seconds
}

const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours

function sessionSecret(): string {
  return (
    process.env.LICENSE_ADMIN_SECRET ||
    process.env.LICENSE_PRIVATE_KEY?.slice(0, 64) ||
    'verdix-dev-session-secret-change-me'
  );
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function getAdminByUsername(username: string): Promise<AdminUser | null> {
  const rows = await query<AdminUser[]>(`SELECT * FROM admin_users WHERE username = ?`, [
    username.trim().toLowerCase(),
  ]);
  return rows[0] || null;
}

export async function createAdmin(username: string, password: string, role = 'admin'): Promise<void> {
  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  await query(
    `INSERT INTO admin_users (id, username, password_hash, role) VALUES (?, ?, ?, ?)`,
    [id, username.trim().toLowerCase(), hash, role]
  );
}

export async function touchLogin(id: string): Promise<void> {
  await query(`UPDATE admin_users SET last_login_at = NOW() WHERE id = ?`, [id]);
}

export async function listAdmins(): Promise<
  { id: string; username: string; role: string; created_at: string; last_login_at: string | null }[]
> {
  return query(
    `SELECT id, username, role, created_at, last_login_at FROM admin_users ORDER BY created_at ASC`
  );
}

export async function countAdmins(): Promise<number> {
  const rows = await query<any[]>(`SELECT COUNT(*) AS n FROM admin_users`);
  return Number(rows[0]?.n || 0);
}

export async function getAdminById(id: string): Promise<AdminUser | null> {
  const rows = await query<AdminUser[]>(`SELECT * FROM admin_users WHERE id = ?`, [id]);
  return rows[0] || null;
}

export async function updateAdmin(
  id: string,
  fields: { username?: string; role?: string }
): Promise<void> {
  const sets: string[] = [];
  const vals: any[] = [];
  if (fields.username !== undefined) { sets.push('username = ?'); vals.push(fields.username); }
  if (fields.role !== undefined) { sets.push('role = ?'); vals.push(fields.role); }
  if (!sets.length) return;
  vals.push(id);
  await query(`UPDATE admin_users SET ${sets.join(', ')} WHERE id = ?`, vals);
}

export async function deleteAdmin(id: string): Promise<void> {
  await query(`DELETE FROM admin_users WHERE id = ?`, [id]);
}

export async function updateAdminPassword(id: string, newPassword: string): Promise<void> {
  const hash = await hashPassword(newPassword);
  await query(`UPDATE admin_users SET password_hash = ? WHERE id = ?`, [hash, id]);
}

// ── Stateless signed session tokens ──────────────────────────────────────────
function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function createSession(user: AdminUser): string {
  const payload: SessionPayload = {
    uid: user.id,
    username: user.username,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(crypto.createHmac('sha256', sessionSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = b64url(crypto.createHmac('sha256', sessionSecret()).update(body).digest());
  // Constant-time comparison.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function anyAdminExists(): Promise<boolean> {
  const rows = await query<any[]>(`SELECT id FROM admin_users LIMIT 1`);
  return rows.length > 0;
}
