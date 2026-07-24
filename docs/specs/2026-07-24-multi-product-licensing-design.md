# Multi-Product Licensing — Design

**Date:** 2026-07-24
**Status:** Approved (design)
**Repo:** `verdix-license-server` (the POS repo is deliberately untouched — see §5)

## Purpose

Turn the license server from a Verdix-POS-only service into a generic licensing server that can issue and validate licenses for **any** product, without breaking a single license already issued to a Verdix POS customer.

Today the server is generic in architecture (Ed25519 signing, machine binding, seat counting, dashboard, MySQL) but assumes exactly one product. Two constants in `src/licensing/core.ts` carry that assumption:

```typescript
export const PRODUCT_ID = 'verdix-pos';   // line 29 — stamped on every issued license
export const KEY_PREFIX = 'VRDX1';        // line 35 — token prefix, checked on verify
```

`PRODUCT_ID` is enforced at `src/licensing/verify.ts:125` (`if (p.product !== PRODUCT_ID) → invalid`). `generateProductKey()` in `service.ts` hardcodes the `VRDX-` product-key prefix. The `licenses` table has no notion of which product a license belongs to.

## Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Existing Verdix licenses | **Must keep working** — hard requirement | Live production customers |
| Signing keys | **Per-product keypair** | A single leaked key would otherwise compromise every product at once; rotation would invalidate everything. Per-product confines a leak to one product. |
| Key format | **Per-product prefix** | Each product gets its own product-key prefix (`VRDX-…`) and license-token prefix (`VRDX1.…`), so a key is identifiable on sight |
| POS repo | **No changes** | The POS is a single-product *verifier*; it does not need multi-product machinery (§5) |

## Architecture

### 1. `products` table (new)

The product registry is what everything else keys off:

```sql
CREATE TABLE products (
  id             VARCHAR(64) PRIMARY KEY,   -- 'verdix-pos', 'my-other-app'
  name           VARCHAR(255) NOT NULL,     -- 'Verdix POS' (dashboard display)
  key_prefix     VARCHAR(16) NOT NULL,      -- 'VRDX'  → product keys: VRDX-XXXX-XXXX-XXXX
  license_prefix VARCHAR(16) NOT NULL,      -- 'VRDX1' → tokens: VRDX1.<payload>.<sig>
  public_key     TEXT NULL,                 -- PEM; shown in dashboard for embedding in the app
  env_key_name   VARCHAR(64) NOT NULL,      -- env var holding this product's PRIVATE key
  status         ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

`licenses` gains:

```sql
ALTER TABLE licenses
  ADD COLUMN product_id VARCHAR(64) NOT NULL DEFAULT 'verdix-pos',
  ADD CONSTRAINT fk_license_product FOREIGN KEY (product_id) REFERENCES products(id);
```

**Backward compatibility mechanism.** The migration inserts the `verdix-pos` row first:

```
id='verdix-pos', name='Verdix POS', key_prefix='VRDX',
license_prefix='VRDX1', env_key_name='LICENSE_PRIVATE_KEY'
```

Because `product_id` defaults to `'verdix-pos'`, every pre-existing license row is silently and correctly attributed to Verdix POS. No backfill script, no data loss, no reissue.

### 2. Crypto core: constants → parameters

```typescript
// before
export function signLicense(payload, privateKeyPem)              // prefix baked in
export function verifyLicenseKey(key)                            // compares against PRODUCT_ID

// after
export function signLicense(payload, privateKeyPem, licensePrefix)
export function verifyLicenseKey(key, expectedProduct, expectedPrefix, publicKeyPem)
```

`LicensePayload.product` (core.ts:43) **already exists** and already carries the product string. Only its *source* changes: from the module-level constant to the license's product record.

**The wire format does not change.** Same payload shape, same Ed25519 scheme, same `<prefix>.<b64payload>.<b64sig>` layout. A `VRDX1.` token issued before this work and one issued after are byte-compatible.

### 3. Per-product key resolution

```typescript
// before
export function getPrivateKeyPem(): string
//   env LICENSE_PRIVATE_KEY → keys/private-key.pem

// after
export function getPrivateKeyPem(product: Product): string
//   env[product.env_key_name] → keys/<product.id>/private-key.pem
```

For `verdix-pos`, `env_key_name` is `LICENSE_PRIVATE_KEY` — **identical to today**. The Railway variable needs no change, and the existing local `keys/private-key.pem` continues to resolve (special-cased for `verdix-pos` so the current dev setup keeps working).

New products use whatever `env_key_name` they declare, e.g. `LICENSE_PRIVATE_KEY_MYAPP`.

Public keys are stored in `products.public_key` — a public key is not a secret, and holding it lets the dashboard show developers exactly what to embed in their app.

### 4. Dashboard, CLI, activation

- **Dashboard:** new "Products" section (list/add products, view public key). License list gains a product filter; the license-create form gains a product dropdown.
- **CLI:** `npm run new -- --product <id>` (defaults to `verdix-pos`). `npm run keygen -- --product <id>` generates a keypair for a new product.
- **Activation:** flow shape is unchanged. The app posts its product key; the server resolves the license → its `product_id` → that product's private key and prefix → signs.

### 5. Why the POS repo is not touched

`lib/licensing/` in the POS repo is a deliberate duplicate of the server's crypto (see the repo-split design). It is tempting to keep the two byte-identical, but the POS is a **single-product verifier**: it only ever asks "is this token mine, and is the signature valid?" It has no use for a product registry, per-product key resolution, or a prefix parameter.

So the two copies **intentionally diverge** after this change:

- **Server `src/licensing/core.ts`** — multi-product: product id and prefix are parameters.
- **POS `lib/licensing/core.ts`** — single-product: keeps `PRODUCT_ID = 'verdix-pos'` and `KEY_PREFIX = 'VRDX1'` as local constants.

The shared, must-stay-identical part is narrower than the whole file: the **payload shape, the signature scheme, and the token layout**. Those are what make a token verifiable on both sides. The sync comment in both files must be rewritten to say exactly this — otherwise a future reader will "fix" the divergence and break something.

Consequence: deployed POS builds keep verifying licenses with no update at all.

### 6. Error handling

| Condition | Behavior |
|---|---|
| Product id not in `products` | `400 unknown product` |
| No private key for product | `500 signing key not configured` — message names the expected `env_key_name` |
| Token prefix / product mismatch on verify | `invalid` (same as today) |
| Product `status='inactive'` | Refuse to issue new licenses; existing licenses still verify |

### 7. Testing

The gate for this work is a backward-compatibility test, mirroring the one used for the repo split:

1. **A token issued BEFORE the change must still verify AFTER it.** Capture a real `VRDX1.` token first; assert it verifies post-migration.
2. A license issued for `verdix-pos` after the change verifies against the POS's embedded public key.
3. A license issued for a second, new product verifies with that product's key — and **fails** against the Verdix key (proves isolation).
4. Existing `licenses` rows all report `product_id='verdix-pos'` after migration.

## Out of scope (YAGNI)

- Per-product seat/feature rule engines — the existing `max_activations` / `features` fields suffice
- Multi-tenant admin accounts (one admin per product) — single admin, as today
- Per-product dashboard branding — one dashboard
- Key-rotation tooling — remains manual
- Any change to the POS repo
