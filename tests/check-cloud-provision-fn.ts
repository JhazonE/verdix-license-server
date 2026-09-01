/**
 * Verifies provisionCloudDatabase is importable and validates its inputs.
 *
 * This deliberately does NOT provision a real database — that needs admin MySQL
 * credentials and mysqldump. It checks the function exists with the right shape
 * and fails cleanly on a product key that does not exist, which is the contract
 * the HTTP endpoint depends on.
 */
import assert from 'node:assert/strict';
import { provisionCloudDatabase, deriveTenantNames } from '../src/provision-cloud';

async function main() {
  assert.equal(typeof provisionCloudDatabase, 'function', 'provisionCloudDatabase is exported');

  // Tenant naming stays deterministic — the endpoint reports these names to the operator.
  const a = deriveTenantNames('license-id-1');
  const b = deriveTenantNames('license-id-1');
  assert.deepEqual(a, b, 'deriveTenantNames is deterministic');
  assert.ok(a.dbName.startsWith('verdix_c_'), 'db name is prefixed');
  assert.ok(a.dbUser.startsWith('u_'), 'db user is prefixed');
  assert.notDeepEqual(deriveTenantNames('license-id-2'), a, 'different licences get different names');

  // An unknown product key must reject, not hang or return a partial result.
  await assert.rejects(
    () => provisionCloudDatabase('VRDX-0000-0000-0000'),
    /No license found/i,
    'unknown product key rejects with a clear message'
  );

  console.log('check-cloud-provision-fn: all assertions passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
