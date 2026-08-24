# Outbound Webhooks — Design

Status: approved for planning
Date: 2026-08-24

## Problem

The license server has no way to notify an external system (a vendor's own
backend, Slack, a CRM, etc.) when license-relevant events happen. Operators
who want to react to activations, revocations, or new customers today must
poll the dashboard by hand.

## Goal

When a license event occurs, POST a signed JSON payload to a per-product
webhook URL, so an external system can react to it. Delivery must never
block or fail the underlying license operation.

## Non-goals

- A delivery-tracking table / admin UI for replaying failed deliveries.
  Failures are logged to `activation_logs` and that's the audit trail for v1.
- Webhook URLs per-event or per-customer — one URL (and one secret) per
  product is enough for this iteration.
- Inbound webhooks / receiving data from other systems — out of scope, this
  is outbound only.

## Events

| Event                     | Trigger                                                          |
|---------------------------|-------------------------------------------------------------------|
| `license.activated`       | `POST /api/activate` succeeds (new signed issuance)                |
| `license.status_changed`  | `POST /api/validate` returns a status different from what the stored license had before this heartbeat (e.g. flips to `revoked`/`suspended`/expired) |
| `license.issued`          | `POST /api/licenses` (dashboard "Issue License")                   |
| `license.revoked`         | `POST /api/licenses/:id/status` with `status=revoked`               |
| `license.reactivated`     | `POST /api/licenses/:id/status` with `status=active` (from a non-active status) |
| `customer.created`        | `POST /api/customers`                                              |

Heartbeats that report *no* status change do not fire a webhook — this
avoids spamming on every poll interval while still catching the case an
operator actually cares about (something changed).

## Schema

Extend `src/schema.ts`'s existing `COLUMNS` idempotent-migration array (same
pattern as `embed_marked`):

- `products.webhook_url` — `VARCHAR(500) NULL`
- `products.webhook_secret` — `VARCHAR(64) NULL`

`webhook_secret` is generated server-side (random 32-byte hex) the first
time a `webhook_url` is saved for a product, and is never exposed for
editing directly — only regenerable (clears + regenerates together with the
URL, or via a dedicated "regenerate secret" action).

## Delivery (`src/webhooks.ts`, new module)

```ts
sendWebhook(product: Product, event: string, data: object): void
```

- **Fire-and-forget**: callers never `await` this (or await a promise that
  itself never rejects) — a webhook failure must never surface as a failure
  of `/api/activate`, `/api/validate`, license issuance, or customer
  creation.
- No-op if `product.webhook_url` is falsy.
- Body: `{ event, productId, timestamp, data }`.
- Signing: `X-Webhook-Signature: sha256=<hmac-sha256(secret, rawBody)>` and
  `X-Webhook-Event: <event>` headers, following the Stripe/GitHub pattern so
  the receiver can verify authenticity.
- Retry: up to 3 attempts total, backoff 1s / 5s (fixed, not exponential —
  simple and enough for transient blips), 5s request timeout per attempt.
- On final failure after retries: log to `activation_logs` via the existing
  `svc.log(...)` helper with action `webhook.fail`, detail including the
  event name, URL host (not full URL, avoid leaking query secrets in logs),
  and last error message. No throw, ever — errors are swallowed after
  logging.
- Uses Node's built-in `https`/`http` (matching the rest of the codebase,
  which has no HTTP client dependency) with a short timeout, not `fetch`
  keep-alive pitfalls to worry about at this volume.

## Call sites

Each call site builds a small `data` object with IDs/status only — **never**
private key material or full signed license tokens (those already leave via
the API response to the POS; the webhook is a notification, not a key
distribution channel).

- `server.ts` `/api/activate`: after `svc.issueSignedLicense`, call
  `sendWebhook(product, 'license.activated', { licenseId, machineId, customer, edition })`.
- `server.ts` `/api/validate`: after `svc.validateHeartbeat`, if
  `result.status` differs from the license's status before the call, fire
  `license.status_changed` with `{ licenseId, machineId, oldStatus, newStatus }`.
- `service.ts` `createLicense`: fire `license.issued` with
  `{ licenseId, customerId, productKey, edition }`.
- `service.ts` `setLicenseStatus`: fire `license.revoked` /
  `license.reactivated` depending on the new status (only when it actually
  changes from what was stored).
- `service.ts` `createCustomer`: fire `customer.created` with
  `{ customerId, businessName }`.

Since `product` isn't already in scope at every call site (`createCustomer`
has no product), that event uses a server-wide fallback: look up the
`verdix-pos` product's webhook config, OR — simpler and consistent — treat
`customer.created` as product-agnostic and skip sending it if there's no
single obvious product. **Resolution:** fire `customer.created` once per
product that has a `webhook_url` configured (loop over `listProducts()`
filtered to those with a URL). This keeps the "one URL per product" model
consistent without inventing a separate global webhook concept.

## Dashboard UI

Add a `webhook_url` text input to the product edit form in
`public/dashboard.html` / `app.js`, next to the existing `env_key_name`
field. Saving a non-empty URL for the first time generates the secret
server-side; the secret is shown once in a copyable field (like a
newly-issued API key pattern) with a "regenerate" button that rotates it
(existing signatures from the old secret stop verifying — acceptable, same
tradeoff as key rotation elsewhere in this app).

## Testing

Follow the `tests/check-*.ts` convention already in this repo:

- `tests/check-webhooks.ts` — spins up a local `http.createServer` mock
  receiver, verifies: signature computation is correct and verifiable with
  the same secret, retry happens on failure (mock returns 500 twice then
  200), gives up after 3 attempts and logs failure, no-ops silently when
  `webhook_url` is unset, and never throws/rejects in a way that could
  propagate to a caller.

## Open questions resolved during brainstorming

- Retry strategy: fire-and-forget with in-process retry (no DB queue table).
- Signing: HMAC-SHA256 per product secret, Stripe/GitHub-style header.
- Config: per-product column, not a single global env var.
