import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { healthView } from '../src/health.js';
import { holdFlock } from '../src/os/index.js';
import { cacheKey } from '../src/testrun/cache.js';
import { checksFor, checksPermission, ChecksPermissionMissing, postChecks } from '../src/testrun/checks.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { localHost, type RunHost } from '../src/testrun/host.js';
import { checkNamesFor } from '../src/testrun/index.js';
import { mergeShards, runTestRun, tierCommand, tiersFor, type TestRunDeps, type TestRunResult } from '../src/testrun/run.js';
import { recommendTestSlots, testSlotCap } from '../src/testrun/slots.js';
import { testRunStatus, viewerTestRuns } from '../src/testrun/status.js';
import { fullRunAllowed, PrTestRuns, type OpenPr } from '../src/coordinator/test-runs.js';
import { exampleProject } from './helpers.js';

const posix = process.platform !== 'win32';
const hasPerl = posix && (() => {
  try {
    execFileSync('perl', ['-e', '1']);
    return true;
  } catch {
    return false;
  }
})();
const pin = 'postgres:16@sha256:' + 'a'.repeat(64);

/** A stand-in docker: names, a port the daemon picks, labels, rm. */
function fakeDocker(dir: string): string {
  const js = join(dir, 'docker.cjs');
  writeFileSync(
    js,
    `const fs = require('fs'), path = require('path');
const f = path.join(process.env.HOME, 'state.json'); fs.mkdirSync(process.env.HOME, { recursive: true });
const lock = f + '.lock';
for (;;) { try { fs.mkdirSync(lock); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } }
process.on('exit', () => fs.rmdirSync(lock));
const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { containers: {}, next: 42000 };
const a = process.argv.slice(2); const flag = (n) => { const i = a.indexOf(n); return i < 0 ? null : a[i + 1]; };
const save = () => fs.writeFileSync(f, JSON.stringify(s));
if (a[0] === 'run') { s.containers[flag('--name')] = { label: flag('--label'), port: s.next++ }; save(); }
else if (a[0] === 'port') console.log('127.0.0.1:' + s.containers[a[1]].port);
else if (a[0] === 'ps') console.log(Object.keys(s.containers).filter((n) => s.containers[n].label === flag('--filter').replace(/^label=/, '')).join('\\n'));
else if (a[0] === 'rm') { for (const n of a.slice(1)) delete s.containers[n]; save(); }
`,
  );
  const bin = join(dir, 'docker');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function rig(testRun: unknown, o: { cap?: number } = {}) {
  const p = exampleProject();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.dir, encoding: 'utf8' }).trim();
  const base = mkdtempSync(join(tmpdir(), 'tr-runs-'));
  const slots = join(base, 'slots');
  mkdirSync(slots);
  writeFileSync(join(slots, 'config.json'), JSON.stringify({ max_agents: 2, max_test_runs: o.cap ?? 2 }));
  const lockPath = join(base, 'full-run.lock');
  writeFileSync(lockPath, '');
  const log = new EventLog(join(base, 'events.db'));
  const host = localHost(join(base, 'host'), { docker: fakeDocker(base) });
  const deps: TestRunDeps = { config: TestRunConfig.parse(testRun), host, repo: p.dir, log, actor: 'test', logDir: join(base, 'logs'), lockPath, slotsDir: slots, slotPollMs: 50 };
  const events = <T extends Parameters<EventLog['read']>[1] extends (infer U)[] | undefined ? U : never>(t: T) => log.read(0, [t]).map((e) => ({ ...e, payload: e.payload as EventPayload<T> }));
  return { ...p, sha, base, slots, lockPath, log, host, deps, events };
}

test('a fast run: its tiers in a fresh workspace with its own database, every step recorded, and wiped after', { skip: !hasPerl && 'perl for the flock holder' }, async () => {
  const r = rig({
    setup: ['echo setup > setup-ran'],
    tiers: [
      { name: 'chain', command: 'test -f setup-ran && test -f .worklane/config.yaml && echo chain ok', kind: 'fast' },
      { name: 'db', command: 'case "$DATABASE_URL" in postgres://postgres:*@127.0.0.1:*/test) echo db ok ;; *) exit 1 ;; esac', kind: 'fast', database: true },
      { name: 'plan', command: 'cat {changed_files}; grep -qx src/a.ts {changed_files}', kind: 'fast' },
      { name: 'suite', command: 'exit 1 # {shard_index} {shard_total}', kind: 'full', shardable: true },
    ],
    database: { image: pin },
  });
  const res = await runTestRun(r.deps, { repo: r.dir, sha: r.sha, kind: 'fast', prs: [7], changedFiles: ['src/a.ts'] });
  assert.equal(res.ok, true, JSON.stringify(res.tiers));
  assert.deepEqual(res.tiers.map((t) => [t.tier, t.ok]), [['chain', true], ['db', true], ['plan', true]], 'only the fast tiers');
  assert.match(readFileSync(join(r.base, 'logs', res.tiers[2]!.logRef), 'utf8'), /src\/a\.ts/);
  assert.equal(r.events('testrun.queued')[0]!.payload.prs[0], 7);
  assert.equal(r.events('testrun.started').length, 1);
  assert.deepEqual(r.events('testrun.finished')[0]!.payload.results, [{ tier: 'chain', ok: true }, { tier: 'db', ok: true }, { tier: 'plan', ok: true }]);
  assert.ok(!existsSync(join(r.base, 'host', 'runs', res.id)), 'wiped');
  assert.deepEqual(JSON.parse(readFileSync(join(r.base, 'host', 'docker-home', 'state.json'), 'utf8')).containers, {}, 'its database is gone');
  assert.equal(r.events('testrun.wipe_failed').length, 0);
});

test('each tier records its per-test durations from its output (names and times only), and 0 when its runner prints none', { skip: !hasPerl && 'perl' }, async () => {
  const tap = ['# Subtest: db', '    # Subtest: migrates', '    ok 1 - migrates', '      ---', '      duration_ms: 4500.25', '      ...', 'ok 1 - db', '  ---', '  duration_ms: 4600', '  ...'].join('\n');
  const r = rig({
    tiers: [
      { name: 'node', command: `cat <<'EOF'\n${tap}\nEOF`, kind: 'fast' },
      { name: 'plain', command: 'echo all good', kind: 'fast' },
    ],
  });
  const res = await runTestRun(r.deps, { repo: r.dir, sha: r.sha, kind: 'fast', prs: [] });
  assert.equal(res.ok, true, JSON.stringify(res.tiers));
  assert.deepEqual(
    r.events('testrun.durations').map((e) => e.payload),
    [
      { id: res.id, tier: 'node', tests: [{ name: 'db > migrates', ms: 4500.3 }], parsed: 1 },
      { id: res.id, tier: 'plain', tests: [], parsed: 0 },
    ],
  );
});

test('a failing setup fails every tier, and a tier that needs the change\'s files fails when given none', { skip: !hasPerl && 'perl' }, async () => {
  const r = rig({ setup: ['exit 3'], tiers: [{ name: 'a', command: 'true', kind: 'fast' }, { name: 'b', command: 'true', kind: 'fast' }] });
  const res = await runTestRun(r.deps, { repo: r.dir, sha: r.sha, kind: 'fast', prs: [] });
  assert.equal(res.ok, false);
  assert.deepEqual(res.tiers.map((t) => [t.tier, t.ok]), [['a', false], ['b', false]]);
  assert.match(res.tiers[0]!.summary, /setup step 1 \(exit 3\) failed/);
  const r2 = rig({ tiers: [{ name: 'plan', command: 'node plan.js {changed_files}', kind: 'fast' }] });
  const res2 = await runTestRun(r2.deps, { repo: r2.dir, sha: r2.sha, kind: 'fast', prs: [1] });
  assert.equal(res2.ok, false);
  assert.match(res2.tiers[0]!.summary, /given none/);
  // No tiers of the kind is never a pass.
  const res3 = await runTestRun(r2.deps, { repo: r2.dir, sha: r2.sha, kind: 'full', prs: [1] });
  assert.equal(res3.ok, false);
});

test('isolation: a run waits for an exclusive holder of the full-run lock, then takes it shared and proceeds', { skip: !hasPerl && 'perl for the flock holder' }, async () => {
  const r = rig({ tiers: [{ name: 'a', command: 'echo ran', kind: 'fast' }] });
  // An agent's full run holds the lock exclusively for 1.5 s.
  const agent = await holdFlock(r.lockPath, 'exclusive');
  const t0 = Date.now();
  setTimeout(() => void agent.release(), 1500);
  const res = await runTestRun(r.deps, { repo: r.dir, sha: r.sha, kind: 'fast', prs: [1] });
  assert.equal(res.ok, true, JSON.stringify(res.tiers));
  const started = r.events('testrun.started')[0]!;
  assert.ok(Date.parse(started.ts) - t0 >= 1300, 'it started only after the exclusive holder let go');
  assert.ok(started.payload.lock_wait_ms >= 1000, `recorded the wait (${started.payload.lock_wait_ms} ms)`);
  // Shared: two test runs hold it at once, and an exclusive taker waits for both.
  const a = await holdFlock(r.lockPath, 'shared');
  const b = await holdFlock(r.lockPath, 'shared');
  let exclusive = false;
  const x = holdFlock(r.lockPath, 'exclusive').then((h) => ((exclusive = true), h));
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(exclusive, false);
  await a.release();
  await b.release();
  await (await x).release();
  assert.equal(exclusive, true);
  // A missing lock file is never "unlocked": the run doesn't go ahead.
  const missing = await runTestRun({ ...r.deps, lockPath: join(r.base, 'nope.lock') }, { repo: r.dir, sha: r.sha, kind: 'fast', prs: [1] });
  assert.equal(missing.ok, false);
  assert.match(missing.tiers[0]!.summary, /lock file .* is missing/);
});

test('the slot pool: no more runs at once than the machine\'s test-run cap; the rest wait their turn', { skip: !hasPerl && 'perl' }, async () => {
  const r = rig({ tiers: [{ name: 'a', command: `node -e "require('fs').appendFileSync(process.argv[1], 'start ' + Date.now() + '\\n'); setTimeout(() => require('fs').appendFileSync(process.argv[1], 'end ' + Date.now() + '\\n'), 600)" "$MARK"`, kind: 'fast' }], env: { MARK: '' } }, { cap: 2 });
  const mark = join(r.base, 'marks');
  r.deps.config.env.MARK = mark;
  assert.equal(testSlotCap(r.slots), 2);
  const results = await Promise.all([1, 2, 3, 4].map((n) => runTestRun(r.deps, { repo: r.dir, sha: r.sha, kind: 'fast', prs: [n] })));
  assert.ok(results.every((x) => x.ok), JSON.stringify(results.map((x) => x.tiers)));
  let live = 0;
  let peak = 0;
  const marks = readFileSync(mark, 'utf8').trim().split('\n').map((l) => l.split(' ')).map(([k, t]) => ({ k, t: Number(t) })).sort((a, b) => a.t - b.t || (a.k === 'end' ? -1 : 1));
  for (const m of marks) peak = Math.max(peak, (live += m.k === 'start' ? 1 : -1));
  assert.equal(peak, 2);
});

test('a superseded run is cancelled: it stops waiting or running, is wiped, and records cancelled', { skip: !hasPerl && 'perl' }, async () => {
  const r = rig({ tiers: [{ name: 'slow', command: 'sleep 30', kind: 'fast' }] });
  const c = new AbortController();
  const p = runTestRun(r.deps, { repo: r.dir, sha: r.sha, kind: 'fast', prs: [5] }, { signal: c.signal });
  await new Promise((res) => setTimeout(res, 1200));
  c.abort();
  const res = await p;
  assert.equal(res.ok, false);
  assert.equal(r.events('testrun.finished')[0]!.payload.outcome, 'cancelled');
  assert.ok(!existsSync(join(r.base, 'host', 'runs', res.id)), 'wiped');
  // Cancelled while still queued: never started, nothing to wipe.
  const held = await holdFlock(r.lockPath, 'exclusive');
  const c2 = new AbortController();
  const p2 = runTestRun(r.deps, { repo: r.dir, sha: r.sha, kind: 'fast', prs: [6] }, { signal: c2.signal });
  setTimeout(() => c2.abort(), 300);
  assert.equal((await p2).ok, false);
  await held.release();
  assert.equal(r.events('testrun.finished').at(-1)!.payload.outcome, 'cancelled');
});

test('sharding: shardable full tiers split by 1-based shard, the rest run once, and the shards merge into one result', () => {
  const c = TestRunConfig.parse({
    tiers: [
      { name: 'chain', command: 'npm run chain', kind: 'fast' },
      { name: 'suite', command: 'npm test -- --shard={shard_index}/{shard_total}', kind: 'full', shardable: true },
      { name: 'timing', command: 'npm test -- --timing {shard}/{total}', kind: 'full', shardable: true },
      { name: 'chain-full', command: 'npm run chain', kind: 'full' },
    ],
  });
  assert.deepEqual(tiersFor(c, { kind: 'full', shard: { index: 1, total: 3 } }).map((t) => t.name), ['suite', 'timing', 'chain-full']);
  assert.deepEqual(tiersFor(c, { kind: 'full', shard: { index: 2, total: 3 } }).map((t) => t.name), ['suite', 'timing']);
  assert.deepEqual(tiersFor(c, { kind: 'fast' }).map((t) => t.name), ['chain']);
  assert.equal(tierCommand(c.tiers[1]!, { index: 2, total: 3 }, null), 'npm test -- --shard=2/3');
  assert.equal(tierCommand(c.tiers[2]!, { index: 3, total: 3 }, null), 'npm test -- --timing 3/3');
  assert.equal(tierCommand({ ...c.tiers[0]!, command: "plan {changed_files}" }, { index: 1, total: 1 }, "/r/it's"), `plan '/r/it'\\''s'`);
  const shard = (id: string, ok: boolean[]): TestRunResult => ({ id, sha: 'a'.repeat(40), kind: 'full', ok: ok.every(Boolean), outcome: 'done', tiers: ok.map((x, i) => ({ tier: ['suite', 'timing'][i]!, ok: x, durationMs: 1000 * (i + 1), summary: x ? 'ok' : 'boom', logRef: `${id}/t${i}` })) });
  const m = mergeShards([shard('s1', [true, true]), shard('s2', [false, true])]);
  assert.equal(m.ok, false);
  assert.deepEqual(m.tiers.map((t) => [t.tier, t.ok]), [['suite', false], ['timing', true]]);
  assert.equal(m.tiers[0]!.summary, 'boom');
  assert.throws(() => mergeShards([]), /no shards/);
});

test('caches are keyed by the lockfile: the same lockfile gets the same directory across runs, a changed one a new one', { skip: !hasPerl && 'perl' }, async () => {
  const r = rig({ tiers: [{ name: 'a', command: 'echo "$npm_config_cache" > /dev/null; test -d "$npm_config_cache" && touch "$npm_config_cache/seen-$RANDOM"', kind: 'fast' }], caches: [{ name: 'npm', env: 'npm_config_cache', key: ['package-lock.json'] }] });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: r.dir, encoding: 'utf8' }).trim();
  writeFileSync(join(r.dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  git('add', 'package-lock.json');
  git('commit', '-qm', 'lock');
  const one = git('rev-parse', 'HEAD');
  writeFileSync(join(r.dir, 'README.md'), 'changed, lockfile not\n');
  git('add', 'README.md');
  git('commit', '-qm', 'readme');
  const two = git('rev-parse', 'HEAD');
  writeFileSync(join(r.dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
  git('add', 'package-lock.json');
  git('commit', '-qm', 'lock 2');
  const three = git('rev-parse', 'HEAD');
  assert.equal(cacheKey(r.dir, one, ['package-lock.json']), cacheKey(r.dir, two, ['package-lock.json']));
  assert.notEqual(cacheKey(r.dir, two, ['package-lock.json']), cacheKey(r.dir, three, ['package-lock.json']));
  assert.notEqual(cacheKey(r.dir, r.sha, ['package-lock.json']), cacheKey(r.dir, one, ['package-lock.json']), 'no lockfile is a key of its own');
  for (const sha of [one, two, three]) assert.equal((await runTestRun(r.deps, { repo: r.dir, sha, kind: 'fast', prs: [] })).ok, true);
  const dirs = execFileSync('ls', [join(r.base, 'host', 'cache')], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(dirs.length, 2, 'two keys');
  const first = join(r.base, 'host', 'cache', `npm-${cacheKey(r.dir, one, ['package-lock.json'])}`);
  assert.equal(execFileSync('ls', [first], { encoding: 'utf8' }).trim().split('\n').length, 2, 'the first two runs shared it, and the wipe kept it');
});

function fakeGitHub(status = 201, body: unknown = { id: 1 }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

test('checks are posted per tier with the right conclusion; tiers sharing a check pass only together; no log in them', async () => {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'tr-checks-')), 'events.db'));
  const gh = fakeGitHub();
  const sha = 'b'.repeat(40);
  const result: TestRunResult = {
    id: 'fast-bbbb-1',
    sha,
    kind: 'full',
    ok: false,
    outcome: 'done',
    tiers: [
      { tier: 'isolated-db', ok: true, durationMs: 61_000, summary: 'secret log line', logRef: 'x' },
      { tier: 'timing', ok: false, durationMs: 5000, summary: 'secret log line', logRef: 'y' },
      { tier: 'ledger', ok: true, durationMs: 2000, summary: 'secret log line', logRef: 'z' },
    ],
  };
  const names = { 'isolated-db': 'suite', timing: 'suite', ledger: 'ledger' };
  await postChecks({ repo: 'example-org/example-shop', token: async () => 'tok', log, actor: 'test', fetch: gh.f, api: 'https://gh.test' }, sha, result, names);
  assert.deepEqual(gh.calls.map((c) => [c.url, c.body.name, c.body.head_sha, c.body.status, c.body.conclusion]), [
    ['https://gh.test/repos/example-org/example-shop/check-runs', 'suite', sha, 'completed', 'failure'],
    ['https://gh.test/repos/example-org/example-shop/check-runs', 'ledger', sha, 'completed', 'success'],
  ]);
  assert.doesNotMatch(JSON.stringify(gh.calls), /secret log line/, 'a check never carries a log');
  assert.match(String((gh.calls[0]!.body.output as { summary: string }).summary), /failed: timing/);
  assert.deepEqual((log.read(0, ['testrun.checks_posted'])[0]!.payload as EventPayload<'testrun.checks_posted'>).checks, [{ name: 'suite', conclusion: 'failure' }, { name: 'ledger', conclusion: 'success' }]);
  // A tier with no ok tiers can't pass, and an unmapped tier posts test-run/<tier>.
  assert.deepEqual(checksFor({ ...result, tiers: [{ ...result.tiers[2]!, ok: false }] }, {}).map((c) => [c.name, c.conclusion]), [['test-run/ledger', 'failure']]);
  assert.deepEqual(checkNamesFor(TestRunConfig.parse({ tiers: [{ name: 'a', command: 'x', kind: 'fast' }], checks: { a: 'A' } })), { a: 'A' });
  await assert.rejects(postChecks({ repo: 'o/r', token: async () => 't', log, actor: 'test', fetch: gh.f }, 'abc1234', result, names), /full commit/);
});

test('a missing Checks: write permission is detected and said plainly in health; nothing pretends the checks were posted', async () => {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'tr-checks-')), 'events.db'));
  const gh = fakeGitHub(403, { message: 'Resource not accessible by integration' });
  const result: TestRunResult = { id: 'fast-cccc-1', sha: 'c'.repeat(40), kind: 'fast', ok: true, outcome: 'done', tiers: [{ tier: 'chain', ok: true, durationMs: 1, summary: '', logRef: '' }] };
  await assert.rejects(postChecks({ repo: 'o/r', token: async () => 't', log, actor: 'test', fetch: gh.f }, result.sha, result, {}), ChecksPermissionMissing);
  assert.equal((log.read(0, ['testrun.checks_failed'])[0]!.payload as EventPayload<'testrun.checks_failed'>).reason, 'no_permission');
  assert.equal(log.read(0, ['testrun.checks_posted']).length, 0);
  const view = healthView(log.read(0), null, { updates: [] });
  assert.match(view.suggestions[0]!, /^Test runs can't post their checks: the App has no Checks: write permission/);
  assert.match(view.suggestions[0]!, /The owner adds Checks: read & write/);
  // The App's permission read up front: read-only is said too, before any post fails.
  const keyDir = mkdtempSync(join(tmpdir(), 'tr-key-'));
  const { generateKeyPairSync } = await import('node:crypto');
  writeFileSync(join(keyDir, 'k.pem'), generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const perm = fakeGitHub(200, { permissions: { checks: 'read', pull_requests: 'write' } });
  const p = await checksPermission({ appId: 1, installationId: 2, keyPath: join(keyDir, 'k.pem') }, { fetch: perm.f, api: 'https://gh.test' });
  assert.equal(perm.calls[0]!.url, 'https://gh.test/app/installations/2');
  assert.equal(p.level, 'read');
  const log2 = new EventLog(join(mkdtempSync(join(tmpdir(), 'tr-checks-')), 'events.db'));
  log2.append('testrun.checks_permission', p, 'test');
  assert.match(testRunStatus(log2.read(0)).problems[0]!, /no Checks: write permission \(it has read\)/);
  log2.append('testrun.checks_permission', { level: 'write', detail: '' }, 'test');
  assert.deepEqual(testRunStatus(log2.read(0)).problems, []);
  // A sandbox that failed its check is said too: no test runs start.
  log2.append('testrun.sandbox', { ok: false, detail: 'FAIL wl-test-shop can reach /srv/worklane (open)' }, 'test');
  assert.match(testRunStatus(log2.read(0)).problems[0]!, /^Test runs are off: the sandbox failed its check \(FAIL wl-test-shop can reach/);
});

/** A PrTestRuns with stand-ins for GitHub and the runs. */
function prRig(log = new EventLog(join(mkdtempSync(join(tmpdir(), 'tr-prs-')), 'events.db'))) {
  let prs: OpenPr[] = [];
  let now = 0;
  const started: { pr: number; sha: string; signal: AbortSignal; resolve: (r: TestRunResult) => void }[] = [];
  const posted: [string, boolean][] = [];
  const wiped: string[] = [];
  const host = { wipe: async (id: string) => (wiped.push(id), { ok: true, left: [] }) } as unknown as RunHost;
  const runs = new PrTestRuns({
    log,
    actor: 'test',
    repo: '/r',
    remote: 'origin',
    host,
    listPrs: async () => prs,
    fetchPr: (pr) => pr.headSha,
    changed: () => ['a.ts'],
    now: () => now,
    pollMs: 1000,
    start: (req, o) =>
      new Promise((resolve) => {
        started.push({ pr: req.prs[0]!, sha: req.sha, signal: o.signal, resolve });
        o.signal.addEventListener('abort', () => resolve({ id: 'x', sha: req.sha, kind: 'fast', ok: false, tiers: [], outcome: 'cancelled' }));
      }),
    post: async (sha, r) => void posted.push([sha, r.ok]),
  });
  const pr = (number: number, headSha: string, o: Partial<OpenPr> = {}): OpenPr => ({ number, headSha, base: 'main', author: 'someone', bot: false, ...o });
  return { log, runs, started, posted, wiped, pr, setPrs: (p: OpenPr[]) => (prs = p), advance: (ms: number) => (now += ms) };
}

test('the tick runs the fast tier on every open PR (the harness\'s, the owner\'s, a bot\'s), re-runs a new head and cancels the superseded run', async () => {
  const r = prRig();
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  r.setPrs([r.pr(1, a, { author: 'example-app[bot]', bot: true }), r.pr(2, b, { author: 'example-owner' }), r.pr(3, 'c'.repeat(40), { author: 'dependabot[bot]', bot: true })]);
  r.advance(5000);
  assert.deepEqual((await r.runs.tick()).started, [1, 2, 3]);
  assert.deepEqual((await r.runs.tick()).started, [], 'polled at most every pollMs');
  // PR 2 gets a new head: the old run is cancelled, a new one starts; PR 3 closes: its run is cancelled.
  const b2 = 'd'.repeat(40);
  r.setPrs([r.pr(1, a, { bot: true }), r.pr(2, b2)]);
  r.advance(5000);
  const t = await r.runs.tick();
  assert.deepEqual(t.cancelled.sort(), [2, 3]);
  assert.deepEqual(t.started, [2]);
  assert.equal(r.started.find((s) => s.sha === b)!.signal.aborted, true);
  assert.equal(r.started.find((s) => s.sha === b2)!.signal.aborted, false);
  for (const s of r.started.filter((x) => !x.signal.aborted)) s.resolve({ id: 'r', sha: s.sha, kind: 'fast', ok: true, tiers: [], outcome: 'done' });
  await r.runs.idle();
  assert.deepEqual(r.posted.sort(), [[a, true], [b2, true]], 'checks only on heads that are still the PR\'s');
  // A finished head isn't run again.
  r.advance(5000);
  assert.deepEqual((await r.runs.tick()).started, []);
  // Bots get the fast tier; the full tier (a batch) waits for the owner's approval.
  assert.equal(fullRunAllowed({ bot: true }, false), false);
  assert.equal(fullRunAllowed({ bot: true }, true), true);
  assert.equal(fullRunAllowed({ bot: false }, false), true);
});

test('after a restart: a finished head is not run again, an interrupted run is wiped and recorded, and runs again', async () => {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'tr-prs-')), 'events.db'));
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  log.append('testrun.queued', { id: 'fast-a-1', sha: a, kind: 'fast', prs: [1], shard: null }, 'test');
  log.append('testrun.started', { id: 'fast-a-1', slot: 'test-0', lock_wait_ms: 0 }, 'test');
  log.append('testrun.finished', { id: 'fast-a-1', sha: a, kind: 'fast', prs: [1], ok: true, outcome: 'done', results: [], detail: '' }, 'test');
  log.append('testrun.queued', { id: 'fast-b-1', sha: b, kind: 'fast', prs: [2], shard: null }, 'test');
  log.append('testrun.started', { id: 'fast-b-1', slot: 'test-1', lock_wait_ms: 0 }, 'test');
  const r = prRig(log);
  assert.deepEqual(await r.runs.recover(), ['fast-b-1']);
  assert.deepEqual(r.wiped, ['fast-b-1']);
  assert.equal((log.read(0, ['testrun.finished']).at(-1)!.payload as EventPayload<'testrun.finished'>).outcome, 'interrupted');
  r.setPrs([r.pr(1, a), r.pr(2, b)]);
  r.advance(5000);
  assert.deepEqual((await r.runs.tick()).started, [2]);
  r.runs.stop();
  await r.runs.idle();
});

test('the dashboard\'s view of the test runs: queue, running, recent; a viewer sees tier pass or fail only', () => {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'tr-status-')), 'events.db'));
  const a = 'a'.repeat(40);
  log.append('testrun.queued', { id: 'q', sha: a, kind: 'fast', prs: [1], shard: null }, 'test');
  log.append('testrun.queued', { id: 'r', sha: a, kind: 'full', prs: [1, 2], shard: { index: 1, total: 2 } }, 'test');
  log.append('testrun.started', { id: 'r', slot: 'test-0', lock_wait_ms: 12 }, 'test');
  log.append('testrun.tier', { id: 'r', tier: 'suite', ok: false, duration_ms: 1000, summary: 'AssertionError at secret path', log_ref: 'r/suite.log', cpu_s: 3.5, mem_peak_mb: 800 }, 'test');
  log.append('testrun.queued', { id: 'd', sha: a, kind: 'fast', prs: [3], shard: null }, 'test');
  log.append('testrun.started', { id: 'd', slot: 'test-1', lock_wait_ms: 0 }, 'test');
  log.append('testrun.finished', { id: 'd', sha: a, kind: 'fast', prs: [3], ok: false, outcome: 'done', results: [{ tier: 'chain', ok: false }], detail: '' }, 'test');
  const s = testRunStatus(log.read(0));
  assert.deepEqual([s.queue.map((x) => x.id), s.running.map((x) => x.id), s.recent.map((x) => [x.id, x.state])], [['q'], ['r'], [['d', 'failed']]]);
  assert.deepEqual(s.tierStats, [{ tier: 'suite', runs: 1, medianMs: 1000, peakMemMb: 800, maxCpuS: 3.5 }]);
  const v = viewerTestRuns(s);
  assert.deepEqual(v.running[0], { id: 'r', sha: a, kind: 'full', prs: [1, 2], state: 'running', tiers: [{ tier: 'suite', ok: false }] });
  assert.doesNotMatch(JSON.stringify(v), /secret|suite\.log|test-0/);
});

test('the recommended test-run slot count for the machine: cores after the agents, memory after the instances\' caps', () => {
  // 24 cores and 30 GB; instance caps 8G, 6G and 6G; 6 agent slots of ~2 cores; a run takes 4 cores and 2.5 GB.
  const r = recommendTestSlots({ cores: 24, memGb: 30, instanceCapsGb: [8, 6, 6], agentSlots: 6, perRun: { cores: 4, memGb: 2.5 } });
  assert.deepEqual(r, { slots: 2, byCpu: 2, byMemory: 3, freeCores: 10, freeMemGb: 8 });
  assert.equal(recommendTestSlots({ cores: 8, memGb: 8, instanceCapsGb: [8], agentSlots: 4, perRun: { cores: 4, memGb: 2 } }).slots, 1, 'never below one');
  assert.equal(testSlotCap(mkdtempSync(join(tmpdir(), 'tr-noslots-'))), 2, 'without a setting: the default');
});

test('the result says how the run ended: a cancel during the last tier is cancelled, a tier that really failed is done and not ok', { skip: !hasPerl && 'perl' }, async () => {
  const r = rig({ tiers: [{ name: 'first', command: 'true', kind: 'fast' }, { name: 'last', command: 'sleep 30', kind: 'fast', timeout_s: 30 }] });
  const c = new AbortController();
  const p = runTestRun(r.deps, { repo: r.dir, sha: r.sha, kind: 'fast', prs: [1] }, { signal: c.signal });
  for (let i = 0; i < 100 && !r.events('testrun.tier').length; i++) await new Promise((res) => setTimeout(res, 100));
  await new Promise((res) => setTimeout(res, 300));
  c.abort();
  const cancelled = await p;
  assert.equal(cancelled.outcome, 'cancelled', 'cancelled while its last tier ran');
  assert.equal(cancelled.ok, false);
  assert.deepEqual(cancelled.tiers.map((t) => [t.tier, t.ok]), [['first', true], ['last', false]], 'the same tiers a timeout would show: only outcome tells them apart');
  assert.equal(r.events('testrun.finished').at(-1)!.payload.outcome, cancelled.outcome, 'the same value testrun.finished records');
  const r2 = rig({ tiers: [{ name: 'first', command: 'true', kind: 'fast' }, { name: 'last', command: 'exit 1', kind: 'fast' }] });
  const failed = await runTestRun(r2.deps, { repo: r2.dir, sha: r2.sha, kind: 'fast', prs: [1] });
  assert.deepEqual([failed.outcome, failed.ok], ['done', false], 'a real failure is a verdict');
  const missing = await runTestRun({ ...r2.deps, lockPath: join(r2.base, 'nope.lock') }, { repo: r2.dir, sha: r2.sha, kind: 'fast', prs: [1] });
  assert.equal(missing.outcome, 'error', 'a run that could not go ahead is no verdict');
  const shard = (o: TestRunResult['outcome']): TestRunResult => ({ id: o, sha: r.sha, kind: 'full', ok: o === 'done', tiers: [], outcome: o });
  assert.equal(mergeShards([shard('done'), shard('cancelled')]).outcome, 'cancelled', 'one shard without a verdict: the run has none');
  assert.equal(mergeShards([shard('done'), shard('done')]).outcome, 'done');
});
