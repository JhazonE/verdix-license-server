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
// Strip line comments so a mention in a comment cannot satisfy an assertion.
const handlerSrc = src.slice(start, end).replace(/^\s*\/\/.*$/gm, '');

// The mint is gated on subscription
assert.match(handlerSrc, /type\s*===\s*'subscription'/, 'FAIL: mint is not gated on type === subscription');
// It signs for the HOSTED sentinel, not a hardcoded string
assert.match(handlerSrc, /HOSTED_MACHINE_ID/, 'FAIL: HOSTED_MACHINE_ID not used');
assert.ok(!/'HOSTED'/.test(handlerSrc), 'FAIL: hardcoded HOSTED');
// It records the activation, so the token can be recovered later
assert.match(handlerSrc, /record:\s*true/, 'FAIL: mint does not pass record: true');
assert.match(handlerSrc, /hostedTokenError/, 'FAIL: hostedTokenError missing');

// Re-read before signing (createLicense returns a stale in-memory snapshot)
const reread = handlerSrc.search(/svc\.getLicense\(/);
const sign = handlerSrc.search(/svc\.issueSignedLicense\(/);
assert.ok(reread >= 0 && sign >= 0 && reread < sign, 'FAIL: re-read (getLicense) must come before issueSignedLicense');
assert.match(handlerSrc, /svc\.issueSignedLicense\(\s*fresh\s*,/, 'FAIL: issueSignedLicense must sign the re-read licence (fresh), not the in-memory one');
// Fallback to the in-memory licence if the re-read returns nothing
assert.match(handlerSrc, /svc\.getLicense\([^)]*\)\)\s*\|\|\s*lic\b/, 'FAIL: re-read lacks the "|| lic" fallback');

// Error isolation: the try wraps only the mint, so it must open after createLicense completes
const created = /await svc\.createLicense\(\{[\s\S]*?\}\);/.exec(handlerSrc);
assert.ok(created, 'FAIL: createLicense call not found');
const tryAt = handlerSrc.search(/\btry\s*\{/);
assert.ok(tryAt >= created.index + created[0].length, 'FAIL: try must open after createLicense (a mint failure must not lose the licence)');
assert.ok(tryAt < reread, 'FAIL: re-read and mint must be inside the try');

// Contract: hostedLicenseKey is only ever assigned conditionally, never declared in an object literal
// (which would put hostedLicenseKey: undefined on perpetual licence responses)
assert.ok(!/hostedLicenseKey\s*:/.test(handlerSrc), 'FAIL: hostedLicenseKey declared in an object literal; it must be assigned only for subscriptions');
assert.ok(!/hostedTokenError\s*:/.test(handlerSrc), 'FAIL: hostedTokenError declared in an object literal; it must be assigned only on failure');
const assignKey = handlerSrc.search(/\.hostedLicenseKey\s*=/);
const subAt = handlerSrc.search(/type\s*===\s*'subscription'/);
assert.ok(assignKey > subAt && subAt >= 0, 'FAIL: hostedLicenseKey must be assigned inside the subscription branch');

console.log('PASS: POST /api/licenses mints a hosted token for subscriptions.');
