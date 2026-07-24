/**
 * Private signing key loader.
 * ----------------------------------------------------------------------------
 * Resolves the Ed25519 PRIVATE key from, in order:
 *   1. process.env.LICENSE_PRIVATE_KEY   (Railway / production secret)
 *   2. license-server/keys/private-key.pem (local development)
 *
 * The env var may contain literal "\n" sequences (common when pasting a PEM
 * into a hosting dashboard) — those are normalized back to real newlines.
 */
import fs from 'fs';
import path from 'path';

let cached: string | null = null;

export function getPrivateKeyPem(): string {
  if (cached) return cached;

  const fromEnv = process.env.LICENSE_PRIVATE_KEY;
  if (fromEnv && fromEnv.includes('BEGIN')) {
    cached = fromEnv.replace(/\\n/g, '\n').trim() + '\n';
    return cached;
  }

  const filePath = path.join(__dirname, '..', 'keys', 'private-key.pem');
  if (fs.existsSync(filePath)) {
    cached = fs.readFileSync(filePath, 'utf8');
    return cached;
  }

  throw new Error(
    'No signing key found. Set LICENSE_PRIVATE_KEY or run `npm run license:keygen`.'
  );
}

export function hasPrivateKey(): boolean {
  try {
    getPrivateKeyPem();
    return true;
  } catch {
    return false;
  }
}
