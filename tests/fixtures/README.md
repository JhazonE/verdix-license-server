# Fixtures

`legacy-token.txt` — a real license token issued by the **pre-multi-product**
code, signed with the production Verdix keypair.

It exists to prove backward compatibility: this exact token must keep
verifying after the multi-product change. If `npx tsx tests/verify-legacy.ts`
ever fails, the wire format or the Verdix key resolution has regressed and
every license already in customers' hands is at risk.

Do not regenerate this file.
