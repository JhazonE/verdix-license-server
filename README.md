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
npm run keygen

# 2. Configure the database (see Environment below), then create tables.
npm run migrate

# 3. Create your admin login.
npm run seed-admin -- --username admin --password "ChangeMe123"

# 4. Start the dashboard.
npm run server      # → http://localhost:4100
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

## Creating a cloud customer (dashboard)

**Dashboard → Customers → Create Cloud Customer** onboards a hosted-web
customer in one action: it issues a **licence**, **provisions their cloud
database** on Railway (schema cloned from the reference DB, scoped user
created), and **mints a hosted signed token** — then hands you a ready-to-paste
Railway environment block (`DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`,
`LICENSE_KEY`, ...) for that customer's deployment.

- **Admin only.** The `POST /api/cloud-customers` endpoint enforces
  `session.role === 'admin'` — provisioning uses admin MySQL credentials that
  can create databases and users, so it's restricted the same way
  `/api/users` is.
- **Requires `PUBLIC_SERVER_URL`.** Set it to this licence server's own public
  URL (e.g. `https://license.example.com`) so the generated env block's
  `LICENSE_SERVER_URL` is correct. Without it, the dashboard shows a
  placeholder instead of guessing — it used to fall back to
  `http://localhost:<port>`, which is always wrong once pasted into a
  customer's own Railway service.
- **Terminals field.** Set `max_activations` to the number of tills the store
  actually runs, not the number of machines. Cloud seats are counted from the
  POS's `pos_terminals` table, so leaving this at 1 blocks the store from ever
  adding a second till.
- **The three steps are not atomic.** Licence creation, database provisioning,
  and token minting run as separate steps. If provisioning or minting fails,
  the licence is **kept** (never rolled back), and the modal shows exactly
  which steps succeeded. `provision-cloud` is idempotent, so it's safe to
  re-run the CLI fallback to finish a partially-failed onboarding:

  ```bash
  npm run provision-cloud -- --license VRDX-XXXX-XXXX-XXXX
  npm run new -- --product-key VRDX-XXXX-XXXX-XXXX --web --edition web
  ```

- **The CLI still works** and remains the documented fallback for both
  provisioning and token minting — see below.
- **Testing** — use `./staging.sh` (`server | migrate | seed-admin | psql |
  reset`), never the production database. The repo's `.env` points
  `LICENSE_DB_HOST` at `metro.proxy.rlwy.net`, the **live** licence database
  holding real customer licences; `./staging.sh` overrides those variables to
  a local staging database and refuses to run if the target doesn't look like
  staging.

## Command-line issuing

```bash
# For an existing product key (records the activation)
npm run new -- --product-key VRDX-XXXX-XXXX-XXXX --machine "ABCD-..."

# Ad-hoc, no DB record (perpetual / subscription)
npm run new -- --customer "Juan's Store" --machine "ABCD-..." --adhoc
npm run new -- --customer "Acme" --machine "ABCD-..." --adhoc --days 365
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

# Public URL of this server — required for the Create Cloud Customer dashboard
# flow to generate a correct LICENSE_SERVER_URL in the env block.
PUBLIC_SERVER_URL=https://license.example.com
```

If `LICENSE_DB_*` is unset it uses `CLOUD_DB_*` (Railway), then `DB_*` (local).

## Deploy to Railway

1. Deploy this server (start command: `npx tsx license-server/server.ts`, or
   precompile). Point it at a Railway MySQL service.
2. Set env vars: `LICENSE_DB_*` (or `CLOUD_DB_*`), `LICENSE_ADMIN_SECRET`, and
   `LICENSE_PRIVATE_KEY` (paste the contents of `keys/private-key.pem`).
3. `npm run migrate` + `npm run seed-admin` once against it.

## Licensing a new product

> **Tip:** the dashboard tracks these four steps per product. Open **Products**
> and click a row to see which are done, copy the values each remaining step
> needs, and mark step 3 once you've embedded the key. Step 3 is bound to the
> key's fingerprint, so rotating the keypair flips it back to a red **Stale**
> state instead of leaving a stale checkmark.

1. **Register the product** — dashboard → Products → Add, or SQL:

   ```sql
   INSERT INTO products (id, name, key_prefix, license_prefix, env_key_name, status)
   VALUES ('my-app', 'My App', 'MYAP', 'MYAP1', 'LICENSE_PRIVATE_KEY_MYAPP', 'active');
   ```

   - `key_prefix` — product keys look like `MYAP-XXXX-XXXX-XXXX`
   - `license_prefix` — tokens look like `MYAP1.<payload>.<signature>`
   - `env_key_name` — the env var holding this product's PRIVATE key in production.
     This is not a fixed convention — it's whatever you put in this column. `keygen`
     (step 2) reads it back off the product row and prints the exact name to set.

2. **Generate its keypair** — every product needs its own; never reuse another
   product's key (a leak of one would compromise both):

   ```bash
   npm run keygen -- --product my-app
   ```

   Writes `keys/my-app/private-key.pem` and `keys/my-app/public-key.pem`, and
   stores the public key on the product row. At the end it prints the env var
   name to use in step 4 — read it from the output rather than assuming.

3. **Embed the public key in your app.** `keygen` only auto-embeds the public
   key for `verdix-pos` (into `lib/licensing/public-key.ts` in that repo). For
   any other product, copy `keys/my-app/public-key.pem` (or the copy on the
   dashboard) into your own app yourself. Your app verifies with that key, its
   own product id, and its own `license_prefix`.

   → **[App Integration Guide](docs/app-integration.md)** walks through this side
   in full: which files to copy, the three values you must override (missing one
   fails silently), activation, heartbeat, and a pre-ship checklist.

4. **Deploy the private key** — set the env var named in your product's
   `env_key_name` column (e.g. `LICENSE_PRIVATE_KEY_MYAPP`) in Railway to the
   contents of `keys/my-app/private-key.pem`. Never commit it.

Each product is cryptographically isolated: a license signed for one product
fails verification against any other product's key.

Two things the dashboard deliberately does **not** claim:

- **Step 3 is your assertion, not a verification.** The server can't see your
  app's repo. The fingerprint binding only guarantees the mark can't outlive the
  key it was made for.
- **Step 4 describes the server you're viewing.** A local dashboard reports
  `local file only` even when Railway is configured correctly, which is why the
  badge names the source instead of claiming the key is deployed.

## Security

- **Asymmetric (Ed25519)** — the POS verifies but never signs; no shared secret
  ships in the app.
- **Machine binding** — every key embeds a hardware fingerprint.
- **Private key** lives only here (file gitignored, or env secret on Railway).
  Back it up. Losing it means you can't issue keys for the current POS build.
- Put the deployed dashboard behind HTTPS and a strong admin password.
