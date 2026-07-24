/**
 * In-memory read cache for the license server.
 * ----------------------------------------------------------------------------
 * Populated from MySQL on startup, refreshed every REFRESH_INTERVAL ms.
 * When MySQL is temporarily unreachable, reads served from stale cache so the
 * server keeps accepting POS heartbeats and activation checks.
 *
 * Writes still require a live MySQL connection — you cannot issue new licenses
 * while offline. But existing licenses and activations remain queryable.
 */
import { query } from './db';

const REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes

export interface CachedLicense {
  id: string;
  customer_id: string;
  product_key: string;
  edition: string;
  type: string;
  expires_at: string | null;
  max_activations: number;
  features: string;
  status: string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

export interface CachedActivation {
  id: string;
  license_id: string;
  machine_id: string;
  machine_label: string | null;
  signed_license: string;
  app_version: string | null;
  ip_address: string | null;
  status: string;
  activated_at: string;
  last_seen_at: string | null;
}

// ── Internal stores ────────────────────────────────────────────────────────
const _licenseById  = new Map<string, CachedLicense>();
const _licenseByKey = new Map<string, CachedLicense>(); // keyed by product_key (upper)
const _activations  = new Map<string, CachedActivation>(); // key: `${license_id}:${machine_id}`
const _activationById = new Map<string, CachedActivation>();

let _lastSync: Date | null = null;
let _timer: ReturnType<typeof setInterval> | null = null;

// ── Reads ─────────────────────────────────────────────────────────────────
export function getCachedLicense(id: string): CachedLicense | null {
  return _licenseById.get(id) ?? null;
}

export function getCachedLicenseByKey(productKey: string): CachedLicense | null {
  return _licenseByKey.get(productKey.trim().toUpperCase()) ?? null;
}

export function getCachedActivation(licenseId: string, machineId: string): CachedActivation | null {
  return _activations.get(`${licenseId}:${machineId}`) ?? null;
}

export function countCachedActiveActivations(licenseId: string): number {
  let n = 0;
  for (const a of _activations.values()) {
    if (a.license_id === licenseId && a.status === 'active') n++;
  }
  return n;
}

export function isMachineActivatedInCache(licenseId: string, machineId: string): boolean {
  const a = _activations.get(`${licenseId}:${machineId}`);
  return !!a && a.status === 'active';
}

// ── Write-through helpers (called after successful MySQL writes) ───────────
export function cachePutLicense(l: CachedLicense): void {
  _licenseById.set(l.id, l);
  _licenseByKey.set(l.product_key.toUpperCase(), l);
}

export function cacheUpdateLicenseStatus(id: string, status: string): void {
  const l = _licenseById.get(id);
  if (l) { l.status = status; _licenseByKey.set(l.product_key.toUpperCase(), l); }
}

export function cachePutActivation(a: CachedActivation): void {
  _activations.set(`${a.license_id}:${a.machine_id}`, a);
  _activationById.set(a.id, a);
}

export function cacheReleaseActivation(activationId: string): void {
  const a = _activationById.get(activationId);
  if (a) { a.status = 'released'; }
}

// ── Sync ──────────────────────────────────────────────────────────────────
async function syncFromDb(): Promise<void> {
  try {
    const licenses = await query<CachedLicense[]>(`SELECT * FROM licenses`);
    const acts = await query<CachedActivation[]>(`SELECT * FROM activations`);

    _licenseById.clear();
    _licenseByKey.clear();
    _activations.clear();
    _activationById.clear();

    for (const l of licenses) {
      _licenseById.set(l.id, l);
      _licenseByKey.set(l.product_key.toUpperCase(), l);
    }
    for (const a of acts) {
      _activations.set(`${a.license_id}:${a.machine_id}`, a);
      _activationById.set(a.id, a);
    }

    _lastSync = new Date();
    console.log(`[cache] synced — ${licenses.length} licenses, ${acts.length} activations`);
  } catch (e: any) {
    console.warn('[cache] sync failed, serving stale cache:', e.message);
  }
}

export async function initCache(): Promise<void> {
  await syncFromDb();
  _timer = setInterval(syncFromDb, REFRESH_INTERVAL);
}

export function stopCache(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export function cacheStatus() {
  return {
    lastSync: _lastSync?.toISOString() ?? null,
    licenses: _licenseById.size,
    activations: _activations.size,
  };
}
