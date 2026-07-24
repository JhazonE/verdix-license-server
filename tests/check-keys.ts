import { getPrivateKeyPem } from '../src/keys';
import { getProduct, DEFAULT_PRODUCT_ID } from '../src/products';

async function main() {
  const noArg = getPrivateKeyPem();
  if (!noArg.includes('BEGIN PRIVATE KEY')) { console.error('FAIL: default path'); process.exit(1); }

  const product = await getProduct(DEFAULT_PRODUCT_ID);
  if (!product) { console.error('FAIL: verdix-pos missing'); process.exit(1); }
  const viaProduct = getPrivateKeyPem(product);

  if (noArg.trim() !== viaProduct.trim()) {
    console.error('FAIL: verdix-pos resolves a DIFFERENT key than the default path');
    process.exit(1);
  }
  console.log('PASS: verdix-pos resolves the same key as the legacy default path.');
  process.exit(0);
}
main();
