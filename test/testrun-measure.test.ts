import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BRAND } from '../src/brand.js';
import { EventLog } from '../src/events/log.js';
import { initInstance } from '../src/instance.js';
import { holdFlock } from '../src/os/index.js';
import { unfinishedRuns } from '../src/coordinator/test-runs.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { localHost, type RunHost } from '../src/testrun/host.js';
import { busyReason, engineSetKeys, MeasureRefused, measureLine, planMeasure, runMeasure, suiteDurations, unfinishedMeasureRuns } from '../src/testrun/measure.js';
import { measureCommand, parseMeasureArgs } from '../src/testrun/measure-cli.js';
import { runTestRun } from '../src/testrun/run.js';
import { tryTestSlot } from '../src/testrun/slots.js';
import { testRunStatus } from '../src/testrun/status.js';
import { agentIsSelf, exampleProject, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const hasPerl = posix && (() => {
  try {
    execFileSync('perl', ['-e', '1']);
    return true;
  } catch {
    return false;
  }
})();

// INVARIANT: no measure may reach GitHub: every fetch in this file is counted, and each test asserts none was made.
let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  fetches++;
  throw new Error('a measure made a network call');
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const TEST_RUN = {
  tiers: [
    { name: 'lanes', command: 'echo "lanes=$LANES"', kind: 'fast' },
    { name: 'plan', command: 'cat {changed_files}', kind: 'fast' },
    { name: 'slow', command: 'true', kind: 'full' },
  ],
  caches: [{ name: 'npm', env: 'npm_config_cache', key: ['package.json'] }],
  shared: [{ name: 'ports', env: 'PORTS_DIR' }],
  env: { LANES: '1', PGSSLMODE: 'disable' },
};

/** A host that records every call and does nothing: a refusal must leave `calls` empty. */
function recordingHost(): RunHost & { calls: string[] } {
  const calls: string[] = [];
  const no = (m: string) => async () => {
    calls.push(m);
    throw new Error(`${m} called`);
  };
  return { kind: 'sandbox', calls, create: no('create'), storeTips: no('storeTips'), changedFiles: no('changedFiles'), cache: no('cache'), shared: no('shared'), startDb: no('startDb'), fetch: no('fetch'), exec: no('exec'), check: no('check'), wipe: no('wipe'), helperVersion: no('helperVersion') } as RunHost & { calls: string[] };
}

const refusedSets: Array<[string[], RegExp]> = [
  [['NOPE=1'], /NOPE: not a key of tests\.yaml test_run env \(its keys: LANES, PGSSLMODE\)/],
  [['lanes=1'], /lanes: not a key/],
  [['Lanes=1'], /Lanes: not a key/],
  [[' LANES=1'], /" LANES" is not a variable name/],
  [['LANES =1'], /"LANES " is not a variable name/],
  [['LΑNES=1'], /is not a variable name/], // a Greek capital alpha
  [['LANES​=1'], /is not a variable name/], // a zero-width space
  [['LANES='], /"" is not a value/],
  [['LANES=1,,2'], /"" is not a value/],
  [['LANES=1,'], /"" is not a value/],
  [['LANES=1=2'], /"1=2" is not a value/],
  [['LANES=1,DATABASE_URL=postgres://x'], /"DATABASE_URL=postgres:\/\/x" is not a value/],
  [['LANES=1 2'], /"1 2" is not a value/],
  [['LANES=$(id)'], /is not a value/],
  [['LANES'], /KEY=V1,V2/],
  [[`LANES=${Array.from({ length: 13 }, (_, i) => i + 1).join(',')}`], /at most 12 values/],
  [['DATABASE_URL=postgres://elsewhere'], /DATABASE_URL: set by the engine/],
  [['database_url=x'], /database_url: set by the engine/],
  [['npm_config_cache=/tmp/x'], /npm_config_cache: set by the engine/],
  [['NPM_CONFIG_CACHE=x'], /NPM_CONFIG_CACHE: set by the engine/],
  [['PORTS_DIR=/x'], /PORTS_DIR: set by the engine/],
  [['PATH=/x'], /PATH: set by the engine/],
  [['HOME=/x'], /HOME: set by the engine/],
  [['CI=0'], /CI: set by the engine/],
  [['TMPDIR=/x'], /TMPDIR: set by the engine/],
  [['NODE_OPTIONS=--require=x'], /NODE_OPTIONS: set by the harness or the system/],
  [['LANES=1', 'PGSSLMODE=require'], /exactly one --set KEY=V1,V2,\.\.\. \(got 2\)/],
  [[], /exactly one --set .*\(got 0\)/],
];

test('--set: only a key tests.yaml test_run env already has, spelled exactly, never one the engine sets, with plain values', () => {
  const c = TestRunConfig.parse(TEST_RUN);
  const sha = 'a'.repeat(40);
  for (const [sets, why] of refusedSets) {
    assert.throws(() => planMeasure(c, { sha, tiers: ['lanes'], sets }), (e: unknown) => e instanceof MeasureRefused && why.test(e.message) && /nothing was started$/.test(e.message), `${JSON.stringify(sets)} must be refused with ${why}`);
  }
  assert.deepEqual(engineSetKeys(c).slice(0, 2), ['DATABASE_URL', 'CI']);
  assert.throws(() => planMeasure(c, { sha, tiers: ['plan'], sets: ['LANES=1'] }), /needs a change's files/);
  assert.throws(() => planMeasure(c, { sha, tiers: ['nope'], sets: ['LANES=1'] }), /not a tier of tests\.yaml test_run \(its tiers: lanes, plan, slow\)/);
  assert.throws(() => planMeasure(c, { sha: 'HEAD', tiers: ['lanes'], sets: ['LANES=1'] }), /not a commit id/);
  assert.deepEqual(planMeasure(c, { sha, tiers: ['lanes'], sets: ['LANES=1,2,4'] }), { sha, tiers: ['lanes'], key: 'LANES', values: ['1', '2', '4'], kind: 'fast' });
  assert.equal(planMeasure(c, { sha, tiers: ['lanes', 'slow'], sets: ['PGSSLMODE=require'] }).kind, 'full');
});

/** An instance of the example project with TEST_RUN in its tests.yaml, in a directory of its own. */
function instance() {
  const dir = mkdtempSync(join(tmpdir(), 'measure-inst-'));
  const { dir: repo } = exampleProject();
  const t = join(repo, BRAND.configDir, 'tests.yaml');
  appendFileSync(t, `test_run: ${JSON.stringify(TEST_RUN)}\n`);
  execFileSync('git', ['commit', '-q', '-am', 'test_run'], { cwd: repo });
  const home = initInstance('shop', repo, 'example-org/example-shop', dir);
  agentIsSelf(home);
  writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nland_mode: pr\n');
  return { dir, repo, home };
}

test('the command refuses a bad --set (every spelling above), a bad tier or argument, before any host exists: no helper call, no event log', async () => {
  const inst = instance();
  const key = `${BRAND.envPrefix}_INSTANCES_DIR`;
  const prev = process.env[key];
  process.env[key] = inst.dir;
  try {
    const cases: string[][] = [...refusedSets.map(([sets]) => ['--tier', 'lanes', ...sets.flatMap((s) => ['--set', s])]), ['--tier', 'plan', '--set', 'LANES=1'], ['--tier', 'lanes', '--set', 'LANES=1', '--force'], ['--tier', 'lanes', '--set', 'LANES=1', '--sha', 'f'.repeat(40)], ['--set', 'LANES=1']];
    for (const args of cases) {
      const hosts: RunHost[] = [];
      const errs: string[] = [];
      const code = await measureCommand('shop', 'measure', args, { out: () => assert.fail('nothing is printed but the refusal'), err: (l) => errs.push(l), host: () => (hosts.push(recordingHost()), hosts.at(-1)!) });
      assert.equal(code, 2, `${JSON.stringify(args)}: ${errs.join('\n')}`);
      assert.match(errs.join('\n'), /^refused: .*nothing was started$|^usage: /, JSON.stringify(args));
      assert.equal(hosts.length, 0, `${JSON.stringify(args)}: no host was made, so no helper was called`);
    }
    assert.ok(!existsSync(join(inst.home, 'state', 'events.db')), 'no event log was opened, nothing recorded');
    assert.ok(!existsSync(join(inst.home, 'state', 'test-runs-measure')), 'no run directory');
    // WHY: the refusal exactly as the owner sees it.
    const errs: string[] = [];
    await measureCommand('shop', 'measure', ['--tier', 'lanes', '--set', 'DATABASE_URL=postgres://x'], { err: (l) => errs.push(l) });
    assert.deepEqual(errs, ['refused: --set DATABASE_URL: set by the engine for every run, never by a measure; nothing was started']);
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  assert.equal(fetches, 0);
});

test('arguments are parsed strictly: an unknown flag, or one without its value, is a usage error', () => {
  assert.deepEqual(parseMeasureArgs(['--tier', 'a,b', '--set', 'K=1,2', '--json']), { sha: null, tiers: ['a', 'b'], sets: ['K=1,2'], json: true });
  assert.equal(parseMeasureArgs(['--tier', 'a', '--set']), null);
  assert.equal(parseMeasureArgs(['--tier', 'a', '--set=K=1']), null);
  assert.equal(parseMeasureArgs(['--sha', 'a', '--sha', 'b']), null);
});

function rig(testRun: unknown = TEST_RUN) {
  const p = exampleProject();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.dir, encoding: 'utf8' }).trim();
  const base = mkdtempSync(join(tmpdir(), 'measure-'));
  const slots = join(base, 'slots');
  mkdirSync(slots);
  writeFileSync(join(slots, 'config.json'), JSON.stringify({ max_agents: 2, max_test_runs: 2 }));
  const lockPath = join(base, 'full-run.lock');
  writeFileSync(lockPath, '');
  const log = new EventLog(join(base, 'events.db'));
  const config = TestRunConfig.parse(testRun);
  return { ...p, sha, base, slots, lockPath, log, config, deps: (host: RunHost) => ({ instance: 'shop', config, host, repo: p.dir, log, actor: 'measure-test', logDir: join(base, 'logs'), lockPath, slotsDir: slots, slotPollMs: 50 }) };
}

test('busy: refused while the instance has a test run queued or running, a test slot is held, or the full-run lock is held; nothing starts', { skip: !hasPerl && 'perl for the flock holder' }, async () => {
  const plan = (sha: string) => ({ sha, tiers: ['lanes'], key: 'LANES', values: ['1', '2'], kind: 'fast' as const });
  // WHY: a PR's run in flight on this instance (queued, never finished) is busy.
  const a = rig();
  a.log.append('testrun.queued', { id: 'fast-abc', sha: a.sha.slice(0, 10), kind: 'fast', prs: [3], shard: null }, 'c');
  const h1 = recordingHost();
  await assert.rejects(runMeasure(a.deps(h1), plan(a.sha)), (e: unknown) => e instanceof MeasureRefused && /the machine is busy: this instance has 1 test run\(s\) in flight \(fast-abc queued\)\. Run it when the box is idle; nothing was started/.test(e.message));
  assert.deepEqual(h1.calls, [], 'no helper call');
  assert.equal(a.log.read(0, ['testrun.measure']).length, 0, 'nothing recorded');
  // WHY: a test slot held on the machine (another instance's run) is busy.
  const b = rig();
  const slot = tryTestSlot('other test run fast-x', b.slots)!;
  const h2 = recordingHost();
  await assert.rejects(runMeasure(b.deps(h2), plan(b.sha)), /1 test slot\(s\) are held on this machine \(test-0: other test run fast-x\)/);
  assert.deepEqual(h2.calls, []);
  slot.release();
  // WHY: a full run holding the machine's lock is busy.
  const c = rig();
  const full = await holdFlock(c.lockPath, 'exclusive');
  try {
    const h3 = recordingHost();
    await assert.rejects(runMeasure(c.deps(h3), plan(c.sha)), /full-run\.lock is held/);
    assert.deepEqual(h3.calls, []);
    assert.match(busyReason([], { slotsDir: c.slots, lockPath: c.lockPath }) ?? '', /is held/);
  } finally {
    await full.release();
  }
  assert.equal(busyReason([], { slotsDir: c.slots, lockPath: c.lockPath }), null, 'quiet once it is released');
  // WHY: a missing lock file is refused: no run could take it either.
  assert.match(busyReason([], { slotsDir: c.slots, lockPath: join(c.base, 'missing.lock') }) ?? '', /missing.lock is missing: the machine's locks aren't set up/);
  assert.equal(fetches, 0);
});

/** A local host that sleeps in each exec and records how many execs overlap and each one's LANES. */
function trackingHost(base: string): RunHost & { seen: string[]; maxAtOnce: number } {
  const inner = localHost(join(base, 'host'));
  let now = 0;
  const t = {
    ...inner,
    kind: 'local' as const,
    seen: [] as string[],
    maxAtOnce: 0,
    async exec(id: string, command: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal) {
      now++;
      t.maxAtOnce = Math.max(t.maxAtOnce, now);
      t.seen.push(env.LANES ?? '');
      await new Promise((r) => setTimeout(r, 150));
      try {
        return await inner.exec(id, command, env, timeoutMs, signal);
      } finally {
        now--;
      }
    },
  };
  return t;
}

test('values run one at a time, in the order given, each a whole run with only that key changed; per-suite times are read from its log', { skip: !hasPerl && 'perl for the flock holder' }, async () => {
  const r = rig({ ...TEST_RUN, tiers: [{ name: 'lanes', command: 'printf "\\033[2m  ⏱ alpha suite: 1.5s\\033[0m ok\\n  ⏱ beta: 250ms\\n"; echo "lanes=$LANES pg=$PGSSLMODE"; test "$LANES" != 3', kind: 'fast' }] });
  const host = trackingHost(r.base);
  const lines: string[] = [];
  const out = await runMeasure({ ...r.deps(host), onValue: (v) => lines.push(measureLine(v)) }, planMeasure(r.config, { sha: r.sha, tiers: ['lanes'], sets: ['LANES=1,2,3'] }));
  assert.equal(out.stopped, null);
  assert.equal(host.maxAtOnce, 1, 'never two runs at once');
  assert.deepEqual(host.seen, ['1', '2', '3'], 'in the order given');
  assert.deepEqual(out.values.map((v) => [v.value, v.ok, v.tiers[0]!.status]), [['1', true, 'passed'], ['2', true, 'passed'], ['3', false, 'failed']]);
  assert.deepEqual(out.values[0]!.tiers[0]!.suites, [{ name: 'alpha suite', ms: 1500 }, { name: 'beta', ms: 250 }]);
  assert.equal(new Set(out.values.map((v) => v.runId)).size, 3, 'a run of its own each');
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^LANES=1 {2}wall \d+\.\ds {2}ok {2}lanes passed in \d+\.\ds \(cpu n\/a, mem n\/a\); suites: alpha suite 1\.5s, beta 0\.3s {2}\[run measure-[0-9a-f]{10}-[0-9a-f]{8}\]$/);
  assert.match(lines[2]!, /^LANES=3 .* FAILED {2}lanes failed in/);
  for (const v of out.values) assert.ok(!existsSync(join(r.base, 'host', 'runs', v.runId)), 'each run wiped');
  assert.match(readFileSync(join(r.base, 'logs', out.values[1]!.runId, 'lanes.log'), 'utf8'), /lanes=2 pg=disable/, 'only the key changed');
  assert.equal(fetches, 0);
});

test('no check, no PR: a measure records only testrun.measure, so the PR runs, the batcher and the test-run view never see it', { skip: !hasPerl && 'perl for the flock holder' }, async () => {
  const r = rig();
  const before = fetches;
  const out = await runMeasure(r.deps(localHost(join(r.base, 'host'))), planMeasure(r.config, { sha: r.sha, tiers: ['lanes'], sets: ['LANES=1,2'] }));
  assert.equal(out.values.length, 2);
  assert.equal(fetches, before, 'no network call at all, so no check posted and no PR touched');
  const all = r.log.read();
  assert.ok(all.length > 0);
  assert.deepEqual([...new Set(all.map((e) => e.type))], ['testrun.measure'], 'nothing but its own type');
  assert.deepEqual(all.map((e) => (e.payload as { phase: string }).phase), ['started', 'run_started', 'run_finished', 'run_started', 'run_finished', 'finished']);
  const st = testRunStatus(all);
  assert.deepEqual([st.queue, st.running, st.recent, st.tierStats], [[], [], [], []], "the dashboard's test-run view shows no run");
  assert.deepEqual(unfinishedRuns(all), [], "the coordinator's recover finds nothing to wipe or rerun");
  assert.deepEqual(unfinishedMeasureRuns(all), []);
  // INVARIANT: structurally, nothing measure.ts reaches can post a check or call GitHub.
  const reach = new Set<string>();
  const walk = (f: string) => {
    if (reach.has(f)) return;
    reach.add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(/^import [^'"]*['"](\.[^'"]+)['"]/gm)) walk(resolve(dirname(f), m[1]!.replace(/\.js$/, '.ts')));
  };
  walk(join(repoRoot, 'src', 'testrun', 'measure.ts'));
  const names = [...reach].map((f) => f.slice(join(repoRoot, 'src').length + 1));
  for (const bad of ['testrun/checks.ts', 'testrun/index.ts', 'testrun/setup.ts', 'github-app.ts', 'coordinator/test-runs.ts', 'coordinator/pr-batch.ts']) assert.ok(!names.includes(bad), `measure.ts reaches ${bad}`);
  const cli = readFileSync(join(repoRoot, 'src', 'testrun', 'measure-cli.ts'), 'utf8');
  assert.deepEqual([...cli.matchAll(/^import [^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]).sort(), ['../brand.js', '../events/log.js', '../instance.js', '../os/child-process.js', './host.js', './measure.js', './workspace.js', 'node:path']);
});

test('the helper sees exactly what a PR run of the tier sends it: the same calls, command and env, the measured value aside', { skip: !hasPerl && 'perl for the flock holder' }, async () => {
  const record = (inner: RunHost, calls: string[]): RunHost => ({
    ...inner,
    storeTips: () => (calls.push('storeTips'), inner.storeTips()),
    create: (id, b, refs) => (calls.push(`create ${refs.exclude.join(',')}`), inner.create(id, b, refs)),
    cache: (n, k) => (calls.push(`cache ${n}`), inner.cache(n, k)),
    shared: (n) => (calls.push(`shared ${n}`), inner.shared(n)),
    startDb: (id, db) => (calls.push('startDb'), inner.startDb(id, db)),
    changedFiles: (id, f) => (calls.push('changedFiles'), inner.changedFiles(id, f)),
    exec: (id, command, env, ms, signal) => (calls.push(`exec ${ms} ${command} ${JSON.stringify(Object.entries(env).filter(([k]) => !/^(npm_config_cache|PORTS_DIR)$/.test(k)))}`), inner.exec(id, command, env, ms, signal)),
    wipe: (id) => (calls.push('wipe'), inner.wipe(id)),
    helperVersion: () => (calls.push('helperVersion'), inner.helperVersion()),
    check: () => (calls.push('check'), inner.check()),
  });
  const r = rig();
  const pr: string[] = [];
  await runTestRun({ config: r.config, host: record(localHost(join(r.base, 'host')), pr), repo: r.dir, log: r.log, actor: 'c', logDir: join(r.base, 'logs'), lockPath: r.lockPath, slotsDir: r.slots, slotPollMs: 50 }, { repo: r.dir, sha: r.sha, kind: 'fast', prs: [1], tiers: ['lanes'] });
  const m: string[] = [];
  await runMeasure(r.deps(record(localHost(join(r.base, 'host2')), m)), planMeasure(r.config, { sha: r.sha, tiers: ['lanes'], sets: ['LANES=1'] }));
  assert.equal(m[0], 'helperVersion', 'it asks the protocol first, as the coordinator does at start');
  assert.deepEqual(m.slice(1), pr, 'then exactly the calls of a PR run of that tier');
});

test('a measure killed mid-run: the next one wipes what it left before starting', { skip: !hasPerl && 'perl for the flock holder' }, async () => {
  const r = rig();
  r.log.append('testrun.measure', { id: 'm-old', sha: r.sha.slice(0, 10), key: 'LANES', phase: 'run_started', value: '1', run_id: 'measure-left-behind', ok: null, wall_ms: null, tiers: [], detail: '' }, 'measure-test');
  const host = localHost(join(r.base, 'host'));
  const wiped: string[] = [];
  const out = await runMeasure(r.deps({ ...host, wipe: (id: string) => (wiped.push(id), host.wipe(id)) }), planMeasure(r.config, { sha: r.sha, tiers: ['lanes'], sets: ['LANES=2'] }));
  assert.equal(wiped[0], 'measure-left-behind');
  assert.equal(out.values.length, 1);
  assert.deepEqual(unfinishedMeasureRuns(r.log.read()), []);
});

test('suite durations: stopwatch lines first, else the per-test ones the metrics read', () => {
  assert.deepEqual(suiteDurations('\x1b[2m  ⏱ a b: 2.0s\x1b[0m ok\n⏱ c: 900ms\n'), [{ name: 'a b', ms: 2000 }, { name: 'c', ms: 900 }]);
  assert.deepEqual(suiteDurations('--- PASS: TestX (0.12s)\n'), [{ name: 'TestX', ms: 120 }]);
  assert.deepEqual(suiteDurations('nothing timed\n'), []);
});
