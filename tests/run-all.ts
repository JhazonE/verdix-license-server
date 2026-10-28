// Runs every tests/check-*.ts file, each in its own child process, and reports
// all failures rather than stopping at the first one. Exits non-zero if any
// file fails. Uses no shell, so it behaves the same under cmd.exe, sh and Docker.
//
// Run: npm test   (or: npx tsx tests/run-all.ts)
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const testsDir = __dirname;
const tsxCli = require.resolve('tsx/cli');

const files = readdirSync(testsDir)
  .filter((f) => /^check-.*\.ts$/.test(f))
  .sort();

if (files.length === 0) {
  console.error('No tests/check-*.ts files found.');
  process.exit(1);
}

const failed: string[] = [];

for (const file of files) {
  console.log(`— tests/${file}`);
  const res = spawnSync(process.execPath, [tsxCli, path.join(testsDir, file)], {
    stdio: 'inherit',
    cwd: path.join(testsDir, '..'),
  });
  const ok = res.status === 0 && !res.error;
  if (res.error) console.error(`  could not run: ${res.error.message}`);
  console.log(ok ? `  RESULT: PASS ${file}` : `  RESULT: FAIL ${file} (${res.signal ?? 'exit ' + res.status})`);
  if (!ok) failed.push(file);
}

console.log(`\n${files.length - failed.length} passed, ${failed.length} failed of ${files.length}`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAILED: ${f}`);
  process.exit(1);
}
