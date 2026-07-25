import fs from 'fs';
import path from 'path';
import { getPrivateKeySource, getPrivateKeyPem } from '../src/keys';
import type { Product } from '../src/products';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    console.error('  FAIL ' + name);
    failures++;
  }
}

function fakeProduct(id: string, envKeyName: string): Product {
  return {
    id,
    name: id,
    key_prefix: 'TST',
    license_prefix: 'TST1',
    public_key: null,
    env_key_name: envKeyName,
    status: 'active',
  } as Product;
}

// A syntactically valid Ed25519 private key PEM for the env-var path.
const { privateKey } = require('crypto').generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// ── source: 'none' ───────────────────────────────────────────────────────────
// A product id that has no keys/<id>/ directory and no env var set.
const missing = fakeProduct('zzz-nonexistent-product', 'ZZZ_NO_SUCH_ENV_VAR');
delete process.env.ZZZ_NO_SUCH_ENV_VAR;
check("no env var and no file => 'none'", getPrivateKeySource(missing) === 'none');

// ── source: 'env' ────────────────────────────────────────────────────────────
process.env.ZZZ_TEST_PRIVATE_KEY = privateKey;
const viaEnv = fakeProduct('zzz-env-product', 'ZZZ_TEST_PRIVATE_KEY');
check("env var set => 'env'", getPrivateKeySource(viaEnv) === 'env');
// An env var without a PEM body must not count — getPrivateKeyPem requires
// 'BEGIN', so the reported source has to apply the same test.
process.env.ZZZ_TEST_EMPTY = 'not-a-pem';
const viaBadEnv = fakeProduct('zzz-bad-env-product', 'ZZZ_TEST_EMPTY');
check("env var without BEGIN => 'none'", getPrivateKeySource(viaBadEnv) === 'none');

// ── source: 'local-file' ─────────────────────────────────────────────────────
// verdix-pos keeps the flat keys/private-key.pem layout, so it exercises the
// file path in a real checkout.
const flatPem = path.join(__dirname, '..', 'keys', 'private-key.pem');
if (fs.existsSync(flatPem)) {
  const posProduct = fakeProduct('verdix-pos', 'ZZZ_UNSET_FOR_THIS_CHECK');
  delete process.env.ZZZ_UNSET_FOR_THIS_CHECK;
  check("file present, no env => 'local-file'", getPrivateKeySource(posProduct) === 'local-file');

  // The reported source must agree with what signing actually resolves.
  let resolved = false;
  try {
    resolved = getPrivateKeyPem(posProduct).includes('BEGIN PRIVATE KEY');
  } catch {
    resolved = false;
  }
  check('source agrees with getPrivateKeyPem', resolved === true);
} else {
  console.log("  skip 'local-file' checks — no keys/private-key.pem in this checkout");
}

// ── Cache must not mask the source ───────────────────────────────────────────
// getPrivateKeyPem populates a module cache keyed by product id that stores
// only the PEM. Reading the source after that must still be correct.
process.env.ZZZ_CACHE_TEST = privateKey;
const cacheProduct = fakeProduct('zzz-cache-product', 'ZZZ_CACHE_TEST');
getPrivateKeyPem(cacheProduct); // populates the cache
check("source still 'env' after cache fill", getPrivateKeySource(cacheProduct) === 'env');

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nPASS: private key source reporting is correct.');
process.exit(0);
