// The engine updater's drain (scripts/machine/<cli>-update.cjs, src/update-drain.ts): a machine that is never quiet
// (one instance running test runs back to back) once starved updates for good. After drain_after_minutes of a busy
// machine, the updater puts up a flag that every start gate honors (test slots, the full-run lock, agent slots); what
// is running finishes, nothing is stopped; it installs once nothing is in flight and reopens on every way a run ends.
// A flag past its expiry is ignored, so a crashed updater never leaves the machine drained.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fullRunLock, slotStatus, tryAgentSlot } from '../src/slots.js';
import { testSlotsHeld, tryTestSlot } from '../src/testrun/slots.js';
import { runLimitMs } from '../src/testrun/run.js';
import { SETUP_TIMEOUT_S } from '../src/testrun/timeout.js';
import { drainRefusal, updateDrain, DRAIN_TTL_MAX_MS } from '../src/update-drain.js';
import { addStartGate, passGate, TestRunHeld } from '../src/testrun/gate.js';
import { updateDrainPath, UPDATE_DRAIN_FILE, SYSTEM_SLOTS } from '../src/os/index.js';
import { drainView } from '../src/dashboard.js';
import { updatesPanel } from '../src/updates.js';
import type { TestRunConfig, TestRunTier } from '../src/testrun/config.js';
import { repoRoot } from './helpers.js';

type Flag = { since: string; until: string; to: string | null };
type Deps = Record<string, unknown> & { drainState(): Flag | null; saveDrain(f: Flag | null): void };
const u = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as {
  run(deps: object): Promise<string>;
  realDeps(print: (l: string) => void, files: Record<string, string>): Deps;
  drainStep(prev: Flag | null, stuck: unknown, current: string, head: string, entries: unknown[], alive: (pid: number) => boolean, afterMs: number, now: number): null | { flag: Flag; tests: number; agents: number; deadline: number | null; overdue: boolean; line: string };
  drainAfterMs(cfg: unknown): number;
  DRAIN_TTL_MS: number;
  DRAIN_MARGIN_MS: number;
  STUCK_INCIDENT: string;
};

const MIN = 60_000;
const OLD = '0'.repeat(40);
const NEW = 'b9634df'.padEnd(40, 'c');
const T0 = Date.parse('2026-10-14T03:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** The slot directory as the updater's realDeps reads it: each lock's pid, start and recorded cap. */
function readSlots(dir: string) {
  return readdirSync(dir)
    .filter((n) => n === 'STOP' || /^(test|agent)-\d+\.lock$/.test(n) || n === 'full-run.lock')
    .map((name) => {
      let j: Record<string, unknown> = {};
      try {
        j = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
      } catch {
        // STOP may hold anything
      }
      return { name, pid: (j.pid as number) || null, acquiredAt: typeof j.acquiredAt === 'string' ? j.acquiredAt : null, limitMs: typeof j.limit_ms === 'number' ? j.limit_ms : null };
    });
}

/**
 * A machine on engine OLD following a main whose tip NEW is green, with the updater's real drain file (realDeps,
 * written into the test's slot directory, where src/update-drain.ts reads it for a non-system slot directory).
 */
function machine(o: { cfg?: Record<string, unknown>; tip?: string; checks?: 'green' | 'pending'; held?: unknown; buildFails?: boolean; unhealthy?: boolean; fetchThrows?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'drain-'));
  const drainFile = updateDrainPath(dir);
  const real = u.realDeps(() => {}, { log: join(dir, 'updates.jsonl'), state: join(dir, 'state.json'), held: join(dir, 'held.json'), drain: drainFile });
  let current = OLD;
  let stuck: unknown = null;
  let memo: unknown = null;
  const tip = o.tip ?? NEW;
  const events: Record<string, unknown>[] = [];
  const raised: { at: number; kind: string; detail: string; fix: string }[] = [];
  const resolved: { at: number; kind: string }[] = [];
  const switched: { sha: string; at: number; inFlight: number }[] = [];
  const builds: number[] = [];
  const deps = {
    config: () => ({ enabled: true, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'], ...o.cfg }),
    installed: () => current,
    exec: (file: string, args: string[]) => {
      if (file === 'git') return `${tip}\trefs/heads/main\n`;
      if (file === 'systemd-run') {
        builds.push(Date.now());
        if (o.buildFails) throw new Error('npm ci failed');
        return '';
      }
      if (file === 'systemctl' && args[0] === 'list-units') return 'worklane-x.service loaded active running x\n';
      if (file === 'systemctl' && args[0] === 'show') return current === tip && o.unhealthy ? 'ActiveState=failed\nSubState=failed\nNRestarts=0\nResult=exit-code\n' : 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n';
      return '';
    },
    fetchJson: async (url: string) => {
      if (o.fetchThrows) throw new Error('network down');
      if (url.includes('/compare/')) return { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, commits: [{ sha: NEW, parents: [{ sha: OLD }], commit: { committer: { date: iso(Date.now() - 10 * MIN) } } }] };
      return { check_runs: [o.checks === 'pending' ? { name: 'test', status: 'in_progress', conclusion: null, started_at: '1', id: 1 } : { name: 'test', status: 'completed', conclusion: 'success', started_at: '1', id: 1 }] };
    },
    slots: () => readSlots(dir),
    alive: (pid: number) => pid === process.pid,
    installTree: () => {},
    syncHelpers: () => [],
    switchTo: (s: string) => {
      switched.push({ sha: s, at: Date.now(), inFlight: testSlotsHeld(dir).length + slotStatus(dir).agents.length });
      current = s;
    },
    now: () => Date.now(),
    sleep: async (ms: number) => void mock.timers.tick(ms),
    log: (e: Record<string, unknown>) => events.push(e),
    held: () => o.held ?? null,
    hold: () => {},
    configChangedAt: () => 0,
    verdicts: () => memo,
    saveVerdicts: (m: unknown) => (memo = m),
    stuckState: () => stuck,
    saveStuck: (s: unknown) => (stuck = s),
    drainState: real.drainState,
    saveDrain: real.saveDrain,
    raiseIncident: (kind: string, _key: string, detail: string, fix: string) => raised.push({ at: Date.now(), kind, detail, fix }),
    resolveIncident: (kind: string) => resolved.push({ at: Date.now(), kind }),
    note: (event: string, to: string | null, reason: string) => (events.push({ event, to, reason }), event),
  };
  return { dir, drainFile, deps, events, raised, resolved, switched, builds, current: () => current, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One instance running test runs back to back through the real test-slot gate, each `runMin` long, recording its cap. */
function instance(dir: string, runMin: number, capMin = runMin + 5) {
  let cur: { lock: { path: string; release(): void }; ends: number; rec: { started: number; ended: number | null } } | null = null;
  const runs: { started: number; ended: number | null }[] = [];
  let killed = 0;
  return {
    runs,
    killed: () => killed,
    step() {
      const now = Date.now();
      // A run whose slot vanished before its end was stopped by someone else.
      if (cur && !existsSync(cur.lock.path)) killed++;
      if (cur && now >= cur.ends) {
        cur.lock.release();
        cur.rec.ended = now;
        cur = null;
      }
      if (!cur) {
        const lock = tryTestSlot('example-instance test run', dir, capMin * MIN);
        if (lock) {
          const rec = { started: now, ended: null };
          runs.push(rec);
          cur = { lock, ends: now + runMin * MIN, rec };
        }
      }
    },
    stop: () => cur?.lock.release(),
  };
}

/** Minute by minute for `minutes`: the instance first, then the updater every 10 minutes. */
async function simulate(m: ReturnType<typeof machine>, inst: ReturnType<typeof instance>, minutes: number) {
  const start = Date.now();
  const ticks: { at: number; result: string; drained: boolean }[] = [];
  let next = start;
  while (Date.now() - start <= minutes * MIN) {
    inst.step();
    if (Date.now() >= next) {
      const result = await u.run(m.deps);
      ticks.push({ at: Date.now() - start, result, drained: existsSync(m.drainFile) });
      next += 10 * MIN;
    }
    mock.timers.tick(MIN);
  }
  return ticks;
}

function withClock<T>(fn: () => Promise<T> | T): Promise<T> {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  return Promise.resolve()
    .then(fn)
    .finally(() => mock.timers.reset());
}

test('starvation: an instance running 25-minute test runs back to back; the updater drains after an hour, installs once they finish, and reopens', () =>
  withClock(async () => {
    const m = machine();
    const inst = instance(m.dir, 25);
    try {
      const ticks = await simulate(m, inst, 6 * 60);
      const installs = ticks.filter((t) => t.result === 'installed');
      assert.equal(installs.length, 1, `installed once in 6 hours; the updater said: ${[...new Set(ticks.map((t) => t.result))].join(', ')}`);
      assert.equal(m.current(), NEW);
      assert.equal(m.switched[0]!.inFlight, 0, 'switched with nothing in flight');
      const drainFrom = ticks.find((t) => t.drained)!.at;
      assert.ok(drainFrom >= 60 * MIN, `not before drain_after_minutes (60): drained from minute ${drainFrom / MIN}`);
      const installAt = T0 + installs[0]!.at;
      // The drain: no run started from the moment it began to the install; the run in flight then finished in full.
      assert.deepEqual(inst.runs.filter((r) => r.started >= T0 + drainFrom && r.started < installAt), [], 'no new test run during the drain');
      const inFlight = inst.runs.filter((r) => r.started < T0 + drainFrom && (r.ended === null || r.ended > T0 + drainFrom));
      assert.equal(inFlight.length, 1);
      assert.equal(inFlight[0]!.ended! - inFlight[0]!.started, 25 * MIN, 'the in-flight run ran its whole length');
      assert.equal(inst.killed(), 0, 'no run lost its slot to anyone');
      // Reopened: the flag is gone and runs start again right after the install.
      assert.equal(existsSync(m.drainFile), false);
      assert.ok(inst.runs.some((r) => r.started >= installAt), 'test runs start again after the install');
      // The stuck alert, while draining: raised at once with what is finishing, resolved by the install.
      const during = m.raised.filter((r) => r.kind === u.STUCK_INCIDENT && r.at >= T0 + drainFrom && r.at < installAt);
      assert.ok(during.length >= 1, 'the stuck alert is raised while draining');
      assert.match(during[0]!.detail, /draining for the update since .*: no new test run or agent starts; 1 test run finishing; the test runs are due by /);
      assert.ok(m.resolved.some((r) => r.kind === u.STUCK_INCIDENT && r.at >= installAt), 'resolved by the install');
      assert.match(String(m.events.find((e) => e.event === 'waiting' && /draining/.test(String(e.reason)))!.reason), /^not quiet: a test run is going; draining for the update since /);
    } finally {
      inst.stop();
      m.done();
    }
  }));

test('in-flight runs are never killed: a run past its cap keeps the drain on, the update waits, and the alert says it is overdue', () =>
  withClock(async () => {
    const m = machine({ cfg: { drain_after_minutes: 20 } });
    const inst = instance(m.dir, 10 * 60, 30); // a 10-hour run that said it would take 30 minutes
    try {
      const ticks = await simulate(m, inst, 3 * 60);
      assert.deepEqual([...new Set(ticks.map((t) => t.result))], ['waiting'], 'never installs over it');
      assert.deepEqual(m.builds, [], 'not even a build');
      assert.equal(inst.runs.length, 1);
      assert.equal(inst.killed(), 0);
      assert.equal(existsSync(m.drainFile), true, 'still draining');
      assert.ok(ticks.filter((t) => t.at >= 20 * MIN).every((t) => t.drained), 'drained from drain_after_minutes on');
      const last = m.raised.at(-1)!;
      assert.match(last.detail, /1 test run finishing; OVERDUE: the test runs were due by .*nothing is stopped and the update keeps waiting/);
      assert.match(last.fix, /nothing is stopped and the update waits/);
    } finally {
      inst.stop();
      m.done();
    }
  }));

test('the drain blocks every start gate: test slots, the full-run lock and agent slots; an expired, far-future or unreadable flag blocks none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drain-gate-'));
  const real = u.realDeps(() => {}, { log: join(dir, 'l'), state: join(dir, 's'), held: join(dir, 'h'), drain: updateDrainPath(dir) });
  const free = () => {
    const t = tryTestSlot('t', dir);
    const a = tryAgentSlot('a', dir);
    t?.release();
    a?.release();
    return { test: !!t, agent: !!a };
  };
  try {
    const now = Date.now();
    real.saveDrain({ since: iso(now), until: iso(now + 30 * MIN), to: NEW });
    assert.deepEqual(free(), { test: false, agent: false });
    const full = await fullRunLock('a full run', 0, dir);
    assert.ok(!('lock' in full));
    assert.match(String(full.holder?.owner), /^draining for an engine update since /);
    assert.equal(existsSync(join(dir, 'full-run.lock')), false);
    for (const [why, flag] of [
      ['expired', { since: iso(now - 90 * MIN), until: iso(now - 1) }],
      ['too far ahead', { since: iso(now), until: iso(now + DRAIN_TTL_MAX_MS + MIN) }],
      ['no expiry', { since: iso(now) }],
    ] as const) {
      writeFileSync(updateDrainPath(dir), JSON.stringify(flag));
      assert.equal(updateDrain(dir), null, why);
      assert.deepEqual(free(), { test: true, agent: true }, why);
    }
    writeFileSync(updateDrainPath(dir), '{torn');
    assert.deepEqual(free(), { test: true, agent: true }, 'unreadable');
    real.saveDrain(null);
    assert.deepEqual(free(), { test: true, agent: true });
    const got = await fullRunLock('a full run', 0, dir);
    assert.ok('lock' in got);
    got.lock.release();
    // On a machine, the flag is root's, outside the group-writable slot directory.
    assert.equal(updateDrainPath(SYSTEM_SLOTS.dir), UPDATE_DRAIN_FILE);
    assert.match(UPDATE_DRAIN_FILE, /^\/var\/lib\/[^/]+\/update-drain\.json$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the full-run lock waits out a drain inside its wait and takes the lock once it ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drain-full-'));
  try {
    writeFileSync(updateDrainPath(dir), JSON.stringify({ since: iso(Date.now()), until: iso(Date.now() + 30 * MIN) }));
    setTimeout(() => rmSync(updateDrainPath(dir), { force: true }), 150);
    const got = await fullRunLock('a queued full run', 5_000, dir, 20);
    assert.ok('lock' in got, 'taken after the drain ended, within the wait');
    got.lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reopened on every way a run ends: installed, current, refused, held, pending checks, a failed build, a rollback, updates off, an emergency stop, an error', () =>
  withClock(async () => {
    const cases: [string, Parameters<typeof machine>[0], string | RegExp, ((dir: string) => void)?][] = [
      ['installed', {}, 'installed'],
      ['current', { tip: OLD }, 'current'],
      ['refused', { cfg: { required_checks: [] } }, 'refused'],
      ['held', { held: { sha: NEW, at: iso(T0 + 1), failed: ['rollback: x'] } }, 'held'],
      ['pending checks', { checks: 'pending' }, 'waiting'],
      ['build failed', { buildFails: true }, 'build_failed'],
      ['rolled back', { unhealthy: true }, 'rolled_back'],
      ['updates off', { cfg: { enabled: false } }, 'disabled'],
      ['emergency stop', {}, 'waiting', (dir) => writeFileSync(join(dir, 'STOP'), JSON.stringify({ by: 'owner', at: iso(T0), reason: 'x' }))],
      ['error', { fetchThrows: true }, /network down/],
    ];
    for (const [name, o, want, setup] of cases) {
      const m = machine(o);
      try {
        setup?.(m.dir);
        m.deps.saveDrain({ since: iso(Date.now() - 2 * 3600_000), until: iso(Date.now() + 20 * MIN), to: NEW });
        assert.ok(updateDrain(m.dir), `${name}: draining before the run`);
        const r = await u.run(m.deps).catch((e: Error) => e.message);
        if (typeof want === 'string') assert.equal(r, want, name);
        else assert.match(r, want, name);
        assert.equal(existsSync(m.drainFile), false, `${name}: reopened`);
        const slot = tryTestSlot('t', m.dir);
        assert.ok(slot, `${name}: a test run can start again`);
        slot.release();
      } finally {
        m.done();
      }
    }
  }));

test('an expired flag left by a crashed updater is ignored by the gates, and the next run below the threshold removes it', () =>
  withClock(async () => {
    const m = machine();
    const inst = instance(m.dir, 25);
    try {
      writeFileSync(m.drainFile, JSON.stringify({ since: iso(T0 - 5 * 3600_000), until: iso(T0 - 4 * 3600_000), to: NEW }));
      inst.step();
      assert.equal(inst.runs.length, 1, 'a run starts despite the stale flag');
      assert.equal(await u.run(m.deps), 'waiting');
      assert.equal(existsSync(m.drainFile), false, 'an expired flag is not a drain: the run below the threshold removes it');
      assert.doesNotMatch(String(m.events.at(-1)!.reason), /draining/);
    } finally {
      inst.stop();
      m.done();
    }
  }));

test('the drain decision: drain_after_minutes, the deadline from each run\'s recorded cap, overdue, and a run with no cap', () => {
  const alive = () => true;
  const stuck = (min: number) => ({ installed: OLD, since: iso(T0 - min * MIN), tip: NEW, notQuietSince: iso(T0 - min * MIN), raised: false });
  const run = (startedMinAgo: number, capMin: number | null) => ({ name: 'test-0.lock', pid: 101, acquiredAt: iso(T0 - startedMinAgo * MIN), limitMs: capMin === null ? null : capMin * MIN });
  assert.equal(u.drainAfterMs({}), 60 * MIN);
  assert.equal(u.drainAfterMs({ drain_after_minutes: 15 }), 15 * MIN);
  assert.equal(u.drainAfterMs({ drain_after_minutes: 0 }), 60 * MIN);
  assert.equal(u.drainStep(null, stuck(59), OLD, NEW, [run(10, 30)], alive, 60 * MIN, T0), null, 'busy 59 minutes: not yet');
  assert.equal(u.drainStep(null, { ...stuck(90), installed: 'e'.repeat(40) }, OLD, NEW, [run(10, 30)], alive, 60 * MIN, T0), null, 'another engine\'s clock does not count');
  const d = u.drainStep(null, stuck(60), OLD, NEW, [run(10, 30), { name: 'agent-0.lock', pid: 101 }, { name: 'test-1.lock', pid: 101, acquiredAt: iso(T0), limitMs: 5 * MIN }], alive, 60 * MIN, T0)!;
  assert.deepEqual(d.flag, { since: iso(T0), until: iso(T0 + u.DRAIN_TTL_MS), to: NEW });
  assert.equal(d.deadline, T0 + 20 * MIN + u.DRAIN_MARGIN_MS, 'the latest run\'s start plus its cap, plus the margin');
  assert.match(d.line, /2 test runs and 1 agent finishing; the test runs are due by /);
  // A flag of its own keeps the drain going, from its own start, below the threshold too.
  const kept = u.drainStep(d.flag, null, OLD, NEW, [run(70, 30)], alive, 60 * MIN, T0 + 10 * MIN)!;
  assert.equal(kept.flag.since, iso(T0));
  assert.equal(kept.overdue, true);
  assert.match(kept.line, /OVERDUE/);
  assert.match(u.drainStep(null, stuck(60), OLD, NEW, [run(10, null)], alive, 60 * MIN, T0)!.line, /a test run has no recorded cap/);
});

test('a test run records its cap in its slot: its setup steps\', its database\'s and its tiers\' timeouts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drain-cap-'));
  try {
    const lock = tryTestSlot('t', dir, 1234)!;
    assert.equal((JSON.parse(readFileSync(lock.path, 'utf8')) as { limit_ms: number }).limit_ms, 1234);
    lock.release();
    const tiers = [{ name: 'fast', timeout_s: 600, database: false }, { name: 'e2e', timeout_s: 1200, database: true }] as unknown as TestRunTier[];
    const config = { setup: ['a', 'b'], database: { ready_timeout_s: 60 } } as unknown as TestRunConfig;
    assert.equal(runLimitMs(config, tiers), (2 * SETUP_TIMEOUT_S + 60 + 1800) * 1000);
    assert.equal(runLimitMs({ ...config, database: undefined } as unknown as TestRunConfig, tiers.slice(0, 1)), (2 * SETUP_TIMEOUT_S + 600) * 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Updates panel: draining since when, and what is still finishing (read-only)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drain-view-'));
  try {
    assert.equal(drainView(dir), null);
    const since = iso(Date.now() - 20 * MIN);
    writeFileSync(updateDrainPath(dir), JSON.stringify({ since, until: iso(Date.now() + 25 * MIN), to: NEW }));
    // Taken before the drain began (the gates refuse new ones now): one test run and one agent still finishing.
    rmSync(updateDrainPath(dir));
    const t = tryTestSlot('t', dir)!;
    const a = tryAgentSlot('a', dir)!;
    writeFileSync(updateDrainPath(dir), JSON.stringify({ since, until: iso(Date.now() + 25 * MIN), to: NEW }));
    const view = drainView(dir)!;
    assert.deepEqual(view, { since, until: view.until, to: NEW, testRuns: 1, agents: 1 });
    assert.deepEqual(updatesPanel([], null, { sha: OLD, version: null }, view).drain, view);
    assert.equal(updatesPanel([], null, { sha: OLD, version: null }).drain, null);
    t.release();
    a.release();
    writeFileSync(updateDrainPath(dir), JSON.stringify({ since, until: iso(Date.now() - 1), to: NEW }));
    assert.equal(drainView(dir), null, 'a lapsed flag is not shown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shared start gate: the coordinator adds the drain as its `drain` source, and a run asked for while it stands is held, not started', () => {
  assert.match(readFileSync(join(repoRoot, 'src', 'service.ts'), 'utf8'), /addStartGate\('drain', drainRefusal\);/);
  const dir = mkdtempSync(join(tmpdir(), 'drain-source-'));
  const was = process.env.AGENT_SLOTS_DIR;
  process.env.AGENT_SLOTS_DIR = dir;
  const ungate = addStartGate('drain', drainRefusal);
  try {
    passGate();
    writeFileSync(updateDrainPath(dir), JSON.stringify({ since: iso(Date.now()), until: iso(Date.now() + 30 * MIN), to: NEW }));
    assert.throws(passGate, (e: unknown) => e instanceof TestRunHeld && e.refusals.some((r) => r.source === 'drain' && /^draining for an engine update since /.test(r.reason)));
    writeFileSync(updateDrainPath(dir), JSON.stringify({ since: iso(Date.now() - 90 * MIN), until: iso(Date.now() - 1), to: NEW }));
    passGate();
  } finally {
    ungate();
    if (was === undefined) delete process.env.AGENT_SLOTS_DIR;
    else process.env.AGENT_SLOTS_DIR = was;
    rmSync(dir, { recursive: true, force: true });
  }
});
