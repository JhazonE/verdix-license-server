import {
  publicKeyFingerprint,
  deriveEmbedState,
  deriveSetupPill,
  EmbedMark,
} from '../src/setup-status';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    console.error('  FAIL ' + name);
    failures++;
  }
}

const PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=',
  '-----END PUBLIC KEY-----',
].join('\n');

// ── Fingerprint normalization ────────────────────────────────────────────────
// These all describe the SAME key. A PEM round-trips through MySQL, the
// clipboard, and env vars containing literal \n, so cosmetic differences must
// never change the fingerprint — otherwise a rotation is falsely reported.
const base = publicKeyFingerprint(PEM);
check('fingerprint is 16 hex chars', /^[0-9a-f]{16}$/.test(base));
check('trailing newline ignored', publicKeyFingerprint(PEM + '\n') === base);
check('leading/trailing space ignored', publicKeyFingerprint('  ' + PEM + '  ') === base);
check('CRLF ignored', publicKeyFingerprint(PEM.replace(/\n/g, '\r\n')) === base);
check('literal backslash-n ignored', publicKeyFingerprint(PEM.replace(/\n/g, '\\n')) === base);
check('internal blank lines ignored', publicKeyFingerprint(PEM.replace(/\n/g, '\n\n')) === base);

// A genuinely different key must produce a different fingerprint.
const OTHER = PEM.replace('Gb9ECWmEzf6F', 'Zz9ECWmEzf6F');
check('different key differs', publicKeyFingerprint(OTHER) !== base);

// ── Embed state ──────────────────────────────────────────────────────────────
const markMatching: EmbedMark = { at: '2026-07-25T10:00:00Z', by: 'admin', key_fp: base };
const markOther: EmbedMark = { at: '2026-07-24T10:00:00Z', by: 'admin', key_fp: 'ffffffffffffffff' };

check('no mark => pending', deriveEmbedState(PEM, null) === 'pending');
check('matching fp => done', deriveEmbedState(PEM, markMatching) === 'done');
check('mismatched fp => stale', deriveEmbedState(PEM, markOther) === 'stale');
// Whitespace drift in the stored PEM must not fake a rotation.
check('done survives whitespace drift', deriveEmbedState(PEM + '\n', markMatching) === 'done');
// No key to embed means the step cannot be complete.
check('null key + mark => stale', deriveEmbedState(null, markMatching) === 'stale');
check('null key + no mark => pending', deriveEmbedState(null, null) === 'pending');

// ── Setup pill (first match wins: stale > needs-setup > ready) ────────────────
check('stale embed => stale pill',
  deriveSetupPill({ hasKeypair: true, source: 'env', embed: 'stale' }) === 'stale');
check('stale wins over missing keypair',
  deriveSetupPill({ hasKeypair: false, source: 'none', embed: 'stale' }) === 'stale');
check('no keypair => needs-setup',
  deriveSetupPill({ hasKeypair: false, source: 'env', embed: 'done' }) === 'needs-setup');
check('no signing key => needs-setup',
  deriveSetupPill({ hasKeypair: true, source: 'none', embed: 'done' }) === 'needs-setup');
check('pending embed => needs-setup',
  deriveSetupPill({ hasKeypair: true, source: 'env', embed: 'pending' }) === 'needs-setup');
check('all done => ready',
  deriveSetupPill({ hasKeypair: true, source: 'env', embed: 'done' }) === 'ready');
// local-file still counts as ready: the server cannot tell "not deployed to
// Railway" from "deployed, but I'm looking at a local dashboard".
check('local-file still ready',
  deriveSetupPill({ hasKeypair: true, source: 'local-file', embed: 'done' }) === 'ready');

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nPASS: setup-status derivation is correct.');
process.exit(0);
