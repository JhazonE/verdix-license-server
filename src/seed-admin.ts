/**
 * seed-admin — create the first LMS administrator.
 * Run:  npm run license:seed-admin -- --username admin --password "StrongPass123"
 * If no args are given it defaults to admin / admin (change immediately!).
 */
import { migrate } from './schema';
import { createAdmin, getAdminByUsername } from './auth';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

async function main() {
  await migrate();

  const username = (arg('username', 'admin') as string).toLowerCase();
  const password = arg('password', 'admin') as string;

  const existing = await getAdminByUsername(username);
  if (existing) {
    console.log(`\nℹ️  Admin "${username}" already exists. No changes made.\n`);
    process.exit(0);
  }

  await createAdmin(username, password);
  console.log(`\n✅ Admin created: ${username}`);
  if (password === 'admin') {
    console.log('⚠️  Default password in use — change it right away.');
  }
  console.log('   Start the dashboard with:  npm run license:server\n');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ Failed to seed admin:', e.message, '\n');
  process.exit(1);
});
