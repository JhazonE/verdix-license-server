# Cloud Customer Provisioning UI — Design

Status: approved for planning
Date: 2026-09-01

## Problem

Onboarding a cloud (Railway-hosted) POS customer currently takes three steps in two
different places. The dashboard already creates the license — customer, product,
edition, seats, expiry, features — and returns a product key (`public/app.js`,
`saveLicense()` → `POST /api/licenses`). But the two steps that make it a *cloud*
customer are CLI-only, and must be run from a developer machine:

```bash
npm run provision-cloud -- --license VRDX-XXXX-XXXX-XXXX
npm run new -- --product-key VRDX-XXXX-XXXX-XXXX --web --edition web
```

The operator then hand-assembles a set of Railway environment variables from the
output of those two commands. That hand-assembly is the most error-prone part of the
whole flow: a mistyped `DB_NAME` or a truncated `LICENSE_KEY` produces a deployment
that fails in ways that look like a licensing bug.

The result is that only someone with the repo checked out, the admin MySQL
credentials, and the MySQL client binaries on their PATH can onboard a cloud customer.

## Goal

Onboard a cloud customer entirely from the dashboard: create the license, provision
the customer's database, mint the hosted token, and present a ready-to-paste Railway
environment block — in one guided flow, gated to admins.

## Non-goals

- **Creating the Railway service itself.** That needs Railway's own API and a separate
  credential. The operator still creates the service and pastes the env block.
- **Changing the existing desktop license flow.** `saveLicense()` and
  `POST /api/licenses` keep working exactly as they do for non-cloud licenses.
- **Replacing the CLIs.** `provision-cloud` and `offline-cli` remain, and remain the
  documented fallback when the UI flow fails partway.
- **A rollback/teardown button.** Deleting a customer's database from a web button is
  a materially different risk from creating one; out of scope for this iteration.

## Blocker this design must solve

`src/provision-cloud.ts` shells out to `mysqldump` and `mysql` (lines 70 and 76) to
clone the reference schema. The deployed image is bare `node:20-alpine` — **neither
binary exists in the container.** A "Provision Database" button would therefore work
on a developer machine and fail on Railway.

**Decision: add `mariadb-client` to the Dockerfile** (`RUN apk add --no-cache
mariadb-client`), keeping the existing dump/load code unchanged.

The alternative — reimplementing the schema clone in pure JS over `INFORMATION_SCHEMA`
— was considered and rejected. `mysqldump` already handles foreign keys, composite
indexes, generated columns and views correctly against the real POS schema; a
hand-rolled generator would have to rediscover all of that, and a subtly wrong schema
would corrupt a customer's database rather than fail loudly. The image grows by a few
MB; that is the cheaper risk.

## Access control

The flow is restricted to `role === 'admin'`.

The user table already has `role VARCHAR(32)` with `admin` / `manager` / `staff`
(`src/schema.ts:110`), and `src/server.ts:522` already gates `/api/users` on
`session.role !== 'admin'`. This design follows that established pattern rather than
inventing a new mechanism.

This matters because provisioning uses `CLOUD_PROVISION_*` — admin MySQL credentials
that can create databases and users. Putting that behind a button available to every
dashboard login would hand database-creation rights to anyone holding a `staff`
password. `manager` and `staff` continue to see the Licenses tab and create ordinary
licenses; only `admin` sees the cloud flow.

## The flow

A **Create Cloud Customer** action on the Licenses tab opens a modal carrying the
existing license fields (customer, product, edition, type/expiry, seats, features,
notes) plus a **Provision cloud database** checkbox, checked by default.

On submit the server performs three steps in order and reports each one:

| Step | Action | Reuses |
|---|---|---|
| 1 | Create the license | `createLicense()` (`src/service.ts:141`) |
| 2 | Provision the database + scoped user, clone schema, store encrypted config, add `cloud-sync` feature | `provision-cloud` logic |
| 3 | Mint the hosted token (machine id = `HOSTED` sentinel) | `issueSignedLicense()` |

The UI shows per-step status as each completes:

```
✓ License created        VRDX-A1B2-C3D4-E5F6
✓ Database provisioned   verdix_c_9f2a1b3c4d
✓ Hosted token minted    VRDX1.eyJ2Ijox…
```

It then renders a copyable environment block:

```
DB_HOST=<provisioned host>
DB_PORT=<provisioned port>
DB_USER=u_9f2a1b3c4d
DB_PASSWORD=<generated>
DB_NAME=verdix_c_9f2a1b3c4d
DB_SSL=true
LICENSE_KEY=VRDX1.eyJ2Ijox…
LICENSE_SERVER_URL=<this server's public URL>
```

This block is the deliverable that removes the hand-assembly error.

## Components

### 1. `provisionCloudDatabase(productKey)` — extracted from the CLI

`src/provision-cloud.ts` is currently a script: argument parsing and the provisioning
logic are fused inside `main()`. Extract the logic into an exported async function
that takes the product key and options (`{ rotatePassword?: boolean }`) and returns
the resulting connection config, throwing on failure.

`main()` becomes a thin CLI wrapper over it, so `npm run provision-cloud` keeps
behaving exactly as it does today. The new endpoint calls the same function — one
implementation, two callers.

**Keep the parameter as the product key, not the license id.** The current code takes
a product key, resolves it via `getLicenseByProductKey()` (line 43), and derives the
tenant names from `license.id` (line 46). The orchestrating endpoint already holds the
license id from step 1, so passing the product key costs one redundant lookup — accept
that cost. Changing the signature to take an id would either break the CLI's own
argument (`--license VRDX-…` is a product key) or require the function to accept both,
and neither is worth saving one indexed query on an operation that already runs
`mysqldump`.

### 2. `POST /api/cloud-customers` — the orchestrating endpoint

Placed in the session-guarded section of `src/server.ts`, with an explicit
`session.role !== 'admin'` check mirroring `/api/users`.

Request body: the same fields `POST /api/licenses` accepts, plus
`provision_database: boolean`.

Response reports each step independently:

```jsonc
{
  "success": true,
  "data": {
    "license":  { "id": "...", "product_key": "VRDX-..." },
    "database": { "ok": true, "name": "verdix_c_...", "user": "u_...", "password": "..." },
    "token":    { "ok": true, "signedLicense": "VRDX1..." },
    "env":      { "DB_HOST": "...", "...": "..." }
  }
}
```

### 3. Dashboard UI — `public/dashboard.html` + `public/app.js`

Vanilla HTML/JS, matching the existing modal pattern (`license-modal`,
`license-issued-modal`) and the existing `api()` helper. No framework, no build step.

The Create Cloud Customer control is rendered only when the session role is `admin` —
the dashboard already receives `role` from `GET /api/me` (`src/server.ts:308`).

## Error handling

**The three steps are not atomic, and this design does not pretend otherwise.**

If step 2 or 3 fails, the license created in step 1 is **kept, not rolled back**, and
the response reports exactly which steps succeeded. The UI shows the partial result
with the CLI command needed to finish the job by hand.

This is deliberate. `provision-cloud` is already idempotent — re-running it reuses an
existing database and user — so a retry is safe, whereas deleting a just-created
license to "clean up" would destroy a product key the operator may already have
copied. A visible partial success that names its own remedy is better than a silent
rollback.

Failure of step 2 must not prevent step 3 from being reported: a license with a token
but no database is recoverable; the operator needs to see both states.

## Security

- Admin-gated at the endpoint, not merely hidden in the UI. Hiding a button is not
  access control; the role check lives server-side.
- `CLOUD_PROVISION_*` credentials never leave the server. Only the generated
  per-customer database password is returned, and only in the creation response —
  it is not stored in a retrievable-in-plaintext form or shown again afterwards.
- Token minting reuses `issueSignedLicense()`. No new signing path, no change to the
  Ed25519 contract, no change to `src/licensing/core.ts` — that file is frozen against
  the POS's copy, and diverging it invalidates every issued license.
- The hosted token remains a machine-unbound bearer credential (unchanged property);
  the response is shown once and treated as a secret.

## Deployment considerations

Two things make this change unusually consequential to ship:

1. **The Dockerfile change forces a rebuild and redeploy of the live license server**,
   which every licensed installation — desktop included — depends on for heartbeats.
   This cannot be shipped silently.
2. The repo has an **unpushed commit `e1713ab`** (optional `terminalCount` on
   `/api/validate`, returning `seat-exceeded` and `seatLimit`, for the POS-side cloud
   licensing work). Whatever is built here stacks on top of that commit, so the two
   deploy together. Both are additive and backward compatible, but the combined change
   should be verified against a desktop install before it goes out.

## Testing

Following the repo's existing `tests/check-*.ts` standalone-script convention:

- `check-cloud-provision-fn.ts` — the extracted `provisionCloudDatabase` provisions
  into a scratch database, is idempotent on re-run, and returns the expected config.
- `check-cloud-customer-endpoint.ts` — the endpoint rejects non-admin sessions, and
  reports per-step status correctly including a forced step-2 failure.
- Manual: `npm run provision-cloud` still works unchanged after the extraction, and
  `mysqldump`/`mysql` resolve inside the built container image.
