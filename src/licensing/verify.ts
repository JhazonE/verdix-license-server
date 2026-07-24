/**
 * License verifier + storage (server-only).
 * ----------------------------------------------------------------------------
 * Reads the activated license, verifies its signature against the embedded
 * public key, then enforces product, machine-binding and expiry rules.
 *
 * Storage: the activated key is written to a stable, per-machine path so it
 * survives across launches even for the portable Electron build (whose app
 * folder is unpacked to a temp directory each run). Override with LICENSE_FILE.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  verifyLicenseSignature,
  normalizeMachineId,
  PRODUCT_ID,
  HOSTED_MACHINE_ID,
  LicensePayload,
} from './core';
import { PUBLIC_KEY_PEM } from './public-key';
import { getMachineId } from './machine';

export type LicenseStatus =
  | 'active' // valid, machine matches, not expired
  | 'expired' // valid + correct machine, but past expiry
  | 'wrong-machine' // valid signature, but issued for a different machine
  | 'invalid' // bad signature / malformed / wrong product
  | 'unlicensed'; // no key installed yet

export interface LicenseInfo {
  status: LicenseStatus;
  licensed: boolean;
  machineId: string;
  reason?: string;
  customer?: string;
  edition?: string;
  product?: string;
  issued?: string;
  expires?: string | null;
  /** Null for perpetual licenses; otherwise whole days until expiry (can be negative). */
  daysRemaining?: number | null;
  features?: string[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Absolute path to the license file for this machine. */
export function getLicenseFilePath(): string {
  if (process.env.LICENSE_FILE) return process.env.LICENSE_FILE;
  const base = process.env.PROGRAMDATA || process.env.APPDATA || os.homedir();
  return path.join(base, 'Verdix', 'license.dat');
}

export function readLicenseKey(): string | null {
  const envKey = process.env.LICENSE_KEY?.trim();
  if (envKey) return envKey;
  try {
    const p = getLicenseFilePath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

export function saveLicenseKey(key: string): void {
  const p = getLicenseFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, key.trim(), 'utf8');
}

export function removeLicenseKey(): void {
  try {
    const p = getLicenseFilePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // ignore
  }
}

/**
 * True when the license's machineId matches this machine, OR when it is the
 * HOSTED sentinel (web/hosted licenses carry no hardware binding). The sentinel
 * only ever appears in a vendor-signed payload, so this cannot be forged.
 */
export function isMachineMatch(payloadMachineId: string, actualMachineId: string): boolean {
  const pid = normalizeMachineId(payloadMachineId);
  if (pid === normalizeMachineId(HOSTED_MACHINE_ID)) return true;
  return pid === normalizeMachineId(actualMachineId);
}

/**
 * Evaluate an arbitrary key string (without persisting it). Used by both the
 * status endpoint (passing the stored key) and the activate endpoint (passing
 * a candidate key before saving).
 */
export function evaluateLicenseKey(key: string | null): LicenseInfo {
  const machineId = getMachineId();

  // Developer escape hatch — never enabled in a shipped build.
  if (process.env.LICENSE_DEV_BYPASS === '1') {
    return {
      status: 'active',
      licensed: true,
      machineId,
      customer: 'DEVELOPER BYPASS',
      edition: 'dev',
      product: PRODUCT_ID,
      expires: null,
      daysRemaining: null,
    };
  }

  if (!key) return { status: 'unlicensed', licensed: false, machineId };

  const res = verifyLicenseSignature(key, PUBLIC_KEY_PEM);
  if (!res.valid || !res.payload) {
    return { status: 'invalid', licensed: false, machineId, reason: res.reason };
  }

  const p = res.payload;

  if (p.product !== PRODUCT_ID) {
    return { status: 'invalid', licensed: false, machineId, reason: 'wrong-product' };
  }

  if (!isMachineMatch(p.machineId, machineId)) {
    return {
      status: 'wrong-machine',
      licensed: false,
      machineId,
      reason: 'machine-mismatch',
      customer: p.customer,
      edition: p.edition,
    };
  }

  let daysRemaining: number | null = null;
  if (p.expires) {
    const exp = new Date(p.expires).getTime();
    daysRemaining = Math.ceil((exp - Date.now()) / MS_PER_DAY);
    if (Date.now() > exp) {
      return {
        status: 'expired',
        licensed: false,
        machineId,
        customer: p.customer,
        edition: p.edition,
        product: p.product,
        issued: p.issued,
        expires: p.expires,
        daysRemaining,
      };
    }
  }

  return {
    status: 'active',
    licensed: true,
    machineId,
    customer: p.customer,
    edition: p.edition,
    product: p.product,
    issued: p.issued,
    expires: p.expires,
    daysRemaining,
    features: p.features,
  };
}

/** Status of the currently installed license. */
export function getLicenseInfo(): LicenseInfo {
  return evaluateLicenseKey(readLicenseKey());
}

/**
 * Decode the installed license's payload (only if its signature is authentic).
 * Used by the heartbeat to learn the license id + bound machine. Returns null
 * when there is no license or the signature is invalid.
 */
export function readLicensePayload(): LicensePayload | null {
  const key = readLicenseKey();
  if (!key) return null;
  const res = verifyLicenseSignature(key, PUBLIC_KEY_PEM);
  return res.valid && res.payload ? res.payload : null;
}
