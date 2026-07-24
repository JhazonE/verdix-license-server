/**
 * License Server schema — creates all tables (idempotent).
 * Run standalone:  npm run license:migrate
 */
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

export async function migrate(): Promise<void> {
  await ensureDatabase();
  for (const t of TABLES) {
    await query(t.sql);
    console.log('  ✓ table ready: ' + t.name);
  }
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
