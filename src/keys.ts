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

export function getPrivateKeyPem(product?: Product): string {
  const productId = product?.id ?? DEFAULT_PRODUCT_ID;
  const envVar = product?.env_key_name ?? DEFAULT_ENV_VAR;

  const hit = cache.get(productId);
  if (hit) return hit;

  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.includes('BEGIN')) {
    const pem = normalizePem(fromEnv);
    cache.set(productId, pem);
    return pem;
  }

  for (const filePath of keyFilePaths(productId)) {
    if (fs.existsSync(filePath)) {
      const pem = fs.readFileSync(filePath, 'utf8');
      cache.set(productId, pem);
      return pem;
    }
  }

  throw new Error(
    `No signing key for product "${productId}". Set ${envVar}, or run ` +
      `\`npm run keygen -- --product ${productId}\`.`
  );
}

export function hasPrivateKey(product?: Product): boolean {
  try {
    getPrivateKeyPem(product);
    return true;
  } catch {
    return false;
  }
}
