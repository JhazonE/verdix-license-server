/**
 * Regression: a heartbeat arriving while MySQL was unreachable, for a licence
 * or activation the in-memory cache did not hold, was answered as if the row
 * did not exist — 'released' for a missing activation, 'invalid' for a missing
 * licence. A desktop POS deletes license.dat on 'released', so a database blip
 * permanently de-licensed a store the vendor never touched.
 *
 * "Not in the cache" is not "does not exist": the lookup must fail loudly so
 * /api/validate answers 500, which the POS treats as "unknown" and ignores.
 *
 * No database needed — run with: npx tsx tests/check-lookup-fallback.ts
 */
import { lookupWithCacheFallback, LookupUnavailableError } from '../src/lookup-fallback';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log('  ok   ' + name);
  else {
    console.error('  FAIL ' + name);
    failures++;
  }
}

const dbDown = async (): Promise<never> => {
  throw new Error('connect ETIMEDOUT');
};

(async () => {
  // DB answers → its answer wins, including a genuine "no such row".
  check('db row returned', (await lookupWithCacheFallback(async () => ({ id: 'a' }), () => null))?.id === 'a');
  check(
    'db "not found" is a real null (cache not consulted)',
    (await lookupWithCacheFallback(async () => null, () => ({ id: 'stale' }))) === null
  );

  // DB down, cache has it → serve the cache.
  check('db down + cache hit → cached row', (await lookupWithCacheFallback(dbDown, () => ({ id: 'c' })))?.id === 'c');

  // DB down, cache misses → must NOT be reported as "does not exist".
  let thrown: unknown = null;
  try {
    await lookupWithCacheFallback(dbDown, () => null);
  } catch (e) {
    thrown = e;
  }
  check('db down + cache miss → throws', thrown instanceof LookupUnavailableError);
  check(
    'error keeps the underlying cause',
    thrown instanceof LookupUnavailableError && String((thrown as any).cause?.message).includes('ETIMEDOUT')
  );

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall checks passed');
  }
})();
