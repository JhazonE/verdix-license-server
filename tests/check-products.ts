import { getProduct, listProducts, DEFAULT_PRODUCT_ID } from '../src/products';

async function main() {
  const p = await getProduct(DEFAULT_PRODUCT_ID);
  if (!p) { console.error('FAIL: verdix-pos product missing'); process.exit(1); }
  if (p.key_prefix !== 'VRDX' || p.license_prefix !== 'VRDX1') {
    console.error('FAIL: wrong prefixes', p.key_prefix, p.license_prefix); process.exit(1);
  }
  if (p.env_key_name !== 'LICENSE_PRIVATE_KEY') {
    console.error('FAIL: wrong env_key_name', p.env_key_name); process.exit(1);
  }
  const all = await listProducts();
  console.log('PASS: verdix-pos registered.', all.length, 'product(s).');
  process.exit(0);
}
main();
