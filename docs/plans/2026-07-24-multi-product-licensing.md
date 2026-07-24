# Multi-Product Licensing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the license server issue and validate licenses for any product — not just Verdix POS — without breaking a single already-issued license.

**Architecture:** Add a `products` registry table and a `licenses.product_id` column defaulting to `'verdix-pos'` (so existing rows migrate silently). Turn the `PRODUCT_ID` / `KEY_PREFIX` constants in `src/licensing/core.ts` into parameters. Resolve the signing key per product via a `products.env_key_name` indirection. Dashboard and CLI gain product selection. The wire format is unchanged, so deployed apps need no update.

**Tech Stack:** Node 20, TypeScript, tsx, mysql2, Ed25519 (Node `crypto`), vanilla-JS dashboard.

## Global Constraints

- **Backward compatibility is the hard requirement.** A `VRDX1.` token issued before this work MUST still verify after it. Task 1 captures a real token as the fixture that proves this; it is checked again in Task 8.
- **The wire format must not change:** same `LicensePayload` shape, same Ed25519 scheme, same `<prefix>.<b64url payload>.<b64url signature>` layout.
- **`verdix-pos` keeps `env_key_name = 'LICENSE_PRIVATE_KEY'`** — the existing Railway variable and local `keys/private-key.pem` must keep working untouched.
- **Do NOT modify the POS repo** (`d:\VERDIX_POS\Verdix_POS`) except the single sync-comment rewrite in Task 9. The POS stays a single-product verifier.
- The server has no test runner. "Tests" are verification scripts run with `npx tsx` plus DB assertions, exactly as the plan's steps specify.
- `npm run typecheck` must exit 0 at the end of every task.
- Local DB config comes from `.env` (`LICENSE_DB_*`). MySQL client for ad-hoc SQL: `/d/VERDIX_POS/Verdix_POS/mysql-bundle/bin/mysql.exe -u root -p"$PW" -h 127.0.0.1 verdix_license`.
- Git commits end with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer. Do not push.

## Existing code facts (verified)

- `src/schema.ts` applies a `TABLES: {name, sql}[]` array of `CREATE TABLE IF NOT EXISTS` statements in a loop (`for (const t of TABLES) await query(t.sql)`). **There is no ALTER/migration mechanism** — Task 2 adds one for the new column.
- `src/licensing/core.ts:29,35` — `PRODUCT_ID = 'verdix-pos'`, `KEY_PREFIX = 'VRDX1'`.
- `src/licensing/core.ts` — `signLicense(payload, privateKeyPem)` builds `` `${KEY_PREFIX}.${b64url(data)}.${b64url(signature)}` ``; `verifyLicenseSignature(key, publicKeyPem)` rejects when `parts[0] !== KEY_PREFIX`.
- `src/service.ts:73` — `generateProductKey()` hardcodes `'VRDX'`.
- `src/service.ts:291` — payload built with `product: PRODUCT_ID`; signed via `signLicense(payload, getPrivateKeyPem())`.
- `src/keys.ts` — `getPrivateKeyPem()` resolves env `LICENSE_PRIVATE_KEY` → `__dirname/../keys/private-key.pem`.
- `src/licensing/verify.ts` is POS-shaped (calls `getMachineId()`, uses `PUBLIC_KEY_PEM`) and is **not used by the server**. Task 6 touches it only so it typechecks against the new core signatures.

## File Structure

| File | Change |
|---|---|
| `src/schema.ts` | Add `products` table; add a `COLUMNS` migration list for `licenses.product_id`; seed the `verdix-pos` row |
| `src/products.ts` | **New** — `Product` type + registry queries (`getProduct`, `listProducts`, `createProduct`) |
| `src/licensing/core.ts` | `signLicense` takes a prefix; `verifyLicenseSignature` takes an expected prefix; constants become defaults |
| `src/keys.ts` | `getPrivateKeyPem(product)` resolves via `env_key_name`, falls back to `keys/<id>/private-key.pem` |
| `src/service.ts` | `generateProductKey(prefix)`; issuance resolves the product and signs with its key + prefix |
| `src/server.ts` | Products API routes; license create accepts `product_id` |
| `src/offline-cli.ts` | `--product <id>` flag |
| `src/keygen.ts` | `--product <id>` flag; writes `keys/<id>/` and stores the public key on the product row |
| `public/dashboard.html`, `public/app.js` | Products section; product column/filter; product dropdown on license create |
| POS `lib/licensing/core.ts` + server `src/licensing/core.ts` | Sync-comment rewrite (Task 9) |

---

### Task 1: Capture the backward-compatibility fixture

This must run BEFORE any code changes — it captures the "before" artifact that proves nothing broke.

**Files:**
- Create: `tests/fixtures/legacy-token.txt`
- Create: `tests/fixtures/README.md`

- [ ] **Step 1: Issue a license with the CURRENT (unmodified) code**

```bash
cd /d/VERDIX_POS/verdix-license-server
mkdir -p tests/fixtures
npm run new -- --adhoc --customer "Legacy Compat Fixture" --machine "FIXTURE-MACHINE" --days 3650 2>/dev/null | grep "^VRDX1\." > tests/fixtures/legacy-token.txt
cat tests/fixtures/legacy-token.txt
```
Expected: a single line starting `VRDX1.` (~398 bytes).

- [ ] **Step 2: Confirm the fixture verifies with the CURRENT code**

Create `tests/verify-legacy.ts`:

```typescript
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
```

- [ ] **Step 3: Run it**

Run: `cd /d/VERDIX_POS/verdix-license-server && npx tsx tests/verify-legacy.ts`
Expected: `PASS: legacy token verifies. product = verdix-pos | PRODUCT_ID = verdix-pos`

- [ ] **Step 4: Document the fixture**

Create `tests/fixtures/README.md`:

```markdown
# Fixtures

`legacy-token.txt` — a real license token issued by the **pre-multi-product**
code, signed with the production Verdix keypair.

It exists to prove backward compatibility: this exact token must keep
verifying after the multi-product change. If `npx tsx tests/verify-legacy.ts`
ever fails, the wire format or the Verdix key resolution has regressed and
every license already in customers' hands is at risk.

Do not regenerate this file.
```

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "$(printf 'test: capture pre-change license token as compat fixture\n\nProves the multi-product work does not break already-issued licenses.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Schema — products table, product_id column, verdix-pos seed

**Files:**
- Modify: `src/schema.ts`

**Interfaces:**
- Produces: a `products` table and `licenses.product_id`; the `verdix-pos` row with `key_prefix='VRDX'`, `license_prefix='VRDX1'`, `env_key_name='LICENSE_PRIVATE_KEY'`. Tasks 3-7 read these.

- [ ] **Step 1: Add the `products` table to the TABLES array**

In `src/schema.ts`, add this entry to `TABLES` **before** the `licenses` entry (FK target must exist first):

```typescript
  {
    name: 'products',
    sql: `
      CREATE TABLE IF NOT EXISTS products (
        id             VARCHAR(64) PRIMARY KEY,
        name           VARCHAR(255) NOT NULL,
        key_prefix     VARCHAR(16) NOT NULL,
        license_prefix VARCHAR(16) NOT NULL,
        public_key     TEXT NULL,
        env_key_name   VARCHAR(64) NOT NULL,
        status         ENUM('active','inactive') NOT NULL DEFAULT 'active',
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
  },
```

- [ ] **Step 2: Add a column-migration mechanism**

`schema.ts` has no ALTER support. Add this after the `TABLES` array:

```typescript
/**
 * Additive column migrations. Each runs only when the column is absent, so
 * this stays idempotent like the CREATE TABLE statements above.
 */
const COLUMNS: { table: string; column: string; sql: string }[] = [
  {
    table: 'licenses',
    column: 'product_id',
    sql: `ALTER TABLE licenses
            ADD COLUMN product_id VARCHAR(64) NOT NULL DEFAULT 'verdix-pos'`,
  },
];

async function applyColumns(): Promise<void> {
  for (const c of COLUMNS) {
    const rows = await query<any[]>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [c.table, c.column]
    );
    if (rows.length > 0) {
      console.log(`  · column exists: ${c.table}.${c.column}`);
      continue;
    }
    await query(c.sql);
    console.log(`  ✓ column added: ${c.table}.${c.column}`);
  }
}
```

- [ ] **Step 3: Seed the verdix-pos product row**

Add after `applyColumns`:

```typescript
/**
 * The verdix-pos row must exist before any license references it. Its values
 * reproduce the pre-multi-product hardcoded constants exactly, which is what
 * makes already-issued licenses keep working.
 */
async function seedDefaultProduct(): Promise<void> {
  await query(
    `INSERT IGNORE INTO products
       (id, name, key_prefix, license_prefix, env_key_name, status)
     VALUES ('verdix-pos', 'Verdix POS', 'VRDX', 'VRDX1', 'LICENSE_PRIVATE_KEY', 'active')`
  );
  console.log('  ✓ product seeded: verdix-pos');
}
```

- [ ] **Step 4: Call both from the migration runner**

In `src/schema.ts`, after the `for (const t of TABLES) { … }` loop, add:

```typescript
  await applyColumns();
  await seedDefaultProduct();
```

- [ ] **Step 5: Run the migration**

Run: `cd /d/VERDIX_POS/verdix-license-server && npm run migrate`
Expected: existing `✓ table ready:` lines, plus `✓ table ready: products`, `✓ column added: licenses.product_id`, `✓ product seeded: verdix-pos`.

- [ ] **Step 6: Verify it is idempotent**

Run: `npm run migrate` again.
Expected: `· column exists: licenses.product_id` (not "added"), no errors.

- [ ] **Step 7: Verify existing licenses were attributed to verdix-pos**

```bash
PW="$(grep '^LICENSE_DB_PASSWORD=' .env | cut -d= -f2)"
/d/VERDIX_POS/Verdix_POS/mysql-bundle/bin/mysql.exe -u root -p"$PW" -h 127.0.0.1 verdix_license -N -e \
  "SELECT CONCAT('licenses=', COUNT(*), ' verdix=', SUM(product_id='verdix-pos')) FROM licenses;
   SELECT CONCAT('products=', COUNT(*)) FROM products;" 2>/dev/null
```
Expected: every license row has `product_id='verdix-pos'`; `products=1`.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/schema.ts
git commit -m "$(printf 'feat(schema): products table and licenses.product_id\n\nAdds a products registry plus an additive column-migration mechanism\n(schema.ts previously only did CREATE TABLE IF NOT EXISTS). product_id\ndefaults to verdix-pos so existing license rows migrate with no backfill.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: Product registry module

**Files:**
- Create: `src/products.ts`

**Interfaces:**
- Consumes: the `products` table (Task 2).
- Produces:
  - `export interface Product { id, name, key_prefix, license_prefix, public_key, env_key_name, status }`
  - `export async function getProduct(id: string): Promise<Product | null>`
  - `export async function listProducts(): Promise<Product[]>`
  - `export async function createProduct(input: { id, name, key_prefix, license_prefix, env_key_name }): Promise<Product>`
  - `export async function setProductPublicKey(id: string, pem: string): Promise<void>`
  - `export const DEFAULT_PRODUCT_ID = 'verdix-pos'`
  Tasks 4-8 import these.

- [ ] **Step 1: Write the module**

Create `src/products.ts`:

```typescript
/**
 * Product registry. Each product has its own key prefixes and its own signing
 * keypair (resolved through env_key_name), so a leaked key is confined to one
 * product.
 */
import { query } from './db';

export const DEFAULT_PRODUCT_ID = 'verdix-pos';

export interface Product {
  id: string;
  name: string;
  key_prefix: string;
  license_prefix: string;
  public_key: string | null;
  env_key_name: string;
  status: 'active' | 'inactive';
}

export async function getProduct(id: string): Promise<Product | null> {
  const rows = await query<any[]>(`SELECT * FROM products WHERE id = ?`, [id.trim()]);
  return rows.length ? (rows[0] as Product) : null;
}

export async function listProducts(): Promise<Product[]> {
  return (await query<any[]>(`SELECT * FROM products ORDER BY name`)) as Product[];
}

export async function createProduct(input: {
  id: string;
  name: string;
  key_prefix: string;
  license_prefix: string;
  env_key_name: string;
}): Promise<Product> {
  const id = input.id.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error('Product id must be lowercase letters, digits and dashes.');
  }
  const key_prefix = input.key_prefix.trim().toUpperCase();
  const license_prefix = input.license_prefix.trim().toUpperCase();
  if (!key_prefix || !license_prefix) {
    throw new Error('key_prefix and license_prefix are required.');
  }
  if (!input.env_key_name.trim()) {
    throw new Error('env_key_name is required.');
  }

  await query(
    `INSERT INTO products (id, name, key_prefix, license_prefix, env_key_name, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [id, input.name.trim(), key_prefix, license_prefix, input.env_key_name.trim()]
  );

  const created = await getProduct(id);
  if (!created) throw new Error('Product was not created.');
  return created;
}

export async function setProductPublicKey(id: string, pem: string): Promise<void> {
  await query(`UPDATE products SET public_key = ? WHERE id = ?`, [pem, id.trim()]);
}
```

- [ ] **Step 2: Verify it reads the seeded row**

Create `tests/check-products.ts`:

```typescript
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
```

- [ ] **Step 3: Run it**

Run: `cd /d/VERDIX_POS/verdix-license-server && npx tsx tests/check-products.ts`
Expected: `PASS: verdix-pos registered. 1 product(s).`

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add src/products.ts tests/check-products.ts
git commit -m "$(printf 'feat: product registry module\n\nProduct type plus getProduct/listProducts/createProduct/setProductPublicKey.\nid is validated as a lowercase slug; prefixes are normalized to uppercase.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Parameterize the crypto core

**Files:**
- Modify: `src/licensing/core.ts`

**Interfaces:**
- Produces:
  - `signLicense(payload: LicensePayload, privateKeyPem: string, licensePrefix?: string): string` — prefix defaults to `KEY_PREFIX`
  - `verifyLicenseSignature(key: string, publicKeyPem: string, expectedPrefix?: string): VerifyResult` — defaults to `KEY_PREFIX`
  - `PRODUCT_ID` and `KEY_PREFIX` remain exported (now documented as the verdix-pos defaults)
  Tasks 5-8 call these.

The optional-parameter form is what keeps every existing call site compiling and behaving identically.

- [ ] **Step 1: Make signLicense take a prefix**

In `src/licensing/core.ts`, replace the `signLicense` function with:

```typescript
export function signLicense(
  payload: LicensePayload,
  privateKeyPem: string,
  licensePrefix: string = KEY_PREFIX
): string {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  // For Ed25519 the digest algorithm MUST be null (the algorithm is implied).
  const signature = crypto.sign(null, data, privateKeyPem);
  return `${licensePrefix}.${b64url(data)}.${b64url(signature)}`;
}
```

Also update its docstring line `` Returns the full license key string: `VRDX1.<payload>.<signature>`. `` to:

```
 * Returns `<licensePrefix>.<payload>.<signature>` (default prefix: VRDX1).
```

- [ ] **Step 2: Make verifyLicenseSignature take an expected prefix**

Replace the signature and the prefix check:

```typescript
export function verifyLicenseSignature(
  key: string,
  publicKeyPem: string,
  expectedPrefix: string = KEY_PREFIX
): VerifyResult {
  try {
    const parts = (key || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== expectedPrefix) {
      return { valid: false, reason: 'malformed-key' };
    }
```

Leave the rest of the function body unchanged.

- [ ] **Step 3: Document the constants as defaults**

Replace the comments above `PRODUCT_ID` and `KEY_PREFIX` with:

```typescript
/**
 * Default product id — the original single-product value. Multi-product
 * callers pass the product's own id in LicensePayload.product instead.
 */
export const PRODUCT_ID = 'verdix-pos';

/**
 * Default license-token prefix. Multi-product callers pass the product's
 * license_prefix to signLicense / verifyLicenseSignature instead.
 */
export const KEY_PREFIX = 'VRDX1';
```

- [ ] **Step 4: Verify the legacy fixture STILL verifies (defaults path)**

Run: `cd /d/VERDIX_POS/verdix-license-server && npx tsx tests/verify-legacy.ts`
Expected: `PASS: legacy token verifies. product = verdix-pos | PRODUCT_ID = verdix-pos`
This proves the optional parameters did not change default behavior.

- [ ] **Step 5: Verify an explicit non-matching prefix is rejected**

Create `tests/check-prefix-isolation.ts`:

```typescript
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
```

- [ ] **Step 6: Run it**

Run: `npx tsx tests/check-prefix-isolation.ts`
Expected: `PASS: prefix is enforced (VRDX1 ok, OTHER1 rejected).`

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/licensing/core.ts tests/check-prefix-isolation.ts
git commit -m "$(printf 'feat(core): parameterize license prefix for multi-product\n\nsignLicense and verifyLicenseSignature take an optional prefix defaulting to\nKEY_PREFIX, so every existing call site behaves identically and the wire\nformat is unchanged. Verified against the pre-change compat fixture.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 5: Per-product private key resolution

**Files:**
- Modify: `src/keys.ts`

**Interfaces:**
- Consumes: `Product` (Task 3).
- Produces:
  - `getPrivateKeyPem(product?: Product): string`
  - `hasPrivateKey(product?: Product): boolean`
  With no argument, behavior is exactly as before (env `LICENSE_PRIVATE_KEY` → `keys/private-key.pem`). Task 6 passes a product.

- [ ] **Step 1: Rewrite keys.ts**

Replace the whole body of `src/keys.ts` with:

```typescript
/**
 * Private signing key loader.
 * ----------------------------------------------------------------------------
 * Each product has its OWN keypair, so one leaked key cannot compromise every
 * product. For a given product the key is resolved from, in order:
 *   1. process.env[product.env_key_name]        (Railway / production secret)
 *   2. keys/<product.id>/private-key.pem        (local development)
 *
 * With no product (legacy/default path) it resolves:
 *   1. process.env.LICENSE_PRIVATE_KEY
 *   2. keys/private-key.pem
 *
 * verdix-pos declares env_key_name = 'LICENSE_PRIVATE_KEY' and additionally
 * falls back to the flat keys/private-key.pem, so the original single-product
 * setup keeps working untouched.
 *
 * The env var may contain literal "\n" sequences (common when pasting a PEM
 * into a hosting dashboard) — those are normalized back to real newlines.
 */
import fs from 'fs';
import path from 'path';
import type { Product } from './products';

const DEFAULT_ENV_VAR = 'LICENSE_PRIVATE_KEY';
const DEFAULT_PRODUCT_ID = 'verdix-pos';

const cache = new Map<string, string>();

function normalizePem(pem: string): string {
  return pem.replace(/\\n/g, '\n').trim() + '\n';
}

/** Candidate key file paths for a product, most specific first. */
function keyFilePaths(productId: string): string[] {
  const paths = [path.join(__dirname, '..', 'keys', productId, 'private-key.pem')];
  // verdix-pos predates per-product key directories.
  if (productId === DEFAULT_PRODUCT_ID) {
    paths.push(path.join(__dirname, '..', 'keys', 'private-key.pem'));
  }
  return paths;
}

export function getPrivateKeyPem(product?: Product): string {
  const productId = product?.id ?? DEFAULT_PRODUCT_ID;
  const envVar = product?.env_key_name ?? DEFAULT_ENV_VAR;

  const hit = cache.get(productId);
  if (hit) return hit;

  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.includes('BEGIN')) {
    const pem = normalizePem(fromEnv);
    cache.set(productId, pem);
    return pem;
  }

  for (const filePath of keyFilePaths(productId)) {
    if (fs.existsSync(filePath)) {
      const pem = fs.readFileSync(filePath, 'utf8');
      cache.set(productId, pem);
      return pem;
    }
  }

  throw new Error(
    `No signing key for product "${productId}". Set ${envVar}, or run ` +
      `\`npm run keygen -- --product ${productId}\`.`
  );
}

export function hasPrivateKey(product?: Product): boolean {
  try {
    getPrivateKeyPem(product);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Verify the default path still resolves the existing key**

Create `tests/check-keys.ts`:

```typescript
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
```

- [ ] **Step 3: Run it**

Run: `cd /d/VERDIX_POS/verdix-license-server && npx tsx tests/check-keys.ts`
Expected: `PASS: verdix-pos resolves the same key as the legacy default path.`
(This is the check that guarantees Railway's existing `LICENSE_PRIVATE_KEY` keeps signing Verdix licenses.)

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add src/keys.ts tests/check-keys.ts
git commit -m "$(printf 'feat(keys): per-product signing key resolution\n\nResolves env[product.env_key_name] then keys/<id>/private-key.pem, with\nverdix-pos also falling back to the original flat keys/private-key.pem so the\nexisting Railway variable and local setup keep working.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 6: Issue licenses per product

**Files:**
- Modify: `src/service.ts`
- Modify: `src/licensing/verify.ts` (typecheck-only touch)

**Interfaces:**
- Consumes: `getProduct` (Task 3), parameterized `signLicense` (Task 4), `getPrivateKeyPem(product)` (Task 5).
- Produces: `generateProductKey(prefix?: string)`; license creation accepting `product_id`; signing that uses the license's product.

- [ ] **Step 1: Parameterize generateProductKey**

In `src/service.ts`, replace:

```typescript
/** e.g. VRDX-7QК4-9FH2-MN8P (prefix + 3 groups of 4). */
export function generateProductKey(): string {
  return ['VRDX', randomGroup(4), randomGroup(4), randomGroup(4)].join('-');
}
```

with:

```typescript
/** e.g. VRDX-7QK4-9FH2-MN8P (product key_prefix + 3 groups of 4). */
export function generateProductKey(prefix: string = 'VRDX'): string {
  return [prefix, randomGroup(4), randomGroup(4), randomGroup(4)].join('-');
}
```

- [ ] **Step 2: Accept product_id when creating a license**

In `src/service.ts`, find the license-creation function containing `let productKey = generateProductKey();` (around line 140) and its `INSERT INTO licenses (...)` (around line 149). Change them to resolve the product first, use its prefix, and persist `product_id`.

Add `product_id?: string` to that function's input type, then replace the key-generation and INSERT with:

```typescript
  const productId = (input.product_id || DEFAULT_PRODUCT_ID).trim();
  const product = await getProduct(productId);
  if (!product) throw new Error(`Unknown product "${productId}".`);
  if (product.status !== 'active') {
    throw new Error(`Product "${productId}" is inactive; cannot issue new licenses.`);
  }

  let productKey = generateProductKey(product.key_prefix);
  for (let i = 0; i < 5; i++) {
    const clash = await query<any[]>(`SELECT id FROM licenses WHERE product_key = ?`, [productKey]);
    if (clash.length === 0) break;
    productKey = generateProductKey(product.key_prefix);
  }

  await query(
    `INSERT INTO licenses
       (id, customer_id, product_id, product_key, edition, type, expires_at, max_activations, features, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.customer_id,
      productId,
      productKey,
      /* keep the remaining existing arguments in their current order */
    ]
  );
```

Keep the existing argument list for edition/type/expires_at/max_activations/features/notes/created_by exactly as it is — only `product_id` is inserted, positioned right after `customer_id`.

- [ ] **Step 3: Import what this file now needs**

At the top of `src/service.ts`, add:

```typescript
import { getProduct, DEFAULT_PRODUCT_ID } from './products';
```

- [ ] **Step 4: Sign with the license's own product**

In `src/service.ts` around line 291, replace:

```typescript
    product: PRODUCT_ID,
```
with:
```typescript
    product: license.product_id || DEFAULT_PRODUCT_ID,
```

and replace:

```typescript
  const signedLicense = signLicense(payload, getPrivateKeyPem());
```
with:
```typescript
  const signingProduct = await getProduct(license.product_id || DEFAULT_PRODUCT_ID);
  if (!signingProduct) {
    throw new Error(`Unknown product "${license.product_id}" on license ${license.id}.`);
  }
  const signedLicense = signLicense(
    payload,
    getPrivateKeyPem(signingProduct),
    signingProduct.license_prefix
  );
```

- [ ] **Step 5: Add product_id to the License type**

In `src/service.ts`, add to the `License` interface (near `product_key: string;`):

```typescript
  product_id: string;
```

- [ ] **Step 6: Keep verify.ts compiling**

`src/licensing/verify.ts` is POS-shaped and unused by the server, but it must still typecheck. Its `verifyLicenseSignature(key, PUBLIC_KEY_PEM)` call now hits the 2-arg default overload and needs no change. Confirm with a typecheck; if TS reports an error there, add the explicit third argument `KEY_PREFIX`.

- [ ] **Step 7: Verify signing still works for verdix-pos end to end**

Run: `cd /d/VERDIX_POS/verdix-license-server && npm run new -- --adhoc --customer "Post-Change Verdix" --machine "PC-1" --days 30 2>/dev/null | grep "^VRDX1\." | head -1`
Expected: a token beginning `VRDX1.` — same prefix as before the change.

- [ ] **Step 8: Re-verify the legacy fixture**

Run: `npx tsx tests/verify-legacy.ts`
Expected: `PASS: legacy token verifies. product = verdix-pos | PRODUCT_ID = verdix-pos`

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
git add src/service.ts src/licensing/verify.ts
git commit -m "$(printf 'feat(service): issue and sign licenses per product\n\nLicense creation resolves its product, uses that product key_prefix, and\npersists product_id. Signing loads the product own key and license_prefix.\nInactive products cannot receive new licenses. verdix-pos output is\nbyte-identical to before.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 7: CLI — --product on keygen and offline-cli

**Files:**
- Modify: `src/keygen.ts`
- Modify: `src/offline-cli.ts`

**Interfaces:**
- Consumes: `getProduct`, `createProduct`, `setProductPublicKey` (Task 3); `getPrivateKeyPem` (Task 5).
- Produces: `npm run keygen -- --product <id>`, `npm run new -- --product <id>`.

- [ ] **Step 1: Make keygen product-aware**

In `src/keygen.ts`, replace the path constants:

```typescript
const keysDir = path.join(__dirname, '..', 'keys');
const privatePath = path.join(keysDir, 'private-key.pem');
const publicPath = path.join(keysDir, 'public-key.pem');
```

with:

```typescript
function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const productId = (argOf('--product') || 'verdix-pos').trim().toLowerCase();

// verdix-pos predates per-product key directories and keeps the flat layout.
const keysDir =
  productId === 'verdix-pos'
    ? path.join(__dirname, '..', 'keys')
    : path.join(__dirname, '..', 'keys', productId);
const privatePath = path.join(keysDir, 'private-key.pem');
const publicPath = path.join(keysDir, 'public-key.pem');
```

- [ ] **Step 2: Create the key directory before writing**

In `keygen.ts`, immediately before the code that writes `privatePath`, add:

```typescript
  fs.mkdirSync(keysDir, { recursive: true });
```

- [ ] **Step 3: Store the public key on the product row**

At the end of `keygen.ts`'s `main()`, after the keys are written, add:

```typescript
  // Record the public key so the dashboard can show developers what to embed.
  try {
    const { getProduct, setProductPublicKey } = await import('./products');
    if (await getProduct(productId)) {
      await setProductPublicKey(productId, publicKey);
      console.log(`   ✓ public key stored on product "${productId}"`);
    } else {
      console.log(`   · product "${productId}" not registered yet — add it in the dashboard`);
    }
  } catch (e) {
    console.log('   · could not reach the DB to store the public key:', (e as Error).message);
  }
```

If `main()` is not currently `async`, make it `async` and `await` it at the call site.

- [ ] **Step 4: Add --product to offline-cli**

In `src/offline-cli.ts`, the ad-hoc branch builds a payload with `product: PRODUCT_ID` and signs with `getPrivateKeyPem()`. Replace that branch's product/signing lines with:

```typescript
    const productId = (args.product || 'verdix-pos').trim().toLowerCase();
    const { getProduct } = await import('./products');
    const product = await getProduct(productId);
    if (!product) fail(`Unknown product "${productId}". Register it in the dashboard first.`);
```

then in the payload use `product: productId,` in place of `product: PRODUCT_ID,`, and replace the signing call:

```typescript
    const key = signLicense(payload, getPrivateKeyPem(product!), product!.license_prefix);
```

The DB-backed branch already goes through `service.ts`, which Task 6 made product-aware — leave it alone.

- [ ] **Step 5: Verify verdix-pos ad-hoc signing is unchanged**

Run: `cd /d/VERDIX_POS/verdix-license-server && npm run new -- --adhoc --customer "CLI Check" --machine "CLI-1" --days 30 2>/dev/null | grep "^VRDX1\." | head -1`
Expected: a `VRDX1.` token (the default product path).

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/keygen.ts src/offline-cli.ts
git commit -m "$(printf 'feat(cli): --product on keygen and license issuance\n\nkeygen writes keys/<id>/ for new products (verdix-pos keeps the flat layout)\nand stores the public key on the product row. offline-cli --adhoc resolves\nthe product and signs with its key and prefix.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 8: Second-product isolation test (GATE)

This proves the whole feature works and that products are cryptographically isolated. Do not proceed to Task 9 until every step passes.

**Files:**
- Create: `tests/check-multi-product.ts`

- [ ] **Step 1: Register a second product**

```bash
cd /d/VERDIX_POS/verdix-license-server
PW="$(grep '^LICENSE_DB_PASSWORD=' .env | cut -d= -f2)"
/d/VERDIX_POS/Verdix_POS/mysql-bundle/bin/mysql.exe -u root -p"$PW" -h 127.0.0.1 verdix_license -e \
  "INSERT IGNORE INTO products (id,name,key_prefix,license_prefix,env_key_name,status)
   VALUES ('test-app','Test App','TSTA','TSTA1','LICENSE_PRIVATE_KEY_TESTAPP','active');" 2>/dev/null
```

- [ ] **Step 2: Generate its keypair**

Run: `npm run keygen -- --product test-app`
Expected: writes `keys/test-app/private-key.pem` + `public-key.pem`, and prints `✓ public key stored on product "test-app"`.

- [ ] **Step 3: Write the isolation test**

Create `tests/check-multi-product.ts`:

```typescript
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
```

- [ ] **Step 4: Run it**

Run: `npx tsx tests/check-multi-product.ts`
Expected: `PASS: products are isolated — bad-signature / malformed-key`

- [ ] **Step 5: Re-run the full backward-compat suite**

```bash
npx tsx tests/verify-legacy.ts
npx tsx tests/check-prefix-isolation.ts
npx tsx tests/check-keys.ts
npx tsx tests/check-products.ts
```
Expected: four PASS lines, no failures.

- [ ] **Step 6: Confirm the fixture token is byte-identical to what Verdix still issues**

Run: `npm run new -- --adhoc --customer "Final Check" --machine "FC-1" --days 30 2>/dev/null | grep "^VRDX1\." | head -1 | cut -c1-6`
Expected: `VRDX1.` — the prefix Verdix POS builds expect.

- [ ] **Step 7: Commit**

```bash
git add tests/check-multi-product.ts
git commit -m "$(printf 'test: multi-product isolation gate\n\nA second product signs with its own key and TSTA1 prefix; the Verdix public\nkey does NOT validate it, and a Verdix token does not pass under another\nprefix. Backward-compat fixture still verifies.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 9: Dashboard products UI + sync-comment rewrite

**Files:**
- Modify: `src/server.ts` (products API routes; accept `product_id` on license create)
- Modify: `public/dashboard.html`, `public/app.js` (products section, product column/filter, create dropdown)
- Modify: `src/licensing/core.ts` (sync comment)
- Modify: `d:\VERDIX_POS\Verdix_POS\lib\licensing\core.ts` (sync comment — the ONLY POS-repo change)

- [ ] **Step 1: Add products API routes**

In `src/server.ts`, alongside the existing `/api/*` handlers, add (matching the file's existing `sendJson` / auth-guard style):

```typescript
  if (method === 'GET' && p === '/api/products') {
    requireAuth(req, res);
    const { listProducts } = await import('./products');
    return sendJson(res, 200, { success: true, data: await listProducts() });
  }

  if (method === 'POST' && p === '/api/products') {
    requireAuth(req, res);
    const body = await readJsonBody(req);
    const { createProduct } = await import('./products');
    try {
      const created = await createProduct(body);
      return sendJson(res, 200, { success: true, data: created });
    } catch (e) {
      return sendJson(res, 400, { success: false, error: (e as Error).message });
    }
  }
```

Use whatever the file's actual auth guard and body-reader are named — mirror the adjacent license routes exactly rather than inventing helpers.

- [ ] **Step 2: Pass product_id through license creation**

In the existing `POST /api/licenses` handler in `src/server.ts`, include `product_id: body.product_id` in the object passed to the service's create function. The service defaults it to `verdix-pos` when absent (Task 6), so older dashboard builds keep working.

- [ ] **Step 3: Add the Products section to the dashboard**

In `public/dashboard.html`, add a Products panel following the markup pattern of the existing Customers panel: a table with columns **Name / ID / Key prefix / License prefix / Env var / Public key**, and an "Add product" form with inputs for id, name, key_prefix, license_prefix, env_key_name.

In `public/app.js`, add the matching `loadProducts()` (GET `/api/products`) and `createProduct()` (POST `/api/products`) functions, wired the same way the customers list is.

- [ ] **Step 4: Add product selection to license creation**

In `public/app.js`, populate the license-create form's product `<select>` from `loadProducts()`, defaulting to `verdix-pos`, and include `product_id` in the POST body. Add a **Product** column to the licenses table.

- [ ] **Step 5: Verify the dashboard**

```bash
npm run server
```
Then check:
- `curl -s -o /dev/null -w "%{http_code}" http://localhost:4100/login` → `200`
- Log in, open Products → both `verdix-pos` and `test-app` are listed
- Create a license for `test-app` → its product key starts with `TSTA-`
- Create a license for `verdix-pos` → its product key starts with `VRDX-`

Stop the server when done.

- [ ] **Step 6: Rewrite the sync comment in the SERVER core.ts**

At the top of `src/licensing/core.ts`, replace the existing "DUPLICATED from the Verdix POS repo" comment block with:

```typescript
// Shares a crypto contract with lib/licensing/core.ts in the Verdix POS repo.
//
// The two files intentionally DIVERGE: this one is multi-product (product id
// and token prefix are parameters); the POS copy is a single-product verifier
// that keeps PRODUCT_ID/KEY_PREFIX as local constants. Do not "fix" that.
//
// What MUST stay identical on both sides, or already-issued licenses stop
// verifying:
//   1. The LicensePayload shape (field names, types, JSON serialization).
//   2. The signature scheme: Ed25519, crypto.sign(null, data, key) over the
//      UTF-8 JSON of the payload.
//   3. The token layout: <prefix>.<base64url payload>.<base64url signature>.
```

- [ ] **Step 7: Rewrite the sync comment in the POS core.ts**

This is the only change to the POS repo. In `d:\VERDIX_POS\Verdix_POS\lib\licensing\core.ts`, add (or replace the equivalent note) at the top:

```typescript
// Shares a crypto contract with src/licensing/core.ts in the verdix-license-server
// repo. That copy is multi-product (prefix/product are parameters); this one is a
// single-product VERIFIER and deliberately keeps PRODUCT_ID/KEY_PREFIX as
// constants. The divergence is intentional — do not sync the files wholesale.
//
// What MUST stay identical on both sides, or already-issued licenses stop
// verifying:
//   1. The LicensePayload shape (field names, types, JSON serialization).
//   2. The signature scheme: Ed25519, crypto.sign(null, data, key) over the
//      UTF-8 JSON of the payload.
//   3. The token layout: <prefix>.<base64url payload>.<base64url signature>.
```

- [ ] **Step 8: Confirm the POS still typechecks**

Run: `cd /d/VERDIX_POS/Verdix_POS && npm run typecheck 2>&1 | grep -v "^.next" | grep -cE "error TS"`
Expected: `10` (the pre-existing baseline — a comment-only change must not move it).

- [ ] **Step 9: Commit both repos**

```bash
cd /d/VERDIX_POS/verdix-license-server
npm run typecheck
git add src/server.ts public/dashboard.html public/app.js src/licensing/core.ts
git commit -m "$(printf 'feat(dashboard): product management UI\n\nProducts API and dashboard section; license creation takes a product and\nshows its column. Rewrites the crypto sync comment: the POS copy is now an\nintentional single-product divergence, and only the payload shape, signature\nscheme, and token layout must match.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"

cd /d/VERDIX_POS/Verdix_POS
git add lib/licensing/core.ts
git commit -m "$(printf 'docs(licensing): clarify what must stay in sync with the license server\n\nThe server copy is multi-product; this one stays a single-product verifier.\nOnly the payload shape, signature scheme, and token layout are load-bearing.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md`
- Modify: `RAILWAY-MIGRATION.md`

- [ ] **Step 1: Document adding a product in README.md**

Add a "Licensing a new product" section:

````markdown
## Licensing a new product

1. **Register the product** — dashboard → Products → Add, or SQL:

   ```sql
   INSERT INTO products (id, name, key_prefix, license_prefix, env_key_name, status)
   VALUES ('my-app', 'My App', 'MYAP', 'MYAP1', 'LICENSE_PRIVATE_KEY_MYAPP', 'active');
   ```

   - `key_prefix` — product keys look like `MYAP-XXXX-XXXX-XXXX`
   - `license_prefix` — tokens look like `MYAP1.<payload>.<signature>`
   - `env_key_name` — the env var holding this product's PRIVATE key in production

2. **Generate its keypair** (never reuse another product's):

   ```bash
   npm run keygen -- --product my-app
   ```

   Writes `keys/my-app/` and stores the public key on the product row.

3. **Embed the public key in your app.** Copy it from the dashboard. Your app
   verifies with that key, its own product id, and its own `license_prefix`.

4. **Deploy the private key** — set `LICENSE_PRIVATE_KEY_MYAPP` in Railway to the
   contents of `keys/my-app/private-key.pem`. Never commit it.

Each product is cryptographically isolated: a license signed for one product
fails verification against any other product's key.
````

- [ ] **Step 2: Note the per-product env vars in RAILWAY-MIGRATION.md**

In the Step 3 variables list, add:

```markdown
- [ ] **Per-product signing keys** — one variable per product, named by that product's
      `env_key_name` (e.g. `LICENSE_PRIVATE_KEY_MYAPP`). `verdix-pos` uses
      `LICENSE_PRIVATE_KEY`, so the original variable is unchanged.
```

- [ ] **Step 3: Commit**

```bash
cd /d/VERDIX_POS/verdix-license-server
git add README.md RAILWAY-MIGRATION.md
git commit -m "$(printf 'docs: how to license a new product\n\nRegister, keygen, embed the public key, deploy the private key. Notes the\nper-product env vars in the Railway checklist.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- §1 products table + `licenses.product_id` + verdix-pos seed → Task 2 ✓
- §2 crypto core parameterized → Task 4 ✓
- §3 per-product key resolution → Task 5 ✓
- §4 dashboard / CLI / activation → Tasks 7, 9 ✓
- §5 POS untouched except the sync comment → Task 9 Steps 7-8 ✓
- §6 error handling (unknown product, missing key naming env_key_name, inactive product, prefix mismatch) → Tasks 3, 5, 6 ✓
- §7 testing: pre-change token still verifies (Tasks 1, 4, 6, 8); verdix-pos verifies after (Task 6/8); second product isolated (Task 8); rows attributed (Task 2 Step 7) ✓
- Product registry module (implied by §1) → Task 3 ✓

**Placeholder scan:** No TBD/TODO. Task 9 Steps 1/3/4 direct the implementer to mirror existing file conventions rather than inventing helper names — deliberate, because inventing names for `server.ts`'s auth guard / body reader without seeing them would produce code that does not compile.

**Type consistency:** `Product` (Task 3) is the parameter type in Task 5's `getPrivateKeyPem(product?: Product)` and is what Task 6 passes. `signLicense(payload, pem, prefix?)` and `verifyLicenseSignature(key, pem, expectedPrefix?)` (Task 4) match every call in Tasks 6, 7, 8. `DEFAULT_PRODUCT_ID` is exported by Task 3 and imported in Task 6. `license.product_id` is added to the `License` interface in Task 6 Step 5 before Step 4 reads it.
