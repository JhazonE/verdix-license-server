/**
 * License Server schema — creates all tables (idempotent).
 * Run standalone:  npm run license:migrate
 */
import fs from 'fs';
import path from 'path';
import { ensureDatabase, query } from './db';

const TABLES: { name: string; sql: string }[] = [
  {
    name: 'customers',
    sql: `
      CREATE TABLE IF NOT EXISTS customers (
        id            VARCHAR(36) PRIMARY KEY,
        business_name VARCHAR(255) NOT NULL,
        contact_name  VARCHAR(255) NULL,
        email         VARCHAR(255) NULL,
        phone         VARCHAR(64)  NULL,
        address       TEXT NULL,
        notes         TEXT NULL,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_business_name (business_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
  },
  {
    name: 'products',
    sql: `
      CREATE TABLE IF NOT EXISTS products (
        id             VARCHAR(64) PRIMARY KEY,
        name           VARCHAR(255) NOT NULL,
        key_prefix     VARCHAR(16) NOT NULL,
        license_prefix VARCHAR(16) NOT NULL,
        public_key     TEXT NULL,
        env_key_name   VARCHAR(64) NOT NULL,
        status         ENUM('active','inactive') NOT NULL DEFAULT 'active',
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_key_prefix (key_prefix),
        UNIQUE KEY uniq_license_prefix (license_prefix)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
  },
  {
    name: 'licenses',
    sql: `
      CREATE TABLE IF NOT EXISTS licenses (
        id               VARCHAR(36) PRIMARY KEY,
        customer_id      VARCHAR(36) NOT NULL,
        product_key      VARCHAR(40) NOT NULL UNIQUE,
        edition          VARCHAR(64) NOT NULL DEFAULT 'standard',
        type             ENUM('perpetual','subscription') NOT NULL DEFAULT 'perpetual',
        expires_at       DATETIME NULL,
        max_activations  INT NOT NULL DEFAULT 1,
        features         JSON NULL,
        status           ENUM('active','suspended','revoked') NOT NULL DEFAULT 'active',
        notes            TEXT NULL,
        created_by       VARCHAR(64) NULL,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_customer (customer_id),
        INDEX idx_product_key (product_key),
        INDEX idx_status (status),
        CONSTRAINT fk_license_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
  },
  {
    name: 'activations',
    sql: `
      CREATE TABLE IF NOT EXISTS activations (
        id              VARCHAR(36) PRIMARY KEY,
        license_id      VARCHAR(36) NOT NULL,
        machine_id      VARCHAR(128) NOT NULL,
        machine_label   VARCHAR(255) NULL,
        signed_license  MEDIUMTEXT NOT NULL,
        app_version     VARCHAR(32) NULL,
        ip_address      VARCHAR(64) NULL,
        status          ENUM('active','released') NOT NULL DEFAULT 'active',
        activated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen_at    TIMESTAMP NULL,
        UNIQUE KEY uniq_license_machine (license_id, machine_id),
        INDEX idx_license (license_id),
        INDEX idx_machine (machine_id),
        CONSTRAINT fk_activation_license FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
  },
  {
    name: 'activation_logs',
    sql: `
      CREATE TABLE IF NOT EXISTS activation_logs (
        id          BIGINT AUTO_INCREMENT PRIMARY KEY,
        license_id  VARCHAR(36) NULL,
        machine_id  VARCHAR(128) NULL,
        action      VARCHAR(64) NOT NULL,
        detail      TEXT NULL,
        ip_address  VARCHAR(64) NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_license (license_id),
        INDEX idx_action (action)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
  },
  {
    name: 'admin_users',
    sql: `
      CREATE TABLE IF NOT EXISTS admin_users (
        id            VARCHAR(36) PRIMARY KEY,
        username      VARCHAR(64) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role          VARCHAR(32) NOT NULL DEFAULT 'admin',
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login_at TIMESTAMP NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
  },
  {
    name: 'cloud_configs',
    sql: `
      CREATE TABLE IF NOT EXISTS cloud_configs (
        license_id       VARCHAR(36) PRIMARY KEY,
        db_host          VARCHAR(255) NOT NULL,
        db_port          INT NOT NULL DEFAULT 3306,
        db_name          VARCHAR(128) NOT NULL,
        db_user          VARCHAR(128) NOT NULL,
        db_password_enc  TEXT NOT NULL,
        updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_cloudcfg_license FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
  },
];

/**
 * Additive column migrations. Each runs only when the column is absent, so
 * this stays idempotent like the CREATE TABLE statements above.
 */
const COLUMNS: { table: string; column: string; sql: string }[] = [
  {
    table: 'licenses',
    column: 'product_id',
    sql: `ALTER TABLE licenses
            ADD COLUMN product_id VARCHAR(64) NOT NULL DEFAULT 'verdix-pos'`,
  },
];

async function applyColumns(): Promise<void> {
  for (const c of COLUMNS) {
    const rows = await query<any[]>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [c.table, c.column]
    );
    if (rows.length > 0) {
      console.log(`  · column exists: ${c.table}.${c.column}`);
      continue;
    }
    await query(c.sql);
    console.log(`  ✓ column added: ${c.table}.${c.column}`);
  }
}

/**
 * Additive unique-index migrations. Each runs only when the named index is
 * absent, so this stays idempotent like CREATE TABLE / applyColumns above.
 * Needed because `products` already exists in live databases — CREATE TABLE
 * IF NOT EXISTS will never retrofit a UNIQUE constraint onto it.
 */
const INDEXES: { table: string; index: string; sql: string }[] = [
  {
    table: 'products',
    index: 'uniq_key_prefix',
    sql: `ALTER TABLE products ADD UNIQUE KEY uniq_key_prefix (key_prefix)`,
  },
  {
    table: 'products',
    index: 'uniq_license_prefix',
    sql: `ALTER TABLE products ADD UNIQUE KEY uniq_license_prefix (license_prefix)`,
  },
];

async function applyIndexes(): Promise<void> {
  for (const idx of INDEXES) {
    const rows = await query<any[]>(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [idx.table, idx.index]
    );
    if (rows.length > 0) {
      console.log(`  · index exists: ${idx.table}.${idx.index}`);
      continue;
    }
    await query(idx.sql);
    console.log(`  ✓ index added: ${idx.table}.${idx.index}`);
  }
}

/**
 * The verdix-pos row must exist before any license references it. Its values
 * reproduce the pre-multi-product hardcoded constants exactly, which is what
 * makes already-issued licenses keep working.
 */
async function seedDefaultProduct(): Promise<void> {
  await query(
    `INSERT IGNORE INTO products
       (id, name, key_prefix, license_prefix, env_key_name, status)
     VALUES ('verdix-pos', 'Verdix POS', 'VRDX', 'VRDX1', 'LICENSE_PRIVATE_KEY', 'active')`
  );
  console.log('  ✓ product seeded: verdix-pos');

  // Backfill verdix-pos's public key from the on-disk PEM when the column is
  // still empty. The dashboard shows this column so developers can copy the key
  // to embed in their app; verdix-pos predates the products table, so its row
  // starts out NULL. Signing never reads this column (it goes through
  // env_key_name), so a missing PEM file here is not fatal.
  const rows = await query<any[]>(
    `SELECT public_key FROM products WHERE id = 'verdix-pos'`
  );
  if (rows.length > 0 && !rows[0].public_key) {
    const pemPath = path.join(__dirname, '..', 'keys', 'public-key.pem');
    if (fs.existsSync(pemPath)) {
      await query(`UPDATE products SET public_key = ? WHERE id = 'verdix-pos'`, [
        fs.readFileSync(pemPath, 'utf8'),
      ]);
      console.log('  ✓ public key backfilled: verdix-pos');
    } else {
      console.log('  · no keys/public-key.pem on disk — verdix-pos public_key left empty');
    }
  }
}

export async function migrate(): Promise<void> {
  await ensureDatabase();
  for (const t of TABLES) {
    await query(t.sql);
    console.log('  ✓ table ready: ' + t.name);
  }
  await applyColumns();
  await applyIndexes();
  await seedDefaultProduct();
}

if (require.main === module) {
  migrate()
    .then(() => {
      console.log('\n✅ License Server schema is up to date.\n');
      process.exit(0);
    })
    .catch((e) => {
      console.error('\n❌ Migration failed:', e.message, '\n');
      process.exit(1);
    });
}
