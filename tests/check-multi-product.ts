import { readFileSync } from 'fs';
import path from 'path';
import { signLicense, verifyLicenseSignature, LICENSE_FORMAT_VERSION } from '../src/licensing/core';
import { getPrivateKeyPem } from '../src/keys';
import { getProduct } from '../src/products';

function pub(rel: string): string {
  return readFileSync(path.join(__dirname, '..', 'keys', rel), 'utf8');
}

async function main() {
  const verdix = await getProduct('verdix-pos');
  const testApp = await getProduct('test-app');
  if (!verdix || !testApp) { console.error('FAIL: products missing'); process.exit(1); }

  const payload = {
    v: LICENSE_FORMAT_VERSION,
    lid: 'test-lid',
    product: 'test-app',
    customer: 'Isolation Test',
    edition: 'standard',
    machineId: 'ISOLATION1',
    issued: new Date().toISOString(),
    expires: null,
    features: [],
  };

  const token = signLicense(payload, getPrivateKeyPem(testApp), testApp.license_prefix);

  if (!token.startsWith('TSTA1.')) {
    console.error('FAIL: expected TSTA1 prefix, got', token.split('.')[0]); process.exit(1);
  }

  const own: any = verifyLicenseSignature(token, pub('test-app/public-key.pem'), 'TSTA1');
  if (!own.valid) { console.error('FAIL: test-app token did not verify —', own.reason); process.exit(1); }

  // The critical isolation check: the Verdix key must NOT validate it.
  const cross: any = verifyLicenseSignature(token, pub('public-key.pem'), 'TSTA1');
  if (cross.valid) {
    console.error('FAIL: SECURITY — Verdix public key validated a test-app license');
    process.exit(1);
  }

  // And a Verdix token must not pass under the test-app prefix.
  const legacy = readFileSync(path.join(__dirname, 'fixtures', 'legacy-token.txt'), 'utf8').trim();
  const wrongPrefix: any = verifyLicenseSignature(legacy, pub('public-key.pem'), 'TSTA1');
  if (wrongPrefix.valid) { console.error('FAIL: prefix not enforced'); process.exit(1); }

  console.log('PASS: products are isolated —', cross.reason, '/', wrongPrefix.reason);
  process.exit(0);
}
main();
