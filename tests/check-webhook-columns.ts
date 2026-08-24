import { query } from '../src/db';

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

  const cols = await query<any[]>(
    `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products'
        AND COLUMN_NAME IN ('webhook_url', 'webhook_secret')`
  );
  const byName = Object.fromEntries(cols.map((c) => [c.COLUMN_NAME, c]));

  check('products.webhook_url exists', !!byName.webhook_url);
  check('webhook_url is varchar(500)', byName.webhook_url?.CHARACTER_MAXIMUM_LENGTH === 500);
  check('products.webhook_secret exists', !!byName.webhook_secret);
  check('webhook_secret is varchar(64)', byName.webhook_secret?.CHARACTER_MAXIMUM_LENGTH === 64);

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nPASS: webhook_url / webhook_secret columns are correct.');
  process.exit(0);
}
main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
