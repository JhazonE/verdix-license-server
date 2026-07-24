import { readFileSync } from 'fs';
import path from 'path';
import { verifyLicenseSignature } from '../src/licensing/core';

const pub = readFileSync(path.join(__dirname, '..', 'keys', 'public-key.pem'), 'utf8');
const token = readFileSync(path.join(__dirname, 'fixtures', 'legacy-token.txt'), 'utf8').trim();

const good: any = verifyLicenseSignature(token, pub, 'VRDX1');
if (!good.valid) { console.error('FAIL: VRDX1 should verify —', good.reason); process.exit(1); }

const bad: any = verifyLicenseSignature(token, pub, 'OTHER1');
if (bad.valid) { console.error('FAIL: OTHER1 prefix should NOT verify'); process.exit(1); }
if (bad.reason !== 'malformed-key') { console.error('FAIL: wrong reason', bad.reason); process.exit(1); }

console.log('PASS: prefix is enforced (VRDX1 ok, OTHER1 rejected).');
