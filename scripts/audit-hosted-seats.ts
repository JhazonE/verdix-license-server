/**
 * audit-hosted-seats — READ-ONLY report of licences that gain a seat on deploy.
 * ----------------------------------------------------------------------------
 * Every licence provisioned through the old cloud endpoint holds an active
 * synthetic `HOSTED` activation row. That row used to count against
 * max_activations; the seat-count change excludes it, so each of those
 * licences gains one seat. This script only lists them so the operator can
 * decide whether any max_activations needs adjusting. It never writes.
 *
 * A licence only gains a seat in practice if it is status 'active' and not
 * expired: the heartbeat path returns before any seat logic for revoked,
 * suspended or expired licences (src/service.ts).
 *
 *   npm run audit-hosted-seats
 */
import { query } from '../src/db';
import { HOSTED_ACTIVATION_MACHINE_ID } from '../src/cache';

interface Row {
  product_key: string;
  business_name: string;
  license_status: string;
  max_activations: number;
  expires_at: Date | string | null;
  other_active: number;
}

async function main() {
  const rows = await query<Row[]>(
    `SELECT l.product_key,
            c.business_name,
            l.status AS license_status,
            l.max_activations,
            l.expires_at,
            (SELECT COUNT(*) FROM activations a
              WHERE a.license_id = l.id
                AND a.status = 'active'
                AND a.machine_id <> ?) AS other_active
       FROM licenses l
       JOIN customers c ON c.id = l.customer_id
       JOIN activations h ON h.license_id = l.id
                         AND h.status = 'active'
                         AND h.machine_id = ?
      ORDER BY c.business_name, l.product_key`,
    [HOSTED_ACTIVATION_MACHINE_ID, HOSTED_ACTIVATION_MACHINE_ID]
  );

  if (rows.length === 0) {
    console.log('\nNo licences hold an active HOSTED activation. Nothing gains a seat.\n');
    process.exit(0);
  }

  const now = Date.now();
  const table = rows.map((r) => {
    const used = Number(r.other_active);
    const max = Number(r.max_activations);
    const expired = r.expires_at != null && new Date(r.expires_at).getTime() < now;
    return {
      product_key: r.product_key,
      business: r.business_name,
      license_status: r.license_status,
      expires_at: r.expires_at ? new Date(r.expires_at).toISOString().slice(0, 10) : '-',
      max_activations: max,
      used_before: used + 1,
      used_after: used,
      free_after: max - used,
      _effective: r.license_status === 'active' && !expired,
    };
  });

  const effective = table.filter((t) => t._effective);
  const inert = table.filter((t) => !t._effective);
  const display = table.map(({ _effective, ...rest }) => rest);

  console.log('\nLicences holding an active HOSTED activation (read-only):\n');
  console.log('used_before counts the HOSTED row; used_after excludes it; free_after = max_activations - used_after.\n');
  console.table(display);

  console.log(
    `\nSummary: ${effective.length} active, unexpired licence(s) gain a seat when the change is deployed.`
  );
  if (inert.length) {
    console.log(
      `         ${inert.length} other licence(s) are also listed but have no practical effect` +
        ' (revoked, suspended or expired; the heartbeat returns before seat logic).'
    );
  }
  console.log('         No data was modified.\n');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ Failed to audit hosted seats:', e.message, '\n');
  process.exit(1);
});
