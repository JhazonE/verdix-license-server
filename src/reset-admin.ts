/**
 * reset-admin — reset (or create) an LMS administrator's password.
 * ----------------------------------------------------------------------------
 * Unlike seed-admin, this OVERWRITES the password if the admin already exists.
 * Connects to whatever LICENSE_DB_* env vars are set — point these at Railway
 * to fix a locked-out cloud dashboard.
 *
 *   npm run license:reset-admin -- --username admin --password "NewPass123"
 */
import { migrate } from './schema';
import {
  getAdminByUsername,
  createAdmin,
  updateAdminPassword,
  listAdmins,
} from './auth';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

async function main() {
  await migrate();

  const username = (arg('username', 'admin') as string).toLowerCase();
  const password = arg('password') as string | undefined;

  if (!password) {
    console.error('\n❌ Missing --password.  Usage:');
    console.error('   npm run license:reset-admin -- --username admin --password "NewPass123"\n');
    const admins = await listAdmins();
    if (admins.length) {
      console.log('   Existing admins on this database:');
      for (const a of admins) console.log(`     - ${a.username} (${a.role})`);
      console.log('');
    } else {
      console.log('   (No admin users exist on this database yet.)\n');
    }
    process.exit(1);
  }

  const existing = await getAdminByUsername(username);
  if (existing) {
    await updateAdminPassword(existing.id, password);
    console.log(`\n✅ Password reset for existing admin: ${username}\n`);
  } else {
    await createAdmin(username, password);
    console.log(`\n✅ New admin created: ${username}\n`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ Failed to reset admin:', e.message, '\n');
  process.exit(1);
});
