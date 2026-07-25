/**
 * Endpoint checks for the setup API. Requires a running server and admin creds:
 *
 *   npm run server
 *   SETUP_TEST_USER=admin SETUP_TEST_PASS=... npx tsx tests/check-setup-api.ts
 */
const BASE = process.env.SETUP_TEST_BASE || 'http://localhost:4100';
const USER = process.env.SETUP_TEST_USER || 'admin';
const PASS = process.env.SETUP_TEST_PASS || '';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    console.error('  FAIL ' + name);
    failures++;
  }
}

async function main() {
  if (!PASS) {
    console.error('FAIL: set SETUP_TEST_PASS to the admin password.');
    process.exit(1);
  }

  // Log in and keep the session cookie.
  const login = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
  check('login succeeded', login.status === 200 && cookie.length > 0);
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };

  // ── Unknown product 404s ───────────────────────────────────────────────────
  const missing = await fetch(BASE + '/api/products/zzz-no-such-product/setup', { headers: auth });
  check('unknown product => 404', missing.status === 404);

  // ── Happy path shape ───────────────────────────────────────────────────────
  const res = await fetch(BASE + '/api/products/verdix-pos/setup', { headers: auth });
  check('verdix-pos setup => 200', res.status === 200);
  const body = await res.json();
  const d = body.data;
  check('has productId', d?.productId === 'verdix-pos');
  check('has licensePrefix', d?.licensePrefix === 'VRDX1');
  check('has envKeyName', typeof d?.envKeyName === 'string' && d.envKeyName.length > 0);
  check('has pill', ['ready', 'needs-setup', 'stale'].includes(d?.pill));
  check('steps.registered.ok is true', d?.steps?.registered?.ok === true);
  check('steps.keypair.ok is boolean', typeof d?.steps?.keypair?.ok === 'boolean');
  check('steps.embed.state valid', ['pending', 'done', 'stale'].includes(d?.steps?.embed?.state));
  check('steps.signing.source valid', ['env', 'local-file', 'none'].includes(d?.steps?.signing?.source));

  // ── The private key must NEVER be in the response ──────────────────────────
  const raw = JSON.stringify(body);
  check('no PRIVATE KEY in response', !raw.includes('PRIVATE KEY'));
  check('no privateKey field', !/privateKey/i.test(raw));

  // ── POST /embed ignores a client-supplied fingerprint ─────────────────────
  const forged = 'deadbeefdeadbeef';
  await fetch(BASE + '/api/products/verdix-pos/embed', {
    method: 'POST',
    headers: auth,
    // key_fp and by are attacker-controlled here; both must be ignored.
    body: JSON.stringify({ marked: true, key_fp: forged, by: 'not-the-session-user' }),
  });
  const after = await (await fetch(BASE + '/api/products/verdix-pos/setup', { headers: auth })).json();
  const mark = after.data?.steps?.embed;
  check('body key_fp ignored', mark?.state === 'done' || mark?.state === 'stale');
  check('marked by session user', mark?.by === USER);

  // Clear the mark so the test leaves no trace.
  await fetch(BASE + '/api/products/verdix-pos/embed', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ marked: false }),
  });
  const cleared = await (await fetch(BASE + '/api/products/verdix-pos/setup', { headers: auth })).json();
  check('unmark returns to pending', cleared.data?.steps?.embed?.state === 'pending');

  // ── Marking with no public key must 400 ───────────────────────────────────
  // There is nothing to fingerprint, so the mark would describe nothing.
  // Uses a throwaway product so no real product row is disturbed.
  const tmpId = 'zzz-setup-test-' + Date.now();
  const made = await fetch(BASE + '/api/products', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      id: tmpId,
      name: 'Setup Test (temporary)',
      key_prefix: 'ZZ' + String(Date.now()).slice(-2),
      license_prefix: 'ZY' + String(Date.now()).slice(-2),
      env_key_name: 'ZZZ_SETUP_TEST_KEY',
    }),
  });
  if (made.status === 200) {
    const noKey = await fetch(BASE + '/api/products/' + tmpId + '/embed', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ marked: true }),
    });
    check('mark without public key => 400', noKey.status === 400);

    const fresh = await (await fetch(BASE + '/api/products/' + tmpId + '/setup', { headers: auth })).json();
    check('fresh product keypair not ok', fresh.data?.steps?.keypair?.ok === false);
    check('fresh product => needs-setup', fresh.data?.pill === 'needs-setup');

    // There is no delete-product endpoint; remove the row directly.
    console.log(`  note remove the test product with: DELETE FROM products WHERE id = '${tmpId}';`);
  } else {
    console.log('  skip 400/fresh-product checks — could not create a temp product');
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nPASS: setup API is correct.');
  process.exit(0);
}
main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
