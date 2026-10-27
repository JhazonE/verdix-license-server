/**
 * HOSTED activations must never consume a seat. Seat counting happens in four
 * places: the in-memory cache (tested behaviourally) and three SQL sites in
 * src/service.ts (asserted on source text, since they need a live MySQL and a
 * missed one is a silent failure).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cachePutActivation,
  countCachedActiveActivations,
  HOSTED_ACTIVATION_MACHINE_ID,
  CachedActivation,
} from '../src/cache';

function mkActivation(id: string, machineId: string): CachedActivation {
  return {
    id,
    license_id: 'lic-seat-test',
    machine_id: machineId,
    machine_label: null,
    signed_license: 'x',
    app_version: null,
    ip_address: null,
    status: 'active',
    activated_at: new Date().toISOString(),
    last_seen_at: null,
  };
}

// 1. Cache path — real function, no DB.
assert.equal(HOSTED_ACTIVATION_MACHINE_ID, 'HOSTED');
cachePutActivation(mkActivation('a1', 'HOSTED'));
cachePutActivation(mkActivation('a2', 'ABC123'));
assert.equal(countCachedActiveActivations('lic-seat-test'), 1, 'cached seat count excludes HOSTED');

// 2. SQL sites — every COUNT(*) over activations in these functions must constrain machine_id.
const src = readFileSync(join(__dirname, '..', 'src', 'service.ts'), 'utf8');

function functionBody(name: string): string {
  const start = src.search(new RegExp(String.raw`function\s+${name}\s*\(`));
  assert.ok(start >= 0, `${name} not found in src/service.ts`);
  const next = src.slice(start + 1).search(/\n(?:export\s+)?(?:async\s+)?function\s/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

for (const fn of ['countActiveActivations', 'listLicenses', 'dashboardStats']) {
  const body = functionBody(fn);
  const counts = body.match(/COUNT\(\*\)[^`]*?FROM\s+activations[^`)]*/gi) ?? [];
  assert.ok(counts.length > 0, `${fn}: no COUNT(*) over activations found (test is stale)`);
  for (const c of counts) {
    assert.ok(/machine_id/.test(c), `${fn}: activation count does not constrain machine_id: ${c}`);
  }
}

console.log('check-hosted-seat-exclusion: ok');
