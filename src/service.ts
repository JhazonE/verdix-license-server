/**
 * License Server business logic.
 * ----------------------------------------------------------------------------
 * Customers, license issuance (Product Keys), machine-bound signing, and
 * revocation. The actual Ed25519 signing reuses the shared crypto core, so the
 * keys this produces verify against the POS's embedded public key.
 */
import crypto from 'crypto';
import {
  signLicense,
  normalizeMachineId,
  LicensePayload,
  PRODUCT_ID,
  LICENSE_FORMAT_VERSION,
} from './licensing/core';
import { getPrivateKeyPem } from './keys';
import { getProduct, listProducts, DEFAULT_PRODUCT_ID } from './products';
import { sendWebhook } from './webhooks';
import { query, withTransaction } from './db';
import {
  getCachedLicense,
  getCachedLicenseByKey,
  getCachedActivation,
  countCachedActiveActivations,
  isMachineActivatedInCache,
  cachePutLicense,
  cacheUpdateLicenseStatus,
  cachePutActivation,
  cacheReleaseActivation,
  CachedLicense,
} from './cache';

// ── Types ──────────────────────────────────────────────────────────────────
export interface Customer {
  id: string;
  business_name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  created_at: string;
}

export type LicenseType = 'perpetual' | 'subscription';
export type LicenseStatus = 'active' | 'suspended' | 'revoked';

export interface License {
  id: string;
  customer_id: string;
  product_id: string;
  product_key: string;
  edition: string;
  type: LicenseType;
  expires_at: string | null;
  max_activations: number;
  features: string[] | null;
  status: LicenseStatus;
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

// ── Product Key generation ───────────────────────────────────────────────────
// Human-typable, unambiguous alphabet (no 0/O/1/I).
const PK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomGroup(len: number): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += PK_ALPHABET[bytes[i] % PK_ALPHABET.length];
  return out;
}

/** e.g. VRDX-7QK4-9FH2-MN8P (product key_prefix + 3 groups of 4). */
export function generateProductKey(prefix: string = 'VRDX'): string {
  return [prefix, randomGroup(4), randomGroup(4), randomGroup(4)].join('-');
}

// ── Customers ────────────────────────────────────────────────────────────────
export async function createCustomer(input: {
  business_name: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
}): Promise<Customer> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO customers (id, business_name, contact_name, email, phone, address, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.business_name.trim(),
      input.contact_name?.trim() || null,
      input.email?.trim() || null,
      input.phone?.trim() || null,
      input.address?.trim() || null,
      input.notes?.trim() || null,
    ]
  );
  const created = (await getCustomer(id)) as Customer;

  // The customer row is already committed above — a failure fanning out
  // webhooks (including listProducts() itself erroring) must never surface
  // as a failure of customer creation, which actually succeeded.
  try {
    const products = await listProducts();
    for (const product of products) {
      if (product.webhook_url) {
        sendWebhook(product, 'customer.created', {
          customerId: id,
          businessName: created.business_name,
        });
      }
    }
  } catch (e) {
    console.error('[webhooks] customer.created fan-out failed:', (e as Error).message);
  }

  return created;
}

export async function listCustomers(): Promise<(Customer & { license_count: number })[]> {
  return query(
    `SELECT c.*, COUNT(l.id) AS license_count
       FROM customers c
       LEFT JOIN licenses l ON l.customer_id = c.id
       GROUP BY c.id
       ORDER BY c.created_at DESC`
  );
}

export async function getCustomer(id: string): Promise<Customer | null> {
  const rows = await query<Customer[]>(`SELECT * FROM customers WHERE id = ?`, [id]);
  return rows[0] || null;
}

// ── Licenses ─────────────────────────────────────────────────────────────────
export async function createLicense(input: {
  customer_id: string;
  product_id?: string;
  edition?: string;
  type: LicenseType;
  expires_at?: string | null; // ISO/date for subscription
  max_activations?: number;
  features?: string[];
  notes?: string;
  created_by?: string;
}): Promise<License> {
  const id = crypto.randomUUID();

  if (input.type === 'subscription' && !input.expires_at) {
    throw new Error('Subscription licenses require an expiry date.');
  }
  const expires =
    input.type === 'subscription' && input.expires_at
      ? new Date(input.expires_at).toISOString().slice(0, 19).replace('T', ' ')
      : null;

  const productId = (input.product_id || DEFAULT_PRODUCT_ID).trim();
  const product = await getProduct(productId);
  if (!product) throw new Error(`Unknown product "${productId}".`);
  if (product.status !== 'active') {
    throw new Error(`Product "${productId}" is inactive; cannot issue new licenses.`);
  }

  // Generate a unique product key (retry on the rare collision).
  let productKey = generateProductKey(product.key_prefix);
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await query<any[]>(`SELECT id FROM licenses WHERE product_key = ?`, [productKey]);
    if (clash.length === 0) break;
    productKey = generateProductKey(product.key_prefix);
  }

  await query(
    `INSERT INTO licenses
       (id, customer_id, product_id, product_key, edition, type, expires_at, max_activations, features, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.customer_id,
      productId,
      productKey,
      (input.edition || 'standard').trim(),
      input.type,
      expires,
      Math.max(1, input.max_activations || 1),
      JSON.stringify(input.features || []),
      input.notes?.trim() || null,
      input.created_by || null,
    ]
  );

  await log(id, null, 'license.created', `Product key ${productKey} issued`);
  sendWebhook(product, 'license.issued', {
    licenseId: id,
    customerId: input.customer_id,
    productKey,
    edition: (input.edition || 'standard').trim(),
  });
  const created = await getLicense(id) as License;
  if (created) cachePutLicense(created as unknown as CachedLicense);
  return created;
}

function normalizeLicenseRow(row: any): License {
  return {
    ...row,
    features:
      typeof row.features === 'string'
        ? safeJson(row.features)
        : Array.isArray(row.features)
        ? row.features
        : [],
  };
}

function safeJson(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function getLicense(id: string): Promise<License | null> {
  try {
    const rows = await query<any[]>(`SELECT * FROM licenses WHERE id = ?`, [id]);
    return rows[0] ? normalizeLicenseRow(rows[0]) : null;
  } catch {
    const cached = getCachedLicense(id);
    return cached ? normalizeLicenseRow(cached) : null;
  }
}

export async function getLicenseByProductKey(productKey: string): Promise<License | null> {
  try {
    const rows = await query<any[]>(`SELECT * FROM licenses WHERE product_key = ?`, [
      productKey.trim().toUpperCase(),
    ]);
    return rows[0] ? normalizeLicenseRow(rows[0]) : null;
  } catch {
    const cached = getCachedLicenseByKey(productKey);
    return cached ? normalizeLicenseRow(cached) : null;
  }
}

export async function listLicenses(): Promise<any[]> {
  const rows = await query<any[]>(
    `SELECT l.*, c.business_name,
            (SELECT COUNT(*) FROM activations a WHERE a.license_id = l.id AND a.status = 'active') AS active_count
       FROM licenses l
       JOIN customers c ON c.id = l.customer_id
       ORDER BY l.created_at DESC`
  );
  return rows.map(normalizeLicenseRow);
}

export async function setLicenseStatus(id: string, status: LicenseStatus): Promise<void> {
  const before = await getLicense(id);
  await query(`UPDATE licenses SET status = ? WHERE id = ?`, [status, id]);
  cacheUpdateLicenseStatus(id, status);
  await log(id, null, 'license.' + status, `Status set to ${status}`);

  if (before && before.status !== status) {
    const product = await getProduct(before.product_id);
    if (product) {
      const event = status === 'revoked' ? 'license.revoked' : status === 'active' ? 'license.reactivated' : null;
      if (event) {
        sendWebhook(product, event, {
          licenseId: id,
          oldStatus: before.status,
          newStatus: status,
        });
      }
    }
  }
}

export async function addLicenseFeature(licenseId: string, feature: string): Promise<void> {
  const license = await getLicense(licenseId);
  if (!license) throw new Error('License not found: ' + licenseId);
  const features = Array.from(new Set([...(license.features || []), feature]));
  await query(`UPDATE licenses SET features = ? WHERE id = ?`, [JSON.stringify(features), licenseId]);
  cacheUpdateLicenseStatus(licenseId, license.status); // keep cache warm; status unchanged
  await log(licenseId, null, 'license.feature.added', feature);
}

// ── Cloud Config (per-license multi-tenant DB storage) ────────────────────────
export interface CloudConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
}

export async function upsertCloudConfig(licenseId: string, cfg: CloudConfig): Promise<void> {
  const { encryptDbPassword } = await import('./cloud-config-crypto');
  await query(
    `INSERT INTO cloud_configs (license_id, db_host, db_port, db_name, db_user, db_password_enc)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       db_host = VALUES(db_host), db_port = VALUES(db_port), db_name = VALUES(db_name),
       db_user = VALUES(db_user), db_password_enc = VALUES(db_password_enc)`,
    [licenseId, cfg.host, cfg.port, cfg.name, cfg.user, encryptDbPassword(cfg.password)]
  );
  await log(licenseId, null, 'cloud.config.saved', `Cloud DB ${cfg.name}`);
}

export async function getCloudConfig(licenseId: string): Promise<CloudConfig | null> {
  const rows = await query<any[]>(`SELECT * FROM cloud_configs WHERE license_id = ?`, [licenseId]);
  const r = rows[0];
  if (!r) return null;
  const { decryptDbPassword } = await import('./cloud-config-crypto');
  const password = decryptDbPassword(r.db_password_enc);
  if (password === null) return null;
  return { host: r.db_host, port: Number(r.db_port), name: r.db_name, user: r.db_user, password };
}

// ── Signing (machine binding) ────────────────────────────────────────────────
/**
 * Build + sign a machine-bound license from a license record. Used by BOTH the
 * dashboard's manual (offline) generation and, later, the online activation
 * endpoint. Records/updates the activation row and returns the signed key.
 */
export async function issueSignedLicense(
  license: License,
  machineIdRaw: string,
  opts: { machineLabel?: string; appVersion?: string; ip?: string; record?: boolean } = {}
): Promise<{ signedLicense: string; payload: LicensePayload }> {
  const machineId = normalizeMachineId(machineIdRaw);
  if (!machineId) throw new Error('A valid Machine ID is required.');

  const customer = await getCustomer(license.customer_id);

  const payload: LicensePayload = {
    v: LICENSE_FORMAT_VERSION,
    lid: license.id,
    product: license.product_id || DEFAULT_PRODUCT_ID,
    customer: customer?.business_name || 'Unknown',
    edition: license.edition,
    machineId,
    issued: new Date().toISOString(),
    expires: license.expires_at ? new Date(license.expires_at).toISOString() : null,
    features: license.features || [],
  };

  const signingProduct = await getProduct(license.product_id || DEFAULT_PRODUCT_ID);
  if (!signingProduct) {
    throw new Error(`Unknown product "${license.product_id}" on license ${license.id}.`);
  }
  const signedLicense = signLicense(
    payload,
    getPrivateKeyPem(signingProduct),
    signingProduct.license_prefix
  );

  if (opts.record !== false) {
    const activationId = crypto.randomUUID();
    await query(
      `INSERT INTO activations
         (id, license_id, machine_id, machine_label, signed_license, app_version, ip_address, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         signed_license = VALUES(signed_license),
         machine_label  = VALUES(machine_label),
         app_version    = VALUES(app_version),
         ip_address     = VALUES(ip_address),
         status         = 'active',
         last_seen_at   = NOW()`,
      [
        activationId,
        license.id,
        machineId,
        opts.machineLabel || null,
        signedLicense,
        opts.appVersion || null,
        opts.ip || null,
      ]
    );
    cachePutActivation({
      id: activationId,
      license_id: license.id,
      machine_id: machineId,
      machine_label: opts.machineLabel || null,
      signed_license: signedLicense,
      app_version: opts.appVersion || null,
      ip_address: opts.ip || null,
      status: 'active',
      activated_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    });
    await log(license.id, machineId, 'license.signed', 'Machine-bound license issued');
  }

  return { signedLicense, payload };
}

export async function countActiveActivations(licenseId: string): Promise<number> {
  try {
    const rows = await query<any[]>(
      `SELECT COUNT(*) AS n FROM activations WHERE license_id = ? AND status = 'active'`,
      [licenseId]
    );
    return Number(rows[0]?.n || 0);
  } catch {
    return countCachedActiveActivations(licenseId);
  }
}

export async function machineAlreadyActivated(licenseId: string, machineId: string): Promise<boolean> {
  try {
    const rows = await query<any[]>(
      `SELECT id FROM activations WHERE license_id = ? AND machine_id = ? AND status = 'active'`,
      [licenseId, normalizeMachineId(machineId)]
    );
    return rows.length > 0;
  } catch {
    return isMachineActivatedInCache(licenseId, normalizeMachineId(machineId));
  }
}

export async function listActivations(licenseId?: string): Promise<any[]> {
  if (licenseId) {
    return query(
      `SELECT a.*, l.product_key, c.business_name
         FROM activations a
         JOIN licenses l ON l.id = a.license_id
         JOIN customers c ON c.id = l.customer_id
        WHERE a.license_id = ?
        ORDER BY a.activated_at DESC`,
      [licenseId]
    );
  }
  return query(
    `SELECT a.*, l.product_key, c.business_name
       FROM activations a
       JOIN licenses l ON l.id = a.license_id
       JOIN customers c ON c.id = l.customer_id
      ORDER BY a.activated_at DESC
      LIMIT 200`
  );
}

export async function getActivation(licenseId: string, machineId: string): Promise<any | null> {
  try {
    const rows = await query<any[]>(
      `SELECT * FROM activations WHERE license_id = ? AND machine_id = ?`,
      [licenseId, normalizeMachineId(machineId)]
    );
    return rows[0] || null;
  } catch {
    return getCachedActivation(licenseId, normalizeMachineId(machineId));
  }
}

export async function touchActivation(
  licenseId: string,
  machineId: string,
  opts: { appVersion?: string; ip?: string } = {}
): Promise<void> {
  await query(
    `UPDATE activations
        SET last_seen_at = NOW(),
            app_version  = COALESCE(?, app_version),
            ip_address   = COALESCE(?, ip_address)
      WHERE license_id = ? AND machine_id = ?`,
    [opts.appVersion || null, opts.ip || null, licenseId, normalizeMachineId(machineId)]
  );
}

export type HeartbeatStatus =
  | 'active'
  | 'revoked'
  | 'suspended'
  | 'released'
  | 'expired'
  | 'invalid'
  | 'seat-exceeded';

// Statuses actually persisted in licenses.status. 'expired'/'released'/'invalid'/
// 'seat-exceeded' are derived at read-time inside validateHeartbeat and are never
// written back to the row, so they must never be compared against a previously-read
// stored status — that comparison would differ (and fire) on every single heartbeat.
// 'seat-exceeded' in particular is a transient per-heartbeat report (cloud terminal
// count vs. seat limit), not a stored license status — it must never fire
// license.status_changed on every poll.
const STORED_LICENSE_STATUSES: ReadonlySet<string> = new Set(['active', 'suspended', 'revoked']);

/**
 * Decide whether a heartbeat-observed status should fire `license.status_changed`.
 * Only fires for a genuine transition between STORED statuses (active/suspended/
 * revoked) — never for the derived 'expired'/'released'/'invalid' heartbeat
 * statuses, which would otherwise spam the webhook on every poll since they're
 * never reflected in the stored `statusBefore` value.
 */
export function shouldFireStatusChanged(
  statusBefore: LicenseStatus | undefined | null,
  newStatus: HeartbeatStatus
): boolean {
  return STORED_LICENSE_STATUSES.has(newStatus) && newStatus !== statusBefore;
}

export interface HeartbeatResult {
  status: HeartbeatStatus;
  signedLicense?: string;
  expires?: string | null;
  seatLimit?: number | null;
}

/**
 * Source-of-truth status check for an already-activated machine. Updates the
 * "last seen" timestamp and, when still active, returns a freshly-signed
 * license so renewals/extensions propagate without re-activation.
 */
export async function validateHeartbeat(
  licenseId: string,
  machineId: string,
  opts: { appVersion?: string; ip?: string; terminalCount?: number } = {}
): Promise<HeartbeatResult> {
  const license = await getLicense(licenseId);
  if (!license) return { status: 'invalid' };

  const activation = await getActivation(licenseId, machineId);
  if (activation) await touchActivation(licenseId, machineId, opts);
  await log(licenseId, machineId, 'heartbeat', 'license=' + license.status, opts.ip);

  if (license.status === 'revoked') return { status: 'revoked' };
  if (license.status === 'suspended') return { status: 'suspended' };
  if (!activation || activation.status === 'released') return { status: 'released' };

  const expires = license.expires_at ? new Date(license.expires_at).toISOString() : null;
  if (license.expires_at && new Date(license.expires_at).getTime() < Date.now()) {
    return { status: 'expired', expires };
  }

  const seatLimit = license.max_activations ?? null;

  // Cloud seat check: every hosted terminal shares one activation, so seats are
  // counted from the POS-reported terminal total instead. Report the overage —
  // never withhold the license, which would lock a paying store out of checkout.
  if (opts.terminalCount !== undefined && seatLimit !== null && opts.terminalCount > seatLimit) {
    const { signedLicense } = await issueSignedLicense(license, machineId, { record: false });
    return { status: 'seat-exceeded', signedLicense, expires, seatLimit };
  }

  // Still valid — re-sign (propagates renewed expiry/features) without adding a row.
  const { signedLicense } = await issueSignedLicense(license, machineId, { record: false });
  return { status: 'active', signedLicense, expires, seatLimit };
}

export async function releaseActivation(activationId: string): Promise<void> {
  const rows = await query<any[]>(`SELECT license_id, machine_id FROM activations WHERE id = ?`, [
    activationId,
  ]);
  await query(`UPDATE activations SET status = 'released' WHERE id = ?`, [activationId]);
  cacheReleaseActivation(activationId);
  if (rows[0]) await log(rows[0].license_id, rows[0].machine_id, 'activation.released', 'Seat released');
}

// ── Audit log ────────────────────────────────────────────────────────────────
export async function log(
  licenseId: string | null,
  machineId: string | null,
  action: string,
  detail?: string,
  ip?: string
): Promise<void> {
  try {
    await query(
      `INSERT INTO activation_logs (license_id, machine_id, action, detail, ip_address)
       VALUES (?, ?, ?, ?, ?)`,
      [licenseId, machineId, action, detail || null, ip || null]
    );
  } catch {
    /* logging must never break the main flow */
  }
}

// ── System configuration (backup / restore / reset) ──────────────────────────
export async function exportBackup(): Promise<object> {
  const products = await query<any[]>(`SELECT * FROM products ORDER BY created_at ASC`);
  const customers = await query<any[]>(`SELECT * FROM customers ORDER BY created_at ASC`);
  const licenses = await query<any[]>(`SELECT * FROM licenses ORDER BY created_at ASC`);
  const activations = await query<any[]>(`SELECT * FROM activations ORDER BY activated_at ASC`);
  const logs = await query<any[]>(`SELECT * FROM activation_logs ORDER BY created_at ASC`);
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    tables: { products, customers, licenses, activations, activation_logs: logs },
  };
}

export async function resetAllData(): Promise<void> {
  await query(`SET FOREIGN_KEY_CHECKS = 0`);
  try {
    await query(`TRUNCATE TABLE activation_logs`);
    await query(`TRUNCATE TABLE activations`);
    await query(`TRUNCATE TABLE licenses`);
    await query(`TRUNCATE TABLE customers`);
  } finally {
    await query(`SET FOREIGN_KEY_CHECKS = 1`);
  }
}

export async function importBackup(
  data: any
): Promise<{ customers: number; licenses: number; activations: number }> {
  if (!data?.tables) throw new Error('Invalid backup format — missing "tables" key.');
  const {
    products = [],
    customers = [],
    licenses = [],
    activations = [],
    activation_logs: logs = [],
  } = data.tables;

  await query(`SET FOREIGN_KEY_CHECKS = 0`);
  try {
    await query(`TRUNCATE TABLE activation_logs`);
    await query(`TRUNCATE TABLE activations`);
    await query(`TRUNCATE TABLE licenses`);
    await query(`TRUNCATE TABLE customers`);

    // Products are NOT truncated — restore upserts on top of whatever the
    // migration already seeded (verdix-pos), so a restored row for the same
    // id wins over the seeded default, and products created after this
    // backup was taken (with no matching row in the backup) are preserved
    // rather than deleted. Licenses below reference product_id, so this must
    // run first.
    for (const pr of products) {
      // embed_marked must travel with public_key, not be left off the INSERT:
      // the mark fingerprints the key it was asserted against, so restoring one
      // without the other reunites a stale mark with a key it no longer matches
      // (or resurrects a cleared mark on a fresh row). Don't "tidy" this back out.
      await query(
        `INSERT INTO products (id, name, key_prefix, license_prefix, public_key, env_key_name, status, embed_marked, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name), key_prefix = VALUES(key_prefix), license_prefix = VALUES(license_prefix),
           public_key = VALUES(public_key), env_key_name = VALUES(env_key_name), status = VALUES(status),
           embed_marked = VALUES(embed_marked)`,
        [pr.id, pr.name, pr.key_prefix, pr.license_prefix, pr.public_key ?? null,
         pr.env_key_name, pr.status, pr.embed_marked ? JSON.stringify(pr.embed_marked) : null, pr.created_at]
      );
    }

    for (const c of customers) {
      await query(
        `INSERT INTO customers (id, business_name, contact_name, email, phone, address, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.id, c.business_name, c.contact_name ?? null, c.email ?? null, c.phone ?? null,
         c.address ?? null, c.notes ?? null, c.created_at]
      );
    }
    for (const l of licenses) {
      await query(
        `INSERT INTO licenses
           (id, customer_id, product_id, product_key, edition, type, expires_at, max_activations,
            features, status, notes, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [l.id, l.customer_id, l.product_id ?? 'verdix-pos', l.product_key, l.edition, l.type, l.expires_at ?? null,
         l.max_activations,
         typeof l.features === 'string' ? l.features : JSON.stringify(l.features ?? []),
         l.status, l.notes ?? null, l.created_by ?? null, l.created_at]
      );
    }
    for (const a of activations) {
      await query(
        `INSERT INTO activations
           (id, license_id, machine_id, machine_label, signed_license, app_version,
            ip_address, status, activated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [a.id, a.license_id, a.machine_id, a.machine_label ?? null, a.signed_license,
         a.app_version ?? null, a.ip_address ?? null, a.status, a.activated_at,
         a.last_seen_at ?? null]
      );
    }
    for (const lg of logs) {
      await query(
        `INSERT INTO activation_logs (license_id, machine_id, action, detail, ip_address, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [lg.license_id ?? null, lg.machine_id ?? null, lg.action, lg.detail ?? null,
         lg.ip_address ?? null, lg.created_at]
      );
    }
  } finally {
    await query(`SET FOREIGN_KEY_CHECKS = 1`);
  }

  return { customers: customers.length, licenses: licenses.length, activations: activations.length };
}

export async function dashboardStats(): Promise<any> {
  const [c] = await query<any[]>(`SELECT COUNT(*) AS n FROM customers`);
  const [l] = await query<any[]>(`SELECT COUNT(*) AS n FROM licenses`);
  const [a] = await query<any[]>(`SELECT COUNT(*) AS n FROM activations WHERE status = 'active'`);
  const [r] = await query<any[]>(`SELECT COUNT(*) AS n FROM licenses WHERE status = 'revoked'`);
  return {
    customers: Number(c.n),
    licenses: Number(l.n),
    activations: Number(a.n),
    revoked: Number(r.n),
  };
}
