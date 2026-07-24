/**
 * AES-256-GCM string encryption primitive (zero external deps).
 * Layout: base64( iv[12] | authTag[16] | ciphertext ). Decrypt never throws —
 * returns null on any failure so callers can treat tampered/foreign data as
 * "absent" rather than crashing.
 */
import crypto from 'crypto';

export function deriveKey(...parts: string[]): Buffer {
  return crypto.createHash('sha256').update(parts.join(':')).digest();
}

export function encryptGcm(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptGcm(blob: string, key: Buffer): string | null {
  try {
    const buf = Buffer.from(blob, 'base64');
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
