/**
 * audit-hosted-seats — READ-ONLY report of licences that gain a seat on deploy.
 * ----------------------------------------------------------------------------
 * Every licence provisioned through the old cloud endpoint holds an active
 * synthetic `HOSTED` activation row. That row used to count against
 * max_activations; the seat-count change excludes it, so each of those
 * licences gains one seat. This script only lists them so the operator can
 * decide whether any max_activations needs adjusting. It never writes.
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
  other_active: number;
}

async function main() {
  const rows = await query<Row[]>(
    `SELECT l.product_key,
            c.business_name,
            l.status AS license_status,
            l.max_activations,
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

  const table = rows.map((r) => {
    const n = Number(r.other_active);
    return {
      product_key: r.product_key,
      business: r.business_name,
      license_status: r.license_status,
      max_activations: Number(r.max_activations),
      seats_before: n + 1,
      seats_after: n,
    };
  });

  console.log('\nLicences holding an active HOSTED activation (read-only):\n');
  console.table(table);

  console.log(
    `\nSummary: ${rows.length} licence(s) gain a seat when the change is deployed` +
      ' (seats_before counts the HOSTED row; seats_after excludes it).' +
      ' No data was modified.\n'
  );
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ Failed to audit hosted seats:', e.message, '\n');
  process.exit(1);
});
