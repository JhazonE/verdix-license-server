/**
 * Private signing key loader.
 * ----------------------------------------------------------------------------
 * Each product has its OWN keypair, so one leaked key cannot compromise every
 * product. For a given product the key is resolved from, in order:
 *   1. process.env[product.env_key_name]        (Railway / production secret)
 *   2. keys/<product.id>/private-key.pem        (local development)
 *
 * With no product (legacy/default path) it resolves:
 *   1. process.env.LICENSE_PRIVATE_KEY
 *   2. keys/private-key.pem
 *
 * verdix-pos declares env_key_name = 'LICENSE_PRIVATE_KEY' and additionally
 * falls back to the flat keys/private-key.pem, so the original single-product
 * setup keeps working untouched.
 *
 * The env var may contain literal "\n" sequences (common when pasting a PEM
 * into a hosting dashboard) — those are normalized back to real newlines.
 */
import fs from 'fs';
import path from 'path';
import type { Product } from './products';
import type { PrivateKeySource } from './setup-status';

const DEFAULT_ENV_VAR = 'LICENSE_PRIVATE_KEY';
const DEFAULT_PRODUCT_ID = 'verdix-pos';

const cache = new Map<string, string>();

function normalizePem(pem: string): string {
  return pem.replace(/\\n/g, '\n').trim() + '\n';
}

/** Candidate key file paths for a product, most specific first. */
function keyFilePaths(productId: string): string[] {
  const paths = [path.join(__dirname, '..', 'keys', productId, 'private-key.pem')];
  // verdix-pos predates per-product key directories.
  if (productId === DEFAULT_PRODUCT_ID) {
    paths.push(path.join(__dirname, '..', 'keys', 'private-key.pem'));
  }
  return paths;
}

/**
 * Single resolution point for a product's private key, shared by
 * getPrivateKeyPem and getPrivateKeySource so the source the dashboard reports
 * can never disagree with the key actually used for signing.
 *
 * Deliberately does NOT consult the module cache: the cache stores only the
 * PEM, so a cached hit cannot say where the key came from.
 */
function resolveKey(
  productId: string,
  envVar: string
): { pem: string; source: PrivateKeySource } | null {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.includes('BEGIN')) {
    return { pem: normalizePem(fromEnv), source: 'env' };
  }
  for (const filePath of keyFilePaths(productId)) {
    if (fs.existsSync(filePath)) {
      return { pem: fs.readFileSync(filePath, 'utf8'), source: 'local-file' };
    }
  }
  return null;
}

export function getPrivateKeyPem(product?: Product): string {
  const productId = product?.id ?? DEFAULT_PRODUCT_ID;
  const envVar = product?.env_key_name ?? DEFAULT_ENV_VAR;

  const hit = cache.get(productId);
  if (hit) return hit;

  const resolved = resolveKey(productId, envVar);
  if (resolved) {
    cache.set(productId, resolved.pem);
    return resolved.pem;
  }

  throw new Error(
    `No signing key for product "${productId}". Set ${envVar}, or run ` +
      `\`npm run keygen -- --product ${productId}\`.`
  );
}

/**
 * Where this server resolves the product's private key from — without returning
 * any key material.
 *
 * NOTE: this describes THIS running server. Opening the dashboard locally
 * reports 'local-file' even when Railway is correctly configured, which is why
 * the UI names the source rather than claiming the key is deployed.
 */
export function getPrivateKeySource(product?: Product): PrivateKeySource {
  const productId = product?.id ?? DEFAULT_PRODUCT_ID;
  const envVar = product?.env_key_name ?? DEFAULT_ENV_VAR;
  return resolveKey(productId, envVar)?.source ?? 'none';
}

/**
 * Repo-relative path of the key file this product WOULD use, for display only.
 *
 * The dashboard must not derive this as `keys/<id>/private-key.pem`: verdix-pos
 * predates per-product directories and lives at the flat `keys/private-key.pem`,
 * so a derived path would point an operator at a file that does not exist.
 * Returns the file that actually resolved when there is one, otherwise the
 * preferred location to create.
 */
export function getKeyFileHint(product?: Product): string {
  const productId = product?.id ?? DEFAULT_PRODUCT_ID;
  const candidates = keyFilePaths(productId);
  const existing = candidates.find((f) => fs.existsSync(f));
  const chosen = existing ?? candidates[0];
  return path.relative(path.join(__dirname, '..'), chosen).replace(/\\/g, '/');
}

export function hasPrivateKey(product?: Product): boolean {
  try {
    getPrivateKeyPem(product);
    return true;
  } catch {
    return false;
  }
}
