import { query } from '../src/db';
import { getProduct, setProductEmbedMark, DEFAULT_PRODUCT_ID } from '../src/products';
import type { EmbedMark } from '../src/setup-status';

async function main() {
  let failures = 0;
  function check(name: string, cond: boolean) {
    if (cond) {
      console.log('  ok   ' + name);
    } else {
      console.error('  FAIL ' + name);
      failures++;
    }
  }

  // The column must exist after migrate.
  const cols = await query<any[]>(
    `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products'
        AND COLUMN_NAME = 'embed_marked'`
  );
  check('products.embed_marked exists', cols.length === 1);
  check('embed_marked is JSON', cols.length === 1 && cols[0].DATA_TYPE === 'json');

  // Round-trip a mark through the DB, then restore whatever was there before so
  // this test leaves no trace.
  const before = await getProduct(DEFAULT_PRODUCT_ID);
  if (!before) {
    console.error('FAIL: verdix-pos product missing — run migrate first');
    process.exit(1);
  }
  const original = before.embed_marked;

  const mark: EmbedMark = { at: '2026-07-25T10:00:00Z', by: 'test-runner', key_fp: 'abc123def456789a' };
  try {
    await setProductEmbedMark(DEFAULT_PRODUCT_ID, mark);
    const marked = await getProduct(DEFAULT_PRODUCT_ID);
    check('mark round-trips', JSON.stringify(marked?.embed_marked) === JSON.stringify(mark));

    await setProductEmbedMark(DEFAULT_PRODUCT_ID, null);
    const cleared = await getProduct(DEFAULT_PRODUCT_ID);
    check('mark clears to null', cleared?.embed_marked == null);
  } finally {
    await setProductEmbedMark(DEFAULT_PRODUCT_ID, original);
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nPASS: embed_marked column and round-trip are correct.');
  process.exit(0);
}
main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
