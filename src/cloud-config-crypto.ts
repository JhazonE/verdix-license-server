/**
 * Encrypts the per-customer DB password for at-rest storage in cloud_configs.
 * Keyed by CLOUD_CONFIG_SECRET (license-server env). Distinct from the POS's
 * machine-derived client-side encryption.
 */
import { encryptGcm, decryptGcm, deriveKey } from './licensing/crypto/aes-gcm';

function key() {
  const secret = process.env.CLOUD_CONFIG_SECRET;
  if (!secret) throw new Error('CLOUD_CONFIG_SECRET is not set on the license server.');
  return deriveKey('verdix-cloud-config', secret);
}

export function encryptDbPassword(password: string): string {
  return encryptGcm(password, key());
}

export function decryptDbPassword(blob: string): string | null {
  return decryptGcm(blob, key());
}
