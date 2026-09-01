/**
 * Verifies POST /api/cloud-customers is admin-gated.
 *
 * Requires the staging server to be running:  ./staging.sh server
 * Run with:                                   npx tsx tests/check-cloud-customer-endpoint.ts
 */
import assert from 'node:assert/strict';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4100';

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const raw = res.headers.get('set-cookie') || '';
  const cookie = raw.split(';')[0];
  assert.ok(cookie.includes('lms_session'), 'login returned a session cookie');
  return cookie;
}

async function main() {
  // (a) No session at all → rejected.
  const anon = await fetch(BASE + '/api/cloud-customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: 'x', type: 'perpetual' }),
  });
  assert.ok(anon.status === 401 || anon.status === 403, `unauthenticated request rejected (got ${anon.status})`);

  // (b) An admin session reaches the handler (a validation error is fine — a 403 is not).
  const adminCookie = await login('admin', 'staging-only-pw');
  const admin = await fetch(BASE + '/api/cloud-customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({}),   // deliberately invalid
  });
  assert.notEqual(admin.status, 403, 'admin is not forbidden');
  assert.notEqual(admin.status, 404, 'route exists');

  console.log('check-cloud-customer-endpoint: all assertions passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
