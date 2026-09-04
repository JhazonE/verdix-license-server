/**
 * Lookup tables copied into every newly provisioned tenant database.
 *
 * Order matters: rows are inserted in this sequence, so a parent table must
 * precede any table holding a foreign key onto it (user_types before
 * user_type_permissions). `migrations` is first and is not lookup data — it
 * marks the tenant schema as fully migrated, so `npm run migrate` in the POS
 * does not try to replay all 118 migrations against a schema that already has
 * them.
 *
 * Deliberately excludes products, suppliers, customers and every transactional
 * table: a new tenant starts empty of business records.
 */
export const SEED_TABLES: readonly string[] = [
  'migrations',
  'user_types',
  'user_type_permissions',
  'payment_methods',
  'units_of_measure',
  'tax_rates',
  'payment_term_types',
  'accounts',
  'sales_areas',
] as const;

/**
 * Default reference database provisioning clones from, and that seed-ref-db.ts
 * curates. Defined once because the two must never disagree: if provisioning
 * fell back to the live POS master while the operator script curated a
 * different database, a new tenant would be seeded with another customer's
 * production data.
 */
export const DEFAULT_REF_DB = 'verdix_ref';
