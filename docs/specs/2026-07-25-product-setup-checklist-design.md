# Product Setup Checklist — Design

**Date:** 2026-07-25
**Status:** Approved, ready for planning

## Problem

Licensing a new product takes four steps (register → generate keypair → embed the
public key in the app → deploy the private key). Today that sequence lives only
in the README. The Products tab shows the raw `products` row, so a half-finished
product looks identical to a working one, and the two failure modes that follow
from a missed step are silent:

- forgetting the `license_prefix` override → the app reports `malformed-key`
  (`verifyLicenseSignature` defaults to `VRDX1`, `src/licensing/core.ts:119`)
- forgetting the product id override → the app reports `wrong-product`
  (`verify.ts` compares against the `verdix-pos` constant, `src/licensing/verify.ts:125`)

Neither message points at the missing setup step.

## Goal

Show, per product, which setup steps are complete and what to do next — with the
values needed for the remaining steps available to copy. Audience is the
developer running the dashboard, so command lines, env var names and PEMs are
shown directly.

## Non-goals

- Splitting `public/app.js` (657 lines) or `public/dashboard.html` (579 lines).
  This feature adds ~120 lines and pushes both toward wanting a per-tab split,
  but that refactor is out of scope here.
- Verifying the production deployment. See "Honest limits" below.

## Step verifiability

The four steps are not equally knowable, and the design follows that rather than
presenting a uniform row of checkmarks:

| Step | Signal | Auto-detected |
|------|--------|---------------|
| 1. Registered | product row exists | yes |
| 2. Keypair | `public_key IS NOT NULL` | yes |
| 3. Embedded in app | operator's mark + key fingerprint | **no — manually marked** |
| 4. Private key | resolution source | yes, but only for *this* server |

Step 3 happens in a different repository. The server cannot observe it, so the
operator marks it — but the mark is bound to the key it was made for (below), so
it cannot silently outlive the key.

## Data model

One additive column, following the existing `COLUMNS` migration pattern in
`src/schema.ts:137-144`:

```
products.embed_marked  JSON NULL
```

```json
{ "at": "2026-07-25T10:12:00Z", "by": "admin", "key_fp": "a3f9c2e1b7d4..." }
```

`NULL` means never marked. Additive and idempotent, so live databases migrate
without disruption.

## Fingerprint normalization

`key_fp` = `sha256(<base64 body of the public key PEM>)`, first 16 hex chars.

The hash MUST be computed over the PEM with all whitespace stripped — not the
raw string. The same key legitimately appears with different whitespace: round
tripped through MySQL, pasted via clipboard, or supplied through an env var
containing literal `\n` sequences (which `keys.ts:29-31` already normalizes).
Hashing raw text would make a trailing newline or a CRLF read as a key change
and raise a false `stale` alarm.

New module `src/setup-status.ts` holds `publicKeyFingerprint()` and the step
derivation. It goes in its own file because `products.ts` is CRUD and `keys.ts`
is private-key loading; neither should grow a second responsibility.

## Step 3 states

Three states, not two:

- **`pending`** — `embed_marked` is NULL → `→ 3. Embed in your app  [mark as done]`
- **`done`** — stored `key_fp` matches the current public key → `✓ 3. Embed  marked by admin · Jul 25`
- **`stale`** — a mark exists but the fingerprint differs → `⚠ 3. Embed  STALE — key changed since you marked this`

`stale` is what makes the manual mark trustworthy: after `keygen --force`, the
public key embedded in the app yesterday is no longer the right one, and the
checkbox must stop claiming otherwise.

The record is NOT cleared on rotation. Keeping the original `at`/`by` visible
distinguishes "marked previously, for a different key" from "never marked" —
the history the operator asked for.

**Edge case:** `public_key` NULL with a mark present is `stale`, not `done`.
There is no key to embed, so the step cannot be complete.

## Step 4: private key source

New `getPrivateKeySource(product)` in `src/keys.ts` returns `'env' | 'local-file' | 'none'`:

| Source | Badge | Meaning |
|--------|-------|---------|
| `env` | 🟢 `from env var` | the production path |
| `local-file` | 🟡 `local file only` | Railway deployment NOT verified |
| `none` | 🔴 `not found` | keygen has not run |

Two implementation constraints:

1. The lookup order must be extracted from `getPrivateKeyPem` (`keys.ts:50-63`)
   into a shared helper, so the reported source cannot drift from the source
   actually used for signing. A disagreement between them would make the UI lie.
2. It must bypass the module cache (`keys.ts:27`). The cache stores only the PEM,
   not its origin, so a cached hit cannot answer where the key came from.

## API

```
GET  /api/products/:id/setup    → derived state (admin-authed)
POST /api/products/:id/embed    → { marked: true|false }
```

`GET` response:

```json
{
  "steps": {
    "registered": { "ok": true },
    "keypair":    { "ok": true },
    "embed":      { "state": "stale", "at": "...", "by": "admin" },
    "signing":    { "ok": true, "source": "local-file" }
  },
  "publicKey": "-----BEGIN PUBLIC KEY-----\n...",
  "envKeyName": "LICENSE_PRIVATE_KEY_VINV",
  "licensePrefix": "VINV1",
  "productId": "verdix-inventory"
}
```

A separate endpoint rather than extra fields on `GET /api/products`, because
`getPrivateKeySource` touches the filesystem; that cost should be paid per
product on expand, not for every row on page load.

**Security:**

- The private key never crosses the wire. Only a boolean and the `source` label.
- `POST /embed` computes the fingerprint server-side from the current
  `public_key`. It MUST NOT accept a fingerprint from the request body — a
  client-supplied value would let any fingerprint be marked and defeat stale
  detection entirely.
- `by` comes from the session (`server.ts:304`), not the body.
- `POST /embed` returns 400 when `public_key` is NULL — nothing to mark.
- `GET /setup` returns 404 for an unknown product.

## UI

In `renderProducts()` (`public/app.js:212`): each row gains a chevron and an
`onclick`, plus a new **Setup** column with a status pill. Expanding inserts a
`<tr class="detail">` spanning the table, lazy-loaded on first expand. Reuses
the existing `.keyout` block (`dashboard.html:145`) and the `navigator.clipboard`
helper already used for issued keys (`app.js:344`).

```
┌────────────────────────────────────────────────────────────┐
│ ✓  1. Registered          verdix-inventory · VINV-*        │
│                                                            │
│ ✓  2. Signing keypair     public key stored                │
│                                                            │
│ ⚠  3. Embed in your app   STALE — key changed              │
│      marked by admin · Jul 24 (for an older key)           │
│      ┌──────────────────────────────────────┐              │
│      │ -----BEGIN PUBLIC KEY-----           │  [copy]      │
│      └──────────────────────────────────────┘              │
│      Your verifier must override all three:                │
│        product id      verdix-inventory       [copy]       │
│        license prefix  VINV1                  [copy]       │
│        public key      (above)                             │
│                                    [✓ Mark as embedded]    │
│                                                            │
│ ⚠  4. Private key         local file only                  │
│      Set in Railway:  LICENSE_PRIVATE_KEY_VINV  [copy]     │
│      = contents of keys/verdix-inventory/private-key.pem   │
└────────────────────────────────────────────────────────────┘
```

When the keypair is missing, step 2 shows the copyable command
`npm run keygen -- --product <id>`.

All three verifier overrides are shown together because they are exactly the
three silent failures described under Problem.

### Setup pill

Evaluated in this order — the first match wins:

1. `Stale` (red) — `embed.state === 'stale'`
2. `Needs setup` (amber) — `keypair` not ok, OR `signing.source === 'none'`,
   OR `embed.state === 'pending'`
3. `Ready` (green) — keypair ok, signing resolves (`env` or `local-file`), and
   `embed.state === 'done'`

`Stale` is checked first, and gets its own colour, because it is the
actively-broken state: the app is running against a key that no longer matches.

Note that `signing.source === 'local-file'` still counts as `Ready`. The server
cannot distinguish "not deployed to Railway" from "deployed, but I am looking at
a local dashboard" (see Honest limits), so it must not block `Ready` on that
difference. The amber badge inside the expanded panel carries that nuance.

## Testing

Standalone `check-*.ts` scripts run with `npx tsx`, matching the existing
`tests/` convention (`PASS`/`FAIL` plus exit code, no framework).

- `publicKeyFingerprint()` returns the same value across differing whitespace,
  CRLF, and trailing newlines — this is what prevents false `stale`
- fingerprint mismatch → `stale`; match → `done`; NULL mark → `pending`
- `public_key` NULL with a mark present → `stale`, not `done`
- `getPrivateKeySource()` agrees with `getPrivateKeyPem()` in all three cases
- `GET /setup` response contains no private key material
- `POST /embed` ignores a fingerprint supplied in the request body
- `GET /setup` 404s for an unknown product
- migration is idempotent — running `migrate` twice does not error

## Honest limits

**Step 4 cannot confirm the key is on Railway.** It reports what the running
server can resolve. Opening the dashboard locally shows `local file only` even
when Railway is correctly configured. This is why the badge names the source
instead of claiming `✓ deployed` — it is truthful about what it knows.

**Step 3 is an operator assertion, not a verification.** The fingerprint binding
ensures the assertion cannot outlive the key it was made for, but it cannot
confirm the key was ever actually embedded.
