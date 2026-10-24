// Restores the archived diabetes engine v1 (archive/diabetes-engine-v1/) over the live one.
// The archive is never loaded by the app or the build; this is the only way it comes back.
//
//   node scripts/revert-diabetes-engine.mjs --check  exit 0 if the archive is present and its tests pass (changes nothing)
//   node scripts/revert-diabetes-engine.mjs          copy v1 over src/ and tests/, run sync-shared and npm test
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const ARCHIVE = 'archive/diabetes-engine-v1';
const ENGINE = `${ARCHIVE}/diabetes-engine.js`;
const TEST = `${ARCHIVE}/diabetes-engine.test.js`;
const check = process.argv.includes('--check');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// Archive test runs against the archived engine (require './diabetes-engine.js').
const archiveTest = run(process.execPath, ['--test', TEST]);
const passCount = Number((archiveTest.out.match(/^(?:# |ℹ )pass (\d+)/m) || [])[1] ?? -1);

if (archiveTest.status !== 0 || passCount <= 0) {
  console.error(`archive FAILED: ${TEST} did not pass (node --test exit ${archiveTest.status}, pass count ${passCount})`);
  console.error(archiveTest.out);
  process.exit(1);
}

if (check) {
  console.log(`archive OK (${passCount} tests pass)`);
  process.exit(0);
}

// Real revert: the archived test requires './diabetes-engine.js'; the live test lives in tests/ and needs '../src/diabetes-engine.js'.
fs.copyFileSync(ENGINE, 'src/diabetes-engine.js');
const testSrc = fs.readFileSync(TEST, 'utf8');
const liveTest = testSrc.replace("require('./diabetes-engine.js')", "require('../src/diabetes-engine.js')");
if (liveTest === testSrc) throw new Error(`${TEST}: require path not found — update this script`);
fs.writeFileSync('tests/diabetes-engine.test.js', liveTest);
console.log('restored src/diabetes-engine.js and tests/diabetes-engine.test.js from archive');

const sync = spawnSync(process.execPath, ['scripts/sync-shared.mjs'], { stdio: 'inherit' });
if (sync.status !== 0) process.exit(sync.status ?? 1);

const npmTest = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (npmTest.status !== 0) {
  console.error('npm test FAILED after revert — fix before deploying');
  process.exit(npmTest.status ?? 1);
}

console.log(`
Revert complete. Redeploy before pushing:
  1. Supabase edge functions: diabetes-sync, notify-glucose-forecast
  2. Unschedule pg_cron job: diabetes-learn
  3. Push main + TestFlight (iOS app bundles src/)
`);
