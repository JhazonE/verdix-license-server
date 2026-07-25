# Product Setup Checklist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-product expandable setup checklist to the dashboard Products tab, showing which of the four licensing setup steps are complete and what to do next.

**Architecture:** A new `src/setup-status.ts` derives step state from what the server can actually verify (product row, stored public key, resolvable private key) plus one operator-marked step stored in a new `products.embed_marked` JSON column. The mark is bound to a fingerprint of the public key it was made for, so rotating the keypair flips it to `stale` instead of leaving a false checkmark. Two new admin-authed endpoints serve and update that state; the Products table gains a Setup pill and a lazy-loaded expandable detail row.

**Tech Stack:** TypeScript (strict), Node built-in `http` + `crypto`, MySQL via `mysql2` (`query()` helper in `src/db.ts`), vanilla JS dashboard (no framework, no build step), standalone `tsx` test scripts.

**Spec:** `docs/specs/2026-07-25-product-setup-checklist-design.md`

## Global Constraints

- **Branch:** `feat/product-setup-checklist` (already created; the spec commit is on it).
- **The private key must NEVER cross the wire.** API responses carry only a boolean and a `source` label (`'env' | 'local-file' | 'none'`) — never key material.
- **`POST /embed` must compute the fingerprint server-side** from the current `public_key`. It must NOT read a fingerprint from the request body; a client-supplied value would defeat stale detection.
- **`by` comes from `session.username`**, never from the request body.
- **Fingerprint = `sha256` over the PEM with ALL whitespace stripped**, first 16 hex chars. Hashing raw text makes a trailing newline or CRLF read as a key change and raises a false `stale`.
- **Migrations are additive and idempotent** — follow the existing `COLUMNS` pattern in `src/schema.ts:137-144`. Running `migrate` twice must not error.
- **Do not modify** `src/licensing/core.ts` — it is a shared crypto contract with the POS repo (see its header comment). This feature does not need to.
- **Follow existing dashboard idioms:** `$(id)`, `api(path, opts)`, `esc()`, `toast()`, `skeletonTable(cols)` in `public/app.js`; `.pill` / `.pill.active` / `.pill.suspended` / `.pill.revoked`, `code.key`, `.btn.sm`, `.btn.ghost`, `.keyout`, `.muted` in `public/dashboard.html`.
- **All user-supplied values rendered into HTML must go through `esc()`.**
- **Verify with:** `npm run typecheck` (must pass clean before every commit).

## File Structure

| File | Responsibility |
|------|----------------|
| `src/setup-status.ts` | **Create.** Fingerprinting + step derivation. Pure logic, no HTTP. |
| `src/keys.ts` | **Modify.** Extract the key-file lookup into a shared helper; add `getPrivateKeySource()`. |
| `src/schema.ts` | **Modify.** Add the `products.embed_marked` column migration. |
| `src/products.ts` | **Modify.** Add `embed_marked` to the `Product` interface + `setProductEmbedMark()`. |
| `src/server.ts` | **Modify.** Add `GET /api/products/:id/setup` and `POST /api/products/:id/embed`. |
| `public/app.js` | **Modify.** Setup pill, expandable row, detail panel renderer, mark action. |
| `public/dashboard.html` | **Modify.** CSS for the detail row + `Stale` pill variant. |
| `tests/check-setup-status.ts` | **Create.** Fingerprint + derivation unit tests (no DB, no server). |
| `tests/check-setup-api.ts` | **Create.** Endpoint tests: no key leak, body-fingerprint ignored, 404. |

`setup-status.ts` is its own module because `products.ts` is CRUD and `keys.ts` is private-key loading; neither should grow a second responsibility.

---

### Task 1: Fingerprinting and step derivation

The pure logic core, with no DB or HTTP dependency, so it can be tested directly.

**Files:**
- Create: `src/setup-status.ts`
- Test: `tests/check-setup-status.ts`

**Interfaces:**
- Consumes: nothing. This module is dependency-free apart from Node's `crypto` — it must not import from `products.ts` or `keys.ts`, since both of those will import from it (Tasks 2 and 3).
- Produces:
  - `publicKeyFingerprint(pem: string): string`
  - `type PrivateKeySource = 'env' | 'local-file' | 'none'`
  - `type EmbedState = 'pending' | 'done' | 'stale'`
  - `interface EmbedMark { at: string; by: string; key_fp: string }`
  - `deriveEmbedState(publicKey: string | null, mark: EmbedMark | null): EmbedState`
  - `type SetupPill = 'ready' | 'needs-setup' | 'stale'`
  - `deriveSetupPill(input: { hasKeypair: boolean; source: PrivateKeySource; embed: EmbedState }): SetupPill`

- [ ] **Step 1: Write the failing test**

Create `tests/check-setup-status.ts`:

```typescript
import {
  publicKeyFingerprint,
  deriveEmbedState,
  deriveSetupPill,
  EmbedMark,
} from '../src/setup-status';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    console.error('  FAIL ' + name);
    failures++;
  }
}

const PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=',
  '-----END PUBLIC KEY-----',
].join('\n');

// ── Fingerprint normalization ────────────────────────────────────────────────
// These all describe the SAME key. A PEM round-trips through MySQL, the
// clipboard, and env vars containing literal \n, so cosmetic differences must
// never change the fingerprint — otherwise a rotation is falsely reported.
const base = publicKeyFingerprint(PEM);
check('fingerprint is 16 hex chars', /^[0-9a-f]{16}$/.test(base));
check('trailing newline ignored', publicKeyFingerprint(PEM + '\n') === base);
check('leading/trailing space ignored', publicKeyFingerprint('  ' + PEM + '  ') === base);
check('CRLF ignored', publicKeyFingerprint(PEM.replace(/\n/g, '\r\n')) === base);
check('literal backslash-n ignored', publicKeyFingerprint(PEM.replace(/\n/g, '\\n')) === base);
check('internal blank lines ignored', publicKeyFingerprint(PEM.replace(/\n/g, '\n\n')) === base);

// A genuinely different key must produce a different fingerprint.
const OTHER = PEM.replace('Gb9ECWmEzf6F', 'Zz9ECWmEzf6F');
check('different key differs', publicKeyFingerprint(OTHER) !== base);

// ── Embed state ──────────────────────────────────────────────────────────────
const markMatching: EmbedMark = { at: '2026-07-25T10:00:00Z', by: 'admin', key_fp: base };
const markOther: EmbedMark = { at: '2026-07-24T10:00:00Z', by: 'admin', key_fp: 'ffffffffffffffff' };

check('no mark => pending', deriveEmbedState(PEM, null) === 'pending');
check('matching fp => done', deriveEmbedState(PEM, markMatching) === 'done');
check('mismatched fp => stale', deriveEmbedState(PEM, markOther) === 'stale');
// Whitespace drift in the stored PEM must not fake a rotation.
check('done survives whitespace drift', deriveEmbedState(PEM + '\n', markMatching) === 'done');
// No key to embed means the step cannot be complete.
check('null key + mark => stale', deriveEmbedState(null, markMatching) === 'stale');
check('null key + no mark => pending', deriveEmbedState(null, null) === 'pending');

// ── Setup pill (first match wins: stale > needs-setup > ready) ────────────────
check('stale embed => stale pill',
  deriveSetupPill({ hasKeypair: true, source: 'env', embed: 'stale' }) === 'stale');
check('stale wins over missing keypair',
  deriveSetupPill({ hasKeypair: false, source: 'none', embed: 'stale' }) === 'stale');
check('no keypair => needs-setup',
  deriveSetupPill({ hasKeypair: false, source: 'env', embed: 'done' }) === 'needs-setup');
check('no signing key => needs-setup',
  deriveSetupPill({ hasKeypair: true, source: 'none', embed: 'done' }) === 'needs-setup');
check('pending embed => needs-setup',
  deriveSetupPill({ hasKeypair: true, source: 'env', embed: 'pending' }) === 'needs-setup');
check('all done => ready',
  deriveSetupPill({ hasKeypair: true, source: 'env', embed: 'done' }) === 'ready');
// local-file still counts as ready: the server cannot tell "not deployed to
// Railway" from "deployed, but I'm looking at a local dashboard".
check('local-file still ready',
  deriveSetupPill({ hasKeypair: true, source: 'local-file', embed: 'done' }) === 'ready');

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nPASS: setup-status derivation is correct.');
process.exit(0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/check-setup-status.ts`
Expected: FAIL — cannot find module `../src/setup-status`.

- [ ] **Step 3: Write minimal implementation**

Create `src/setup-status.ts`:

```typescript
/**
 * Product setup status derivation.
 * ----------------------------------------------------------------------------
 * Pure logic — no DB, no HTTP, no filesystem. Turns raw product facts into the
 * four-step checklist the dashboard renders.
 *
 * Three of the four setup steps are observable by the server. Embedding the
 * public key into the product's own app is NOT (it happens in a different
 * repository), so the operator marks it. To stop that mark from outliving the
 * key it was made for, it stores a fingerprint of the public key it was made
 * against — a `keygen --force` rotation then flips the step to `stale` rather
 * than leaving a checkmark that no longer reflects reality.
 */
import crypto from 'crypto';

export type PrivateKeySource = 'env' | 'local-file' | 'none';
export type EmbedState = 'pending' | 'done' | 'stale';
export type SetupPill = 'ready' | 'needs-setup' | 'stale';

/** Operator's assertion that the public key was embedded in the product's app. */
export interface EmbedMark {
  /** ISO timestamp the mark was made. */
  at: string;
  /** Admin username who marked it. */
  by: string;
  /** Fingerprint of the public key the mark was made against. */
  key_fp: string;
}

/**
 * Stable fingerprint of a public key PEM.
 *
 * ALL whitespace is stripped before hashing. The same key legitimately shows up
 * with different whitespace — round-tripped through MySQL, pasted via the
 * clipboard, or supplied through an env var holding literal "\n" sequences (see
 * normalizePem in keys.ts). Hashing the raw string would make a trailing
 * newline or a CRLF look like a key rotation and raise a false `stale`.
 */
export function publicKeyFingerprint(pem: string): string {
  const stripped = (pem || '').replace(/\\n/g, '').replace(/\s+/g, '');
  return crypto.createHash('sha256').update(stripped).digest('hex').slice(0, 16);
}

/**
 * Resolve the embed step. `stale` means a mark exists but was made against a
 * different key — the app is running with a public key that no longer matches.
 */
export function deriveEmbedState(publicKey: string | null, mark: EmbedMark | null): EmbedState {
  if (!mark) return 'pending';
  // A mark with no key to embed cannot be `done`; there is nothing it describes.
  if (!publicKey) return 'stale';
  return mark.key_fp === publicKeyFingerprint(publicKey) ? 'done' : 'stale';
}

/**
 * Roll the steps up into the single pill shown in the table. First match wins.
 *
 * `stale` is checked first and rendered distinctly because it is the actively
 * broken state, not merely an unfinished one.
 *
 * Note `source === 'local-file'` still counts as ready: this server cannot tell
 * "never deployed to Railway" apart from "deployed, but you are viewing a local
 * dashboard", so it must not gate `ready` on that difference. The expanded
 * panel surfaces the nuance instead.
 */
export function deriveSetupPill(input: {
  hasKeypair: boolean;
  source: PrivateKeySource;
  embed: EmbedState;
}): SetupPill {
  if (input.embed === 'stale') return 'stale';
  if (!input.hasKeypair || input.source === 'none' || input.embed === 'pending') {
    return 'needs-setup';
  }
  return 'ready';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx tests/check-setup-status.ts`
Expected: PASS — every `ok` line, ending `PASS: setup-status derivation is correct.`

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/setup-status.ts tests/check-setup-status.ts
git commit -m "feat(setup): fingerprint public keys and derive setup step state

The embed step is marked by the operator because the server cannot see
another repo. Binding the mark to a fingerprint of the key it was made
against means a keygen --force rotation flips it to stale instead of
leaving a checkmark that is no longer true.

Fingerprints hash the PEM with whitespace stripped, so the same key
round-tripped through MySQL, the clipboard, or an env var with literal
\\n does not read as a rotation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Report where the private key came from

**Files:**
- Modify: `src/keys.ts` (extract lookup from `getPrivateKeyPem`, lines 43-69)
- Test: `tests/check-key-source.ts` (create)

**Interfaces:**
- Consumes: `PrivateKeySource` from `src/setup-status.ts` (Task 1); `Product` from `src/products.ts`.
- Produces: `getPrivateKeySource(product?: Product): PrivateKeySource`

**Context — two constraints from the spec:**

1. The lookup order must be **shared** with `getPrivateKeyPem`, not duplicated. If they drift, the UI reports a source that differs from the key actually used for signing.
2. It must **bypass the module cache** (`src/keys.ts:27`). The cache stores only the PEM, not its origin, so a cached hit cannot say where the key came from.

- [ ] **Step 1: Write the failing test**

Create `tests/check-key-source.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import { getPrivateKeySource, getPrivateKeyPem } from '../src/keys';
import type { Product } from '../src/products';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    console.error('  FAIL ' + name);
    failures++;
  }
}

function fakeProduct(id: string, envKeyName: string): Product {
  return {
    id,
    name: id,
    key_prefix: 'TST',
    license_prefix: 'TST1',
    public_key: null,
    env_key_name: envKeyName,
    status: 'active',
  } as Product;
}

// A syntactically valid Ed25519 private key PEM for the env-var path.
const { privateKey } = require('crypto').generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// ── source: 'none' ───────────────────────────────────────────────────────────
// A product id that has no keys/<id>/ directory and no env var set.
const missing = fakeProduct('zzz-nonexistent-product', 'ZZZ_NO_SUCH_ENV_VAR');
delete process.env.ZZZ_NO_SUCH_ENV_VAR;
check("no env var and no file => 'none'", getPrivateKeySource(missing) === 'none');

// ── source: 'env' ────────────────────────────────────────────────────────────
process.env.ZZZ_TEST_PRIVATE_KEY = privateKey;
const viaEnv = fakeProduct('zzz-env-product', 'ZZZ_TEST_PRIVATE_KEY');
check("env var set => 'env'", getPrivateKeySource(viaEnv) === 'env');
// An env var without a PEM body must not count — getPrivateKeyPem requires
// 'BEGIN', so the reported source has to apply the same test.
process.env.ZZZ_TEST_EMPTY = 'not-a-pem';
const viaBadEnv = fakeProduct('zzz-bad-env-product', 'ZZZ_TEST_EMPTY');
check("env var without BEGIN => 'none'", getPrivateKeySource(viaBadEnv) === 'none');

// ── source: 'local-file' ─────────────────────────────────────────────────────
// verdix-pos keeps the flat keys/private-key.pem layout, so it exercises the
// file path in a real checkout.
const flatPem = path.join(__dirname, '..', 'keys', 'private-key.pem');
if (fs.existsSync(flatPem)) {
  const posProduct = fakeProduct('verdix-pos', 'ZZZ_UNSET_FOR_THIS_CHECK');
  delete process.env.ZZZ_UNSET_FOR_THIS_CHECK;
  check("file present, no env => 'local-file'", getPrivateKeySource(posProduct) === 'local-file');

  // The reported source must agree with what signing actually resolves.
  let resolved = false;
  try {
    resolved = getPrivateKeyPem(posProduct).includes('BEGIN PRIVATE KEY');
  } catch {
    resolved = false;
  }
  check('source agrees with getPrivateKeyPem', resolved === true);
} else {
  console.log("  skip 'local-file' checks — no keys/private-key.pem in this checkout");
}

// ── Cache must not mask the source ───────────────────────────────────────────
// getPrivateKeyPem populates a module cache keyed by product id that stores
// only the PEM. Reading the source after that must still be correct.
process.env.ZZZ_CACHE_TEST = privateKey;
const cacheProduct = fakeProduct('zzz-cache-product', 'ZZZ_CACHE_TEST');
getPrivateKeyPem(cacheProduct); // populates the cache
check("source still 'env' after cache fill", getPrivateKeySource(cacheProduct) === 'env');

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nPASS: private key source reporting is correct.');
process.exit(0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/check-key-source.ts`
Expected: FAIL — `getPrivateKeySource` is not exported from `../src/keys`.

- [ ] **Step 3: Write minimal implementation**

In `src/keys.ts`, replace the body of `getPrivateKeyPem` (lines 43-69) and add the new function. The lookup is factored into `resolveKey` so both callers share one order:

```typescript
import type { PrivateKeySource } from './setup-status';

/**
 * Single resolution point for a product's private key, shared by
 * getPrivateKeyPem and getPrivateKeySource so the source the dashboard reports
 * can never disagree with the key actually used for signing.
 *
 * Deliberately does NOT consult the module cache: the cache stores only the
 * PEM, so a cached hit cannot say where the key came from.
 */
function resolveKey(
  productId: string,
  envVar: string
): { pem: string; source: PrivateKeySource } | null {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.includes('BEGIN')) {
    return { pem: normalizePem(fromEnv), source: 'env' };
  }
  for (const filePath of keyFilePaths(productId)) {
    if (fs.existsSync(filePath)) {
      return { pem: fs.readFileSync(filePath, 'utf8'), source: 'local-file' };
    }
  }
  return null;
}

export function getPrivateKeyPem(product?: Product): string {
  const productId = product?.id ?? DEFAULT_PRODUCT_ID;
  const envVar = product?.env_key_name ?? DEFAULT_ENV_VAR;

  const hit = cache.get(productId);
  if (hit) return hit;

  const resolved = resolveKey(productId, envVar);
  if (resolved) {
    cache.set(productId, resolved.pem);
    return resolved.pem;
  }

  throw new Error(
    `No signing key for product "${productId}". Set ${envVar}, or run ` +
      `\`npm run keygen -- --product ${productId}\`.`
  );
}

/**
 * Where this server resolves the product's private key from — without returning
 * any key material.
 *
 * NOTE: this describes THIS running server. Opening the dashboard locally
 * reports 'local-file' even when Railway is correctly configured, which is why
 * the UI names the source rather than claiming the key is deployed.
 */
export function getPrivateKeySource(product?: Product): PrivateKeySource {
  const productId = product?.id ?? DEFAULT_PRODUCT_ID;
  const envVar = product?.env_key_name ?? DEFAULT_ENV_VAR;
  return resolveKey(productId, envVar)?.source ?? 'none';
}
```

Leave `hasPrivateKey` (lines 71-78) as it is — it still works and other callers use it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx tests/check-key-source.ts`
Expected: PASS — ending `PASS: private key source reporting is correct.`

Then confirm nothing regressed in the existing key resolution:

Run: `npx tsx tests/check-keys.ts`
Expected: `PASS: verdix-pos resolves the same key as the legacy default path.`

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/keys.ts tests/check-key-source.ts
git commit -m "feat(keys): report which source a product's private key came from

Extracts the lookup order into a shared resolveKey so the source shown
in the dashboard cannot drift from the key used for signing, and skips
the module cache, which stores only the PEM and so cannot say where it
came from.

Returns a label only, never key material.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Persist the embed mark

**Files:**
- Modify: `src/schema.ts` (add to the `COLUMNS` array at lines 137-144)
- Modify: `src/products.ts` (extend `Product`, add setter)

**Interfaces:**
- Consumes: `EmbedMark` from `src/setup-status.ts` (Task 1).
- Produces:
  - `Product.embed_marked: EmbedMark | null` (new field on the existing interface)
  - `setProductEmbedMark(id: string, mark: EmbedMark | null): Promise<void>`

- [ ] **Step 1: Add the column migration**

In `src/schema.ts`, extend the `COLUMNS` array (currently lines 137-144) with a second entry:

```typescript
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
    // The operator's assertion that this product's public key was embedded in
    // its app, as { at, by, key_fp }. NULL means never marked. key_fp binds the
    // mark to the key it was made for, so a rotation invalidates it.
    sql: `ALTER TABLE products ADD COLUMN embed_marked JSON NULL`,
  },
];
```

`applyColumns` (lines 146-165) already skips columns that exist, so this is idempotent with no further change.

- [ ] **Step 2: Extend the Product interface and add the setter**

In `src/products.ts`, add the import and the `embed_marked` field to the `Product` interface (lines 10-18):

```typescript
import type { EmbedMark } from './setup-status';

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
}
```

Then append the setter after `setProductPublicKey` (lines 74-76):

```typescript
/**
 * Record (or clear) the operator's assertion that this product's public key was
 * embedded in its app. Pass null to clear.
 *
 * The caller computes key_fp from the CURRENT public_key — never from client
 * input, which would let any fingerprint be marked and defeat stale detection.
 */
export async function setProductEmbedMark(id: string, mark: EmbedMark | null): Promise<void> {
  await query(`UPDATE products SET embed_marked = ? WHERE id = ?`, [
    mark ? JSON.stringify(mark) : null,
    id.trim(),
  ]);
}
```

- [ ] **Step 3: Write the migration idempotency test**

Create `tests/check-embed-column.ts`:

```typescript
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
  await setProductEmbedMark(DEFAULT_PRODUCT_ID, mark);
  const marked = await getProduct(DEFAULT_PRODUCT_ID);
  check('mark round-trips', JSON.stringify(marked?.embed_marked) === JSON.stringify(mark));

  await setProductEmbedMark(DEFAULT_PRODUCT_ID, null);
  const cleared = await getProduct(DEFAULT_PRODUCT_ID);
  check('mark clears to null', cleared?.embed_marked == null);

  await setProductEmbedMark(DEFAULT_PRODUCT_ID, original);

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
```

- [ ] **Step 4: Run the migration twice to prove idempotency**

Run: `npm run migrate`
Expected: includes `✓ column added: products.embed_marked`.

Run: `npm run migrate` again
Expected: includes `· column exists: products.embed_marked`, exit 0, no error.

- [ ] **Step 5: Run the test**

Run: `npx tsx tests/check-embed-column.ts`
Expected: PASS — ending `PASS: embed_marked column and round-trip are correct.`

**Note on the JSON column:** `mysql2` returns a `JSON` column already parsed into an object, so `Product.embed_marked` needs no manual `JSON.parse`. If this test reports `mark round-trips` FAIL with a string value, the driver returned a string — add a parse in `getProduct` and re-run. Do not paper over it in the UI layer.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/schema.ts src/products.ts tests/check-embed-column.ts
git commit -m "feat(products): store the operator's embed mark

Adds products.embed_marked (JSON, nullable) via the existing additive
column migration, holding { at, by, key_fp }. NULL means never marked.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Setup and embed endpoints

**Files:**
- Modify: `src/server.ts` (insert after the products routes, currently lines 280-292)
- Test: `tests/check-setup-api.ts` (create)

**Interfaces:**
- Consumes: `getProduct`, `setProductEmbedMark` (`src/products.ts`, Task 3); `getPrivateKeySource` (`src/keys.ts`, Task 2); `publicKeyFingerprint`, `deriveEmbedState`, `deriveSetupPill` (`src/setup-status.ts`, Task 1).
- Produces:
  - `GET /api/products/:id/setup` → `{ success, data: { productId, licensePrefix, keyPrefix, envKeyName, publicKey, pill, steps } }`
  - `POST /api/products/:id/embed` with body `{ marked: boolean }` → `{ success }`

Both sit below the session guard at `src/server.ts:253-256`, so they are admin-authed with no extra work.

- [ ] **Step 1: Write the failing test**

Create `tests/check-setup-api.ts`. It drives the handler logic through HTTP against a running server, so it needs `LICENSE_UI_PORT` and an admin session:

```typescript
/**
 * Endpoint checks for the setup API. Requires a running server and admin creds:
 *
 *   npm run server
 *   SETUP_TEST_USER=admin SETUP_TEST_PASS=... npx tsx tests/check-setup-api.ts
 */
const BASE = process.env.SETUP_TEST_BASE || 'http://localhost:4100';
const USER = process.env.SETUP_TEST_USER || 'admin';
const PASS = process.env.SETUP_TEST_PASS || '';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    console.error('  FAIL ' + name);
    failures++;
  }
}

async function main() {
  if (!PASS) {
    console.error('FAIL: set SETUP_TEST_PASS to the admin password.');
    process.exit(1);
  }

  // Log in and keep the session cookie.
  const login = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
  check('login succeeded', login.status === 200 && cookie.length > 0);
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };

  // ── Unknown product 404s ───────────────────────────────────────────────────
  const missing = await fetch(BASE + '/api/products/zzz-no-such-product/setup', { headers: auth });
  check('unknown product => 404', missing.status === 404);

  // ── Happy path shape ───────────────────────────────────────────────────────
  const res = await fetch(BASE + '/api/products/verdix-pos/setup', { headers: auth });
  check('verdix-pos setup => 200', res.status === 200);
  const body = await res.json();
  const d = body.data;
  check('has productId', d?.productId === 'verdix-pos');
  check('has licensePrefix', d?.licensePrefix === 'VRDX1');
  check('has envKeyName', typeof d?.envKeyName === 'string' && d.envKeyName.length > 0);
  check('has pill', ['ready', 'needs-setup', 'stale'].includes(d?.pill));
  check('steps.registered.ok is true', d?.steps?.registered?.ok === true);
  check('steps.keypair.ok is boolean', typeof d?.steps?.keypair?.ok === 'boolean');
  check('steps.embed.state valid', ['pending', 'done', 'stale'].includes(d?.steps?.embed?.state));
  check('steps.signing.source valid', ['env', 'local-file', 'none'].includes(d?.steps?.signing?.source));

  // ── The private key must NEVER be in the response ──────────────────────────
  const raw = JSON.stringify(body);
  check('no PRIVATE KEY in response', !raw.includes('PRIVATE KEY'));
  check('no privateKey field', !/privateKey/i.test(raw));

  // ── POST /embed ignores a client-supplied fingerprint ─────────────────────
  const forged = 'deadbeefdeadbeef';
  await fetch(BASE + '/api/products/verdix-pos/embed', {
    method: 'POST',
    headers: auth,
    // key_fp and by are attacker-controlled here; both must be ignored.
    body: JSON.stringify({ marked: true, key_fp: forged, by: 'not-the-session-user' }),
  });
  const after = await (await fetch(BASE + '/api/products/verdix-pos/setup', { headers: auth })).json();
  const mark = after.data?.steps?.embed;
  check('body key_fp ignored', mark?.state === 'done' || mark?.state === 'stale');
  check('marked by session user', mark?.by === USER);

  // Clear the mark so the test leaves no trace.
  await fetch(BASE + '/api/products/verdix-pos/embed', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ marked: false }),
  });
  const cleared = await (await fetch(BASE + '/api/products/verdix-pos/setup', { headers: auth })).json();
  check('unmark returns to pending', cleared.data?.steps?.embed?.state === 'pending');

  // ── Marking with no public key must 400 ───────────────────────────────────
  // There is nothing to fingerprint, so the mark would describe nothing.
  // Uses a throwaway product so no real product row is disturbed.
  const tmpId = 'zzz-setup-test-' + Date.now();
  const made = await fetch(BASE + '/api/products', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      id: tmpId,
      name: 'Setup Test (temporary)',
      key_prefix: 'ZZ' + String(Date.now()).slice(-2),
      license_prefix: 'ZY' + String(Date.now()).slice(-2),
      env_key_name: 'ZZZ_SETUP_TEST_KEY',
    }),
  });
  if (made.status === 200) {
    const noKey = await fetch(BASE + '/api/products/' + tmpId + '/embed', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ marked: true }),
    });
    check('mark without public key => 400', noKey.status === 400);

    const fresh = await (await fetch(BASE + '/api/products/' + tmpId + '/setup', { headers: auth })).json();
    check('fresh product keypair not ok', fresh.data?.steps?.keypair?.ok === false);
    check('fresh product => needs-setup', fresh.data?.pill === 'needs-setup');

    // There is no delete-product endpoint; remove the row directly.
    console.log(`  note remove the test product with: DELETE FROM products WHERE id = '${tmpId}';`);
  } else {
    console.log('  skip 400/fresh-product checks — could not create a temp product');
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nPASS: setup API is correct.');
  process.exit(0);
}
main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Start the server in one shell: `npm run server`
Then run: `SETUP_TEST_PASS=<your admin password> npx tsx tests/check-setup-api.ts`
Expected: FAIL — `verdix-pos setup => 200` fails (the route does not exist yet, so the server falls through and does not return 200 with this shape).

- [ ] **Step 3: Write minimal implementation**

In `src/server.ts`, extend the products import (line 36):

```typescript
import { listProducts, createProduct, getProduct, setProductEmbedMark } from './products';
```

Add these imports near the other `./` imports:

```typescript
import { getPrivateKeySource } from './keys';
import { publicKeyFingerprint, deriveEmbedState, deriveSetupPill } from './setup-status';
```

Then insert both routes immediately after the existing `POST /api/products` block (which ends at line 292), before the `// Licenses` comment:

```typescript
      // GET /api/products/:id/setup — derived setup checklist state.
      // Returns the PUBLIC key (developers need it to embed) and only a label
      // for the private key. No private key material is ever serialized.
      const setupMatch = p.match(/^\/api\/products\/([^/]+)\/setup$/);
      if (method === 'GET' && setupMatch) {
        const product = await getProduct(decodeURIComponent(setupMatch[1]));
        if (!product) return sendJson(res, 404, { success: false, error: 'Product not found.' });

        const source = getPrivateKeySource(product);
        const embed = deriveEmbedState(product.public_key, product.embed_marked);
        const hasKeypair = !!product.public_key;

        return sendJson(res, 200, {
          success: true,
          data: {
            productId: product.id,
            licensePrefix: product.license_prefix,
            keyPrefix: product.key_prefix,
            envKeyName: product.env_key_name,
            publicKey: product.public_key,
            pill: deriveSetupPill({ hasKeypair, source, embed }),
            steps: {
              registered: { ok: true },
              keypair: { ok: hasKeypair },
              embed: {
                state: embed,
                at: product.embed_marked?.at ?? null,
                by: product.embed_marked?.by ?? null,
              },
              signing: { ok: source !== 'none', source },
            },
          },
        });
      }

      // POST /api/products/:id/embed — record or clear the operator's assertion
      // that the public key was embedded in the product's app.
      const embedMatch = p.match(/^\/api\/products\/([^/]+)\/embed$/);
      if (method === 'POST' && embedMatch) {
        const product = await getProduct(decodeURIComponent(embedMatch[1]));
        if (!product) return sendJson(res, 404, { success: false, error: 'Product not found.' });

        const body = await readBody(req);
        if (body.marked === false) {
          await setProductEmbedMark(product.id, null);
          return sendJson(res, 200, { success: true });
        }

        if (!product.public_key) {
          return sendJson(res, 400, {
            success: false,
            error: 'No public key yet — run keygen for this product first.',
          });
        }

        // key_fp is computed HERE from the stored key, and `by` comes from the
        // session. Accepting either from the request body would let any
        // fingerprint be marked, defeating stale detection entirely.
        await setProductEmbedMark(product.id, {
          at: new Date().toISOString(),
          by: session.username,
          key_fp: publicKeyFingerprint(product.public_key),
        });
        return sendJson(res, 200, { success: true });
      }
```

- [ ] **Step 4: Run test to verify it passes**

Restart the server (`npm run server`), then run:
`SETUP_TEST_PASS=<your admin password> npx tsx tests/check-setup-api.ts`
Expected: PASS — ending `PASS: setup API is correct.`

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/check-setup-api.ts
git commit -m "feat(api): serve product setup state and accept the embed mark

GET /api/products/:id/setup returns derived step state, the public key,
and a label for where the private key resolves from. No private key
material is serialized.

POST /api/products/:id/embed computes key_fp server-side from the stored
public key and takes 'by' from the session; a client-supplied
fingerprint would let any value be marked and defeat stale detection.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Expandable setup panel in the Products tab

**Files:**
- Modify: `public/dashboard.html` (CSS near line 108; `.pill` variants at lines 102-107)
- Modify: `public/app.js` (`renderProducts` at lines 212-232; append new functions after `saveProduct`, which ends at line 253)

**Interfaces:**
- Consumes: `GET /api/products/:id/setup` and `POST /api/products/:id/embed` (Task 4). Existing dashboard helpers: `$`, `api`, `esc`, `toast`, `setCount`, `matchesQuery`, `val`, `fmtDate`, `productsCache`.
- Produces: the rendered UI. No exports (the dashboard is plain script scope).

- [ ] **Step 1: Add the CSS**

In `public/dashboard.html`, add a `Stale` pill variant after the existing `.pill` variants (after line 107) and the detail-row styles after `code.key` (line 108):

```css
    .pill.stale { background:rgba(239,68,68,.14); color:#fca5a5; }
    tr.expandable { cursor:pointer; }
    tr.expandable:hover { background:var(--panel2); }
    .chev { display:inline-block; width:14px; transition:transform .15s; color:var(--muted); }
    .chev.open { transform:rotate(90deg); }
    tr.detail > td { background:var(--panel2); padding:0; }
    .setup { padding:22px 26px; display:flex; flex-direction:column; gap:20px; }
    .setup-step { display:grid; grid-template-columns:26px 1fr; gap:12px; align-items:start; }
    .setup-step .mark { font-size:15px; line-height:1.4; }
    .setup-step .mark.ok { color:#86efac; }
    .setup-step .mark.warn { color:#fcd34d; }
    .setup-step .mark.bad { color:#fca5a5; }
    .setup-step .mark.todo { color:#a5b4fc; }
    .setup-step h4 { margin:0 0 4px; font-size:13px; font-weight:700; }
    .setup-step .note { color:var(--muted); font-size:12px; line-height:1.6; }
    .copyrow { display:flex; align-items:center; gap:10px; margin-top:8px; }
    .copyrow .lbl { color:var(--muted); font-size:12px; min-width:104px; }
    .setup pre { margin:8px 0 0; background:var(--panel); border:1px solid var(--border2);
      border-radius:9px; padding:11px 13px; font-family:ui-monospace,monospace;
      font-size:11px; line-height:1.6; color:#c7d2fe; overflow-x:auto; white-space:pre; }
```

- [ ] **Step 2: Add the Setup column and make rows expandable**

In `public/app.js`, replace `renderProducts` (lines 212-232) entirely:

```javascript
function renderProducts() {
  const el = $('products-table');
  if (!el) return;
  if (!productsCache.length) { setCount('products-count', 0, 0); el.innerHTML = '<div class="empty">No products yet. Click "New Product".</div>'; return; }
  const q = val('products-search');
  const data = productsCache.filter((p) => matchesQuery(p, ['name', 'id', 'key_prefix', 'license_prefix', 'env_key_name'], q));
  setCount('products-count', data.length, productsCache.length);
  if (!data.length) { el.innerHTML = '<div class="empty">No products match your search.</div>'; return; }
  el.innerHTML = `<table><thead><tr><th></th><th>Name</th><th>ID</th><th>Key Prefix</th><th>License Prefix</th><th>Env Var</th><th>Public Key</th><th>Setup</th></tr></thead><tbody>${
    data.map((p) => `<tr class="expandable" onclick="toggleProductSetup('${esc(p.id)}')">
      <td><span class="chev" id="chev-${esc(p.id)}">›</span></td>
      <td><strong>${esc(p.name)}</strong></td>
      <td><code class="key">${esc(p.id)}</code></td>
      <td><code class="key">${esc(p.key_prefix)}</code></td>
      <td><code class="key">${esc(p.license_prefix)}</code></td>
      <td><code class="key">${esc(p.env_key_name)}</code></td>
      <td>${p.public_key
        ? '<span class="pill active">present</span>'
        : '<span class="pill suspended">missing</span>'}</td>
      <td id="setup-pill-${esc(p.id)}"><span class="muted" style="font-size:12px">—</span></td>
    </tr>
    <tr class="detail hidden" id="detail-${esc(p.id)}"><td colspan="8"><div id="setup-${esc(p.id)}"></div></td></tr>`).join('')
  }</tbody></table>`;
}
```

- [ ] **Step 3: Add the expand/render/mark logic**

Append to `public/app.js` after `saveProduct` (which ends at line 253):

```javascript
// ── Product setup checklist ───────────────────────────────────────────────────
// The four setup steps are not equally knowable. Three are derived from server
// state; embedding the public key happens in the product's own repo, so the
// operator marks it and the mark is bound to the key's fingerprint.
const setupCache = {};

async function toggleProductSetup(id) {
  const row = $('detail-' + id);
  const chev = $('chev-' + id);
  if (!row) return;
  const opening = row.classList.contains('hidden');
  row.classList.toggle('hidden', !opening);
  if (chev) chev.classList.toggle('open', opening);
  if (!opening) return;

  const panel = $('setup-' + id);
  if (setupCache[id]) { panel.innerHTML = renderSetupPanel(setupCache[id]); return; }
  panel.innerHTML = '<div class="setup"><span class="muted">Loading setup status…</span></div>';
  await loadProductSetup(id);
}

async function loadProductSetup(id) {
  const res = await api('/api/products/' + encodeURIComponent(id) + '/setup');
  if (!res.success) {
    $('setup-' + id).innerHTML = `<div class="setup"><span class="muted">${esc(res.error || 'Could not load setup status.')}</span></div>`;
    return;
  }
  setupCache[id] = res.data;
  $('setup-' + id).innerHTML = renderSetupPanel(res.data);
  renderSetupPill(id, res.data.pill);
}

function renderSetupPill(id, pill) {
  const cell = $('setup-pill-' + id);
  if (!cell) return;
  const map = {
    'ready':       ['active',    'Ready'],
    'needs-setup': ['suspended', 'Needs setup'],
    'stale':       ['stale',     'Stale'],
  };
  const [cls, label] = map[pill] || ['suspended', 'Unknown'];
  cell.innerHTML = `<span class="pill ${cls}">${label}</span>`;
}

function copyBtn(text, label) {
  // Base64 so quotes/newlines in the value can't break out of the attribute.
  return `<button class="btn ghost sm" onclick="event.stopPropagation();copyValue('${btoa(unescape(encodeURIComponent(text)))}','${esc(label)}')">copy</button>`;
}

async function copyValue(b64, label) {
  try {
    await navigator.clipboard.writeText(decodeURIComponent(escape(atob(b64))));
    toast(label + ' copied to clipboard.', 'success');
  } catch {
    toast('Could not copy to clipboard.', 'error');
  }
}

function renderSetupPanel(d) {
  const s = d.steps;

  // Step 1 — always satisfied; the row exists because it's registered.
  const step1 = `<div class="setup-step">
    <span class="mark ok">✓</span>
    <div><h4>1. Registered</h4>
      <div class="note"><code class="key">${esc(d.productId)}</code> · product keys look like <code class="key">${esc(d.keyPrefix)}-XXXX-XXXX-XXXX</code></div></div>
  </div>`;

  // Step 2 — a stored public key means keygen ran for this product.
  const step2 = s.keypair.ok
    ? `<div class="setup-step">
        <span class="mark ok">✓</span>
        <div><h4>2. Signing keypair</h4>
          <div class="note">Public key stored on the product row.</div></div>
      </div>`
    : `<div class="setup-step">
        <span class="mark bad">✗</span>
        <div><h4>2. Signing keypair</h4>
          <div class="note">No keypair yet. Run this, then reopen this panel:</div>
          <pre>npm run keygen -- --product ${esc(d.productId)}</pre>
          <div class="copyrow">${copyBtn('npm run keygen -- --product ' + d.productId, 'Command')}</div></div>
      </div>`;

  // Step 3 — operator-marked. All three verifier overrides are shown together
  // because each one, if missed, fails silently: a wrong prefix reports
  // malformed-key and a wrong product id reports wrong-product.
  const embedHead = {
    done:    ['ok',   '✓', `Marked by ${esc(s.embed.by || '—')} · ${s.embed.at ? fmtDate(s.embed.at) : '—'}`],
    pending: ['todo', '→', 'You must do this in the product\'s own repo — the server cannot verify it.'],
    stale:   ['bad',  '⚠', `STALE — the key changed since this was marked${s.embed.by ? ` by ${esc(s.embed.by)} · ${fmtDate(s.embed.at)}` : ''}. Re-embed the key below.`],
  }[s.embed.state];

  const keyBlock = d.publicKey
    ? `<pre>${esc(d.publicKey.trim())}</pre>
       <div class="copyrow"><span class="lbl">public key</span>${copyBtn(d.publicKey.trim(), 'Public key')}</div>`
    : '<div class="note">No public key yet — complete step 2 first.</div>';

  const step3 = `<div class="setup-step">
    <span class="mark ${embedHead[0]}">${embedHead[1]}</span>
    <div><h4>3. Embed the public key in your app</h4>
      <div class="note">${embedHead[2]}</div>
      ${keyBlock}
      <div class="note" style="margin-top:12px">Your verifier must override <strong>all three</strong>:</div>
      <div class="copyrow"><span class="lbl">product id</span><code class="key">${esc(d.productId)}</code>${copyBtn(d.productId, 'Product id')}</div>
      <div class="copyrow"><span class="lbl">license prefix</span><code class="key">${esc(d.licensePrefix)}</code>${copyBtn(d.licensePrefix, 'License prefix')}</div>
      <div class="copyrow"><span class="lbl">public key</span><span class="note">shown above</span></div>
      ${d.publicKey ? `<div class="copyrow" style="margin-top:12px">
        ${s.embed.state === 'done'
          ? `<button class="btn ghost sm" onclick="event.stopPropagation();markEmbedded('${esc(d.productId)}',false)">Unmark</button>`
          : `<button class="btn sm" onclick="event.stopPropagation();markEmbedded('${esc(d.productId)}',true)">${s.embed.state === 'stale' ? 'Re-mark as embedded' : '✓ Mark as embedded'}</button>`}
      </div>` : ''}
    </div>
  </div>`;

  // Step 4 — names the source rather than claiming "deployed", because this
  // only describes the server you're talking to right now.
  const srcNote = {
    'env':        ['ok',   '✓', `Resolved from <code class="key">${esc(d.envKeyName)}</code> — the production path.`],
    'local-file': ['warn', '⚠', `Resolved from <code class="key">keys/${esc(d.productId)}/private-key.pem</code> only. This dashboard can't see your Railway environment, so a production deploy is <strong>not</strong> confirmed.`],
    'none':       ['bad',  '✗', 'No signing key found. Complete step 2, or set the env var below.'],
  }[s.signing.source];

  const step4 = `<div class="setup-step">
    <span class="mark ${srcNote[0]}">${srcNote[1]}</span>
    <div><h4>4. Deploy the private key</h4>
      <div class="note">${srcNote[2]}</div>
      <div class="copyrow"><span class="lbl">env var</span><code class="key">${esc(d.envKeyName)}</code>${copyBtn(d.envKeyName, 'Env var name')}</div>
      <div class="note">Set it to the contents of <code class="key">keys/${esc(d.productId)}/private-key.pem</code>. Never commit it.</div></div>
  </div>`;

  return `<div class="setup">${step1}${step2}${step3}${step4}</div>`;
}

async function markEmbedded(id, marked) {
  const res = await api('/api/products/' + encodeURIComponent(id) + '/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marked }),
  });
  if (!res.success) { toast(res.error || 'Could not update the mark.', 'error'); return; }
  delete setupCache[id];
  await loadProductSetup(id);
  toast(marked ? 'Marked as embedded.' : 'Mark cleared.', 'success');
}
```

- [ ] **Step 4: Verify in the browser**

Run: `npm run server`

Open `http://localhost:4100`, log in, go to **Products**, and confirm:

1. Each row has a `›` chevron that rotates on click; the detail row expands.
2. The Setup pill fills in after expanding (it loads lazily, so `—` before first expand is expected).
3. Step 1 shows the product id and the `XXXX-XXXX-XXXX` key pattern.
4. For `verdix-pos`: step 2 shows `✓`, step 4 shows either `from env var` or the amber `local file only` warning.
5. Every `copy` button copies the right value and raises a toast.
6. Click **Mark as embedded** → step 3 turns green with your username and today's date.
7. Search still filters rows correctly with the new column in place.

- [ ] **Step 5: Verify stale detection end to end**

This is the behaviour the whole design turns on, so exercise it for real.

With a product marked as embedded, rotate its keypair:

```bash
npm run keygen -- --product verdix-pos -- --force
```

⚠️ On a machine holding your real production key, do this with a **throwaway test product** instead (register one in the dashboard, run keygen for it, mark it, then rotate). Rotating `verdix-pos` invalidates every license already issued for it.

Reload Products and expand the product.
Expected: the Setup pill reads `Stale` (red), step 3 shows `⚠ STALE — the key changed since this was marked by <user>`, the new PEM is displayed, and the button reads **Re-mark as embedded**.

- [ ] **Step 6: Commit**

```bash
git add public/app.js public/dashboard.html
git commit -m "feat(dashboard): per-product setup checklist with stale detection

Products rows expand into a four-step checklist. Steps 1, 2 and 4 are
derived from server state; step 3 is operator-marked and flips to a red
Stale state when the keypair rotates, so it can't show a checkmark for a
key the app no longer has.

Step 4 names where the key resolved from rather than claiming it is
deployed, since a local dashboard can't see the Railway environment.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Document the checklist in the README

**Files:**
- Modify: `README.md` (the "Licensing a new product" section, lines 105-142)

- [ ] **Step 1: Point the README at the dashboard**

The README's four numbered steps now have a UI counterpart. Insert this right after the section heading `## Licensing a new product` (line 105), before the existing step 1:

```markdown
> **Tip:** the dashboard tracks these four steps per product. Open **Products**
> and click a row to see which are done, copy the values each remaining step
> needs, and mark step 3 once you've embedded the key. Step 3 is bound to the
> key's fingerprint, so rotating the keypair flips it back to a red **Stale**
> state instead of leaving a stale checkmark.
```

Then append this note at the end of the section, after the closing line about cryptographic isolation (line 142):

```markdown
Two things the dashboard deliberately does **not** claim:

- **Step 3 is your assertion, not a verification.** The server can't see your
  app's repo. The fingerprint binding only guarantees the mark can't outlive the
  key it was made for.
- **Step 4 describes the server you're viewing.** A local dashboard reports
  `local file only` even when Railway is configured correctly, which is why the
  badge names the source instead of claiming the key is deployed.
```

- [ ] **Step 2: Fix the stale script names while you're here**

The README's Setup section (lines 34-46) and Command-line section (lines 62-69) reference `npm run license:keygen`, `license:migrate`, `license:seed-admin`, `license:server` and `license:new`. Those prefixes are left over from when this lived inside the POS monorepo — `package.json` now defines `keygen`, `migrate`, `seed-admin`, `server` and `new`.

Replace every `npm run license:<name>` with `npm run <name>` throughout `README.md`. Verify none remain:

Run: `grep -n "license:" README.md`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe the setup checklist and fix stale script names

The license: script prefixes predate the split from the POS monorepo;
package.json defines the unprefixed names.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Full verification

**Files:** none modified.

- [ ] **Step 1: Run every test**

```bash
npx tsx tests/check-setup-status.ts
npx tsx tests/check-key-source.ts
npx tsx tests/check-embed-column.ts
npx tsx tests/check-keys.ts
npx tsx tests/check-products.ts
npx tsx tests/check-multi-product.ts
npx tsx tests/check-prefix-isolation.ts
npx tsx tests/verify-legacy.ts
```

Expected: every script prints `PASS` and exits 0.

`verify-legacy.ts` matters most here: it verifies a real pre-multi-product token against the production keypair. If it fails, the wire format or Verdix key resolution regressed and every license already in customers' hands is at risk — Task 2 touched key resolution, so this is the guard on that change.

With the server running:

```bash
SETUP_TEST_PASS=<admin password> npx tsx tests/check-setup-api.ts
```

Expected: `PASS: setup API is correct.`

That script creates a throwaway `zzz-setup-test-*` product to exercise the
"no public key" path and prints the id. There is no delete-product endpoint, so
remove the leftover rows:

```bash
npx tsx -e "import('./src/db').then(async m => { const r = await m.query(\"DELETE FROM products WHERE id LIKE 'zzz-setup-test-%'\"); console.log('deleted', r); process.exit(0); })"
```

Then confirm none remain:

```bash
npx tsx -e "import('./src/db').then(async m => { console.log(await m.query(\"SELECT id FROM products WHERE id LIKE 'zzz-%'\")); process.exit(0); })"
```

Expected: `[]`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 3: Confirm the private key never reaches the client**

```bash
grep -rn "getPrivateKeyPem" src/server.ts
```

Expected: no output. The server module must not resolve private key material for these endpoints — only `getPrivateKeySource`.

- [ ] **Step 4: Review the diff**

```bash
git log --oneline main..HEAD
git diff main...HEAD --stat
```

Expected: 6 commits (spec + Tasks 1-6), touching `src/setup-status.ts`, `src/keys.ts`, `src/schema.ts`, `src/products.ts`, `src/server.ts`, `public/app.js`, `public/dashboard.html`, `README.md`, and 4 test files.

- [ ] **Step 5: Report**

Summarize what was built, paste the test output, and state explicitly:
- whether every test passed (with output, not a claim)
- that stale detection was verified in a browser (Task 5, Step 5), or that it was not and why

Do not merge. Present the branch for review.
