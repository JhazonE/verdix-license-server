# Licensing Your App — Integration Guide

How to make a new product verify licenses issued by this server.

The server **signs**; your app **verifies**. This guide covers the app side — the
part that lives in your product's own repository. For the vendor side (registering
a product, generating its keypair, issuing keys), see the README's
[Licensing a new product](../README.md#licensing-a-new-product).

> **Before you start:** register the product and run `keygen` for it first. The
> dashboard's **Products** tab tracks all four setup steps per product and shows
> you the exact values this guide asks for — open it and expand your product row.

---

## The security model in one paragraph

Licenses are signed with **Ed25519**. The server holds the private key and is the
only thing that can create a signature. Your app ships only the **public key**,
which can verify a signature but never produce one — so even a fully decompiled
app cannot forge a license. Every license also embeds a **machine fingerprint**,
so copying a license file to another computer produces a mismatch.

Each product gets its **own keypair**. A license signed for one product fails
verification against another product's key, so a leak is confined to one product.

---

## Step 1 — Copy four files

From this repo's [`src/licensing/`](../src/licensing/) into your app:

| File | Purpose | Edit it? |
|------|---------|----------|
| `core.ts` | Crypto contract: payload shape, sign/verify, token layout | **No** — copy as-is |
| `verify.ts` | Status evaluation, storage, expiry, machine binding | **Yes** — see Step 2 |
| `machine.ts` | Hardware fingerprint | Only for non-Windows (see Caveats) |
| `public-key.ts` | The embedded public key | **Yes** — replace with yours |

`core.ts` imports nothing but Node's built-in `crypto` — no database, no server
dependencies — so it drops into any Node project.

### Do not modify `core.ts`

Three things must stay **byte-identical** between this server and your app, or
already-issued licenses stop verifying:

1. The `LicensePayload` shape — field names, types, JSON serialization
2. The signature scheme — Ed25519, `crypto.sign(null, data, key)` over the UTF-8 JSON
3. The token layout — `<prefix>.<base64url payload>.<base64url signature>`

If you need different behavior, change `verify.ts`, never `core.ts`.

---

## Step 2 — Override three values

**This is where integrations fail.** The defaults in `verify.ts` and `core.ts` are
hard-coded to `verdix-pos`, the original single-product setup. If you copy them
unchanged, your app rejects its own licenses.

All three values are shown, copyable, in the dashboard: **Products** → expand your
product → step 3.

### 2a. The public key

Replace the contents of `public-key.ts` with your product's public key
(`keys/<product-id>/public-key.pem`, or copy it from the dashboard):

```ts
export const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA...your key...
-----END PUBLIC KEY-----`;
```

> `keygen` only auto-embeds the public key for `verdix-pos`. For every other
> product you copy it yourself — that is deliberate, so keygen can never
> overwrite another product's key constant.

### 2b. The product id

[`verify.ts`](../src/licensing/verify.ts) compares the payload against the
`PRODUCT_ID` constant imported from `core.ts`, which is `'verdix-pos'`. Change the
comparison to your product's id:

```ts
const PRODUCT_ID = 'my-app';           // your product's registered id

if (p.product !== PRODUCT_ID) {
  return { status: 'invalid', licensed: false, machineId, reason: 'wrong-product' };
}
```

### 2c. The license prefix

`verifyLicenseSignature` takes the expected prefix as its **third parameter**, and
it defaults to `'VRDX1'`. Pass your product's `license_prefix` at **both** call
sites in `verify.ts` (`evaluateLicenseKey` and `readLicensePayload`):

```ts
const LICENSE_PREFIX = 'MYAP1';        // your product's license_prefix

const res = verifyLicenseSignature(key, PUBLIC_KEY_PEM, LICENSE_PREFIX);
```

### What happens if you forget

Both failures are silent — the app just says the license is bad, with no hint that
setup is incomplete:

| Missed | Symptom | Why |
|--------|---------|-----|
| License prefix (2c) | `malformed-key` | The token starts `MYAP1.` but the verifier expects `VRDX1.` and rejects it before checking the signature |
| Product id (2b) | `wrong-product` | Signature verifies, but the payload's `product` field doesn't match the constant |
| Public key (2a) | `bad-signature` | Verifying with the wrong product's key |

---

## Step 3 — Change the license file path

`getLicenseFilePath()` in `verify.ts` hard-codes a `Verdix` folder:

```ts
return path.join(base, 'Verdix', 'license.dat');
```

Change `'Verdix'` to your app's own folder. If you skip this, two products
installed on the same machine fight over one file, and whichever activates last
wins.

`LICENSE_FILE` still overrides the path at runtime, which is useful for testing.

---

## Step 4 — Remove the developer bypass

`evaluateLicenseKey` returns a fully licensed result when `LICENSE_DEV_BYPASS=1`:

```ts
if (process.env.LICENSE_DEV_BYPASS === '1') {
  return { status: 'active', licensed: true, ... };
}
```

Anyone who sets that environment variable runs your app unlicensed. Either delete
the block for shipped builds, or rename it to something unguessable and strip it
at build time. Do not ship it as-is.

---

## Step 5 — Wire up activation

Two options. You can support both.

### Online activation (recommended)

The customer types their product key; your app posts it with the machine id and
receives a signed license.

```
POST https://<your-license-server>/api/activate
Content-Type: application/json

{ "productKey": "MYAP-XXXX-XXXX-XXXX",
  "machineId":  "<from getMachineId()>",
  "machineLabel": "Front counter PC",   // optional, shown in the dashboard
  "appVersion": "1.4.2" }               // optional
```

Success:
```json
{ "success": true,
  "signedLicense": "MYAP1.<payload>.<signature>",
  "info": { "customer": "...", "edition": "...", "expires": "..." } }
```

Save `signedLicense` with `saveLicenseKey()`. The endpoint is public (no admin
auth), and it enforces seat limits, expiry, and revocation server-side.

Failures return `success: false` with a customer-readable `error`, using HTTP
**404** (unknown key), **403** (revoked / expired / seat limit reached), or **500**.
Show the `error` text directly — it is written for end users.

A machine that is already activated can re-fetch freely; it does not consume a
second seat.

### Offline activation

For sites with no internet. The customer reads their **Machine ID** off your
activation screen and sends it to you; you generate a key in the dashboard
(**Licenses** → **Generate Key**) or by CLI, and they paste it back:

```bash
npm run new -- --product-key MYAP-XXXX-XXXX-XXXX --machine "ABCD-..."
```

Your app just calls `saveLicenseKey(pastedKey)` and re-evaluates.

---

## Step 6 — Heartbeat (optional, online only)

Without a heartbeat, a revoked license keeps working on machines that already
activated. Poll periodically to enforce revocation and propagate renewals:

```
POST /api/validate
{ "licenseId": "<payload.lid>", "machineId": "<getMachineId()>", "appVersion": "1.4.2" }
```

Get `licenseId` from `readLicensePayload()` — the `lid` field.

| `status` | Meaning | Suggested handling |
|----------|---------|--------------------|
| `active` | Valid | Response includes a freshly signed `signedLicense` — save it, so renewals apply automatically |
| `expired` | Past expiry | Prompt to renew |
| `revoked` | Vendor revoked it | Lock the app |
| `suspended` | Temporarily disabled | Lock, with a "contact vendor" message |
| `released` | Seat released or never activated here | Re-activate |
| `invalid` | Unknown license id | Treat as unlicensed |

Fail **open** on network errors — a customer's internet outage must not lock them
out of software they paid for. The signed license already carries its own expiry,
so an offline app remains correctly bounded.

---

## Step 7 — Respond to webhooks (optional, online only)

When a license event occurs, the server can POST a signed JSON payload to a
per-product webhook URL, so your backend can react to activations, revocations,
or other events. This is optional — webhooks are only sent if you configure a
URL in the dashboard.

### Events

The server fires webhooks for these six events:

| Event                     | Trigger                                                          | Data payload |
|---------------------------|-------------------------------------------------------------------|--------------|
| `license.activated`       | `POST /api/activate` succeeds (new signed issuance) | `{ licenseId, machineId, customer, edition }` |
| `license.status_changed`  | `POST /api/validate` observes a change to the *stored* license status (`active` ⇄ `suspended`/`revoked`) | `{ licenseId, machineId, oldStatus, newStatus }` |
| `license.issued`          | Dashboard "Issue License" (`POST /api/licenses`) | `{ licenseId, customerId, productKey, edition }` |
| `license.revoked`         | Dashboard sets status to `revoked` (`POST /api/licenses/:id/status`) | `{ licenseId, oldStatus, newStatus }` |
| `license.reactivated`     | Dashboard sets status to `active` from a non-active state | `{ licenseId, oldStatus, newStatus }` |
| `customer.created`        | `POST /api/customers` | `{ customerId, businessName }` |

Heartbeat polls that report *no* status change do not fire a webhook — this
avoids spam on every heartbeat interval while still catching actual changes.

### Webhook payload format

Every webhook POST receives a JSON body with this shape:

```json
{
  "event": "license.activated",
  "productId": "my-app",
  "timestamp": "2026-08-24T10:30:45.123Z",
  "data": { "licenseId": "...", "machineId": "...", ... }
}
```

The `data` object is event-specific (see the table above). The `timestamp` is
ISO 8601 UTC.

### Verifying the signature

Every webhook includes two headers to verify its authenticity:

- `X-Webhook-Event`: the event name (redundant with the body, useful for filtering)
- `X-Webhook-Signature`: `sha256=<hmac-sha256-hex>`, the HMAC of the **raw
  request body** (the exact bytes sent, not re-encoded JSON) using the product's
  secret.

In Node.js, verify it like this:

```ts
import crypto from 'crypto';

function verifyWebhookSignature(
  rawBody: string,   // the exact bytes received, before parsing JSON
  signature: string, // value of X-Webhook-Signature header
  secret: string     // the product's webhook secret
): boolean {
  const computed = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}
```

Call this in your handler **before** trusting the payload:

```ts
if (!verifyWebhookSignature(rawBody, req.headers['x-webhook-signature'] as string, process.env.WEBHOOK_SECRET!)) {
  return res.status(401).send('Signature mismatch');
}

const payload = JSON.parse(rawBody);
// ... react to the event ...
```

### Configuration

To enable webhooks for your product:

1. In the dashboard, go to **Products** and expand your product row.
2. Under step 3, find the **Webhook URL** field and enter your HTTPS endpoint.
3. Click **Save**. The server generates a random 32-byte hex secret and displays
   it once in a copyable box (like a newly-issued API key).
4. Copy that secret into your environment variables.

To rotate the secret later (e.g. if you suspect compromise), click **Regenerate
Secret**. The old secret stops working immediately; any earlier signatures
become invalid.

### Delivery and retries

- **Fire-and-forget**: webhook delivery never blocks or fails the license operation
  that triggered it (activation, heartbeat, etc.). Delivery happens in the
  background.
- **Retries**: the server attempts delivery up to 3 times total, with a fixed
  backoff of 1 second before attempt 2 and 5 seconds before attempt 3.
- **Timeout**: each attempt has a 5-second request timeout.
- **Failure**: on final failure after all retries, the server logs the error
  server-side (via `activation_logs` / `webhook.fail` action) with the event
  name, URL host, and error message, then stops.

> **Important: assume idempotency.** A webhook may be delivered more than once
> if an earlier attempt succeeded but its response was lost before the server
> saw it. Your receiver should either be idempotent (safe to process the same
> event twice) or track `{ event, productId, timestamp, data }` tuples you've
> already seen.

---

## Caveats — read before shipping

### The machine fingerprint is Windows-only

[`machine.ts`](../src/licensing/machine.ts) reads the Windows registry MachineGuid,
the baseboard serial, and the BIOS serial. On any other platform it falls through
to `os.platform()` and `os.arch()`, hashed.

**On Linux and macOS, nearly every machine produces the same fingerprint**, which
means effectively no machine binding. If you ship cross-platform, add a per-platform
source (e.g. `/etc/machine-id` on Linux, `IOPlatformUUID` on macOS) before relying
on it.

### This code is server-side only

`machine.ts` uses `child_process`; `verify.ts` uses `fs`. Neither runs in a browser.

For a web app, run verification on your backend and issue a **hosted** license,
which carries no hardware binding:

```bash
npm run new -- --product my-app --customer "Acme" --web --adhoc
```

That sets `machineId` to the `HOSTED` sentinel, which `isMachineMatch()` accepts on
any machine. The sentinel only ever appears inside a vendor-signed payload, so it
cannot be forged.

### Storage location must be writable and stable

The default is `PROGRAMDATA` (falling back to `APPDATA`, then the home directory).
For a portable or unpacked build, make sure the path you pick survives across
launches — the app folder may be extracted to a temp directory each run.

---

## Verification checklist

Before shipping, confirm each of these against a real issued license:

- [ ] A valid license for **your** product returns `status: 'active'`
- [ ] A license for a **different** product is rejected (`wrong-product`)
- [ ] A tampered token is rejected (`bad-signature`) — flip one character in the payload
- [ ] A license bound to a different machine returns `wrong-machine`
- [ ] An expired subscription returns `expired`
- [ ] No license installed returns `unlicensed`
- [ ] The license file path is **your** app's, not `Verdix`
- [ ] `LICENSE_DEV_BYPASS` does **not** unlock a production build
- [ ] Machine id is stable across restarts and reboots
- [ ] (If online) revoking in the dashboard locks the app within one heartbeat

Then mark step 3 in the dashboard: **Products** → expand → **Mark as embedded**.
That mark is bound to a fingerprint of the key you embedded, so if you ever rotate
the keypair the step turns red **Stale** — telling you the app is running against a
key that no longer matches.

---

## Don't forget the vendor side

Embedding the public key is step 3 of four. Step 4 is deploying the **private** key:
set the env var named in your product's `env_key_name` column (shown in the
dashboard) to the contents of `keys/<product-id>/private-key.pem`. Without it,
signing fails for that product with a 500 on first activation.

Two things the dashboard deliberately does **not** claim:

- **Step 3 is your assertion, not a verification.** The server cannot see your
  app's repo. The fingerprint binding only guarantees the mark cannot outlive the
  key it was made for.
- **Step 4 describes the server you are viewing.** A locally-opened dashboard
  reports `local file only` even when Railway is configured correctly, which is
  why the badge names the source instead of claiming the key is deployed.
