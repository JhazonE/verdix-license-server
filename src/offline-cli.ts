/**
 * offline-cli — issue a signed license key from the command line.
 * ----------------------------------------------------------------------------
 * Quick offline issuing without the dashboard. Requires an existing Product Key
 * (created in the LMS) OR can mint an ad-hoc key bound directly to a machine.
 *
 *   # Sign for an existing license (by product key) + a customer's machine
 *   npm run license:new -- --product-key VRDX-XXXX-XXXX-XXXX --machine ABCD-...
 *
 *   # Ad-hoc one-off (no DB record) — perpetual
 *   npm run license:new -- --customer "Juan's Store" --machine ABCD-... --adhoc
 *
 *   # Ad-hoc subscription
 *   npm run license:new -- --customer "Acme" --machine ABCD-... --adhoc --days 365
 */
import crypto from 'crypto';
import {
  signLicense,
  normalizeMachineId,
  LicensePayload,
  LICENSE_FORMAT_VERSION,
  HOSTED_MACHINE_ID,
} from './licensing/core';
import { getPrivateKeyPem } from './keys';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i++;
      } else {
        out[a.slice(2)] = 'true';
      }
    }
  }
  return out;
}

function fail(msg: string): never {
  console.error('\n❌ ' + msg + '\n');
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const machineRaw = args.web ? HOSTED_MACHINE_ID : args.machine?.trim();
  if (!machineRaw) fail('Missing --machine "MACHINE-ID" (from the POS activation screen), or use --web for a hosted/web license.');

  if (args.adhoc) {
    // Sign directly without touching the database.
    const customer = args.customer?.trim();
    if (!customer) fail('Ad-hoc mode needs --customer "Business Name".');

    let expires: string | null = null;
    if (args.expires && args.expires !== 'true') {
      const d = new Date(args.expires + 'T23:59:59');
      if (isNaN(d.getTime())) fail('Invalid --expires date (YYYY-MM-DD).');
      expires = d.toISOString();
    } else if (args.days && args.days !== 'true') {
      const days = parseInt(args.days, 10);
      if (isNaN(days) || days <= 0) fail('Invalid --days value.');
      expires = new Date(Date.now() + days * 86400000).toISOString();
    }

    const productId = (args.product || 'verdix-pos').trim().toLowerCase();
    const { getProduct } = await import('./products');
    const product = await getProduct(productId);
    if (!product) fail(`Unknown product "${productId}". Register it in the dashboard first.`);

    const payload: LicensePayload = {
      v: LICENSE_FORMAT_VERSION,
      lid: crypto.randomUUID(),
      product: productId,
      customer,
      edition: (args.edition || 'standard').trim(),
      machineId: normalizeMachineId(machineRaw),
      issued: new Date().toISOString(),
      expires,
      features: (args.features || '').split(',').map((f) => f.trim()).filter(Boolean),
    };
    const key = signLicense(payload, getPrivateKeyPem(product!), product!.license_prefix);
    printKey(payload, key);
    return;
  }

  // DB-backed: sign for an existing product key (records the activation).
  const productKey = args['product-key']?.trim();
  if (!productKey) fail('Provide --product-key VRDX-... (or use --adhoc with --customer).');

  // Lazy import to avoid requiring a DB connection in pure --adhoc mode.
  const { getLicenseByProductKey, issueSignedLicense } = await import('./service');
  const license = await getLicenseByProductKey(productKey);
  if (!license) fail('No license found for product key ' + productKey);
  if (license.status !== 'active') fail('License is ' + license.status + ' — cannot issue.');

  const { signedLicense, payload } = await issueSignedLicense(license, machineRaw, {
    machineLabel: args.label,
  });
  printKey(payload, signedLicense);
  process.exit(0);
}

function printKey(payload: LicensePayload, key: string) {
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(' VERDIX POS LICENSE ISSUED');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(' Customer   : ' + payload.customer);
  console.log(' Edition    : ' + payload.edition);
  console.log(' Machine ID : ' + payload.machineId);
  console.log(
    ' Type       : ' +
      (payload.expires ? 'Subscription (expires ' + payload.expires.slice(0, 10) + ')' : 'Perpetual')
  );
  console.log('──────────────────────────────────────────────────────────────');
  console.log('\nLICENSE KEY (give this to the customer):\n');
  console.log(key);
  console.log('');
}

main().catch((e) => fail(e.message));
