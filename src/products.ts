/**
 * Product registry. Each product has its own key prefixes and its own signing
 * keypair (resolved through env_key_name), so a leaked key is confined to one
 * product.
 */
import crypto from 'crypto';
import { query } from './db';
import type { EmbedMark } from './setup-status';

export const DEFAULT_PRODUCT_ID = 'verdix-pos';

export interface Product {
  id: string;
  name: string;
  key_prefix: string;
  license_prefix: string;
  public_key: string | null;
  env_key_name: string;
  status: 'active' | 'inactive';
  /** Operator's embed mark, or null when never marked. See setup-status.ts. */
  embed_marked: EmbedMark | null;
  /** Destination for outbound license-event webhooks, or null when disabled. */
  webhook_url: string | null;
  /** HMAC-SHA256 key for signing webhook bodies. Never sent to clients. */
  webhook_secret: string | null;
}

export async function getProduct(id: string): Promise<Product | null> {
  const rows = await query<any[]>(`SELECT * FROM products WHERE id = ?`, [id.trim()]);
  return rows.length ? (rows[0] as Product) : null;
}

export async function listProducts(): Promise<Product[]> {
  return (await query<any[]>(`SELECT * FROM products ORDER BY name`)) as Product[];
}

export async function createProduct(input: {
  id: string;
  name: string;
  key_prefix: string;
  license_prefix: string;
  env_key_name: string;
}): Promise<Product> {
  const id = input.id.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error('Product id must be lowercase letters, digits and dashes.');
  }
  const key_prefix = input.key_prefix.trim().toUpperCase();
  const license_prefix = input.license_prefix.trim().toUpperCase();
  if (!key_prefix || !license_prefix) {
    throw new Error('key_prefix and license_prefix are required.');
  }
  if (!input.env_key_name.trim()) {
    throw new Error('env_key_name is required.');
  }

  const clashes = await query<any[]>(
    `SELECT id, key_prefix, license_prefix FROM products
      WHERE key_prefix = ? OR license_prefix = ?`,
    [key_prefix, license_prefix]
  );
  const clash = clashes.find((p) => p.key_prefix === key_prefix || p.license_prefix === license_prefix);
  if (clash) {
    throw new Error(
      `Prefix already in use by product "${clash.id}" ` +
        `(key_prefix=${clash.key_prefix}, license_prefix=${clash.license_prefix}). ` +
        `Choose different key_prefix/license_prefix values.`
    );
  }

  await query(
    `INSERT INTO products (id, name, key_prefix, license_prefix, env_key_name, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [id, input.name.trim(), key_prefix, license_prefix, input.env_key_name.trim()]
  );

  const created = await getProduct(id);
  if (!created) throw new Error('Product was not created.');
  return created;
}

export async function setProductPublicKey(id: string, pem: string): Promise<void> {
  await query(`UPDATE products SET public_key = ? WHERE id = ?`, [pem, id.trim()]);
}

/**
 * Record (or clear) the operator's assertion that this product's public key was
 * embedded in its app. Pass null to clear.
 *
 * The caller computes key_fp from the CURRENT public_key — never from client
 * input, which would let any fingerprint be marked and defeat stale detection.
 */
export async function setProductEmbedMark(id: string, mark: EmbedMark | null): Promise<void> {
  await query(`UPDATE products SET embed_marked = ? WHERE id = ?`, [
    mark ? JSON.stringify(mark) : null,
    id.trim(),
  ]);
}

function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Set or clear a product's webhook URL. Generates a secret on first use;
 * clearing the URL leaves any existing secret in place so re-enabling later
 * doesn't silently rotate it out from under an already-configured receiver.
 */
export async function setProductWebhook(id: string, url: string | null): Promise<Product> {
  const trimmed = url?.trim() || null;
  const current = await getProduct(id);
  if (!current) throw new Error(`Unknown product "${id}".`);

  const needsSecret = trimmed && !current.webhook_secret;
  if (needsSecret) {
    await query(`UPDATE products SET webhook_url = ?, webhook_secret = ? WHERE id = ?`, [
      trimmed,
      generateWebhookSecret(),
      id.trim(),
    ]);
  } else {
    await query(`UPDATE products SET webhook_url = ? WHERE id = ?`, [trimmed, id.trim()]);
  }

  const updated = await getProduct(id);
  if (!updated) throw new Error(`Product "${id}" disappeared during update.`);
  return updated;
}

/** Rotate the HMAC secret. Signatures made with the old secret stop verifying. */
export async function regenerateWebhookSecret(id: string): Promise<Product> {
  const current = await getProduct(id);
  if (!current) throw new Error(`Unknown product "${id}".`);
  await query(`UPDATE products SET webhook_secret = ? WHERE id = ?`, [
    generateWebhookSecret(),
    id.trim(),
  ]);
  const updated = await getProduct(id);
  if (!updated) throw new Error(`Product "${id}" disappeared during update.`);
  return updated;
}
