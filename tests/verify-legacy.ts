import { readFileSync } from 'fs';
import path from 'path';
import { verifyLicenseSignature, PRODUCT_ID, KEY_PREFIX } from '../src/licensing/core';

const pub = readFileSync(path.join(__dirname, '..', 'keys', 'public-key.pem'), 'utf8');
const token = readFileSync(path.join(__dirname, 'fixtures', 'legacy-token.txt'), 'utf8').trim();

const res: any = verifyLicenseSignature(token, pub);
if (!res.valid) {
  console.error('FAIL: legacy token did not verify —', res.reason);
  process.exit(1);
}
if (res.payload.product !== 'verdix-pos') {
  console.error('FAIL: unexpected product', res.payload.product);
  process.exit(1);
}
if (!token.startsWith(KEY_PREFIX + '.')) {
  console.error('FAIL: unexpected prefix');
  process.exit(1);
}
console.log('PASS: legacy token verifies. product =', res.payload.product, '| PRODUCT_ID =', PRODUCT_ID);
