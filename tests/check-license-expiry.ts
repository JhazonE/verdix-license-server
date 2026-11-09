// tests/check-license-expiry.ts
//
// The bugs this pins down (all three let a "licensed" install expire):
//
//  1. PERPETUAL LEAK — the Cloud Customer modal hardcoded `type: 'subscription'`
//     and required an expiry date, with no type selector in the form at all. Every
//     cloud-onboarded store got a time-bombed licence no matter what was intended;
//     all 6 edition=web rows in production were subscriptions, while 45+ licences
//     from the New License form were correctly perpetual. createLicense() rejected
//     a subscription with no expiry but never a perpetual WITH one, so nothing
//     upstream caught it.
//
//  2. LOST DAY — createLicense() stored a bare 'YYYY-MM-DD' via
//     `new Date(d).toISOString()`, which parses as MIDNIGHT UTC rather than
//     end-of-day. A licence set to expire Dec 31 died at 00:00 on Dec 31,
//     a full day early. offline-cli.ts got this right (`+ 'T23:59:59'`);
//     the service did not.
//
//  3. TIMEZONE DRIFT — expires_at is a MySQL DATETIME (no zone) and the pool set
//     no `timezone`, so the value was WRITTEN as a UTC wall clock but READ BACK as
//     local. Since validateHeartbeat re-signs on every poll, the same row signed
//     2027-12-31T07:59:59Z on a UTC+8 dev box and 2027-12-31T15:59:59Z on Railway
//     (UTC) — the expiry moved 8 hours depending on which server answered.
import assert from 'assert';
import { normalizeExpiry, createLicense } from '../src/service';

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e: any) {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (e: any) {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}

console.log('\n1. Perpetual licences must never carry an expiry');

check('perpetual + no date -> null', () => {
  assert.strictEqual(normalizeExpiry('perpetual', null), null);
});

check('perpetual + a date -> null (the cloud-modal bug)', () => {
  // The modal sent type:'subscription' + a date; once a type selector exists,
  // picking Perpetual must drop any date left in the form rather than honour it.
  assert.strictEqual(normalizeExpiry('perpetual', '2027-12-31'), null);
});

check('subscription with no date is rejected', () => {
  assert.throws(() => normalizeExpiry('subscription', null), /require/i);
});

console.log('\n2. A subscription expires at END of the chosen day, not its start');

check("bare 'YYYY-MM-DD' -> 23:59:59, not 00:00:00", () => {
  const got = normalizeExpiry('subscription', '2027-12-31')!;
  assert.ok(
    got.endsWith('23:59:59'),
    `expected the stored value to end at 23:59:59, got "${got}" — this is the lost-day bug`
  );
});

check('the stored date does not slip to the previous day', () => {
  const got = normalizeExpiry('subscription', '2027-12-31')!;
  assert.ok(
    got.startsWith('2027-12-31'),
    `expected to stay on 2027-12-31, got "${got}" — the date shifted`
  );
});

console.log('\n3. The stored value must not depend on the server timezone');

// NOTE: these run under whatever zone the process was started in. Setting
// process.env.TZ mid-run does NOT reliably re-latch Node's zone (on Windows it
// is simply ignored), so a single in-process "compare two zones" assertion is a
// false pass. The real guarantee is that a bare date is treated as a CALENDAR
// day and never routed through an offset at all — asserted below, and exercised
// across real zones by the TZ= loop in the header comment of this suite:
//
//   TZ=UTC npx tsx tests/check-license-expiry.ts
//   TZ=Asia/Manila npx tsx tests/check-license-expiry.ts
//   TZ=America/New_York npx tsx tests/check-license-expiry.ts
//
// All three must print the same stored values.

check('a bare date is stored verbatim, with no offset applied', () => {
  // The one input shape that is unambiguous across every zone. This is why the
  // dashboard now sends 'YYYY-MM-DD' instead of an ISO instant.
  assert.strictEqual(normalizeExpiry('subscription', '2027-12-31'), '2027-12-31 23:59:59');
  assert.strictEqual(normalizeExpiry('subscription', '2027-01-01'), '2027-01-01 23:59:59');
});

check('a bare date never lands on an adjacent day', () => {
  // Jan 1 and Dec 31 are where an offset bug shows up as a year change.
  for (const d of ['2027-01-01', '2027-12-31', '2028-02-29']) {
    const got = normalizeExpiry('subscription', d)!;
    assert.ok(got.startsWith(d), `"${d}" was stored as "${got}" — the day shifted`);
  }
});

check('a full timestamp is reduced to its own wall-clock day', () => {
  // Legacy/API callers may still pass a timestamp. It must keep the day its own
  // wall clock names rather than flipping on a UTC conversion.
  const got = normalizeExpiry('subscription', '2027-12-31 15:59:59')!;
  assert.ok(got.startsWith('2027-12-31'), `expected 2027-12-31, got "${got}"`);
});

console.log('\n4. createLicense must not accept an unspecified type');

async function main() {
  await checkAsync('a missing or bogus type is rejected, never defaulted', async () => {
    // Both endpoints build input from `{ ...body }`, so an absent `type` reaches
    // createLicense directly. Silently defaulting is what time-bombed the cloud
    // stores, so the guard rejects anything that is not one of the two values.
    //
    // The guard runs before any query, so this needs no database — which is also
    // the point: a bad type must never get far enough to touch one.
    for (const bad of [undefined, null, '', 'Perpetual', 'sub', 'lifetime']) {
      await assert.rejects(
        () => createLicense({ customer_id: 'no-such-customer', type: bad as any }),
        /must be "perpetual" or "subscription"/,
        `type ${JSON.stringify(bad)} should have been rejected`
      );
    }
  });

  console.log(
    failures === 0
      ? '\nAll expiry checks passed.\n'
      : `\n${failures} expiry check(s) FAILED.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
