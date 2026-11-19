/**
 * DB-first read with an in-memory cache fallback that never confuses
 * "the cache does not have it" with "it does not exist".
 *
 * The heartbeat turns a missing activation into 'released' and a missing
 * licence into 'invalid'. Both are verdicts a POS acts on (a desktop install
 * deletes license.dat on 'released'), so they may only come from a database
 * that actually answered. When MySQL is down and the cache misses, throw:
 * /api/validate then returns 500, which the POS treats as "unknown".
 */
export class LookupUnavailableError extends Error {
  constructor(public readonly cause: unknown) {
    super('Database unreachable and the row is not in the cache');
    this.name = 'LookupUnavailableError';
  }
}

export async function lookupWithCacheFallback<T>(
  fromDb: () => Promise<T | null>,
  fromCache: () => T | null
): Promise<T | null> {
  try {
    return await fromDb();
  } catch (e) {
    const cached = fromCache();
    if (cached) return cached;
    throw new LookupUnavailableError(e);
  }
}
