import { readFileSync } from 'fs';
import path from 'path';
import assert from 'assert';

// The /api/activate and /api/validate handlers must never attach tenant DB
// credentials (cloudConfig). The POS never read them, so no code path may
// produce one. Asserted on source text because the handlers need live MySQL
// and a signing key to exercise.
const src = readFileSync(path.join(__dirname, '..', 'src', 'server.ts'), 'utf8');

assert.ok(
  !src.includes('cloudConfigFor'),
  'FAIL: src/server.ts still contains "cloudConfigFor" (the helper that looks up tenant DB credentials)'
);
assert.ok(
  !/cloudConfig/.test(src),
  'FAIL: src/server.ts still references "cloudConfig" (credentials would be attached to an API response)'
);

console.log('PASS: src/server.ts no longer references cloudConfigFor or cloudConfig.');
