// DUPLICATED from the Verdix POS repo (lib/licensing/core.ts).
// This is the Ed25519 signing/verification contract. If the key format or
// algorithm changes here, apply the identical change to lib/licensing/core.ts
// in the POS repo, or previously issued licenses will fail verification.

/**
 * Verdix POS — License Cryptography Core
 * ----------------------------------------------------------------------------
 * SINGLE SOURCE OF TRUTH for the license format. Imported by BOTH:
 *   - the POS verifier  (lib/licensing/verify.ts)        → uses the PUBLIC key
 *   - the generator app (license-generator/*)            → uses the PRIVATE key
 *
 * Why Ed25519 (asymmetric signatures)?
 *   The generator signs a license payload with a SECRET private key. The POS
 *   only ever holds the PUBLIC key, which can verify a signature but can NOT
 *   create one. Even if an attacker fully decompiles the POS, they cannot
 *   forge a valid license without the private key. This is the strongest
 *   practical model for offline desktop licensing.
 *
 * This file is pure crypto — it imports ONLY Node's built-in `crypto`. Do not
 * add server-only or Next.js imports here, or the generator will break.
 */
import crypto from 'crypto';

/** Bump when the payload shape changes in a backward-incompatible way. */
export const LICENSE_FORMAT_VERSION = 1;

/** Product identifier embedded in every license. The POS rejects mismatches. */
export const PRODUCT_ID = 'verdix-pos';

/** Sentinel machineId marking a web/hosted license (no hardware binding). */
export const HOSTED_MACHINE_ID = 'HOSTED';

/** Human-friendly prefix so a key is recognizable at a glance. */
export const KEY_PREFIX = 'VRDX1';

export interface LicensePayload {
  /** Format version. */
  v: number;
  /** Unique license id (uuid). Lets you track/revoke individual licenses. */
  lid: string;
  /** Product the license is valid for. */
  product: string;
  /** Customer / business name shown in the POS. */
  customer: string;
  /** Edition tier, e.g. "standard" | "enterprise". Free-form. */
  edition: string;
  /** Hardware fingerprint the license is locked to (normalized form). */
  machineId: string;
  /** ISO timestamp the license was issued. */
  issued: string;
  /** ISO expiry timestamp, or null for a perpetual (never-expiring) license. */
  expires: string | null;
  /** Optional feature flags this license unlocks. */
  features: string[];
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  payload?: LicensePayload;
}

/**
 * Normalize a machine fingerprint so cosmetic differences (dashes, spaces,
 * casing) never cause a false mismatch. Both signing and verification run the
 * fingerprint through this before comparison.
 */
export function normalizeMachineId(id: string): string {
  return (id || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/**
 * Sign a license payload with an Ed25519 PRIVATE key (PEM, pkcs8).
 * Returns the full license key string: `VRDX1.<payload>.<signature>`.
 * Only the generator app should ever call this.
 */
export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  // For Ed25519 the digest algorithm MUST be null (the algorithm is implied).
  const signature = crypto.sign(null, data, privateKeyPem);
  return `${KEY_PREFIX}.${b64url(data)}.${b64url(signature)}`;
}

/**
 * Verify a license key's signature against the embedded Ed25519 PUBLIC key.
 * Returns the decoded payload when the signature is authentic. Does NOT check
 * machine binding or expiry — that's the verifier's job (see verify.ts).
 */
export function verifyLicenseSignature(key: string, publicKeyPem: string): VerifyResult {
  try {
    const parts = (key || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== KEY_PREFIX) {
      return { valid: false, reason: 'malformed-key' };
    }

    const data = fromB64url(parts[1]);
    const signature = fromB64url(parts[2]);

    const ok = crypto.verify(null, data, publicKeyPem, signature);
    if (!ok) return { valid: false, reason: 'bad-signature' };

    const payload = JSON.parse(data.toString('utf8')) as LicensePayload;
    if (typeof payload !== 'object' || payload === null) {
      return { valid: false, reason: 'bad-payload' };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false, reason: 'parse-error' };
  }
}

/**
 * Generate a fresh Ed25519 key pair as PEM strings.
 * Used once during setup by the generator's keygen script.
 */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}
