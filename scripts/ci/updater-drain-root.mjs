#!/usr/bin/env node
// CI only (the "test-run sandbox (real systemd)" job in .github/workflows/ci-slow.yml), as root, as the updater runs: a
// machine that is never quiet is drained, installed and reopened, on the machine's real paths. A test run holds a
// real test slot in /var/lib/worklane/agent-slots (taken by the engine's own gate, from dist/, in a process of its
// own); the updater's run() with its real slot reader and its real drain file (/var/lib/worklane/update-drain.json)
// drains once the machine has been busy past drain_after_minutes; then no new test run or agent can start, an
// unprivileged user can neither remove nor rewrite the flag, the run in flight is not touched, and once it ends the
// next run installs and removes the flag; an expired flag blocks nothing. GitHub, the build and the switch are
// stand-ins (no network here); the decisions, the slot files and the flag are the real ones.
//
//   sudo node updater-drain-root.mjs <path to worklane-update.cjs> <path to the engine's dist/src>
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.getuid(), 0, 'run this as root, as the updater runs');
const u = createRequire(import.meta.url)(process.argv[2]);
const dist = process.argv[3];
const SLOTS = '/var/lib/worklane/agent-slots';
const FLAG = '/var/lib/worklane/update-drain.json';
const BASE = '/var/lib/worklane';
const madeBase = !existsSync(BASE);
const madeSlots = !existsSync(SLOTS);
assert.equal(existsSync(FLAG), false, 'no drain flag before the proof');
// As the machine script makes them: root's /var/lib/worklane 0755, the shared slot directory inside it.
if (madeBase) mkdirSync(BASE, { mode: 0o755 });
if (madeSlots) mkdirSync(SLOTS, { mode: 0o2770 });
const { tryTestSlot } = await import(pathToFileURL(join(dist, 'testrun', 'slots.js')).href);
const { tryAgentSlot } = await import(pathToFileURL(join(dist, 'slots.js')).href);
const { updateDrain } = await import(pathToFileURL(join(dist, 'update-drain.js')).href);

// A test run in a process of its own: takes a slot through the engine's gate (cap recorded), holds it until told to end.
const holder = spawn(process.execPath, ['--input-type=module', '-e', `
  const { tryTestSlot } = await import(${JSON.stringify(pathToFileURL(join(dist, 'testrun', 'slots.js')).href)});
  const lock = tryTestSlot('ci test run', ${JSON.stringify(SLOTS)}, 30 * 60_000);
  if (!lock) { console.log('no slot'); process.exit(1); }
  console.log('holding ' + lock.path);
  process.stdin.on('data', () => { lock.release(); console.log('released'); process.exit(0); });
`], { stdio: ['pipe', 'pipe', 'inherit'] });
const said = (re) => new Promise((res, rej) => {
  let out = '';
  holder.stdout.on('data', (d) => ((out += d), re.test(out) && res(out)));
  holder.on('exit', () => (re.test(out) ? res(out) : rej(new Error(`the test run said: ${out}`))));
});
console.log((await said(/holding /)).trim());

const sha = (c) => c.repeat(40);
const OLD = sha('0');
const NEW = sha('a');
let current = OLD;
let skew = 0;
let stuck = { installed: OLD, since: new Date(Date.now() - 3 * 3600_000).toISOString(), tip: NEW, notQuietSince: new Date(Date.now() - 2 * 3600_000).toISOString(), raised: false };
const raised = [];
const deps = {
  ...u.realDeps(() => {}),
  config: () => ({ enabled: true, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'], drain_after_minutes: 60 }),
  installed: () => current,
  exec: (f, args) => (f === 'git' ? `${NEW}\trefs/heads/main\n` : f === 'systemctl' && args[0] === 'show' ? 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n' : f === 'systemctl' && args[0] === 'list-units' ? 'worklane-x.service loaded active running x\n' : ''),
  fetchJson: async (url) =>
    url.includes('/compare/')
      ? { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, commits: [{ sha: NEW, parents: [{ sha: OLD }], commit: { committer: { date: new Date(Date.now() - 600_000).toISOString() } } }] }
      : { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', started_at: '1', id: 1 }] },
  installTree: () => {},
  syncHelpers: () => [],
  switchTo: (s) => (current = s),
  now: () => Date.now() + skew,
  sleep: async (ms) => void (skew += ms),
  log: () => {},
  note: (event, s, reason) => (console.log(`${event} ${String(s).slice(0, 7)}: ${reason}`), event),
  held: () => null,
  hold: () => {},
  configChangedAt: () => 0,
  verdicts: () => null,
  saveVerdicts: () => {},
  stuckState: () => stuck,
  saveStuck: (s) => (stuck = s),
  raiseIncident: (kind, key, detail) => raised.push({ kind, detail }),
  resolveIncident: () => {},
  canaryState: () => null,
};
const asNobody = (cmd) => spawnSync('runuser', ['-u', 'nobody', '--', 'sh', '-c', cmd], { encoding: 'utf8' });
try {
  // Busy for two hours (past drain_after_minutes): the run drains.
  assert.equal(await u.run(deps), 'waiting');
  const st = statSync(FLAG);
  assert.deepEqual([st.uid, st.mode & 0o777], [0, 0o644], 'the flag is root-owned 0644');
  const flag = JSON.parse(readFileSync(FLAG, 'utf8'));
  console.log(`the flag: ${JSON.stringify(flag)}`);
  assert.equal(flag.to, NEW);
  assert.ok(updateDrain(SLOTS), "the engine's gate reads it from the system slot directory");
  assert.equal(tryTestSlot('a new test run', SLOTS), null, 'no new test run starts');
  assert.equal(tryAgentSlot('a new agent', SLOTS), null, 'no new agent starts');
  assert.match(raised.at(-1).detail, /draining for the update since .*1 test run finishing; the test runs are due by /);
  // Nobody but root can end it early.
  assert.notEqual(asNobody(`rm -f ${FLAG}`).status, 0);
  assert.notEqual(asNobody(`echo '{}' > ${FLAG}`).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(FLAG, 'utf8')), flag, 'the flag is unchanged');
  // The run in flight is not touched: it still holds its slot after another drained run.
  assert.equal(await u.run(deps), 'waiting');
  assert.equal(holder.exitCode, null, 'the test run is still going');
  // It ends by itself; the next run installs and reopens.
  const done = said(/released/);
  holder.stdin.write('end\n');
  await done;
  assert.equal(await u.run(deps), 'installed');
  assert.equal(current, NEW);
  assert.equal(existsSync(FLAG), false, 'reopened: the flag is gone');
  const again = tryTestSlot('a test run after the install', SLOTS);
  assert.ok(again, 'test runs start again');
  again.release();
  // A flag a crashed updater left, past its expiry, blocks nothing.
  writeFileSync(FLAG, JSON.stringify({ since: new Date(Date.now() - 3 * 3600_000).toISOString(), until: new Date(Date.now() - 60_000).toISOString(), to: NEW }), { mode: 0o644 });
  const late = tryTestSlot('a test run beside an expired flag', SLOTS);
  assert.ok(late, 'an expired flag is ignored');
  late.release();
  console.log('OK: drained a busy machine as root (root-owned flag, no new test run or agent, the run in flight untouched), installed once it ended, reopened; an expired flag blocks nothing');
} finally {
  holder.kill();
  rmSync(FLAG, { force: true });
  if (madeSlots) rmSync(SLOTS, { recursive: true, force: true });
  if (madeBase) rmSync(BASE, { recursive: true, force: true });
}
