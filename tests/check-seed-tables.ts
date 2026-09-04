import { SEED_TABLES } from '../src/seed-tables';

const expected = [
  'migrations', 'user_types', 'user_type_permissions', 'payment_methods',
  'units_of_measure', 'tax_rates', 'payment_term_types', 'accounts', 'sales_areas',
];

let failed = false;
if (SEED_TABLES.length !== 9) {
  console.error(`FAIL: expected 9 tables, got ${SEED_TABLES.length}`);
  failed = true;
}
for (let i = 0; i < expected.length; i++) {
  if (SEED_TABLES[i] !== expected[i]) {
    console.error(`FAIL: position ${i} expected "${expected[i]}", got "${SEED_TABLES[i]}"`);
    failed = true;
  }
}
// user_types must precede user_type_permissions (FK dependency).
if (SEED_TABLES.indexOf('user_types') > SEED_TABLES.indexOf('user_type_permissions')) {
  console.error('FAIL: user_types must come before user_type_permissions');
  failed = true;
}
console.log(failed ? '❌ FAILED' : '✅ PASS');
process.exit(failed ? 1 : 0);
