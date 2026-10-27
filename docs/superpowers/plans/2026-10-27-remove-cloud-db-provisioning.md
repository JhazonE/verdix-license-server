# Remove Cloud DB Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove cloud database provisioning from the licence server, and make Issue License produce both a Product Key and a hosted LICENSE_KEY for subscriptions.

**Architecture:** Provisioning is deleted outright — five source files, six tests, two HTTP endpoints, two dashboard modals. The `cloud_configs` table stays in the database untouched; only the code stops reading it. The licence-issuing path gains hosted-token minting, and `HOSTED` activation rows are excluded from all four seat-counting surfaces so a minted token never looks like or acts as an occupied seat.

**Tech Stack:** TypeScript (strict, `tsx` runner), Node 20, `mysql2`, vanilla browser JS in `public/`, `node:assert/strict` test scripts with no framework.

**Spec:** [docs/superpowers/specs/2026-10-27-remove-cloud-db-provisioning-design.md](../specs/2026-10-27-remove-cloud-db-provisioning-design.md)

## Global Constraints

- The `cloud_configs` table and its rows are never dropped or modified. `src/schema.ts` keeps its CREATE TABLE.
- Licences carrying `cloud-sync` in `features` are never rewritten. The feature becomes inert.
- `CLOUD_DB_*` is **not** provisioning config — it is the Railway fallback for the licence server's own database (`src/db.ts:29`, `:87`). Never touch it.
- No database credentials may appear in any API response after Task 2.
- `npm run typecheck` must be clean at the end of every task.
- `validateHeartbeat`'s `terminalCount` seat check (`src/service.ts:546`) survives unchanged, including its behaviour of reporting overage while still returning a signed licence.
- Seat exclusion is matched against the literal `'HOSTED'`. Stored `machine_id` is already normalized by `normalizeMachineId` before insert (`src/service.ts:335`, `:377`), so no re-normalization is needed in SQL.
- Attribution on every commit: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Review Focus

Input classes the spec implies that no task's own happy-path test exercises. Each has a test assigned to the task that owns the code.

1. **A licence with a `HOSTED` row and zero real activations** reads `0/N`, not `1/N` — the dashboard regression the spec calls out by name. (Task 1)
2. **MySQL unavailable during an activation** must apply the same seat rule as the SQL path, or the limit silently shifts by one. (Task 1)
3. **A perpetual licence issued through the modal** gets a Product Key and no hosted token, and the response carries no `hostedLicenseKey` field at all. (Task 4)
4. **Hosted token minting fails** (unknown product, missing signing key) while the licence itself was created — the operator must see the licence exists and why the token did not. (Task 4)
5. **A licence issued before this change, carrying `cloud-sync`,** still activates and validates, and its response contains no `cloudConfig` key. (Task 2)

---

## File Structure

| File | Change | Responsibility after |
|---|---|---|
| `src/service.ts` | Modify | Seat counts exclude `HOSTED`; `CloudConfig`/`upsertCloudConfig`/`getCloudConfig` gone |
| `src/cache.ts` | Modify | Cached seat count excludes `HOSTED` |
| `src/server.ts` | Modify | `cloudConfigFor` and both `/api/cloud-customers` handlers gone; `POST /api/licenses` mints hosted tokens |
| `src/provision-cloud.ts` | Delete | — |
| `src/seed-ref-db.ts` | Delete | — |
| `src/seed-tables.ts` | Delete | — |
| `src/tenant-summary.ts` | Delete | — |
| `src/cloud-config-crypto.ts` | Delete | — |
| `public/app.js` | Modify | Cloud modals/handlers gone; issue-result shows both keys |
| `public/dashboard.html` | Modify | Cloud modals gone; issue-result markup gains hosted-token block |
| `package.json` | Modify | `provision-cloud`/`seed-ref-db` scripts gone; `test` script added |
| `Dockerfile` | Modify | No Oracle MySQL client binaries |
| `scripts/audit-hosted-seats.ts` | Create | Read-only pre-deploy audit |
| `tests/check-hosted-seat-exclusion.ts` | Create | Pins `HOSTED` out of all four seat surfaces |
| `tests/check-issue-hosted-token.ts` | Create | Pins the subscription/perpetual token split |
| `docs/cloud-tenancy.md` | Modify | Marked historical |
| `README.md`, `.env.example` | Modify | Provisioning instructions removed |

Deleted tests: `check-cloud-customer-endpoint.ts`, `check-cloud-provision-fn.ts`, `check-provision-seeding.ts`, `check-ref-column-drift.ts`, `check-ref-db-seed.ts`, `check-seed-tables.ts`.

---

### Task 1: Exclude `HOSTED` from all four seat-counting surfaces

Done first and on its own: it is the one behavioural change that touches live
enforcement, and it must be correct before anything mints a hosted token.

**Files:**
- Modify: `src/service.ts:404-415` (`countActiveActivations`), `:250-258` (`listLicenses`), `:698-709` (`dashboardStats`)
- Modify: `src/cache.ts:66-73` (`countCachedActiveActivations`)
- Create: `tests/check-hosted-seat-exclusion.ts`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `HOSTED_ACTIVATION_MACHINE_ID` exported from `src/cache.ts` as `'HOSTED'`, so the SQL and the cache share one constant. (It lives in `cache.ts`, not `licensing/core.ts`, to keep the cache free of a dependency on the signing module.) Signatures of all four functions are unchanged.

- [ ] **Step 1: Add a `test` script to `package.json`**

Add to `scripts`: `"test": "for f in tests/check-*.ts; do echo \"— $f\"; npx tsx \"$f\" || exit 1; done"`.

The existing tests are standalone `tsx` scripts with no runner. Use `sh -c` semantics; on Windows this runs under Git Bash, which the environment provides. If that proves unreliable, a small `tests/run-all.ts` that `require`s each file in turn is an acceptable substitute — the requirement is one command that runs them all and exits non-zero on failure.

- [ ] **Step 2: Write the failing test**

Create `tests/check-hosted-seat-exclusion.ts`, following the no-database style of `tests/check-cloud-provision-fn.ts` and the SQL-assertion approach below. It has three parts:

```typescript
// 1. The cache path (Review Focus #2) — real function, no DB.
import { cachePutActivation, countCachedActiveActivations, HOSTED_ACTIVATION_MACHINE_ID } from '../src/cache';

assert.equal(HOSTED_ACTIVATION_MACHINE_ID, 'HOSTED');

const LID = 'lic-seat-test';
// CachedActivation (src/cache.ts:31) requires all ten fields; write a small
// factory that fills the rest and takes id + machine_id.
cachePutActivation(mkActivation('a1', 'HOSTED'));
cachePutActivation(mkActivation('a2', 'ABC123'));
assert.equal(countCachedActiveActivations(LID), 1, 'cached seat count excludes HOSTED');

// 2. All three SQL sites carry the exclusion. Read src/service.ts as text and
//    assert each COUNT over activations filters machine_id. This is a lint, not
//    a behavioural test — these three queries need a live MySQL to execute, and
//    a missed one is exactly the silent failure the spec warns about.
const src = readFileSync(join(__dirname, '..', 'src', 'service.ts'), 'utf8');
for (const fn of ['countActiveActivations', 'listLicenses', 'dashboardStats']) {
  // extract the function body, assert every `COUNT(*) ... FROM activations`
  // in it also mentions `machine_id`
}
```

Assert on all three SQL sites, and name the function in each assertion message so a failure says which one regressed.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx tests/check-hosted-seat-exclusion.ts`
Expected: FAIL — `HOSTED_ACTIVATION_MACHINE_ID` is not exported from `src/cache.ts`.

- [ ] **Step 4: Export the constant and apply the four exclusions**

In `src/cache.ts`: export `const HOSTED_ACTIVATION_MACHINE_ID = 'HOSTED'`, and add the machine-id condition to the loop in `countCachedActiveActivations`.

In `src/service.ts`, add `AND machine_id <> 'HOSTED'` to the three activation counts:
- `countActiveActivations` (`:406`)
- the `active_count` subquery in `listLicenses` (`:254`) — aliased `a`, so `a.machine_id`
- the activations count in `dashboardStats` (`:701`)

Import the constant and interpolate it rather than hardcoding the string a second time.

Leave the `terminalCount` check at `:546` alone.

- [ ] **Step 5: Run the test and the typecheck**

Run: `npx tsx tests/check-hosted-seat-exclusion.ts && npm run typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/service.ts src/cache.ts tests/check-hosted-seat-exclusion.ts package.json
git commit -m "fix(licensing): exclude hosted activations from every seat count"
```

---

### Task 2: Stop sending database credentials to the POS

**Files:**
- Modify: `src/server.ts:139-148` (delete `cloudConfigFor`), `:242-248` (activate response), `:294-296` (validate response)
- Create: `tests/check-no-cloud-config-in-responses.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `/api/activate` and `/api/validate` responses no longer carry a `cloudConfig` key. Both keep every other field.

- [ ] **Step 1: Write the failing test**

Create `tests/check-no-cloud-config-in-responses.ts`. Read `src/server.ts` as text and assert:

```typescript
assert.ok(!src.includes('cloudConfigFor'), 'cloudConfigFor is gone');
assert.ok(!/cloudConfig/.test(src), 'server.ts no longer references cloudConfig');
```

Covers Review Focus #5: a legacy `cloud-sync` licence cannot receive a `cloudConfig` because no code path can produce one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx tests/check-no-cloud-config-in-responses.ts`
Expected: FAIL — `cloudConfigFor` is still present.

- [ ] **Step 3: Delete `cloudConfigFor` and both call sites**

Remove the helper. In the activate handler, drop the `const cloudConfig = ...` line and the `...(cloudConfig ? { cloudConfig } : {})` spread. Same in the validate handler. Both responses keep `success`, `signedLicense`, `info` / the `result` spread.

- [ ] **Step 4: Run the test and the typecheck**

Run: `npx tsx tests/check-no-cloud-config-in-responses.ts && npm run typecheck`
Expected: PASS. The typecheck will still be clean — `svc.getCloudConfig` is not yet deleted.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/check-no-cloud-config-in-responses.ts
git commit -m "fix(licensing): stop attaching tenant DB credentials to API responses"
```

---

### Task 3: Audit script for existing hosted seats

Before the deploy frees a seat on every already-provisioned licence, the
operator needs to see which licences those are.

**Files:**
- Create: `scripts/audit-hosted-seats.ts`
- Modify: `package.json` (add `audit-hosted-seats` script)

**Interfaces:**
- Consumes: `query` from `src/db`.
- Produces: a CLI only. No module exports; nothing later depends on it.

- [ ] **Step 1: Write the script**

Create `scripts/audit-hosted-seats.ts`. It runs one read-only query joining `licenses`, `customers` and `activations`, and for each licence holding an active `HOSTED` row prints: product key, business name, `max_activations`, count of active non-`HOSTED` activations, and the resulting seat count before and after the change.

It must issue no writes. Follow the arg/exit style of `src/reset-admin.ts`. End with a summary line: how many licences gain a seat.

- [ ] **Step 2: Add the npm script**

Add to `scripts`: `"audit-hosted-seats": "tsx scripts/audit-hosted-seats.ts"`.

- [ ] **Step 3: Verify it typechecks and runs**

Run: `npm run typecheck && npm run audit-hosted-seats`
Expected: no type errors. The run either prints the table, or fails with a connection error if no database is reachable — report which, and do not claim a successful audit without output.

- [ ] **Step 4: Commit**

```bash
git add scripts/audit-hosted-seats.ts package.json
git commit -m "feat(licensing): add a read-only audit of hosted activation seats"
```

---

### Task 4: Issue License mints a hosted token for subscriptions

**Files:**
- Modify: `src/server.ts:460-469` (`POST /api/licenses`)
- Create: `tests/check-issue-hosted-token.ts`

**Interfaces:**
- Consumes: `svc.createLicense`, `svc.getLicense`, `svc.issueSignedLicense` (`src/service.ts:330`), `HOSTED_MACHINE_ID` (`src/licensing/core.ts:43`).
- Produces: `POST /api/licenses` response shape:
  `{ success: true, data: { ...license, hostedLicenseKey?: string, hostedTokenError?: string } }`.
  `hostedLicenseKey` is present only for `type === 'subscription'` when minting succeeded. `hostedTokenError` is present only when minting was attempted and failed. Neither key appears for perpetual licences. Task 5 consumes both.

- [ ] **Step 1: Write the failing test**

Create `tests/check-issue-hosted-token.ts`, asserting against `src/server.ts` as text in the style of Task 2 — the handler needs a live database and a signing key, so this pins the structure, and the behavioural check happens in the manual verification of Task 5.

```typescript
// The mint is gated on subscription (Review Focus #3)
assert.match(handlerSrc, /type\s*===\s*'subscription'/);
// It re-reads the licence before signing, as createLicense returns a pre-insert snapshot
assert.match(handlerSrc, /getLicense/);
// It records the activation, so the token can be recovered later
assert.match(handlerSrc, /record:\s*true/);
// A mint failure still returns the licence (Review Focus #4)
assert.match(handlerSrc, /hostedTokenError/);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx tests/check-issue-hosted-token.ts`
Expected: FAIL — the handler has no subscription branch.

- [ ] **Step 3: Extend the handler**

In `POST /api/licenses`, after `createLicense` succeeds and before responding: when `lic.type === 'subscription'`, re-read with `svc.getLicense(lic.id)` and call `svc.issueSignedLicense(fresh, HOSTED_MACHINE_ID, { record: true })`, putting `signedLicense` on the response as `hostedLicenseKey`.

Wrap the mint in its own `try/catch`. On failure, set `hostedTokenError` to the error message and still return `success: true` with the licence — the licence exists, and hiding that would strand the operator (Review Focus #4).

The re-read is not optional: `createLicense` returns the object it built, and signing a stale snapshot mints a token missing features the row actually has. The deleted `/api/cloud-customers` handler documented this at `src/server.ts:636`; `src/offline-cli.ts` re-reads for the same reason.

Import `HOSTED_MACHINE_ID` — `src/server.ts:42` already imports it.

- [ ] **Step 4: Run the test and the typecheck**

Run: `npx tsx tests/check-issue-hosted-token.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/check-issue-hosted-token.ts
git commit -m "feat(licensing): mint a hosted token when issuing a subscription"
```

---

### Task 5: Issue License result shows both keys

**Files:**
- Modify: `public/dashboard.html:622-639` (the `license-issued-modal` markup)
- Modify: `public/app.js:849-878` (`saveLicense`, `copyIssuedKey`)

**Interfaces:**
- Consumes: `hostedLicenseKey` and `hostedTokenError` from Task 4.
- Produces: nothing later depends on this.

- [ ] **Step 1: Extend the result modal markup**

In `license-issued-modal`, add below the existing product-key block a hidden block (`id="issued-hosted-wrap"`, `style="display:none"`) containing a `<pre id="issued-hosted">` and its own copy button (`id="issued-hosted-copy"`), plus an error line (`id="issued-hosted-err"`, hidden).

Label the two so the operator knows which path each belongs to. The Product Key block says it goes in the POS activation form; the hosted block says it goes in the Railway `LICENSE_KEY` variable. Follow the existing `keyout` / `muted` classes.

- [ ] **Step 2: Populate them in `saveLicense`**

After `show('license-issued-modal')`, show the hosted block and fill `issued-hosted` when `res.data.hostedLicenseKey` is present; show `issued-hosted-err` with the message when `res.data.hostedTokenError` is present; keep both hidden otherwise. Reset all three to hidden at the top of the success path, so a perpetual licence issued after a subscription does not inherit the previous token (Review Focus #3).

Add a `copyIssuedHostedKey()` alongside `copyIssuedKey`, same clipboard-and-confirm pattern.

- [ ] **Step 3: Verify in the dashboard**

Start the server (`npm run server`). Issue a **subscription** licence: both keys appear, each copies. Issue a **perpetual** licence: only the Product Key appears, no hosted block, no stale value.

Then check the Licenses table: the new subscription licence reads `0/N` in Computers, not `1/N` (Review Focus #1).

Report what you saw. If no database is available, say so plainly rather than reporting a pass.

- [ ] **Step 4: Commit**

```bash
git add public/dashboard.html public/app.js
git commit -m "feat(dashboard): show both the product key and the hosted token"
```

---

### Task 6: Delete the provisioning code

With licence issuing complete and seats correct, the old machinery comes out.

**Files:**
- Delete: `src/provision-cloud.ts`, `src/seed-ref-db.ts`, `src/seed-tables.ts`, `src/tenant-summary.ts`, `src/cloud-config-crypto.ts`
- Delete: `tests/check-cloud-customer-endpoint.ts`, `tests/check-cloud-provision-fn.ts`, `tests/check-provision-seeding.ts`, `tests/check-ref-column-drift.ts`, `tests/check-ref-db-seed.ts`, `tests/check-seed-tables.ts`
- Modify: `src/server.ts:523-676` (both `/api/cloud-customers` handlers, imports at `:40-41`)
- Modify: `src/service.ts:292-322` (`CloudConfig`, `upsertCloudConfig`, `getCloudConfig`)
- Modify: `public/app.js`, `public/dashboard.html`, `package.json`, `src/schema.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This task only removes.

- [ ] **Step 1: Delete the files**

The five `src/` files and six `tests/` files above.

- [ ] **Step 2: Remove the server endpoints and imports**

Delete the `GET /api/cloud-customers/:licenseId` and `POST /api/cloud-customers` handlers and the `provision-cloud` and `tenant-summary` imports (`:40-41`).

Also drop `normalizeMachineId` from the `licensing/core` import at `:42`: its only use is at `:550`, inside the handler being deleted. Keep `HOSTED_MACHINE_ID` — Task 4 uses it. Re-grep after deleting to confirm, rather than trusting this line.

- [ ] **Step 3: Remove the service functions**

Delete the `CloudConfig` interface, `upsertCloudConfig` and `getCloudConfig`, and the section comment.

- [ ] **Step 4: Remove the dashboard UI**

In `public/dashboard.html`: the `btn-cloud-customer` button (`:336`), the `cloud-customer-modal` and `cloud-details-modal` blocks.

In `public/app.js`: `openCloudCustomerModal`, `submitCloudCustomer`, `copyCloudEnv`, `openCloudDetails`, `copyCloudDetailsEnv`; the `btn-cloud-customer` visibility lines (`:1432-1433`); and the per-row `cloud-sync` conditional at `:821` that renders the Cloud Details button. No marker replaces it.

- [ ] **Step 5: Remove the npm scripts and mark the schema**

Delete `provision-cloud` and `seed-ref-db` from `package.json`.

In `src/schema.ts`, leave the `cloud_configs` CREATE TABLE in place and add a comment above it: retained for historical rows from the provisioning era, removed 2026-10-27, no longer read or written.

- [ ] **Step 6: Verify nothing dangles**

Run: `npm run typecheck && npm test`
Expected: no type errors, all remaining tests pass.

Then confirm no stragglers:
```bash
grep -rn "provision\|cloudConfig\|getCloudConfig\|seed-ref\|tenant-summary" src public package.json | grep -v cloud_configs
```
Expected: only the `schema.ts` comment. Investigate anything else.

Run `npx tsx tests/check-table-pagination.ts` specifically: it loads `public/app.js` into a VM and will catch a syntax error left by the UI edits.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(licensing): remove cloud database provisioning"
```

---

### Task 7: Dockerfile, docs and environment

**Files:**
- Modify: `Dockerfile`, `README.md`, `.env.example`, `docs/cloud-tenancy.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Strip the MySQL client binaries from the Dockerfile**

Remove both `COPY --from=mysql:8` lines, `libssl3` and `libncurses6` from the apt install, and the header comment explaining why they were needed. Keep `ca-certificates` — TLS to MySQL and outbound webhooks need it.

Stay on `node:20-slim`. Moving to Alpine is a separate, later commit; it cannot be verified here.

- [ ] **Step 2: Verify the image still builds**

Run: `docker build -t verdix-license-server:provisionless .`
Expected: a successful build.

If Docker is unavailable, say so and leave the step unchecked rather than claiming it passed.

- [ ] **Step 3: Update the README**

Replace "Creating a cloud customer (dashboard)" (~`:60-105`) with a section on the two activation paths: paste the Product Key into the POS activation form, or paste the hosted LICENSE_KEY into the service's `LICENSE_KEY` variable. Remove the `npm run provision-cloud` example and the `docs/cloud-tenancy.md` pointer at `:74`, replacing the latter with a note that the document is historical.

In the env-var docs (~`:146`), keep `PUBLIC_SERVER_URL` but drop the "Create Cloud Customer env block" wording. Leave the `LICENSE_DB_*` / `CLOUD_DB_*` text at `:151` and `:157` untouched.

- [ ] **Step 4: Update `.env.example`**

Remove lines 24-30 (the `CLOUD_PROVISION_*` block and `CLOUD_CONFIG_SECRET`). Fix the `PUBLIC_SERVER_URL` comment at `:16`. Leave `CLOUD_DB_*` at `:1` alone.

- [ ] **Step 5: Mark `docs/cloud-tenancy.md` historical**

Add a header block at the top: provisioning was removed on 2026-10-27; this document describes tenant databases that still physically exist but are no longer created, read or managed by the server; it is retained so they can be decommissioned by hand; see the design doc. Leave the body intact.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile README.md .env.example docs/cloud-tenancy.md
git commit -m "docs(licensing): retire the provisioning docs and image dependencies"
```

Include in the commit body the env vars now safe to clear from Railway: `CLOUD_PROVISION_HOST`, `CLOUD_PROVISION_PORT`, `CLOUD_PROVISION_USER`, `CLOUD_PROVISION_PASSWORD`, `CLOUD_PROVISION_REF_DB`, `CLOUD_CONFIG_SECRET` — and state that `CLOUD_DB_*` must stay.

---

## Final verification

- [ ] `npm run typecheck` clean
- [ ] `npm test` — every remaining test passes; if any needs a database that is not available, name it rather than reporting a clean run
- [ ] `npm run audit-hosted-seats` output captured for the operator
- [ ] Dashboard: subscription shows both keys, perpetual shows one, Computers reads `0/N` on a freshly issued licence
- [ ] `grep -rn "CLOUD_PROVISION\|CLOUD_CONFIG_SECRET" src public` returns nothing
- [ ] `grep -rn "CLOUD_DB" src` still returns `src/db.ts` — the fallback survived
