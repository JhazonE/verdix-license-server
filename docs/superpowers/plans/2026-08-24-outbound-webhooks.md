# Outbound License-Event Webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a license event happens (activation, status change, issue, revoke, reactivate, new customer), POST a signed JSON payload to that product's configured webhook URL, without ever blocking or failing the underlying operation.

**Architecture:** A new `src/webhooks.ts` module owns signing + fire-and-forget delivery with retry. Two new nullable columns (`webhook_url`, `webhook_secret`) are added to `products` via the existing idempotent column-migration pattern in `src/schema.ts`. Call sites in `src/service.ts` and `src/server.ts` call `sendWebhook(...)` after their existing DB writes/logs — never awaited, never able to throw outward. A new `POST /api/products/:id/webhook` endpoint lets the dashboard set/clear the URL and regenerate the secret; the existing per-product expandable panel in the dashboard gets a small webhook section.

**Tech Stack:** TypeScript, Node built-in `http`/`https`/`crypto` (no new dependencies — matches the existing codebase, which has zero HTTP client libraries), MySQL via the existing `query()` helper, `tsx` for running scripts/tests directly.

**Spec:** `docs/superpowers/specs/2026-08-24-outbound-webhooks-design.md`

## Global Constraints

- No new npm dependencies — use Node's built-in `http`/`https`/`crypto` modules, matching the rest of this codebase.
- Webhook delivery must never throw into or block the caller's request/response cycle (`/api/activate`, `/api/validate`, license issue/status endpoints, customer creation).
- Never send private key material or full signed license tokens in a webhook payload.
- Follow the existing idempotent migration pattern in `src/schema.ts` (`COLUMNS` array + `applyColumns()`) — do not hand-write a one-off `ALTER TABLE`.
- Follow the existing `tests/check-*.ts` convention (plain script, `tsx`-run, hits the real configured DB, prints `ok`/`FAIL` per check, exits non-zero on any failure) — no test framework to add.
- Log delivery failures via the existing `svc.log(...)` helper (table `activation_logs`), action `webhook.fail` — no new delivery-tracking table.

---

## Task 1: Schema — `webhook_url` / `webhook_secret` columns

**Files:**
- Modify: `src/schema.ts:137-152` (the `COLUMNS` array)
- Test: `tests/check-webhook-columns.ts` (new)

**Interfaces:**
- Produces: two new nullable columns on `products` — `webhook_url VARCHAR(500) NULL`, `webhook_secret VARCHAR(64) NULL` — that `src/products.ts`'s `Product` interface (Task 2) and `src/webhooks.ts` (Task 3) read.

- [ ] **Step 1: Add the two columns to the `COLUMNS` array**

In `src/schema.ts`, extend the array right after the existing `embed_marked` entry:

```ts
const COLUMNS: { table: string; column: string; sql: string }[] = [
  {
    table: 'licenses',
    column: 'product_id',
    sql: `ALTER TABLE licenses
            ADD COLUMN product_id VARCHAR(64) NOT NULL DEFAULT 'verdix-pos'`,
  },
  {
    table: 'products',
    column: 'embed_marked',
    sql: `ALTER TABLE products ADD COLUMN embed_marked JSON NULL`,
  },
  {
    table: 'products',
    column: 'webhook_url',
    // Destination for outbound license-event notifications. NULL = disabled.
    sql: `ALTER TABLE products ADD COLUMN webhook_url VARCHAR(500) NULL`,
  },
  {
    table: 'products',
    column: 'webhook_secret',
    // HMAC key used to sign webhook bodies. Generated server-side, never
    // accepted from client input (see products.ts setProductWebhook).
    sql: `ALTER TABLE products ADD COLUMN webhook_secret VARCHAR(64) NULL`,
  },
];
```

- [ ] **Step 2: Run the migration against the configured DB**

Run: `npm run migrate`
Expected: output includes `✓ column added: products.webhook_url` and `✓ column added: products.webhook_secret` (or `· column exists:` if already applied by a prior run of this same step).

- [ ] **Step 3: Write the column-existence test**

Create `tests/check-webhook-columns.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx tests/check-webhook-columns.ts`
Expected: `PASS: webhook_url / webhook_secret columns are correct.` with exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/schema.ts tests/check-webhook-columns.ts
git commit -m "feat(schema): add products.webhook_url and webhook_secret columns"
```

---

## Task 2: `src/products.ts` — expose and manage webhook config

**Files:**
- Modify: `src/products.ts`
- Test: `tests/check-webhook-config.ts` (new)

**Interfaces:**
- Consumes: `query()` from `src/db.ts` (`query<T>(sql: string, params?: any[]): Promise<T>`); `Product` interface currently in `src/products.ts:11-21`.
- Produces:
  - `Product.webhook_url: string | null` and `Product.webhook_secret: string | null` fields, read by `src/webhooks.ts` (Task 3) and `src/server.ts` call sites (Tasks 4-6).
  - `export async function setProductWebhook(id: string, url: string | null): Promise<Product>` — sets/clears the URL. Setting a non-empty URL when `webhook_secret` is currently null generates and stores a new secret; setting a URL when a secret already exists keeps the existing secret; clearing the URL (`null`) leaves the secret in place (so re-enabling doesn't silently change it) — returns the updated `Product` row.
  - `export async function regenerateWebhookSecret(id: string): Promise<Product>` — generates a fresh random secret for the product and returns the updated row, regardless of current URL state.

- [ ] **Step 1: Add the fields to the `Product` interface**

In `src/products.ts`, extend the interface at lines 11-21:

```ts
export interface Product {
  id: string;
  name: string;
  key_prefix: string;
  license_prefix: string;
  public_key: string | null;
  env_key_name: string;
  status: 'active' | 'inactive';
  /** Operator's embed mark, or null when never marked. See setup-status.ts. */
  embed_marked: EmbedMark | null;
  /** Destination for outbound license-event webhooks, or null when disabled. */
  webhook_url: string | null;
  /** HMAC-SHA256 key for signing webhook bodies. Never sent to clients. */
  webhook_secret: string | null;
}
```

- [ ] **Step 2: Add `setProductWebhook` and `regenerateWebhookSecret`**

Add near the end of `src/products.ts`, after `setProductEmbedMark`:

```ts
import crypto from 'crypto';

function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Set or clear a product's webhook URL. Generates a secret on first use;
 * clearing the URL leaves any existing secret in place so re-enabling later
 * doesn't silently rotate it out from under an already-configured receiver.
 */
export async function setProductWebhook(id: string, url: string | null): Promise<Product> {
  const trimmed = url?.trim() || null;
  const current = await getProduct(id);
  if (!current) throw new Error(`Unknown product "${id}".`);

  const needsSecret = trimmed && !current.webhook_secret;
  if (needsSecret) {
    await query(`UPDATE products SET webhook_url = ?, webhook_secret = ? WHERE id = ?`, [
      trimmed,
      generateWebhookSecret(),
      id.trim(),
    ]);
  } else {
    await query(`UPDATE products SET webhook_url = ? WHERE id = ?`, [trimmed, id.trim()]);
  }

  const updated = await getProduct(id);
  if (!updated) throw new Error(`Product "${id}" disappeared during update.`);
  return updated;
}

/** Rotate the HMAC secret. Signatures made with the old secret stop verifying. */
export async function regenerateWebhookSecret(id: string): Promise<Product> {
  const current = await getProduct(id);
  if (!current) throw new Error(`Unknown product "${id}".`);
  await query(`UPDATE products SET webhook_secret = ? WHERE id = ?`, [
    generateWebhookSecret(),
    id.trim(),
  ]);
  const updated = await getProduct(id);
  if (!updated) throw new Error(`Product "${id}" disappeared during update.`);
  return updated;
}
```

Note: move the `import crypto from 'crypto';` line to the top of the file with the other imports rather than inline — inline shown above only to make the diff location obvious.

- [ ] **Step 3: Write the test**

Create `tests/check-webhook-config.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx tests/check-webhook-config.ts`
Expected: `PASS: webhook config get/set/rotate are correct.` with exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/products.ts tests/check-webhook-config.ts
git commit -m "feat(products): manage per-product webhook URL and HMAC secret"
```

---

## Task 3: `src/webhooks.ts` — signing + fire-and-forget delivery with retry

**Files:**
- Create: `src/webhooks.ts`
- Test: `tests/check-webhooks.ts` (new)

**Interfaces:**
- Consumes: `Product` type from `src/products.ts` (Task 2, has `webhook_url: string | null`, `webhook_secret: string | null`); `log` from `src/service.ts` (`log(licenseId: string | null, machineId: string | null, action: string, detail?: string, ip?: string): Promise<void>`, at `src/service.ts:490`).
- Produces: `export function sendWebhook(product: Pick<Product, 'id' | 'webhook_url' | 'webhook_secret'>, event: string, data: object): void` — called by Tasks 4-6. Synchronous return (fire-and-forget internally), never throws, never returns a rejecting promise the caller could observe.
- Produces (for tests only): `export function computeSignature(secret: string, rawBody: string): string` — exported so the test can independently verify signatures without duplicating the HMAC logic.

- [ ] **Step 1: Write the failing test first**

Create `tests/check-webhooks.ts`. It starts a local mock HTTP server, points a fake product at it, and exercises success, retry-then-success, retry-exhaustion, and the disabled (`webhook_url: null`) no-op case.

```ts
import http from 'http';
import crypto from 'crypto';
import { sendWebhook, computeSignature } from '../src/webhooks';

function startMockServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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

  const secret = 'test-secret-abc123';

  // 1. computeSignature is a stable, verifiable HMAC-SHA256 of the raw body.
  {
    const body = '{"a":1}';
    const sig = computeSignature(secret, body);
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    check('computeSignature matches manual HMAC', sig === expected);
  }

  // 2. Successful single delivery: correct headers, correct body, correct signature.
  {
    let received: { headers: http.IncomingHttpHeaders; body: string } | null = null;
    const mock = await startMockServer((req, res, body) => {
      received = { headers: req.headers, body };
      res.writeHead(200);
      res.end('ok');
    });
    sendWebhook({ id: 'p1', webhook_url: mock.url, webhook_secret: secret }, 'license.activated', { licenseId: 'L1' });
    await sleep(300);
    await mock.close();

    check('request reached the mock server', received !== null);
    if (received) {
      const r: { headers: http.IncomingHttpHeaders; body: string } = received;
      check('X-Webhook-Event header set', r.headers['x-webhook-event'] === 'license.activated');
      const sigHeader = r.headers['x-webhook-signature'] as string;
      check('X-Webhook-Signature matches body', sigHeader === computeSignature(secret, r.body));
      const parsed = JSON.parse(r.body);
      check('body has event/productId/data', parsed.event === 'license.activated' && parsed.productId === 'p1' && parsed.data.licenseId === 'L1');
    }
  }

  // 3. Retry: first two attempts 500, third succeeds.
  {
    let attempts = 0;
    const mock = await startMockServer((req, res) => {
      attempts++;
      if (attempts < 3) {
        res.writeHead(500);
        res.end('fail');
      } else {
        res.writeHead(200);
        res.end('ok');
      }
    });
    sendWebhook({ id: 'p2', webhook_url: mock.url, webhook_secret: secret }, 'license.issued', { a: 1 });
    await sleep(8000); // 1s + 5s backoff plus request time
    await mock.close();
    check('retried until success (3 attempts)', attempts === 3);
  }

  // 4. Exhaustion: always fails, gives up after 3 attempts, never throws.
  {
    let attempts = 0;
    const mock = await startMockServer((req, res) => {
      attempts++;
      res.writeHead(500);
      res.end('fail');
    });
    let threw = false;
    try {
      sendWebhook({ id: 'p3', webhook_url: mock.url, webhook_secret: secret }, 'license.revoked', { a: 1 });
    } catch {
      threw = true;
    }
    await sleep(8000);
    await mock.close();
    check('sendWebhook call itself never throws', !threw);
    check('gave up after exactly 3 attempts', attempts === 3);
  }

  // 5. No-op when webhook_url is null — must not throw, must not hang.
  {
    let threw = false;
    try {
      sendWebhook({ id: 'p4', webhook_url: null, webhook_secret: null }, 'customer.created', {});
    } catch {
      threw = true;
    }
    check('no-op with null webhook_url does not throw', !threw);
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nPASS: webhook signing, delivery, retry and no-op behavior are correct.');
  process.exit(0);
}
main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx tests/check-webhooks.ts`
Expected: fails immediately with a module-not-found / import error for `../src/webhooks` (the module doesn't exist yet).

- [ ] **Step 3: Implement `src/webhooks.ts`**

```ts
/**
 * Outbound license-event webhooks. Delivery is fire-and-forget: callers never
 * await this and it never throws or rejects in a way a caller could observe —
 * a webhook failure must never break the license operation that triggered it.
 */
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { log } from './service';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 5000]; // delay before attempt 2 and attempt 3
const REQUEST_TIMEOUT_MS = 5000;

export function computeSignature(secret: string, rawBody: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postOnce(url: string, rawBody: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(
      parsed,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(rawBody) },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        res.resume(); // drain, we don't care about the response body
        resolve(res.statusCode || 0);
      }
    );
    req.on('timeout', () => req.destroy(new Error('webhook request timed out')));
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

async function deliverWithRetry(
  productId: string,
  url: string,
  event: string,
  rawBody: string,
  headers: Record<string, string>
): Promise<void> {
  let lastError = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1]);
    try {
      const status = await postOnce(url, rawBody, headers);
      if (status >= 200 && status < 300) return;
      lastError = `HTTP ${status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
  }

  const host = safeHost(url);
  await log(null, null, 'webhook.fail', `product=${productId} event=${event} url_host=${host} error=${lastError}`);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unparseable-url';
  }
}

export interface WebhookableProduct {
  id: string;
  webhook_url: string | null;
  webhook_secret: string | null;
}

/**
 * Fire a webhook for a license/customer event. No-op if the product has no
 * webhook_url configured. Never throws; delivery (including retry) happens
 * in the background after this function returns.
 */
export function sendWebhook(product: WebhookableProduct, event: string, data: object): void {
  if (!product.webhook_url || !product.webhook_secret) return;

  const rawBody = JSON.stringify({
    event,
    productId: product.id,
    timestamp: new Date().toISOString(),
    data,
  });
  const headers = {
    'Content-Type': 'application/json',
    'X-Webhook-Event': event,
    'X-Webhook-Signature': computeSignature(product.webhook_secret, rawBody),
  };

  deliverWithRetry(product.id, product.webhook_url, event, rawBody, headers).catch(() => {
    // deliverWithRetry already logs failures internally; this catch exists
    // only to guarantee nothing here can produce an unhandled rejection.
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx tests/check-webhooks.ts`
Expected: `PASS: webhook signing, delivery, retry and no-op behavior are correct.` with exit code 0. (This test takes ~16s due to the deliberate backoff delays — that's expected, not a hang.)

- [ ] **Step 5: Commit**

```bash
git add src/webhooks.ts tests/check-webhooks.ts
git commit -m "feat(webhooks): HMAC-signed fire-and-forget delivery with retry"
```

---

## Task 4: Wire `license.activated` and `license.status_changed` into the public POS endpoints

**Files:**
- Modify: `src/server.ts` (`/api/activate` handler, `src/server.ts:187-239`; `/api/validate` handler, `src/server.ts:245-265`)

**Interfaces:**
- Consumes: `sendWebhook` and `WebhookableProduct` from `src/webhooks.ts` (Task 3); `getProduct` from `src/products.ts` (already imported at `src/server.ts:36`); `svc.getLicense`, `svc.issueSignedLicense`, `svc.validateHeartbeat` (already used in this file).

- [ ] **Step 1: Import `sendWebhook`**

In `src/server.ts`, add to the imports near line 36-38:

```ts
import { sendWebhook } from './webhooks';
```

- [ ] **Step 2: Fire `license.activated` in `/api/activate`**

In the `/api/activate` handler (`src/server.ts:187-239`), after the existing `await svc.log(license.id, payload.machineId, 'activate.online', 'Online activation', ip);` line and before building the response, add:

```ts
      const activatedProduct = await getProduct(license.product_id);
      if (activatedProduct) {
        sendWebhook(activatedProduct, 'license.activated', {
          licenseId: license.id,
          machineId: payload.machineId,
          customer: payload.customer,
          edition: payload.edition,
        });
      }
```

- [ ] **Step 3: Fire `license.status_changed` in `/api/validate`**

In the `/api/validate` handler (`src/server.ts:245-265`), the status check needs the license's status *before* the heartbeat call for comparison. Replace the handler body with:

```ts
  if (method === 'POST' && p === '/api/validate') {
    try {
      const body = await readBody(req);
      const licenseId = String(body.licenseId || '').trim();
      const machineId = String(body.machineId || '').trim();
      if (!licenseId || !machineId)
        return sendJson(res, 400, { success: false, error: 'licenseId and machineId are required.' });

      const licenseBefore = await svc.getLicense(licenseId);
      const statusBefore = licenseBefore?.status;

      const result = await svc.validateHeartbeat(licenseId, machineId, {
        appVersion: body.appVersion,
        ip: clientIp(req),
      });
      const license = await svc.getLicense(licenseId);

      if (license && result.status !== statusBefore) {
        const product = await getProduct(license.product_id);
        if (product) {
          sendWebhook(product, 'license.status_changed', {
            licenseId,
            machineId,
            oldStatus: statusBefore || null,
            newStatus: result.status,
          });
        }
      }

      const cloudConfig =
        result.status === 'active' && license ? await cloudConfigFor(license) : undefined;
      return sendJson(res, 200, { success: true, ...result, ...(cloudConfig ? { cloudConfig } : {}) });
    } catch (e: any) {
      console.error('Validate error:', e);
      return sendJson(res, 500, { success: false, error: 'Validation failed on the server.' });
    }
  }
```

Note: `result.status` is a `HeartbeatStatus` (`'active'|'revoked'|'suspended'|'released'|'expired'|'invalid'`) while `statusBefore` is a `LicenseStatus` (`'active'|'suspended'|'revoked'`) — comparing them with `!==` is intentional and correct here: any heartbeat outcome that isn't literally `'active'` differing from a stored `'active'` status (or vice versa) is exactly the "something changed" signal the spec asks for.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Manual smoke test**

Run: `npm run server` in one terminal. In another, with a real active license/product-key already seeded (use an existing dev license or issue one via the dashboard first):

```bash
curl -s -X POST http://localhost:4100/api/activate \
  -H "Content-Type: application/json" \
  -d '{"productKey":"<existing product key>","machineId":"TEST-MACHINE-1"}'
```

Expected: HTTP response unchanged (still returns `signedLicense`/`info` as before) — this confirms the webhook call didn't alter or block the existing response, since no `webhook_url` is configured yet on this product (it silently no-ops per Task 3).

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat(webhooks): fire license.activated and license.status_changed"
```

---

## Task 5: Wire `license.issued`, `license.revoked`, `license.reactivated` into `service.ts`

**Files:**
- Modify: `src/service.ts` (`createLicense`, `src/service.ts:121-180`; `setLicenseStatus`, `src/service.ts:236-240`)

**Interfaces:**
- Consumes: `sendWebhook` from `src/webhooks.ts` (Task 3); `getProduct` (already imported at `src/service.ts:17`).
- Note: `src/webhooks.ts` imports `log` from `src/service.ts` (Task 3, Step 3) — `service.ts` importing `sendWebhook` from `webhooks.ts` here does NOT create a circular import problem in practice because `webhooks.ts` only calls `log` inside an async function body (not at module-eval time), but to keep the dependency direction clean or avoid any ambiguity, import `sendWebhook` from `webhooks.ts` at the top of `service.ts` the normal way — Node/TS module resolution handles this one-way-at-eval-time cycle fine since neither side uses the other's export before both modules finish loading.

- [ ] **Step 1: Import `sendWebhook`**

In `src/service.ts`, add to the imports near the top (after the `./products` import at line 17):

```ts
import { sendWebhook } from './webhooks';
```

- [ ] **Step 2: Fire `license.issued` in `createLicense`**

In `createLicense` (`src/service.ts:121-180`), the `product` variable is already fetched at line 143 (`const product = await getProduct(productId);`). After the existing `await log(id, null, 'license.created', ...)` line (line 176), add:

```ts
  await log(id, null, 'license.created', `Product key ${productKey} issued`);
  sendWebhook(product, 'license.issued', {
    licenseId: id,
    customerId: input.customer_id,
    productKey,
    edition: (input.edition || 'standard').trim(),
  });
  const created = await getLicense(id) as License;
```

- [ ] **Step 3: Fire `license.revoked` / `license.reactivated` in `setLicenseStatus`**

`setLicenseStatus` currently takes only `id` and the new `status` — it doesn't know the *previous* status or which product the license belongs to. Replace it:

```ts
export async function setLicenseStatus(id: string, status: LicenseStatus): Promise<void> {
  const before = await getLicense(id);
  await query(`UPDATE licenses SET status = ? WHERE id = ?`, [status, id]);
  cacheUpdateLicenseStatus(id, status);
  await log(id, null, 'license.' + status, `Status set to ${status}`);

  if (before && before.status !== status) {
    const product = await getProduct(before.product_id);
    if (product) {
      const event = status === 'revoked' ? 'license.revoked' : status === 'active' ? 'license.reactivated' : null;
      if (event) {
        sendWebhook(product, event, {
          licenseId: id,
          oldStatus: before.status,
          newStatus: status,
        });
      }
    }
  }
}
```

(A transition to `'suspended'` fires no webhook — the spec only defines `license.revoked` and `license.reactivated` events; suspension isn't in the event table, matching the spec exactly.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Manual verification via existing test**

Run: `npx tsx tests/check-multi-product.ts` (or another existing test that exercises `createLicense`/`setLicenseStatus`) to confirm nothing broke.
Expected: existing `PASS` output, unchanged from before this task.

- [ ] **Step 6: Commit**

```bash
git add src/service.ts
git commit -m "feat(webhooks): fire license.issued, license.revoked, license.reactivated"
```

---

## Task 6: Wire `customer.created` (multi-product fan-out)

**Files:**
- Modify: `src/service.ts` (`createCustomer`, `src/service.ts:80-103`)

**Interfaces:**
- Consumes: `sendWebhook` from `src/webhooks.ts` (already imported in Task 5, Step 1); `listProducts` — needs to be added to the `./products` import at `src/service.ts:17`.

- [ ] **Step 1: Import `listProducts`**

In `src/service.ts`, change line 17 from:

```ts
import { getProduct, DEFAULT_PRODUCT_ID } from './products';
```

to:

```ts
import { getProduct, listProducts, DEFAULT_PRODUCT_ID } from './products';
```

- [ ] **Step 2: Fan out `customer.created` to every product with a webhook configured**

In `createCustomer` (`src/service.ts:80-103`), replace the `return getCustomer(id) as Promise<Customer>;` line with:

```ts
  const created = (await getCustomer(id)) as Customer;

  const products = await listProducts();
  for (const product of products) {
    if (product.webhook_url) {
      sendWebhook(product, 'customer.created', {
        customerId: id,
        businessName: created.business_name,
      });
    }
  }

  return created;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Run: `npx tsx tests/check-products.ts` (exercises product listing) to confirm `listProducts` import didn't break anything.
Expected: existing `PASS` output.

- [ ] **Step 5: Commit**

```bash
git add src/service.ts
git commit -m "feat(webhooks): fan out customer.created to every product with a webhook"
```

---

## Task 7: `POST /api/products/:id/webhook` — dashboard config endpoint

**Files:**
- Modify: `src/server.ts` (add a new route near the existing product routes, after the `setup` route block around `src/server.ts:311-330`)

**Interfaces:**
- Consumes: `setProductWebhook`, `regenerateWebhookSecret` from `src/products.ts` (Task 2) — add both to the existing `./products` import at `src/server.ts:36`.
- Produces: `POST /api/products/:id/webhook` (auth required, inside the existing `/api/*` session-gated block).
  - Body `{ url: string | null }` → calls `setProductWebhook`, returns `{ success: true, data: { webhook_url, webhook_secret } }`.
  - Body `{ regenerateSecret: true }` → calls `regenerateWebhookSecret`, returns `{ success: true, data: { webhook_url, webhook_secret } }`.
  - Exactly one of `url` (including explicit `null` to clear) or `regenerateSecret: true` must be present; otherwise 400.

- [ ] **Step 1: Extend the products import**

In `src/server.ts`, change line 36 from:

```ts
import { listProducts, createProduct, getProduct, setProductEmbedMark } from './products';
```

to:

```ts
import { listProducts, createProduct, getProduct, setProductEmbedMark, setProductWebhook, regenerateWebhookSecret } from './products';
```

- [ ] **Step 2: Add the route**

In `src/server.ts`, inside the authenticated `/api/*` block, add this near the other `/api/products/:id/...` routes (right after the `setupMatch` block that starts at line 311):

```ts
      // POST /api/products/:id/webhook — set/clear the webhook URL, or rotate the secret.
      const webhookMatch = p.match(/^\/api\/products\/([^/]+)\/webhook$/);
      if (method === 'POST' && webhookMatch) {
        const id = decodeSegment(webhookMatch[1]);
        if (!id) return sendJson(res, 404, { success: false, error: 'Product not found.' });
        const product = await getProduct(id);
        if (!product) return sendJson(res, 404, { success: false, error: 'Product not found.' });

        const body = await readBody(req);
        const hasUrlField = Object.prototype.hasOwnProperty.call(body, 'url');
        const wantsRegenerate = body.regenerateSecret === true;
        if (hasUrlField === wantsRegenerate) {
          return sendJson(res, 400, {
            success: false,
            error: 'Provide exactly one of "url" or "regenerateSecret": true.',
          });
        }

        try {
          const updated = wantsRegenerate
            ? await regenerateWebhookSecret(id)
            : await setProductWebhook(id, body.url === null ? null : String(body.url || ''));
          return sendJson(res, 200, {
            success: true,
            data: { webhook_url: updated.webhook_url, webhook_secret: updated.webhook_secret },
          });
        } catch (e) {
          return sendJson(res, 400, { success: false, error: (e as Error).message });
        }
      }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual smoke test**

With `npm run server` running and logged in (grab the session cookie from a browser login, or use the dashboard's dev tools to copy it):

```bash
curl -s -X POST http://localhost:4100/api/products/verdix-pos/webhook \
  -H "Content-Type: application/json" -H "Cookie: lms_session=<paste session cookie>" \
  -d '{"url":"https://example.com/hook"}'
```

Expected: `{"success":true,"data":{"webhook_url":"https://example.com/hook","webhook_secret":"<64 hex chars>"}}`.

Then clear it again so the dev DB doesn't keep a dangling test webhook:

```bash
curl -s -X POST http://localhost:4100/api/products/verdix-pos/webhook \
  -H "Content-Type: application/json" -H "Cookie: lms_session=<paste session cookie>" \
  -d '{"url":null}'
```

Expected: `{"success":true,"data":{"webhook_url":null,"webhook_secret":"<same 64 hex chars as before>"}}`.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(api): add POST /api/products/:id/webhook to configure delivery"
```

---

## Task 8: Dashboard UI — webhook section in the product detail panel

**Files:**
- Modify: `public/app.js` (`renderSetupPanel`, `src/server.ts`'s counterpart in the frontend around `public/app.js:450+`; the `GET /api/products/:id/setup` response also needs the webhook fields — modify `src/server.ts:311-330` setup handler)

**Interfaces:**
- Consumes: `POST /api/products/:id/webhook` (Task 7); the existing `GET /api/products/:id/setup` response shape (Task 7 needs to add `webhookUrl`/`hasWebhookSecret` to it so the panel can render current state without a second round-trip).

- [ ] **Step 1: Read the current setup handler response shape**

Read `src/server.ts` around the `setupMatch` block (starts at line 311) to see exactly what fields `deriveEmbedState`/the JSON response include today, so the new fields are added consistently rather than guessed. (This step is read-only — confirm field names before Step 2.)

- [ ] **Step 2: Add webhook fields to the setup API response**

In `src/server.ts`, inside the `setupMatch` handler, find the `return sendJson(res, 200, { success: true, data: { ... } })` call and add two fields to the `data` object:

```ts
            webhookUrl: product.webhook_url,
            hasWebhookSecret: !!product.webhook_secret,
```

(Only a boolean for the secret — the secret value itself is never sent to the browser except immediately after being generated/rotated via the Task 7 endpoint's direct response.)

- [ ] **Step 3: Add a webhook section to `renderSetupPanel`**

In `public/app.js`, inside `renderSetupPanel(d)` (starts at line 450), add a new block after the existing setup steps and before the function's closing return statement. Read the function first to match its existing template-string style, then append:

```js
  const webhookSection = `<div class="setup-step" style="border-top:1px solid var(--border,#333);margin-top:12px;padding-top:12px">
    <div style="flex:1">
      <h4>Webhook</h4>
      <div class="note">POST license events to your own system. <a href="docs/app-integration.md" target="_blank">See event list</a>.</div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <input id="webhook-url-${esc(d.productId)}" type="text" placeholder="https://your-system.example/webhook"
               value="${esc(d.webhookUrl || '')}" style="flex:1" onclick="event.stopPropagation()">
        <button class="btn ghost sm" onclick="event.stopPropagation();saveProductWebhook('${esc(d.productId)}')">save</button>
      </div>
      ${d.hasWebhookSecret ? `<div style="margin-top:8px"><span class="muted" style="font-size:12px">Secret configured.</span> <button class="btn ghost sm" onclick="event.stopPropagation();regenerateProductWebhookSecret('${esc(d.productId)}')">regenerate secret</button></div>` : ''}
    </div>
  </div>`;
```

Then include `webhookSection` in the function's final returned template string (append it to whatever the function currently returns — read the existing return statement to splice it in correctly rather than guessing the surrounding markup).

- [ ] **Step 4: Add the JS handlers**

In `public/app.js`, near `loadProductSetup` (around line 409), add:

```js
async function saveProductWebhook(id) {
  const url = val('webhook-url-' + id);
  const res = await api('/api/products/' + encodeURIComponent(id) + '/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url.trim() || null }),
  });
  if (!res.success) { toast(res.error, 'error'); return; }
  toast(res.data.webhook_url ? 'Webhook saved.' : 'Webhook cleared.', 'success');
  delete setupCache[id];
  await loadProductSetup(id);
}

async function regenerateProductWebhookSecret(id) {
  const res = await api('/api/products/' + encodeURIComponent(id) + '/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ regenerateSecret: true }),
  });
  if (!res.success) { toast(res.error, 'error'); return; }
  toast('New secret: ' + res.data.webhook_secret, 'success', 'Webhook Secret Rotated');
  delete setupCache[id];
  await loadProductSetup(id);
}
```

(`val()` and `api()` are existing helpers already used throughout `app.js` — confirm their exact signatures by reading their definitions near the top of the file before wiring this in, in case argument order differs from other call sites.)

- [ ] **Step 5: Manual browser test**

Run: `npm run server`, open `http://localhost:4100`, log in, go to Products, click a product row to expand it. Confirm:
- The webhook URL field appears and is empty initially.
- Typing a URL and clicking "save" shows a success toast and the field persists the value after a page reload.
- A "regenerate secret" button appears once a URL has been saved, and clicking it shows the new secret in a toast.
- Clearing the field and saving shows "Webhook cleared."

- [ ] **Step 6: Commit**

```bash
git add public/app.js src/server.ts
git commit -m "feat(dashboard): configure per-product webhook URL and secret"
```

---

## Task 9: Update documentation

**Files:**
- Modify: `docs/app-integration.md`

**Interfaces:**
- None (documentation only).

- [ ] **Step 1: Read the current doc structure**

Read `docs/app-integration.md` to find where license events / activation / heartbeat are already documented, so the new section fits the existing structure rather than being bolted on awkwardly.

- [ ] **Step 2: Add a "Webhooks" section**

Add a new section (mirroring the existing doc's heading style) covering:
- The six events (`license.activated`, `license.status_changed`, `license.issued`, `license.revoked`, `license.reactivated`, `customer.created`) and when each fires — copy the table from `docs/superpowers/specs/2026-08-24-outbound-webhooks-design.md`'s "Events" section.
- The payload shape: `{ event, productId, timestamp, data }`.
- How to verify `X-Webhook-Signature` (`sha256=<hex>` = HMAC-SHA256 of the raw request body using the product's secret) with a short Node example using `crypto.createHmac`.
- Where to configure the URL and see/rotate the secret (dashboard → Products → expand a product row).
- That delivery retries up to 3 times with fixed backoff and gives up silently (logged server-side) — so receivers should be idempotent (an event may arrive more than once if an earlier attempt's response was lost even though it technically succeeded).

- [ ] **Step 3: Commit**

```bash
git add docs/app-integration.md
git commit -m "docs: document outbound license-event webhooks"
```

---

## Task 10: Full regression pass

**Files:** none modified — verification only.

**Interfaces:** none.

- [ ] **Step 1: Typecheck the whole project**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Run every `check-*.ts` test**

Run each of the following in turn (they hit the real configured DB, matching this repo's existing convention — there is no batch test runner script):

```bash
npx tsx tests/check-embed-column.ts
npx tsx tests/check-key-source.ts
npx tsx tests/check-keys.ts
npx tsx tests/check-multi-product.ts
npx tsx tests/check-prefix-isolation.ts
npx tsx tests/check-products.ts
npx tsx tests/check-setup-api.ts
npx tsx tests/check-setup-status.ts
npx tsx tests/verify-legacy.ts
npx tsx tests/check-webhook-columns.ts
npx tsx tests/check-webhook-config.ts
npx tsx tests/check-webhooks.ts
```

Expected: every one prints a `PASS:` line and exits 0.

- [ ] **Step 3: Report**

No commit for this task — it's a verification checkpoint. If anything fails, stop and fix it before considering the plan complete.

---

## Spec coverage check (self-review)

- Schema (`webhook_url`, `webhook_secret`) → Task 1. ✓
- Delivery module: signing, retry, no-throw, no-op when unset → Task 3. ✓
- All six events → Tasks 4, 5, 6. ✓
- Never send private key material / signed license tokens → payloads in Tasks 4-6 only include IDs/status/customer name/edition, verified against the spec's explicit list. ✓
- Dashboard UI to configure URL + view/rotate secret → Tasks 7, 8. ✓
- Testing convention → Tasks 1, 2, 3 each add a `check-*.ts` test; Task 10 runs them all. ✓
- Documentation → Task 9. ✓
