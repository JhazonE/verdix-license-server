/**
 * Product registry. Each product has its own key prefixes and its own signing
 * keypair (resolved through env_key_name), so a leaked key is confined to one
 * product.
 */
import { query } from './db';

export const DEFAULT_PRODUCT_ID = 'verdix-pos';

export interface Product {
  id: string;
  name: string;
  key_prefix: string;
  license_prefix: string;
  public_key: string | null;
  env_key_name: string;
  status: 'active' | 'inactive';
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
