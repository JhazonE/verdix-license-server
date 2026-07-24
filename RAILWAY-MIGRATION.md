# Railway Migration Checklist — License Server Repo Split

**Context:** The license server used to deploy from the POS repo (`JhazonE/Verdix`) as a second service, using `railway.json` + `Dockerfile.license-server`. Those two files have been **deleted** from the POS repo, so the old license service will fail on its next build. It must be replaced by a new service pointed at `JhazonE/verdix-license-server`.

**Do the steps in order.** Do not delete the old service until Step 6 passes.

---

## Step 0 — Capture the old service's environment FIRST

⚠️ **Do this before touching anything else.** Once the old service is gone, these values are unrecoverable.

Railway dashboard → old license service → **Variables** tab → copy every value somewhere safe.

The one that matters most:

- [ ] **`LICENSE_PRIVATE_KEY`** — the Ed25519 signing key (PEM). **If this value is lost or changed, every license ever issued stops verifying.** Copy it exactly, including the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines and newlines.

Also copy:

- [ ] `LICENSE_ADMIN_SECRET` — HMAC secret for dashboard sessions. Changing it just logs admins out; not fatal, but keep it the same to avoid surprises.
- [ ] `LICENSE_DB_HOST`, `LICENSE_DB_PORT`, `LICENSE_DB_USER`, `LICENSE_DB_PASSWORD`, `LICENSE_DB_NAME`, `LICENSE_DB_SSL`
- [ ] `CLOUD_PROVISION_HOST`, `CLOUD_PROVISION_PORT`, `CLOUD_PROVISION_USER`, `CLOUD_PROVISION_PASSWORD`, `CLOUD_PROVISION_REF_DB` (only if you use cloud provisioning)
- [ ] `CLOUD_CONFIG_SECRET` (only if you use cloud provisioning)

> **Note on DB vars:** `db.ts` falls back `LICENSE_DB_*` → `CLOUD_DB_*` → `DB_*` → `localhost`. If the old service relied on `CLOUD_DB_*` or `DB_*` instead of `LICENSE_DB_*`, copy those too — or better, set the explicit `LICENSE_DB_*` names on the new service so the fallback never matters.
>
> `LICENSE_DB_NAME` defaults to `verdix_license` if unset.

---

## Step 1 — Give Railway access to the new repo

`JhazonE/verdix-license-server` is **private**, so Railway needs permission.

- [ ] Railway → project → **New** → **GitHub Repo**
- [ ] If the repo isn't listed: **Configure GitHub App** → grant access to `verdix-license-server` → return to Railway

---

## Step 2 — Create the new service

- [ ] Select repo `JhazonE/verdix-license-server`, branch `main`
- [ ] **No build config needed.** The repo's `railway.json` already declares `builder: DOCKERFILE` / `dockerfilePath: Dockerfile`, and that Dockerfile runs `npx tsx src/server.ts`.
- [ ] Do **not** set a custom config-as-code path — the default `railway.json` is the right one now. (The old split — `railway.json` vs `railway.pos.json` — existed only because both apps shared one repo.)

---

## Step 3 — Set the environment variables

Paste in everything captured in Step 0.

- [ ] `LICENSE_PRIVATE_KEY` — paste the PEM exactly. Multi-line values are fine in Railway's variable editor.
- [ ] `LICENSE_ADMIN_SECRET`
- [ ] `LICENSE_DB_HOST` / `LICENSE_DB_PORT` / `LICENSE_DB_USER` / `LICENSE_DB_PASSWORD` / `LICENSE_DB_NAME` / `LICENSE_DB_SSL`
- [ ] `CLOUD_PROVISION_*` and `CLOUD_CONFIG_SECRET` — only if used

**Do NOT set `PORT`.** Railway injects it, and `server.ts:41` reads `PORT || LICENSE_UI_PORT || 4100`. Setting it by hand can bind the wrong port and fail health checks. `LICENSE_UI_PORT` is a local-dev override only — leave it unset in Railway.

---

## Step 4 — Deploy

- [ ] Trigger the first deploy
- [ ] Watch the build log: it should `npm install`, then start with `npx tsx src/server.ts`
- [ ] Startup log should show the cache sync line and `🔑 Vendix License Management System`

---

## Step 5 — Point a domain at it

- [ ] Settings → **Networking** → generate a domain (or move the custom domain off the old service)
- [ ] If the POS app calls this server by URL, that URL must keep working — either move the existing custom domain over, or update wherever the POS points at the license server (activation endpoint config).

---

## Step 6 — Verify BEFORE deleting the old service

All three must pass:

- [ ] **Dashboard loads** — open the service URL; `/` should 302 to `/login`, and `/login` should render the login page. (A 404 here means the static path is wrong.)
- [ ] **Admin login works** — confirms `LICENSE_ADMIN_SECRET` and the DB connection are good.
- [ ] **Signing works with the OLD key** — issue a license from the dashboard, then verify it activates in the POS app. This is the real test: it proves `LICENSE_PRIVATE_KEY` was carried over correctly and still matches the public key embedded in the POS (`lib/licensing/public-key.ts`).

> If activation fails with an invalid-signature error, **stop** — `LICENSE_PRIVATE_KEY` did not transfer correctly. Fix it before going further; do not delete the old service.

---

## Step 7 — Retire the old service

Only after Step 6 fully passes.

- [ ] Delete (or pause) the old license service in the POS project
- [ ] Confirm the **POS web service** still deploys — it is unaffected: it still uses `railway.pos.json` → `Dockerfile`, both untouched by the split

---

## Optional cleanup (later, not required)

The POS repo still uses the non-default config name `railway.pos.json`, which only existed to avoid colliding with the license `railway.json`. That collision is gone.

To simplify: rename `railway.pos.json` → `railway.json` in the POS repo **and** clear the custom config path in the POS service's Railway settings. Do both together — renaming the file without updating the service setting breaks the POS deploy.

Leave it alone if you'd rather not touch a working deploy.

---

## Reference — what changed in each repo

| | Before | After |
|---|---|---|
| License server code | `Verdix/license-server/` | `verdix-license-server/src/` |
| License Dockerfile | `Verdix/Dockerfile.license-server` | `verdix-license-server/Dockerfile` |
| License Railway config | `Verdix/railway.json` | `verdix-license-server/railway.json` |
| Entrypoint | `npx tsx license-server/server.ts` | `npx tsx src/server.ts` |
| POS Dockerfile | `Verdix/Dockerfile` | unchanged |
| POS Railway config | `Verdix/railway.pos.json` | unchanged |
