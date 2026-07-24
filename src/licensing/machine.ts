/**
 * Machine fingerprint (hardware binding).
 * ----------------------------------------------------------------------------
 * Server-only. Computes a stable, hard-to-spoof identifier for the machine the
 * POS server runs on, so a license can be locked to a single computer. Copying
 * the license file to another PC produces a different fingerprint → invalid.
 *
 * Sources (Windows), strongest first:
 *   - HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid  (per Windows install)
 *   - Win32_BaseBoard.SerialNumber                      (motherboard serial)
 *   - Win32_BIOS.SerialNumber                           (BIOS/system serial)
 * These are hashed together with SHA-256 so the raw serials are never exposed.
 */
import crypto from 'crypto';
import os from 'os';
import { execSync } from 'child_process';

let cached: string | null = null;

function safeExec(cmd: string): string {
  try {
    return execSync(cmd, { timeout: 6000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function getWindowsMachineGuid(): string {
  const out = safeExec(
    'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid'
  );
  const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
  return m ? m[1] : '';
}

function getWmicValue(className: string, property: string): string {
  // wmic is removed on recent Windows 11 builds, so prefer PowerShell CIM.
  const ps = safeExec(
    `powershell -NoProfile -NonInteractive -Command "(Get-CimInstance ${className}).${property}"`
  );
  if (ps) return ps.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join('');
  return '';
}

/**
 * Returns the canonical (grouped, uppercase) machine id shown to the user and
 * embedded in licenses. Cached for the lifetime of the process.
 */
export function getMachineId(): string {
  if (cached) return cached;

  const parts: string[] = [];

  if (process.platform === 'win32') {
    parts.push(getWindowsMachineGuid());
    parts.push(getWmicValue('Win32_BaseBoard', 'SerialNumber'));
    parts.push(getWmicValue('Win32_BIOS', 'SerialNumber'));
  }

  // Always-available, stable-ish fallbacks.
  parts.push(os.platform());
  parts.push(os.arch());

  const meaningful = parts
    .map((p) => p.trim())
    .filter((p) => p && !/^(to be filled by o\.?e\.?m\.?|default string|none|0+)$/i.test(p));

  const basis = meaningful.length > 0 ? meaningful.join('|') : os.hostname();
  const hash = crypto.createHash('sha256').update(basis).digest('hex');

  // First 32 hex chars, grouped into 8 blocks of 4 for readability.
  cached = hash.slice(0, 32).toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
  return cached;
}
