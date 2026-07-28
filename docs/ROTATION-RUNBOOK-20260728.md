# License key rotation — runbook

**Why:** `LICENSE_PRIVATE_KEY` was printed into a Claude Code transcript on
2026-07-28 (a `railway variables` call on the linked license-server service).
The key signs every activation token the POS verifies, so anyone with the
transcript can mint tokens that pass verification.

**Status: COMPLETED 2026-07-28.** All six steps ran and were verified. Kept as
the procedure to follow if this is ever needed again.

Outcome: new keypair generated; Railway `LICENSE_PRIVATE_KEY` replaced (piped
via `--set-from-stdin`, never rendered) and the service redeployed; the new
public key embedded in both repos; POS 1.19.1 built and installed on both
machines; both activations re-signed and cryptographically verified against the
new key; the backup holding the compromised key destroyed.

One correction against the original draft below: step 5 needed **no** SQL
cleanup. `server.ts` skips the seat check for an already-activated machine and
`issueSignedLicense` upserts on `uniq_license_machine`, so re-activating the
same machine refreshes its token in place.

---

## Backup (taken, then destroyed in step 6)

`d:\VERDIX_POS\license-key-backup-20260728\` — **no longer exists.** It was
deleted once both machines verified against the new key, since it held the
compromised private key. The layout below is what to recreate next time.

| File | What |
|---|---|
| `private-key.pem` | the CURRENT (compromised) private key |
| `public-key.pem` | its public half |
| `public-key.ts.pos` | the POS copy, as it was before rotation |

Outside both git repos, so it is not committed. Keep until rotation is verified,
then delete — it contains the compromised private key.

Verified before backup: `keys/private-key.pem` and the Railway
`LICENSE_PRIVATE_KEY` are the **same key** (sha256 `f77b020bce2ef19e`), so one
rotation covers both.

---

## Blast radius

Checked against production `verdix_license` on 2026-07-28:

- **2 active licenses** — `VRDX-C69F-EWKS-NYSJ` (enterprise), `VRDX-B8QM-HFKQ-84MR` (standard)
- **2 activations**

Product keys are **not** signed — the `licenses` table stores no signature.
Signing happens at activation (`src/service.ts:315`). So rotation does **not**
invalidate the product keys. What breaks is the **already-issued token on each
of the 2 activated machines**, until they re-activate.

---

## Ordering constraint (important)

`src/keygen.ts` can no longer update the POS repo since the split — that step is
manual. So there is a window where the server signs with the new key while
deployed POS clients still trust the old public key.

Do it in this order. Do **not** re-activate machines before step 4 lands.

---

## Step 1 — rotate (license-server repo)

```bash
cd d:/VERDIX_POS/verdix-license-server
npm run keygen -- --force
```

`--force` is required; without it keygen refuses, to prevent accidental
rotation. Writes a new `keys/private-key.pem` + `keys/public-key.pem`.

## Step 2 — update Railway

Dashboard → **Vendix-LMS** → `vendix-license-server` → Variables:

```
LICENSE_PRIVATE_KEY = <contents of the NEW keys/private-key.pem>
```

Paste the PEM as-is. `src/keys.ts` normalizes literal `\n` to real newlines, and
the env var takes precedence over the key file.

Redeploy the service.

## Step 3 — update the POS public key (manual)

Copy the new `keys/public-key.pem` body into:

`d:\VERDIX_POS\Verdix_POS\lib\licensing\public-key.ts` → `PUBLIC_KEY_PEM`

Keep the existing file shape; replace only the base64 between the PEM markers.

## Step 4 — ship a POS build

Build and distribute the POS with the new public key, and get it onto both
customer machines. **Until this lands, those machines cannot verify new
tokens.**

## Step 5 — re-activate the 2 machines

Each re-activates against the license server using its existing product key
(`VRDX-C69F-EWKS-NYSJ`, `VRDX-B8QM-HFKQ-84MR`) and receives a token signed by
the new key. Product keys are unchanged, so nothing needs re-issuing.

If `max_activations` (1 each) blocks re-activation, clear the old row in the
`activations` table for that machine first.

## Step 6 — verify, then destroy the backup

Confirm both machines are licensed and the dashboard shows them active. Then
delete `d:\VERDIX_POS\license-key-backup-20260728\` — it holds the compromised
key.

---

## Rollback

Before step 4 is distributed, rollback is: restore `private-key.pem` and
`public-key.pem` from the backup, put the old `LICENSE_PRIVATE_KEY` back in
Railway, redeploy. The 2 machines keep working, since their existing tokens
were signed by that key.

After a new POS build is distributed, rollback also means shipping a build with
the old public key — messier. Treat step 4 as the point of no return.

---

## Note

`CLAUDE.md` states the crypto in `lib/licensing/core.ts` (POS) and
`src/licensing/core.ts` (server) are deliberate copies. Rotation changes only
key material, not the algorithm or format, so those files need no edits.
