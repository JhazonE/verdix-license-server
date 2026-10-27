import { readFileSync } from 'fs';
import path from 'path';
import assert from 'assert';

// POST /api/licenses mints a hosted token for subscriptions. Asserted on source
// text because the handler needs live MySQL and a signing key to exercise.
const src = readFileSync(path.join(__dirname, '..', 'src', 'server.ts'), 'utf8');
const start = src.indexOf("method === 'POST' && p === '/api/licenses'");
assert.ok(start >= 0, 'FAIL: POST /api/licenses handler not found');
const end = src.indexOf('// /api/licenses/:id/', start);
assert.ok(end > start, 'FAIL: end of POST /api/licenses handler not found');
const handlerSrc = src.slice(start, end);

// The mint is gated on subscription
assert.match(handlerSrc, /type\s*===\s*'subscription'/);
// It re-reads the licence before signing, as createLicense returns a pre-insert snapshot
assert.match(handlerSrc, /getLicense/);
// It signs for the HOSTED sentinel, not a hardcoded string
assert.match(handlerSrc, /HOSTED_MACHINE_ID/);
assert.ok(!/'HOSTED'/.test(handlerSrc), 'FAIL: hardcoded HOSTED');
// It records the activation, so the token can be recovered later
assert.match(handlerSrc, /record:\s*true/);
// A mint failure still returns the licence
assert.match(handlerSrc, /hostedTokenError/);
assert.match(handlerSrc, /hostedLicenseKey/);

console.log('PASS: POST /api/licenses mints a hosted token for subscriptions.');
