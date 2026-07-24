# Vendix License Management System (LMS)

A standalone server + admin dashboard that stores customers, issues **Product
Keys**, and signs **machine-locked license keys** for Vendix POS. It holds the
**private key**; the POS ships only the **public key**, so licenses cannot be
forged even if the POS is decompiled.

```
 VENDOR (you)            LICENSE SERVER (this)            CUSTOMER POS
 ─────────────           ─────────────────────           ─────────────
 Dashboard  ──manage──▶  MySQL DB + PRIVATE key  ◀─paste─ Machine ID
            ◀────────── signs license key ───────────────▶ verifies w/ PUBLIC key
```

> **This build = Phases 1 & 3** (database + management dashboard + offline key
> generation). Online POS activation + heartbeat (Phase 2 & 4) plug into this
> same server next.

## Layout

| File | Purpose |
|------|---------|
| `keygen.ts` | One-time: generate Ed25519 key pair, embed public key into the POS |
| `db.ts` / `schema.ts` | MySQL connection + tables (idempotent migrate) |
| `service.ts` | Customers, licenses, product keys, signing, revocation |
| `auth.ts` / `seed-admin.ts` | Admin login (bcrypt + signed session cookie) |
| `server.ts` | HTTP server: dashboard + JSON APIs |
| `offline-cli.ts` | Issue a key from the command line |
| `public/` | Dashboard UI (login, dashboard, app.js) |
| `keys/` | Ed25519 key pair (**gitignored** — secret) |

## Setup (run from the repo root)

```bash
# 1. Generate the signing keys (once). Embeds the public key into the POS.
npm run license:keygen

# 2. Configure the database (see Environment below), then create tables.
npm run license:migrate

# 3. Create your admin login.
npm run license:seed-admin -- --username admin --password "ChangeMe123"

# 4. Start the dashboard.
npm run license:server      # → http://localhost:4100
```

## Issuing a license (dashboard)

1. **Customers → New Customer** — store the business + contact info.
2. **Licenses → Issue License** — pick the customer, edition, perpetual or
   subscription, seats (max activations). You get a **Product Key**
   (`VRDX-XXXX-XXXX-XXXX`).
3. To make an **offline** machine-bound key now: on that license row click
   **Generate Key**, paste the customer's **Machine ID** (from their POS
   activation screen) → copy the signed key → send it to them to paste.
4. **Revoke / Reactivate** from the license row. **Activations** tab lists every
   machine and lets you **Release** a seat (e.g. to move to a new PC).

## Command-line issuing

```bash
# For an existing product key (records the activation)
npm run license:new -- --product-key VRDX-XXXX-XXXX-XXXX --machine "ABCD-..."

# Ad-hoc, no DB record (perpetual / subscription)
npm run license:new -- --customer "Juan's Store" --machine "ABCD-..." --adhoc
npm run license:new -- --customer "Acme" --machine "ABCD-..." --adhoc --days 365
```

## Environment

The server uses its own MySQL database (default name `verdix_license`). It falls
back to the POS's Railway/local config so it works out of the box:

```env
# Preferred — dedicated license DB (e.g. on Railway)
LICENSE_DB_HOST=...
LICENSE_DB_PORT=3306
LICENSE_DB_USER=...
LICENSE_DB_PASSWORD=...
LICENSE_DB_NAME=verdix_license
LICENSE_DB_SSL=true            # set true for Railway/managed MySQL

# Admin session signing secret (set a long random value in production)
LICENSE_ADMIN_SECRET=...

# Private key in production (instead of the keys/ file)
LICENSE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"

# Port (default 4100)
LICENSE_UI_PORT=4100
```

If `LICENSE_DB_*` is unset it uses `CLOUD_DB_*` (Railway), then `DB_*` (local).

## Deploy to Railway

1. Deploy this server (start command: `npx tsx license-server/server.ts`, or
   precompile). Point it at a Railway MySQL service.
2. Set env vars: `LICENSE_DB_*` (or `CLOUD_DB_*`), `LICENSE_ADMIN_SECRET`, and
   `LICENSE_PRIVATE_KEY` (paste the contents of `keys/private-key.pem`).
3. `npm run license:migrate` + `npm run license:seed-admin` once against it.

## Security

- **Asymmetric (Ed25519)** — the POS verifies but never signs; no shared secret
  ships in the app.
- **Machine binding** — every key embeds a hardware fingerprint.
- **Private key** lives only here (file gitignored, or env secret on Railway).
  Back it up. Losing it means you can't issue keys for the current POS build.
- Put the deployed dashboard behind HTTPS and a strong admin password.
