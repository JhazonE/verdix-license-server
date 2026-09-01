# Cloud Customer Provisioning UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Onboard a cloud POS customer entirely from the license dashboard — create the license, provision the customer's database, mint the hosted token, and present a ready-to-paste Railway environment block — behind an admin-only gate.

**Architecture:** The provisioning logic is extracted from the `provision-cloud` CLI script into a reusable exported function, so the CLI and a new HTTP endpoint share one implementation. A new admin-gated `POST /api/cloud-customers` orchestrates three steps (create license → provision database → mint token) and reports each independently. The dashboard gains a modal following the existing vanilla-JS pattern. The Dockerfile gains `mariadb-client`, without which provisioning cannot work in the deployed container.

**Tech Stack:** TypeScript on Node 20, raw `mysql2/promise`, a hand-rolled HTTP server (`src/server.ts` — no Express), vanilla HTML/JS dashboard (no framework, no build step), standalone `tests/check-*.ts` scripts run with `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-01-cloud-customer-provisioning-ui-design.md`

## Global Constraints

- **This repo is a SEPARATE git repository** at `d:/VERDIX_POS/verdix-license-server`. It is not the POS repo. All work and commits happen here.
- **Never test against the production licence database.** The repo's `.env` points `LICENSE_DB_HOST` at `metro.proxy.rlwy.net`, the live database holding 8 real customer licences and 9 activations. Use `./staging.sh` (server | migrate | seed-admin | psql | reset), which overrides `LICENSE_DB_*` in the environment and refuses to run against a non-staging database. Staging dashboard login: `admin` / `staging-only-pw`.
- **Do NOT push and do NOT deploy.** Commit locally only. This repo auto-deploys to a live server that every licensed installation — desktop included — depends on for heartbeats. The decision to ship belongs to the user.
- **`src/licensing/core.ts` is FROZEN.** It is a deliberate duplicate of the POS's copy. Changing the payload shape, the Ed25519 scheme, or the token layout invalidates every licence ever issued. Do not modify it.
- **Admin gating is server-side.** `session.role !== 'admin'` must be checked in the endpoint. Hiding a button in the UI is not access control.
- **`CLOUD_PROVISION_*` credentials never leave the server.** Only the generated per-customer database password is returned, and only in the creation response.
- **The existing desktop flow must not change.** `POST /api/licenses` and `saveLicense()` keep working exactly as they do today.
- **The three orchestration steps are not atomic.** On a step-2 or step-3 failure the licence created in step 1 is KEPT, never rolled back, and the response reports which steps succeeded.
- Verification command for this repo is `npm run typecheck` (there is no unit-test framework — tests are standalone `tsx` scripts).
- The repo has two unpushed commits already (`e1713ab` terminalCount, `d2e6e0c` this spec) plus `8e4ce78` (staging.sh). Work stacks on top of them.

---

### Task 1: Extract `provisionCloudDatabase` from the CLI

**Files:**
- Modify: `src/provision-cloud.ts` (extract the body of `main()` into an exported function)
- Test: `tests/check-cloud-provision-fn.ts` (create)

**Interfaces:**
- Consumes: `getLicenseByProductKey`, `getCloudConfig`, `upsertCloudConfig`, `addLicenseFeature` from `./service`; `deriveTenantNames` (already exported from this file).
- Produces:
  ```typescript
  export interface ProvisionResult {
    dbName: string;
    dbUser: string;
    password: string;
    host: string;
    port: number;
  }
  export async function provisionCloudDatabase(
    productKey: string,
    opts?: { rotatePassword?: boolean }
  ): Promise<ProvisionResult>
  ```
  Throws on failure (no licence found, missing admin creds, `mysqldump` failure, schema load failure).

**Keep the parameter as the product key, not the licence id** — the existing code resolves the key via `getLicenseByProductKey()` (line 43) and derives tenant names from `license.id` (line 46). The CLI's own `--license` argument is a product key. One redundant indexed lookup is cheaper than a dual-signature function.

- [ ] **Step 1: Read the current file end to end**

Read `src/provision-cloud.ts` in full before editing. The logic to extract runs from the `admin` credential block through `addLicenseFeature(license.id, 'cloud-sync')`. Note that `deriveTenantNames`, `arg()` and `flag()` already exist at module scope.

- [ ] **Step 2: Write the failing test**

Create `tests/check-cloud-provision-fn.ts`:

```typescript
/**
 * Verifies provisionCloudDatabase is importable and validates its inputs.
 *
 * This deliberately does NOT provision a real database — that needs admin MySQL
 * credentials and mysqldump. It checks the function exists with the right shape
 * and fails cleanly on a product key that does not exist, which is the contract
 * the HTTP endpoint depends on.
 */
import assert from 'node:assert/strict';
import { provisionCloudDatabase, deriveTenantNames } from '../src/provision-cloud';

assert.equal(typeof provisionCloudDatabase, 'function', 'provisionCloudDatabase is exported');

// Tenant naming stays deterministic — the endpoint reports these names to the operator.
const a = deriveTenantNames('license-id-1');
const b = deriveTenantNames('license-id-1');
assert.deepEqual(a, b, 'deriveTenantNames is deterministic');
assert.ok(a.dbName.startsWith('verdix_c_'), 'db name is prefixed');
assert.ok(a.dbUser.startsWith('u_'), 'db user is prefixed');
assert.notDeepEqual(deriveTenantNames('license-id-2'), a, 'different licences get different names');

// An unknown product key must reject, not hang or return a partial result.
await assert.rejects(
  () => provisionCloudDatabase('VRDX-0000-0000-0000'),
  /No license found/i,
  'unknown product key rejects with a clear message'
);

console.log('check-cloud-provision-fn: all assertions passed');
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `./staging.sh psql </dev/null >/dev/null 2>&1; npx tsx tests/check-cloud-provision-fn.ts`

Expected: FAIL — `provisionCloudDatabase` is not exported from `../src/provision-cloud`.

> Run it with the staging environment so the `getLicenseByProductKey` lookup hits the staging database, not production. The simplest way is to prefix the env vars the same way `staging.sh` does. If the test connects to production even once, stop and fix the invocation before continuing.

- [ ] **Step 4: Perform the extraction**

Restructure `src/provision-cloud.ts` so that:

1. A new exported interface and function hold the logic:

```typescript
export interface ProvisionResult {
  dbName: string;
  dbUser: string;
  password: string;
  host: string;
  port: number;
}

/**
 * Provisions a per-customer cloud database and records its encrypted config.
 * Shared by the CLI (`npm run provision-cloud`) and POST /api/cloud-customers.
 * Idempotent: re-running reuses the existing database and user.
 */
export async function provisionCloudDatabase(
  productKey: string,
  opts: { rotatePassword?: boolean } = {}
): Promise<ProvisionResult> {
  // ... the existing body of main(), with these substitutions:
  //   - `productKey` comes from the parameter, not arg('license')
  //   - `rotate` comes from opts.rotatePassword, not flag('rotate-password')
  //   - console.log lines are kept (harmless; they land in server logs)
  //   - returns { dbName, dbUser, password, host: admin.host, port: admin.port }
}
```

2. `main()` becomes a thin wrapper preserving today's CLI behaviour exactly:

```typescript
async function main() {
  const productKey = (arg('license') || '').trim();
  if (!productKey) throw new Error('Usage: cloud:provision -- --license VRDX-XXXX-XXXX-XXXX');
  const res = await provisionCloudDatabase(productKey, { rotatePassword: flag('rotate-password') });
  console.log(`\n✅ Provisioned cloud DB for ${productKey}`);
  console.log(`   database: ${res.dbName}`);
  console.log(`   user:     ${res.dbUser}`);
  console.log(`   feature 'cloud-sync' added to the license.`);
}
```

Keep the existing `if (require.main === module)` guard at the bottom unchanged.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx tests/check-cloud-provision-fn.ts` (with the staging env vars)
Expected: PASS — `check-cloud-provision-fn: all assertions passed`

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no output.

- [ ] **Step 7: Commit**

```bash
git add src/provision-cloud.ts tests/check-cloud-provision-fn.ts
git commit -m "refactor: extract provisionCloudDatabase for reuse by the API"
```

---

### Task 2: `POST /api/cloud-customers` endpoint

**Files:**
- Modify: `src/server.ts` (add the route inside the session-guarded section)
- Test: `tests/check-cloud-customer-endpoint.ts` (create)

**Interfaces:**
- Consumes: `provisionCloudDatabase` + `ProvisionResult` (Task 1); `createLicense` (`src/service.ts:141`); `issueSignedLicense` (`src/service.ts:334`); `getLicenseByProductKey`; `HOSTED_MACHINE_ID` from `./licensing/core`.
- Produces: `POST /api/cloud-customers`, admin-only, returning the per-step shape below. Task 3's UI consumes it.

**Response shape** (this exact structure — Task 3 reads these field names):

```jsonc
{
  "success": true,
  "data": {
    "license":  { "id": "...", "product_key": "VRDX-...", "ok": true },
    "database": { "ok": true,  "name": "verdix_c_...", "user": "u_...", "password": "...", "host": "...", "port": 3306 },
    "token":    { "ok": true,  "signedLicense": "VRDX1..." },
    "env":      { "DB_HOST": "...", "DB_PORT": "3306", "DB_USER": "...", "DB_PASSWORD": "...", "DB_NAME": "...", "DB_SSL": "true", "LICENSE_KEY": "VRDX1...", "LICENSE_SERVER_URL": "..." },
    "errors":   []
  }
}
```

On a step failure the corresponding object carries `{ ok: false, error: "..." }`, `env` is omitted, and `errors` lists what failed. `success` stays `true` when the licence was created — the operator needs the partial result, not a bare error.

- [ ] **Step 1: Write the failing test**

Create `tests/check-cloud-customer-endpoint.ts`:

```typescript
/**
 * Verifies POST /api/cloud-customers is admin-gated.
 *
 * Requires the staging server to be running:  ./staging.sh server
 * Run with:                                   npx tsx tests/check-cloud-customer-endpoint.ts
 */
import assert from 'node:assert/strict';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4100';

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const raw = res.headers.get('set-cookie') || '';
  const cookie = raw.split(';')[0];
  assert.ok(cookie.includes('lms_session'), 'login returned a session cookie');
  return cookie;
}

// (a) No session at all → rejected.
const anon = await fetch(BASE + '/api/cloud-customers', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ customer_id: 'x', type: 'perpetual' }),
});
assert.ok(anon.status === 401 || anon.status === 403, `unauthenticated request rejected (got ${anon.status})`);

// (b) An admin session reaches the handler (a validation error is fine — a 403 is not).
const adminCookie = await login('admin', 'staging-only-pw');
const admin = await fetch(BASE + '/api/cloud-customers', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
  body: JSON.stringify({}),   // deliberately invalid
});
assert.notEqual(admin.status, 403, 'admin is not forbidden');
assert.notEqual(admin.status, 404, 'route exists');

console.log('check-cloud-customer-endpoint: all assertions passed');
```

- [ ] **Step 2: Run the test to verify it fails**

Start the staging server first: `./staging.sh server` (leave it running in another terminal).
Run: `npx tsx tests/check-cloud-customer-endpoint.ts`
Expected: FAIL — the route returns 404 because it does not exist yet.

- [ ] **Step 3: Implement the endpoint**

In `src/server.ts`, inside the section that already has a valid `session` (below the `const session = getSession(req)` guard, alongside `/api/users`), add:

```typescript
      if (method === 'POST' && p === '/api/cloud-customers') {
        // Provisioning uses admin MySQL credentials that can create databases
        // and users — restrict it the same way /api/users is restricted.
        if (session.role !== 'admin')
          return sendJson(res, 403, { success: false, error: 'Admin role required.' });

        const body = await readBody(req);
        const errors: string[] = [];

        // Step 1 — create the licence. A failure here aborts: there is nothing to provision.
        let license: any;
        try {
          license = await svc.createLicense({ ...body, created_by: session.username });
        } catch (e: any) {
          return sendJson(res, 400, { success: false, error: 'License creation failed: ' + e.message });
        }

        const data: any = {
          license: { ok: true, id: license.id, product_key: license.product_key },
          database: { ok: false },
          token: { ok: false },
          errors,
        };

        // Step 2 — provision the database (skippable).
        let prov: ProvisionResult | null = null;
        if (body.provision_database !== false) {
          try {
            prov = await provisionCloudDatabase(license.product_key);
            data.database = { ok: true, name: prov.dbName, user: prov.dbUser, password: prov.password, host: prov.host, port: prov.port };
          } catch (e: any) {
            data.database = { ok: false, error: e.message };
            errors.push('database: ' + e.message);
          }
        } else {
          data.database = { ok: false, skipped: true };
        }

        // Step 3 — mint the hosted token. Runs even if step 2 failed: a licence with a
        // token but no database is recoverable, and the operator needs to see both states.
        try {
          const { signedLicense } = await svc.issueSignedLicense(license, HOSTED_MACHINE_ID, { record: true });
          data.token = { ok: true, signedLicense };
        } catch (e: any) {
          data.token = { ok: false, error: e.message };
          errors.push('token: ' + e.message);
        }

        if (prov && data.token.ok) {
          data.env = {
            DB_HOST: prov.host,
            DB_PORT: String(prov.port),
            DB_USER: prov.dbUser,
            DB_PASSWORD: prov.password,
            DB_NAME: prov.dbName,
            DB_SSL: 'true',
            LICENSE_KEY: data.token.signedLicense,
            LICENSE_SERVER_URL: process.env.PUBLIC_SERVER_URL || `http://localhost:${process.env.PORT || process.env.LICENSE_UI_PORT || 4100}`,
          };
        }

        return sendJson(res, 200, { success: true, data });
      }
```

Add the imports this needs at the top of `src/server.ts`, alongside the existing ones:

```typescript
import { provisionCloudDatabase, ProvisionResult } from './provision-cloud';
import { HOSTED_MACHINE_ID } from './licensing/core';
```

**Both signatures were verified against the source — the code above matches them:**

```typescript
// src/service.ts:141 — createLicense accepts an optional created_by and returns License
createLicense(input: { customer_id; product_id?; edition?; type; expires_at?; max_activations?; created_by?; ... }): Promise<License>

// src/service.ts:330 — issueSignedLicense's third argument is an options object
issueSignedLicense(
  license: License,
  machineIdRaw: string,
  opts: { machineLabel?; appVersion?; ip?; record?: boolean } = {}
): Promise<{ signedLicense: string; payload: LicensePayload }>
```

`record: true` is correct here: a hosted activation row should exist so the heartbeat can find it (`validateHeartbeat` returns `released` when no activation row matches). Note `normalizeMachineId` is applied inside `issueSignedLicense`, so passing the `HOSTED_MACHINE_ID` constant directly is right.

- [ ] **Step 4: Run the test to verify it passes**

Restart the staging server so it picks up the change, then run:
`npx tsx tests/check-cloud-customer-endpoint.ts`
Expected: PASS — `check-cloud-customer-endpoint: all assertions passed`

- [ ] **Step 5: Exercise the happy path by hand**

With the staging server running, create a real cloud customer end to end:

```bash
COOKIE=$(curl -s -i -X POST http://localhost:4100/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"staging-only-pw"}' \
  | grep -i '^set-cookie:' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)

curl -s -X POST http://localhost:4100/api/cloud-customers \
  -H 'Content-Type: application/json' -H "Cookie: $COOKIE" \
  -d '{"customer_id":"cust_staging_test","product_id":"verdix-pos","edition":"web","type":"subscription","expires_at":"2027-01-01T00:00:00.000Z","max_activations":3,"provision_database":false}'
```

Expected: `success: true`, `license.ok: true`, `token.ok: true` with a `VRDX1.` token, and `database.skipped: true`. Record the real output in your report.

> `provision_database: false` is used here so the check does not need admin MySQL
> credentials. Provisioning itself is covered by Task 1's function and the manual
> container check in Task 4.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck` — expected PASS.

```bash
git add src/server.ts tests/check-cloud-customer-endpoint.ts
git commit -m "feat: add admin-only POST /api/cloud-customers"
```

---

### Task 3: Dashboard UI

**Files:**
- Modify: `public/dashboard.html` (add the modal markup + the toolbar button)
- Modify: `public/app.js` (store the session role, gate the button, add the flow)

**Interfaces:**
- Consumes: `POST /api/cloud-customers` (Task 2) and its exact response field names.
- Produces: no programmatic interface — this is the operator-facing surface.

**Existing conventions to follow (read these first):**
- `$(id)`, `val(id)`, `esc(s)`, `show(id)`, `closeModal(id)`, `api(path, opts)` helpers live at the top of `public/app.js` (lines ~88-111).
- The modal pattern is `<div class="drawer-overlay" id="...">` → `.drawer` → `.drawer-head` / `.drawer-body` / `.drawer-foot`. Copy the structure of `license-issued-modal` (`public/dashboard.html:576`).
- Admin gating in the UI already exists: `public/app.js:983` hides `nav-users` when `me.data.role !== 'admin'`. Follow that idiom.
- `openLicenseModal()` (around `public/app.js:640`) shows how the customer and product dropdowns are populated from `customersCache` / `productsCache`.

- [ ] **Step 1: Store the session role**

In `public/app.js`, near the other module-scope caches (`customersCache`, `productsCache`), add:

```javascript
let currentRole = null;
```

In the bootstrap block that calls `api('/api/me')` (around line 978), record it right after `me.success` is confirmed:

```javascript
      currentRole = me.data.role;
```

- [ ] **Step 2: Add the toolbar button, hidden by default**

In `public/dashboard.html`, in the Licenses tab toolbar next to the existing "New License" control, add:

```html
<button class="btn" id="btn-cloud-customer" style="display:none" onclick="openCloudCustomerModal()">Create Cloud Customer</button>
```

It starts hidden and is revealed only for admins in Step 3.

- [ ] **Step 3: Reveal it for admins only**

In the same bootstrap block as Step 1, after `currentRole` is set:

```javascript
      const cloudBtn = $('btn-cloud-customer');
      if (cloudBtn) cloudBtn.style.display = currentRole === 'admin' ? '' : 'none';
```

> This is presentation only. The real gate is the server-side `session.role !== 'admin'`
> check in Task 2 — a hidden button is not access control.

- [ ] **Step 4: Add the modal markup**

In `public/dashboard.html`, next to `license-issued-modal`, add:

```html
<div class="drawer-overlay" id="cloud-customer-modal" onclick="if(event.target===this)closeModal('cloud-customer-modal')">
  <div class="drawer">
    <div class="drawer-head">
      <div class="ic" style="background:rgba(59,130,246,.15)">
        <svg viewBox="0 0 24 24" fill="none" stroke="#93c5fd" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>
      </div>
      <div><h3>Create Cloud Customer</h3><p>Licence, database and hosted token in one step</p></div>
      <button class="x" onclick="closeModal('cloud-customer-modal')">✕</button>
    </div>
    <div class="drawer-body">
      <label>Customer</label>
      <select id="cc-customer"></select>
      <label>Product</label>
      <select id="cc-product"></select>
      <label>Edition</label>
      <input id="cc-edition" value="web">
      <label>Terminals (max_activations)</label>
      <input id="cc-seats" type="number" min="1" value="1">
      <p class="muted" style="margin:4px 0 14px;font-size:12px">
        Cloud seats are counted from the store's terminals, not from machines.
        Set this to the number of tills the store actually runs — leaving it at 1
        blocks them from adding a second till.
      </p>
      <label>Expiry date</label>
      <input id="cc-expires" type="date">
      <label>Features (comma separated)</label>
      <input id="cc-features" value="cloud-sync">
      <label style="display:flex;align-items:center;gap:8px;margin-top:14px">
        <input id="cc-provision" type="checkbox" checked> Provision cloud database
      </label>
      <div id="cc-err" class="err"></div>
      <div id="cc-steps" style="margin-top:16px"></div>
      <div id="cc-env-wrap" style="display:none;margin-top:16px">
        <label>Railway environment variables</label>
        <div class="keyout"><pre id="cc-env" style="white-space:pre-wrap;word-break:break-all;margin:0;font-size:12px"></pre></div>
      </div>
    </div>
    <div class="drawer-foot">
      <button class="btn" onclick="closeModal('cloud-customer-modal')">Close</button>
      <button class="btn primary" id="cc-submit" onclick="submitCloudCustomer()">Create</button>
      <button class="btn" id="cc-copy" style="display:none" onclick="copyCloudEnv()">Copy Env Block</button>
    </div>
  </div>
</div>
```

- [ ] **Step 5: Add the flow functions**

In `public/app.js`, near the other licence functions, add:

```javascript
function openCloudCustomerModal() {
  if (!customersCache.length) { alert('Create a customer first.'); return; }
  $('cc-customer').innerHTML = customersCache.map((c) => `<option value="${c.id}">${esc(c.business_name)}</option>`).join('');
  const active = productsCache.filter((p) => p.status !== 'inactive');
  $('cc-product').innerHTML = active.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if (active.some((p) => p.id === 'verdix-pos')) $('cc-product').value = 'verdix-pos';
  $('cc-edition').value = 'web';
  $('cc-seats').value = '1';
  $('cc-expires').value = '';
  $('cc-features').value = 'cloud-sync';
  $('cc-provision').checked = true;
  $('cc-err').classList.remove('show');
  $('cc-steps').innerHTML = '';
  $('cc-env-wrap').style.display = 'none';
  $('cc-copy').style.display = 'none';
  $('cc-submit').style.display = '';
  show('cloud-customer-modal');
}

async function submitCloudCustomer() {
  const err = $('cc-err');
  err.classList.remove('show');
  const expires = val('cc-expires');
  if (!expires) { err.textContent = 'Set an expiry date.'; err.classList.add('show'); return; }

  const body = {
    customer_id: val('cc-customer'),
    product_id: val('cc-product') || undefined,
    edition: val('cc-edition'),
    type: 'subscription',
    expires_at: new Date(expires + 'T23:59:59').toISOString(),
    max_activations: parseInt(val('cc-seats') || '1', 10),
    features: val('cc-features').split(',').map((f) => f.trim()).filter(Boolean),
    provision_database: $('cc-provision').checked,
  };

  $('cc-submit').disabled = true;
  $('cc-steps').innerHTML = '<p class="muted" style="font-size:13px">Working…</p>';

  const res = await api('/api/cloud-customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  $('cc-submit').disabled = false;

  if (!res.success) {
    $('cc-steps').innerHTML = '';
    err.textContent = res.error || 'Failed.';
    err.classList.add('show');
    return;
  }

  const d = res.data;
  const row = (ok, label, detail) =>
    `<div style="display:flex;gap:8px;font-size:13px;margin-bottom:6px">
       <span style="color:${ok ? '#86efac' : '#fca5a5'}">${ok ? '✓' : '✕'}</span>
       <span>${esc(label)}</span>
       <span class="muted" style="word-break:break-all">${esc(detail || '')}</span>
     </div>`;

  $('cc-steps').innerHTML =
    row(d.license.ok, 'Licence created', d.license.product_key) +
    row(d.database.ok, d.database.skipped ? 'Database skipped' : 'Database provisioned',
        d.database.ok ? d.database.name : (d.database.error || '')) +
    row(d.token.ok, 'Hosted token minted',
        d.token.ok ? d.token.signedLicense.slice(0, 24) + '…' : (d.token.error || ''));

  if (d.env) {
    $('cc-env').textContent = Object.entries(d.env).map(([k, v]) => `${k}=${v}`).join('\n');
    $('cc-env-wrap').style.display = '';
    $('cc-copy').style.display = '';
    $('cc-submit').style.display = 'none';
  }

  loadLicenses();
}

async function copyCloudEnv() {
  try {
    await navigator.clipboard.writeText($('cc-env').textContent);
    $('cc-copy').textContent = '✓ Copied';
    setTimeout(() => { $('cc-copy').textContent = 'Copy Env Block'; }, 1500);
  } catch {}
}
```

- [ ] **Step 6: Verify in the browser**

Start the staging server (`./staging.sh server`) and open `http://localhost:4100`, logging in as `admin` / `staging-only-pw`.

Confirm, and record each in your report:
- The **Create Cloud Customer** button appears on the Licenses tab.
- Submitting with **Provision cloud database unchecked** shows: licence ✓, database skipped, token ✓.
- The seats field defaults to 1 and shows the warning text about tills.
- The licence appears in the licences table afterwards.

> Checking the non-admin path requires a `manager`/`staff` user. If one is easy to
> create via the Users tab, verify the button is hidden for them; if not, note in
> your report that only the server-side gate was verified (Task 2's test covers it).

- [ ] **Step 7: Commit**

```bash
git add public/dashboard.html public/app.js
git commit -m "feat: add Create Cloud Customer flow to the dashboard"
```

---

### Task 4: Dockerfile — MySQL client binaries

**Files:**
- Modify: `Dockerfile`

**Interfaces:**
- Consumes: nothing.
- Produces: a container image in which `mysqldump` and `mysql` resolve on PATH.

**Why this task exists:** `src/provision-cloud.ts` shells out to `mysqldump` (line 70) and `mysql` (line 76). The image is bare `node:20-alpine`, so **neither binary exists in the deployed container** and provisioning fails at runtime on the server while working on a developer machine.

- [ ] **Step 1: Add the package**

In `Dockerfile`, after the `FROM` line and before `WORKDIR`, add:

```dockerfile
# provision-cloud shells out to mysqldump/mysql to clone the reference schema.
# Without these the Provision Database step fails at runtime in the container.
RUN apk add --no-cache mariadb-client
```

`mariadb-client` provides both `mysql` and `mysqldump` on Alpine.

- [ ] **Step 2: Build the image and verify both binaries resolve**

Run:
```bash
docker build -t verdix-license-test .
docker run --rm verdix-license-test sh -c "which mysqldump && which mysql && mysqldump --version"
```
Expected: both paths print and a version string appears.

> If Docker is not available on this machine, do NOT fake this step. Record in your
> report that the build was not verified locally and that it must be checked before
> deploying — this is the one change that cannot be validated any other way.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "build: install mariadb-client so cloud provisioning works in the container"
```

---

### Task 5: Documentation

**Files:**
- Modify: `README.md` (document the new flow)

**Interfaces:**
- Consumes: everything above.
- Produces: operator-facing documentation. No code.

- [ ] **Step 1: Read the README's existing structure**

Read `README.md` and match its heading style and tone. Find where the CLI commands (`npm run provision-cloud`, `npm run new`) are documented.

- [ ] **Step 2: Document the dashboard flow**

Add a section covering:

1. **What it does** — Create Cloud Customer performs three steps (licence → database → hosted token) and returns a ready-to-paste Railway environment block.
2. **Who can use it** — admins only; the endpoint enforces `session.role === 'admin'` because provisioning uses admin MySQL credentials.
3. **Terminals field** — set it to the number of tills the store runs. Cloud seats are counted from `pos_terminals`, not machines; leaving it at 1 blocks the store from adding a second till.
4. **Partial failure** — the three steps are not atomic. If provisioning or minting fails, the licence is kept and the modal shows which steps succeeded. `provision-cloud` is idempotent, so the CLI fallback below is safe to re-run:
   ```bash
   npm run provision-cloud -- --license VRDX-XXXX-XXXX-XXXX
   npm run new -- --product-key VRDX-XXXX-XXXX-XXXX --web --edition web
   ```
5. **The CLI still works** and remains the documented fallback.
6. **Testing** — use `./staging.sh`, never the production database (`.env` points at the live server).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the Create Cloud Customer dashboard flow"
```

---

### Task 6: Final verification

**Files:** none modified.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS with no output.

- [ ] **Step 2: Confirm the CLI still works unchanged**

The Task 1 extraction must not have altered CLI behaviour. With the staging environment:

```bash
./staging.sh psql <<'EOF'
SELECT product_key FROM licenses LIMIT 1;
EOF
```

Then run `npm run provision-cloud -- --license <that key>` with the staging env vars.

Expected: it either provisions successfully or fails with a clear message about missing `CLOUD_PROVISION_*` credentials — **not** a crash, a `TypeError`, or an "unknown function" error. Either outcome proves the extraction preserved the CLI's wiring. Record the actual output.

- [ ] **Step 3: Run both check scripts**

```bash
npx tsx tests/check-cloud-provision-fn.ts
npx tsx tests/check-cloud-customer-endpoint.ts   # needs ./staging.sh server running
```
Expected: both print their `all assertions passed` line.

- [ ] **Step 4: Confirm production was never touched**

```bash
# Against the PRODUCTION database, read-only:
# expected: still 8 licences and 9 activations, unchanged from before this work.
```
Read the counts and confirm they are unchanged. If they are not, stop and report it immediately — it means something in this work ran against production.

- [ ] **Step 5: Confirm nothing was pushed**

Run: `git status -sb`
Expected: the branch is ahead of `origin/main` by the new commits and **nothing has been pushed**. Deployment is the user's decision.
