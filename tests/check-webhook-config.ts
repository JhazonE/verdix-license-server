import { getProduct, setProductWebhook, regenerateWebhookSecret, DEFAULT_PRODUCT_ID } from '../src/products';

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

  const before = await getProduct(DEFAULT_PRODUCT_ID);
  if (!before) {
    console.error('FAIL: verdix-pos product missing — run migrate first');
    process.exit(1);
  }
  const originalUrl = before.webhook_url;
  const originalSecret = before.webhook_secret;

  try {
    const set1 = await setProductWebhook(DEFAULT_PRODUCT_ID, 'https://example.com/hook');
    check('webhook_url set', set1.webhook_url === 'https://example.com/hook');
    check('webhook_secret generated', !!set1.webhook_secret && set1.webhook_secret.length === 64);

    const secretAfterFirstSet = set1.webhook_secret;
    const set2 = await setProductWebhook(DEFAULT_PRODUCT_ID, 'https://example.com/hook2');
    check('webhook_secret unchanged on URL update', set2.webhook_secret === secretAfterFirstSet);

    const cleared = await setProductWebhook(DEFAULT_PRODUCT_ID, null);
    check('webhook_url clears to null', cleared.webhook_url === null);
    check('webhook_secret survives clearing the URL', cleared.webhook_secret === secretAfterFirstSet);

    const rotated = await regenerateWebhookSecret(DEFAULT_PRODUCT_ID);
    check('regenerateWebhookSecret changes the secret', rotated.webhook_secret !== secretAfterFirstSet);
    check('regenerateWebhookSecret keeps a 64-char hex secret', rotated.webhook_secret!.length === 64);
  } finally {
    await query_restore(originalUrl, originalSecret);
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nPASS: webhook config get/set/rotate are correct.');
  process.exit(0);
}

// Restore exact original values directly (setProductWebhook's secret-preserving
// logic can't reproduce an arbitrary original pairing of url+secret).
async function query_restore(url: string | null, secret: string | null) {
  const { query } = await import('../src/db');
  await query(`UPDATE products SET webhook_url = ?, webhook_secret = ? WHERE id = ?`, [
    url,
    secret,
    DEFAULT_PRODUCT_ID,
  ]);
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
