# Remove cloud DB provisioning; keep subscription licensing

**Date:** 2026-10-27
**Status:** Approved for planning

## Intent and the why

The licence server currently does two jobs. It issues licences, and it
provisions a MySQL database for each cloud customer — creating the database,
a scoped user, a password, and cloning a reference schema into it.

The second job has never been used. The operator deploys each customer's POS
to Railway and sets `DB_HOST`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` by hand
on that service. The provisioned databases, users and passwords have no
consumer.

This is not merely unused code. `cloudConfigFor()` attaches the decrypted
tenant DB password to every `/api/activate` and `/api/validate` response for
any licence carrying the `cloud-sync` feature (`src/server.ts:139`, `:242`,
`:294`). The POS never reads it: the planned `saveCloudConfig()` from the
2026-07-06 multi-tenant design was never implemented, and a search of the POS
codebase finds no reference to it. The POS reads its database config from
`process.env` only (`lib/backup.ts:41`, `app/api/settings/database/route.ts:82`).

So the server transmits database credentials over the network, on every
heartbeat, to a client that discards them. Removing provisioning removes that
exposure.

What remains is the job the operator actually wants: **generate
subscription-based licences**.

## Goals

1. The licence server issues subscription licences with an expiry, seat count
   and features.
2. Issuing a licence yields both credentials the operator may need:
   - a **Product Key**, to paste into the POS activation form;
   - a **hosted LICENSE_KEY**, to paste into Railway environment variables.
3. `/api/activate` and `/api/validate` keep working for activation, renewal
   and revocation.
4. No database credentials appear in any API response.

## Non-goals

- Changing the POS. This work is confined to the licence server.
- Dropping the `cloud_configs` table. It stays in the database untouched; only
  the code stops reading and writing it.
- Changing how signing, key management or revocation work.
- Adding a replacement for provisioning. There is no demand for one.

## Anti-goals

Outcomes that would make this a failure even if the code is removed cleanly:

- **The operator loses a way to activate a customer.** Both paths — activation
  form and Railway variables — must still work afterwards.
- **A hosted token silently consumes a seat.** See "Seat accounting" below.
- **Existing live customers break.** Licences already issued must continue to
  activate and validate. A customer whose licence carries the `cloud-sync`
  feature must keep working; the feature string becomes inert rather than
  invalid.

## The two activation paths

Both must work after this change. They are genuinely different, and the
distinction drove the design.

**Path A — POS activation form.** The operator pastes the Product Key into the
POS activation screen. The POS calls the licence server's `/api/activate` with
*its own* `getMachineId()`, and the server mints a token bound to that machine.
The POS then verifies the token matches the machine before saving it
(`app/api/license/activate-online/route.ts:59`). A hosted token is useless on
this path — it is bound to `HOSTED`, would not match, and would be rejected.

**Path B — Railway environment variable.** The operator pastes the hosted
LICENSE_KEY straight into the service's `LICENSE_KEY` variable. No activation
form is involved. The token is bound to `HOSTED_MACHINE_ID`
(`src/licensing/core.ts:43`), the existing sentinel for licences with no
hardware binding — the same thing `offline-cli.ts --web` produces
(`src/offline-cli.ts:50`).

The Issue License result shows both, and the operator picks per customer.

## Constraints

- The `cloud_configs` table and its rows stay in place. No migration drops it.
  (Operator's decision.)
- Licences already carrying `cloud-sync` in their `features` array are not
  rewritten. The feature stops meaning anything to the server.
- Removal must leave `npm run typecheck` clean and the remaining test files
  passing.

## Seat accounting

`issueSignedLicense(..., { record: true })` inserts an `activations` row
(`src/service.ts:362`), and seats are counted from active activation rows
(`src/service.ts:406`).

This creates a real hazard. If the operator issues a licence (minting a hosted
token, one row) and the customer then activates through the POS form (a second
row for their real machine), a one-seat licence is already full. The existing
`/api/cloud-customers/:id` endpoint guards against exactly this, which is why
it reads back the stored token rather than minting a fresh one
(`src/server.ts:545-552`).

Mint the hosted token with `record: true`, so it can be read back later if the
operator closes the dialog, but exclude `HOSTED` activations from the seat
count. A hosted token is not a machine occupying a till; counting it
misrepresents what `max_activations` means.

The alternative — `record: false`, never storing it — was rejected: the token
would be unrecoverable once the modal closed, forcing a re-mint through the
CLI, which is the problem the Cloud Details endpoint was built to solve.

### All four seat surfaces are excluded

**Operator's decision.** There are four places a hosted activation row would be
counted, and `HOSTED` is excluded from all of them. "Seats" means every number
shown to the operator, not just enforcement:

| Location | What it drives |
|---|---|
| `src/service.ts:406` `countActiveActivations` | enforcement — whether a new activation is allowed |
| `src/cache.ts:66` `countCachedActiveActivations` | the offline fallback `countActiveActivations` falls through to in its `catch` |
| `src/service.ts:254` `listLicenses` `active_count` | the dashboard "Computers" column (`public/app.js:817`, rendered `active_count/max_activations`) |
| `src/service.ts:698` `dashboardStats` | the headline activations count |

Two of these matter more than they look:

- **The cache path is a correctness bug if missed.** If only the SQL changes,
  the seat limit shifts by one the moment MySQL blips — precisely when a
  customer is activating and least able to get help.
- **The dashboard column is the visible one.** Without this exclusion a
  one-seat subscription reads "1/1" the instant it is issued, before the
  customer has activated anything. That looks exactly like the bug this design
  prevents, even though enforcement would be correct.

Apply the exclusion through `normalizeMachineId`, for consistency with
`src/server.ts:550`, rather than a bare `machine_id <> 'HOSTED'` string compare.

## terminalCount enforcement is preserved

`validateHeartbeat` (`src/service.ts:541-549`) holds a second, independent seat
mechanism: a cloud POS reports `terminalCount`, and the server returns
`status: 'seat-exceeded'` when it exceeds `max_activations`. Its comment
explains why — "every hosted terminal shares one activation, so seats are
counted from the POS-reported terminal total instead."

**This is not part of the cloud machinery being retired, and must survive
unchanged.** It is the real seat mechanism for path B: a Railway-deployed POS
running a hosted token is exactly the client that sends `terminalCount`. Once
`HOSTED` rows stop counting toward seats, this becomes the *only* seat
enforcement for hosted customers. Removing it by accident would un-enforce
seats for every one of them.

Note also that it never withholds the licence on overage — it reports the
overage and still returns a signed licence, so a paying store is never locked
out of checkout. Keep that behaviour.

## Retroactive seat change on existing licences

Every customer onboarded through `POST /api/cloud-customers` already has a
`HOSTED` activation row occupying a seat, because that endpoint mints with
`record: true` (`src/server.ts:643`). Applying the exclusion frees one seat on
each of those licences retroactively, on deploy, with no migration.

This is a silent loosening rather than a breakage, so the anti-goals do not
cover it. If `max_activations` was ever sized around the hosted row consuming
one, those licences quietly gain a seat.

**Operator's decision:** the plan includes a **read-only audit script** that
lists licences holding `HOSTED` activation rows alongside their
`max_activations` and real activation count, so the operator can see who is
affected before deploying. It changes no data. The outcome is reported to the
operator, who decides whether any `max_activations` needs adjusting; the
builder does not adjust them.

## Perpetual licences

**Builder's call:** perpetual licences get a Product Key only, no hosted token.
The hosted path exists for cloud deployments on Railway, which are
subscriptions. A perpetual licence is installed on a machine and activates
through the form.

## What gets removed

Roughly 1,200 lines.

**Deleted files:**
- `src/provision-cloud.ts` — database/user creation
- `src/seed-ref-db.ts` — reference schema curation and drift repair
- `src/seed-tables.ts` — reference table list
- `src/tenant-summary.ts` — reads a tenant's users/lookup tables
- `src/cloud-config-crypto.ts` — DB password encryption

**Deleted tests:**
`tests/check-cloud-customer-endpoint.ts`, `check-cloud-provision-fn.ts`,
`check-provision-seeding.ts`, `check-ref-column-drift.ts`,
`check-ref-db-seed.ts`, `check-seed-tables.ts`

**`src/server.ts`:** the `cloudConfigFor()` helper and both call sites; the
`POST /api/cloud-customers` and `GET /api/cloud-customers/:licenseId` handlers;
the now-unused imports.

**`src/service.ts`:** `CloudConfig`, `upsertCloudConfig`, `getCloudConfig`.

**`public/dashboard.html` / `public/app.js`:** the Create Cloud Customer button
and modal, the Cloud Details button and modal, and their handlers
(`openCloudCustomerModal`, `submitCloudCustomer`, `copyCloudEnv`,
`openCloudDetails`, `copyCloudDetailsEnv`), plus the `btn-cloud-customer`
role-visibility line at `app.js:1432` and the per-row conditional at
`app.js:821` that renders the Cloud Details button when a licence carries
`cloud-sync`. No cloud marker replaces it in the licence table.

**`package.json`:** the `provision-cloud` and `seed-ref-db` scripts.

**`src/schema.ts`:** nothing. The `cloud_configs` CREATE TABLE stays, so a
fresh install still matches an existing one. A comment marks it as retained
for historical rows and no longer written.

## The Dockerfile

**Builder's call:** in scope, and simplified.

The current `Dockerfile` exists entirely to serve provisioning. Its header
comment explains the chain: Alpine ships MariaDB's client, which cannot
authenticate against Railway's MySQL 8 (`caching_sha2_password`), so the image
uses `node:20-slim` and copies the real Oracle `mysql` and `mysqldump` binaries
from `mysql:8`, which in turn need `libssl3` and `libncurses6`.

After this change nothing shells out to those binaries. They are in fact
already vestigial: `provision-cloud.ts:119` states explicitly that it does *not*
shell out to `mysqldump | mysql`, and no file in `src/` imports
`child_process`. So the two `COPY --from=mysql:8` lines, the apt packages they
need, and the explanatory comment all go.

Whether to also move the base image to Alpine is left to the builder. It is a
real simplification but changes the runtime in a way that cannot be verified
locally, so staging it as a separate commit — after the removal is confirmed
working — is the safer order.

## Documentation

**Builder's call** on each, because the three cases differ:

- **`docs/cloud-tenancy.md` — retained, marked historical.** The
  `cloud_configs` rows and the `verdix_c_*` / `verdix_ref` databases physically
  still exist, and this is the only record of what they are and how they were
  laid out. Deleting it would destroy the information the operator needs to
  decommission them by hand. Add a header stating that provisioning was removed
  on 2026-10-27, that the document describes databases which still exist but
  are no longer created or read, and point at this design.
- **`README.md` — updated.** The "Creating a cloud customer (dashboard)"
  section (~lines 60-105) and the env-var docs (~line 146) actively instruct
  the operator to do things that will no longer work, including a
  `npm run provision-cloud` invocation. Replace with the two activation paths.
- **`.env.example` — updated.** Lines 24-30 list the six dead variables. Remove
  them.

Take care not to touch `CLOUD_DB_*` in either file. Despite the name it is
unrelated to provisioning: it is the Railway fallback for the licence server's
*own* database (`src/db.ts:29`, `:87`). It stays.

## Tests

`package.json` has no `test` script, and the files in `tests/` are standalone
`tsx` scripts with no runner or CI config.

**Builder's call:** add a `test` script that runs the suite, as part of this
work. The design's acceptance bar ("the remaining test files passing") is not
checkable without one, and six test files are being deleted — leaving the rest
unrunnable would make that bar unverifiable for whoever comes next.

Before writing the new seat-count test, check whether the existing tests need a
live MySQL connection or use fixtures (`tests/check-table-pagination.ts` appears
to use fixtures). Follow whichever convention the existing tests use. If some
tests genuinely require a database that is not available, say so in the
completion report rather than reporting a clean run — do not quietly skip them.

The new test pins `HOSTED` activations out of the seat count, and should cover
the cache fallback path as well as the SQL path, since that is where a miss
would go unnoticed.

## What gets added

A single change to the Issue License flow (`public/app.js:849`,
`public/dashboard.html:488`): when `type` is `subscription`, the server mints a
hosted token alongside the licence, and the result modal shows the Product Key
and the LICENSE_KEY with a copy button for each, labelled so the operator knows
which path each belongs to.

This is a modification of `POST /api/licenses`, not a new endpoint. The removed
`/api/cloud-customers` orchestration collapses to its first and third steps,
with the database step gone.

## Environment variables no longer read

After this change the server ignores `CLOUD_PROVISION_HOST`,
`CLOUD_PROVISION_PORT`, `CLOUD_PROVISION_USER`, `CLOUD_PROVISION_PASSWORD`,
`CLOUD_PROVISION_REF_DB` and `CLOUD_CONFIG_SECRET`. The builder should confirm
the exact set against `src/provision-cloud.ts` and `src/cloud-config-crypto.ts`
before writing them up, and list them in the commit message so the operator can
clear them from Railway. Removing them from Railway is the operator's step, not
the builder's.

`PUBLIC_SERVER_URL` is still used and must stay.

## Left to the builder

- Order of removal, and whether to stage it across commits.
- Whether the Issue License modal shows the hosted token inline or in a
  follow-on panel, provided both keys are copyable and clearly distinguished.
- Exact wording of the labels.
- Whether to move the Docker base image to Alpine, and in which commit.
- The audit script's output format.

## Deploy sequencing

A single deploy is fine. Nothing reads the provisioning env vars after this
change, so they can stay set on Railway harmlessly and be cleared whenever the
operator gets to it. List them in the commit message so there is a record of
what became safe to remove.
