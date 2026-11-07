import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { machineTool } from './isolate.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { lastCheck, updateLog, updateSettings, updatesPanel } from '../src/updates.js';
import { repoRoot } from './helpers.js';

const updaterSrc = join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs');
type Run = { name: string; status: string; conclusion: string | null; started_at?: string; id?: number };
const u = createRequire(import.meta.url)(updaterSrc) as {
  repoFromUrl(url: string): { owner: string; repo: string } | null;
  fastForward(c: unknown): { ok: boolean; reason?: string };
  evaluateChecks(runs: Run[], required: string[]): { ok: boolean; final?: boolean; reason?: string };
  RETIRED_CHECKS: readonly string[];
  quiet(e: { name: string; pid: unknown }[], alive: (p: number) => boolean): { quiet: boolean; why?: string };
  inFlight(e: { name: string; pid: unknown }[], alive: (p: number) => boolean): { tests: unknown[]; agents: unknown[] };
  slotPid(v: unknown): number | null;
  parseUnits(s: string): string[];
  health(samples: { at: number; states: Record<string, string | { state: string; sub: string; restarts: number; result: string }> }[], start: number, now: number): string;
  parseShow(s: string): { state: string; sub: string; restarts: number; result: string };
  redact(s: string): string;
  buildCommand(url: string, sha: string, state?: string): string[];
  installTree(sha: string, opt?: string, buildDir?: string, owner?: string): void;
  run(deps: object): Promise<string>;
  journalLine(event: string, sha: string | null, reason: unknown): string;
  makeNote(o: { readState(): unknown; writeState(s: unknown): void; log(e: Record<string, unknown>): void; print(line: string): void }): (event: string, sha: string | null, reason: string) => string;
  realDeps(print?: (line: string) => void, files?: Record<string, string>): { note(event: string, sha: string | null, reason: string): string; checked(s: Record<string, unknown>): void };
  BUILD_SCRIPT: string;
  verifyRelease(repoUrl: string, tag: string, signers: string, exec: (f: string, a: string[]) => string, gitDir?: string): { ok: true; base: string; object: string; commit: string } | { ok: false; reason: string };
  verifiedUpdater(signers: string, tag: string, commit: string, exec: (f: string, a: string[]) => Buffer, gitDir?: string): { ok: true; commit: string; bytes: Buffer } | { ok: false; reason: string };
};

test('repo from a clone URL', () => {
  assert.deepEqual(u.repoFromUrl('https://github.com/example-org/engine.git'), { owner: 'example-org', repo: 'engine' });
  assert.deepEqual(u.repoFromUrl(['git', 'github.com:example-org/engine.git'].join('@')), { owner: 'example-org', repo: 'engine' }, 'an ssh clone URL');
  assert.equal(u.repoFromUrl('https://gitlab.com/a/b'), null);
});

test('only a fast-forward of the installed engine is installed', () => {
  assert.equal(u.fastForward({ status: 'ahead', ahead_by: 3, behind_by: 0 }).ok, true);
  for (const c of [{ status: 'behind', ahead_by: 0, behind_by: 2 }, { status: 'diverged', ahead_by: 1, behind_by: 1 }, { status: 'identical', ahead_by: 0, behind_by: 0 }, null]) {
    const r = u.fastForward(c);
    assert.equal(r.ok, false, JSON.stringify(c));
    assert.match(r.reason!, /not a fast-forward/);
  }
});

const ok = (name: string, extra: Partial<Run> = {}): Run => ({ name, status: 'completed', conclusion: 'success', started_at: '2026-01-01T00:00:00Z', id: 1, ...extra });

test('checks: every one complete and green, every required one present and successful', () => {
  const req = ['test', 'lint'];
  assert.deepEqual(u.evaluateChecks([ok('test'), ok('lint'), ok('weekly', { conclusion: 'skipped' })], req), { ok: true }, 'a skipped check that isn\'t required is fine');
  const cases: [Run[], boolean, RegExp][] = [
    [[ok('test')], false, /"lint" hasn't run/],
    [[ok('test'), ok('lint', { status: 'in_progress', conclusion: null })], false, /"lint" is in_progress/],
    [[ok('test'), ok('lint', { conclusion: 'skipped' })], true, /"lint" was skipped/],
    [[ok('test'), ok('lint', { conclusion: 'failure' })], true, /"lint" ended failure/],
    [[ok('test'), ok('lint'), ok('other', { conclusion: 'failure' })], true, /"other" ended failure/],
    [[ok('test'), ok('lint'), ok('other', { conclusion: 'cancelled' })], true, /cancelled/],
    [[ok('test'), ok('lint'), ok('other', { status: 'queued', conclusion: null })], false, /"other" is queued/],
  ];
  for (const [runs, final, why] of cases) {
    const r = u.evaluateChecks(runs, req);
    assert.equal(r.ok, false, why.source);
    assert.equal(r.final, final, why.source);
    assert.match(r.reason!, why);
  }
  // #925: a later pass never hides an earlier failure of a required check (GitHub's filter=latest already drops a re-run
  // job's earlier attempts, measured), nor one still running; a required name's runs all passing install.
  assert.deepEqual(u.evaluateChecks([ok('test', { conclusion: 'failure', started_at: '2026-01-01T00:00:00Z' }), ok('test', { started_at: '2026-01-01T01:00:00Z', id: 2 }), ok('lint')], req), { ok: false, final: true, reason: 'required check "test" ended failure' });
  assert.deepEqual(u.evaluateChecks([ok('test', { status: 'in_progress', conclusion: null, started_at: '2026-01-01T00:00:00Z' }), ok('test', { started_at: '2026-01-01T01:00:00Z', id: 2 }), ok('lint')], req), { ok: false, final: false, reason: 'required check "test" is in_progress' });
  assert.deepEqual(u.evaluateChecks([ok('test'), ok('test', { started_at: '2026-01-01T01:00:00Z', id: 2 }), ok('lint')], req), { ok: true });
  assert.deepEqual(u.evaluateChecks([ok('test')], []), { ok: false, final: true, reason: 'no required checks configured in updates.json' });
});

test('a retired check (desktop, #744) an existing updates.json still requires: not waited for when absent, as strict as ever when it ran', () => {
  // Every install made before #744 has "desktop" in required_checks (the old UPDATE_DEFAULT_CHECKS), and no main
  // commit after it runs that job: without this, such an install would never take another update.
  const req = ['test', 'desktop'];
  assert.deepEqual(u.evaluateChecks([ok('test')], req), { ok: true }, 'absent: no longer waited for');
  assert.deepEqual(u.evaluateChecks([ok('test'), ok('desktop', { conclusion: 'failure' })], req), { ok: false, final: true, reason: 'required check "desktop" ended failure' });
  assert.deepEqual(u.evaluateChecks([ok('test'), ok('desktop', { conclusion: 'skipped' })], req), { ok: false, final: true, reason: 'required check "desktop" was skipped' }, 'it ran: skipped still refuses');
  assert.equal(u.evaluateChecks([ok('test'), ok('desktop', { status: 'in_progress', conclusion: null })], req).final, false, 'it is running: waited for');
  // While CI still has the job, every commit gets a run, and it is judged exactly as before.
  assert.deepEqual(u.evaluateChecks([ok('test'), ok('desktop')], req), { ok: true }, 'it ran green: installs as before');
  assert.deepEqual(u.evaluateChecks([ok('test'), ok('desktop', { status: 'queued', conclusion: null })], req), { ok: false, final: false, reason: 'required check "desktop" is queued' }, 'it is queued: waited for');
  // The other required checks lose nothing.
  assert.match(u.evaluateChecks([ok('desktop')], req).reason!, /"test" hasn't run/);
  // Retired names alone are no gate: refused as an empty list is, never installed on nothing.
  assert.deepEqual(u.evaluateChecks([ok('test')], ['desktop']), { ok: false, final: true, reason: 'no required checks configured in updates.json but retired ones (desktop): add the checks to require at a root shell (updates.sh --add-check)' });
  assert.deepEqual(u.evaluateChecks([ok('test'), ok('desktop', { conclusion: 'failure' })], ['desktop']), { ok: false, final: true, reason: 'required check "desktop" ended failure' }, 'retired names alone, and it ran: judged as before');
  assert.deepEqual(u.RETIRED_CHECKS, ['desktop'], 'a fixed list in the installed updater, never read from the commit it judges');
});

test('quiet only with no live agent or full-run lock and no emergency stop', () => {
  const alive = (p: number) => p === 42;
  assert.deepEqual(u.quiet([], alive), { quiet: true });
  assert.deepEqual(u.quiet([{ name: 'agent-0.lock', pid: 7 }, { name: 'slots.lock', pid: 42 }], alive), { quiet: true }, 'a dead holder and the slot guard don\'t count');
  assert.equal(u.quiet([{ name: 'agent-1.lock', pid: 42 }], alive).quiet, false);
  assert.equal(u.quiet([{ name: 'full-run.lock', pid: 42 }], alive).quiet, false);
  assert.deepEqual(u.quiet([{ name: 'test-0.lock', pid: 42 }], alive), { quiet: false, why: 'a test run is going' });
  assert.equal(u.quiet([{ name: 'test-0.lock', pid: 7 }], alive).quiet, true, 'a dead test-run holder doesn\'t count');
  assert.equal(u.quiet([{ name: 'STOP', pid: null }], alive).quiet, false);
});

test('a slot pid below 2, or not a whole number, is no holder: a corrupt slot file never holds updates off for good', () => {
  // kill(pid, 0) answers for a process group (0, negative) or init (1) whatever runs, so "alive" would never end.
  const alive = () => true;
  for (const pid of [0, 1, -1, -42, 1.5, '42', null, undefined, Number.NaN]) {
    assert.equal(u.slotPid(pid), null, `slotPid(${String(pid)})`);
    for (const name of ['agent-0.lock', 'test-0.lock', 'full-run.lock']) {
      assert.deepEqual(u.quiet([{ name, pid }], alive), { quiet: true }, `${name} with pid ${String(pid)} counted as a holder`);
      assert.deepEqual(u.inFlight([{ name, pid }], alive), { tests: [], agents: [] }, `${name} with pid ${String(pid)} counted in flight`);
    }
  }
  assert.equal(u.slotPid(2), 2);
  assert.equal(u.quiet([{ name: 'agent-0.lock', pid: 2 }], alive).quiet, false, 'a real pid still counts');
  assert.equal(u.inFlight([{ name: 'test-0.lock', pid: 4242 }], alive).tests.length, 1);
});

test('the services an update restarts: every worklane service but the updater and the build', () => {
  const listing = 'worklane-quiet.service loaded active running x\nworklane-dashboard-a.service loaded active running y\nworklane-update.service loaded inactive dead z\nworklane-build-1.service loaded active running w\nother.service loaded active running v\n';
  assert.deepEqual(u.parseUnits(listing), ['worklane-quiet.service', 'worklane-dashboard-a.service']);
});

test('health after a restart: steady 30 s is healthy; failed or 2 minutes without that rolls back', () => {
  const s = (at: number, a: string, b = 'active') => ({ at, states: { a: a, b } });
  assert.equal(u.health([s(0, 'activating')], 0, 10_000), 'wait');
  assert.equal(u.health([s(5_000, 'active'), s(40_000, 'active')], 0, 40_000), 'healthy');
  assert.equal(u.health([s(5_000, 'active'), s(20_000, 'activating'), s(40_000, 'active')], 0, 40_000), 'wait', 'a break restarts the steady clock');
  assert.equal(u.health([s(5_000, 'failed')], 0, 5_000), 'failed');
  assert.equal(u.health([s(5_000, 'activating'), s(120_000, 'activating')], 0, 120_000), 'failed');
});

test('the build runs as a throwaway DynamicUser with npm ci --ignore-scripts, never as root', () => {
  const cmd = u.buildCommand('https://github.com/example-org/engine.git', 'a'.repeat(40));
  assert.equal(cmd[0], 'systemd-run');
  assert.ok(cmd.includes('DynamicUser=yes'));
  assert.ok(cmd.includes('NoNewPrivileges=yes') && cmd.includes('ProtectSystem=strict') && cmd.includes('ProtectHome=yes'));
  assert.match(u.BUILD_SCRIPT, /npm ci --ignore-scripts/);
  assert.match(u.BUILD_SCRIPT, /test "\$\(git rev-parse HEAD\)" = "\$2"/, 'exactly the commit whose checks passed');
  // npm appears only inside the DynamicUser's script, nowhere the root process runs it.
  const src = readFileSync(updaterSrc, 'utf8');
  assert.equal(src.split('\n').filter((l) => /\bnpm\b/.test(l) && !/^\s*'npm (ci|run)/.test(l) && !/^\s*\/\//.test(l)).length, 0);
  assert.doesNotMatch(readFileSync(join(repoRoot, 'scripts', 'setup', 'updates.sh'), 'utf8'), /^\s*npm\b/m);
});

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

/** Fake machine for run(): records what it would do. */
function machine(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const logs: Record<string, unknown>[] = [];
  let current = OLD;
  let clock = 0;
  // Per installed commit, how its services behave: active, failed, or loop (crash loop: activating in auto-restart).
  const states: Record<string, string[]> = { [NEW]: ['active'], [OLD]: ['active'] };
  let heldEntry: { sha: string; at: string; failed: string[] } | null = null;
  let configAt = 0;
  const show = (how: string) =>
    how === 'failed' ? 'ActiveState=failed\nSubState=failed\nNRestarts=0\nResult=exit-code\n' : how === 'loop' ? 'ActiveState=activating\nSubState=auto-restart\nNRestarts=2\nResult=exit-code\n' : 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n';
  const deps = {
    config: () => ({ enabled: true, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'] }),
    installed: () => current,
    exec: (file: string, args: string[]) => {
      calls.push([file, ...args].join(' ').slice(0, 80));
      if (file === 'git') return `${NEW}\trefs/heads/main\n`;
      if (file === 'systemctl' && args[0] === 'list-units') return 'worklane-x.service loaded active running x\nworklane-dashboard-x.service loaded active running y\n';
      if (file === 'systemctl' && args[0] === 'show' && args.includes('ExecMainStatus')) return '126\n';
      if (file === 'systemctl' && args[0] === 'show') return show((states[current] ?? ['active'])[0]!);
      if (file === 'journalctl') return `${'x'.repeat(6000)}\nworklane[1]: Failed to execute /usr/local/bin/worklane: Permission denied\nGH_TOKEN=ghs_${'a'.repeat(36)}\n`;
      return '';
    },
    fetchJson: async (url: string) => (url.includes('/compare/') ? { status: 'ahead', ahead_by: 1, behind_by: 0 } : { check_runs: [ok('test')] }),
    slots: () => [],
    alive: () => false,
    installTree: (sha: string) => calls.push(`installTree ${sha.slice(0, 4)}`),
    syncHelpers: (sha: string) => (calls.push(`syncHelpers ${sha.slice(0, 4)}`), [{ path: '/usr/local/libexec/worklane-testrun', state: 'updated' }]),
    switchTo: (sha: string) => {
      current = sha;
      calls.push(`switchTo ${sha.slice(0, 4)}`);
    },
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    log: (e: Record<string, unknown>) => logs.push({ ...e, clock }),
    held: () => heldEntry,
    hold: (e: { sha: string; at: string; failed: string[] }) => {
      heldEntry = e;
    },
    configChangedAt: () => configAt,
    note: (event: string, sha: string | null, reason: string) => (logs.push({ event, to: sha, reason }), event),
    ...over,
  };
  return { deps, calls, logs, states, current: () => current, held: () => heldEntry, release: () => (heldEntry = null), setConfigAt: (t: number) => (configAt = t), setCurrent: (sha: string) => (current = sha) };
}

test('run: off does nothing; up to date does nothing', async () => {
  const m = machine({ config: () => ({ enabled: false }) });
  assert.equal(await u.run(m.deps), 'disabled');
  assert.deepEqual(m.calls, []);
  const same = machine({ installed: () => NEW });
  assert.equal(await u.run(same.deps), 'current');
  assert.ok(!same.calls.some((c) => c.startsWith('systemd-run')));
});

test('regression (#465): a main pass with nothing newer records when and on which channel in the state file, and logs nothing', async () => {
  const checked: Record<string, unknown>[] = [];
  const same = machine({ installed: () => NEW, installedVersion: () => '0.5.0', now: () => Date.parse('2026-10-15T12:00:00Z'), checked: (s: Record<string, unknown>) => checked.push(s) });
  assert.equal(await u.run(same.deps), 'current');
  assert.deepEqual(checked, [{ event: 'current', at: '2026-10-15T12:00:00.000Z', channel: 'main', sha: NEW, version: '0.5.0', newest: NEW }]);
  assert.deepEqual(same.logs, [], 'updates.jsonl stays a log of changes');
});

test('regression (#465): the real deps write a current pass to the state file and not to the log; the dashboard reads it back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upd-state-'));
  const files = { log: join(dir, 'updates.jsonl'), state: join(dir, 'update-state.json'), held: join(dir, 'held.json'), drain: join(dir, 'drain.json') };
  const real = u.realDeps(() => {}, files);
  real.checked({ event: 'current', at: '2026-10-15T12:00:00.000Z', channel: 'release', sha: 'a'.repeat(40), version: '0.5.0', newest: 'v0.5.0' });
  assert.equal(existsSync(files.log), false, 'nothing logged');
  assert.deepEqual(lastCheck(files.state), { at: '2026-10-15T12:00:00.000Z', channel: 'release', sha: 'a'.repeat(40), version: '0.5.0', newest: 'v0.5.0' });
  // A refusal or wait (deps.note) is not a check that found it up to date.
  real.note('waiting', 'b'.repeat(40), 'checks pending');
  assert.equal(lastCheck(files.state), null);
  assert.equal(lastCheck(join(dir, 'missing.json')), null);
  writeFileSync(files.state, JSON.stringify({ event: 'current', at: 'not a date', channel: 'release' }));
  assert.equal(lastCheck(files.state), null);
});

test('the Updates panel shows the last up-to-date check only while it is about the engine installed now (#465)', () => {
  const check = { at: '2026-10-15T12:00:00.000Z', channel: 'release' as const, sha: 'a'.repeat(40), version: '0.5.0', newest: 'v0.5.0' };
  const installed = { sha: 'a'.repeat(40), version: '0.5.0' };
  assert.deepEqual(updatesPanel([], null, installed, null, check).lastCheck, check);
  assert.equal(updatesPanel([], null, installed).lastCheck, null);
  assert.equal(updatesPanel([], null, { sha: 'b'.repeat(40), version: '0.5.1' }, null, check).lastCheck, null, 'another engine since');
  const install = { at: '2026-10-15T13:00:00.000Z', event: 'installed' as const, from: 'a'.repeat(40), to: 'a'.repeat(40) };
  assert.equal(updatesPanel([install], null, installed, null, check).lastCheck, null, 'an install after it');
});

test('run: a fast-forward with green checks on a quiet machine is built unprivileged, switched to and kept when healthy', async () => {
  const m = machine();
  assert.equal(await u.run(m.deps), 'installed');
  const order = m.calls.filter((c) => /^(systemd-run|installTree|switchTo|systemctl restart)/.test(c)).map((c) => c.split(' ').slice(0, 2).join(' '));
  assert.deepEqual(order, ['systemd-run --wait', 'installTree bbbb', 'switchTo bbbb', 'systemctl restart']);
  assert.ok(m.calls.find((c) => c.startsWith('systemd-run'))!.includes('DynamicUser=yes'));
  assert.equal(m.current(), NEW);
  assert.deepEqual(m.logs.map((l) => l.event), ['attempt', 'installed']);
});

test('run: a service that doesn\'t come up rolls back to the previous engine and logs it', async () => {
  const m = machine();
  m.states[NEW] = ['failed'];
  assert.equal(await u.run(m.deps), 'rolled_back');
  assert.equal(m.current(), OLD);
  const last = m.logs.at(-1)!;
  assert.equal(last.event, 'rolled_back');
  assert.equal(last.from, NEW);
  assert.equal(last.to, OLD);
  assert.equal(last.back, 'healthy');
  assert.deepEqual(last.failed, ['worklane-x.service: failed (failed), exit-code', 'worklane-dashboard-x.service: failed (failed), exit-code']);
  assert.deepEqual(m.calls.filter((c) => c.startsWith('switchTo')), ['switchTo bbbb', 'switchTo aaaa']);
});

test('run: the root helpers follow the engine: the new engine\'s before switching to it, the old engine\'s back on a rollback', async () => {
  const m = machine();
  assert.equal(await u.run(m.deps), 'installed');
  const order = m.calls.filter((c) => /^(installTree|syncHelpers|switchTo)/.test(c));
  assert.deepEqual(order, ['installTree bbbb', 'syncHelpers bbbb', 'switchTo bbbb']);
  assert.deepEqual(m.logs.at(-1)!.helpers, [{ path: '/usr/local/libexec/worklane-testrun', state: 'updated' }], 'the install says which helpers it replaced');
  const r = machine();
  r.states[NEW] = ['failed'];
  assert.equal(await u.run(r.deps), 'rolled_back');
  assert.deepEqual(r.calls.filter((c) => /^(syncHelpers|switchTo)/.test(c)), ['syncHelpers bbbb', 'switchTo bbbb', 'syncHelpers aaaa', 'switchTo aaaa']);
});

test('run: a helper that can\'t be replaced holds the update: never switched to, the old engine\'s helpers back, a clear reason', async () => {
  const m = machine({
    syncHelpers: (sha: string) => {
      m.calls.push(`syncHelpers ${sha.slice(0, 4)}`);
      if (sha === NEW) throw new Error("couldn't replace /usr/local/libexec/worklane-testrun with /opt/worklane/bbbb/scripts/machine/worklane-testrun.sh: syntax error");
      return [{ path: '/usr/local/libexec/worklane-testrun', state: 'updated' }];
    },
  });
  assert.equal(await u.run(m.deps), 'rolled_back');
  assert.equal(m.current(), OLD);
  assert.ok(!m.calls.some((c) => c.startsWith('switchTo')), 'never switched');
  assert.deepEqual(m.calls.filter((c) => c.startsWith('syncHelpers')), ['syncHelpers bbbb', 'syncHelpers aaaa']);
  const last = m.logs.at(-1)!;
  assert.equal(last.event, 'rolled_back');
  assert.match(String(last.reason), /^rollback: the root helpers couldn't be put in step with the new engine: couldn't replace \/usr\/local\/libexec\/worklane-testrun/);
  assert.equal(m.held()!.sha, NEW);
  assert.equal(await u.run(m.deps), 'held', 'not retried by itself');
});

test('run: refuses a non-fast-forward, a skipped or failed required check; waits on pending checks or a busy machine', async () => {
  const cases: [Record<string, unknown>, string, RegExp][] = [
    [{ fetchJson: async (url: string) => (url.includes('/compare/') ? { status: 'diverged', ahead_by: 1, behind_by: 2 } : { check_runs: [ok('test')] }) }, 'refused', /not a fast-forward/],
    [{ fetchJson: async (url: string) => (url.includes('/compare/') ? { status: 'ahead', ahead_by: 1, behind_by: 0 } : { check_runs: [ok('test', { conclusion: 'skipped' })] }) }, 'refused', /was skipped/],
    [{ fetchJson: async (url: string) => (url.includes('/compare/') ? { status: 'ahead', ahead_by: 1, behind_by: 0 } : { check_runs: [ok('test', { conclusion: 'failure' })] }) }, 'refused', /ended failure/],
    [{ fetchJson: async (url: string) => (url.includes('/compare/') ? { status: 'ahead', ahead_by: 1, behind_by: 0 } : { check_runs: [ok('test', { status: 'in_progress', conclusion: null })] }) }, 'waiting', /in_progress/],
    [{ fetchJson: async (url: string) => (url.includes('/compare/') ? { status: 'ahead', ahead_by: 1, behind_by: 0 } : { check_runs: [] }) }, 'waiting', /hasn't run/],
    [{ slots: () => [{ name: 'agent-0.lock', pid: 9 }], alive: () => true }, 'waiting', /not quiet: an agent is running/],
  ];
  for (const [over, want, why] of cases) {
    const m = machine(over);
    assert.equal(await u.run(m.deps), want, why.source);
    assert.match(String(m.logs.at(-1)!.reason), why);
    assert.ok(!m.calls.some((c) => c.startsWith('systemd-run') || c.startsWith('switchTo')), `${why.source}: nothing built or switched`);
  }
});

test('a rolled-back commit is held: not tried again until a newer commit, or until an admin releases it at a root shell; updates.json changing never releases it', async () => {
  const m = machine();
  m.states[NEW] = ['failed'];
  assert.equal(await u.run(m.deps), 'rolled_back');
  const held = m.held()!;
  assert.equal(held.sha, NEW);
  assert.deepEqual(held.failed, ['worklane-x.service: failed (failed), exit-code', 'worklane-dashboard-x.service: failed (failed), exit-code']);
  assert.equal(m.logs.at(-1)!.held, true);
  // Ten minutes later: the same commit is skipped, logged once as held, and nothing is built.
  const before = m.calls.length;
  assert.equal(await u.run(m.deps), 'held');
  assert.equal(m.logs.at(-1)!.event, 'held');
  assert.match(String(m.logs.at(-1)!.reason), /rolled back at .*held until a newer commit, or until an admin releases it at a root shell: sudo bash \/opt\/worklane\/current\/scripts\/setup\/updates\.sh --release-hold/);
  assert.ok(!m.calls.slice(before).some((c) => c.startsWith('systemd-run') || c.startsWith('switchTo')));
  // updates.json written after the rollback (the on/off switch, the channel: what any coordinator can change) doesn't release it.
  m.setConfigAt(Date.parse(held.at) + 1000);
  m.states[NEW] = ['active'];
  assert.equal(await u.run(m.deps), 'held');
  // updates.sh --release-hold, at a root shell, moves the hold file aside: then it is tried again.
  m.release();
  assert.equal(await u.run(m.deps), 'installed');
});

test('a newer commit than the held one is tried', async () => {
  const NEWER = 'c'.repeat(40);
  const m = machine({
    exec: (file: string, args: string[]) => (file === 'git' ? `${NEWER}\trefs/heads/main\n` : machine().deps.exec(file, args)),
    held: () => ({ sha: NEW, at: new Date(0).toISOString(), failed: [] }),
  });
  assert.equal(await u.run(m.deps), 'installed');
});

test('a rollback says why: each failing unit\'s result, exit status and journal tail, redacted and capped', async () => {
  const m = machine();
  m.states[NEW] = ['failed'];
  await u.run(m.deps);
  const d = m.logs.at(-1)!.diagnosis as { unit: string; result: string; status: string; restarts: number; journal: string }[];
  assert.deepEqual(d.map((x) => [x.unit, x.result, x.status]), [['worklane-x.service', 'exit-code', '126'], ['worklane-dashboard-x.service', 'exit-code', '126']]);
  assert.match(d[0]!.journal, /Failed to execute \/usr\/local\/bin\/worklane: Permission denied/);
  assert.doesNotMatch(d[0]!.journal, /ghs_a{36}/, 'the token is redacted');
  assert.match(d[0]!.journal, /GH_TOKEN=\[redacted\]/);
  assert.ok(d[0]!.journal.length <= 4001, 'capped');
  assert.ok(m.calls.some((c) => c.startsWith('journalctl -u worklane-x.service -n 30 --no-pager')));
});

test('a crash loop rolls back at once, not after the full 2-minute window', async () => {
  const m = machine();
  m.states[NEW] = ['loop'];
  assert.equal(await u.run(m.deps), 'rolled_back');
  const rolled = m.logs.find((l) => l.event === 'rolled_back')!;
  // The new engine's services were judged on the first sample; the rest of the clock is the old engine settling.
  assert.ok((rolled.clock as number) <= 60_000, `rolled back by ${rolled.clock} ms`);
  assert.deepEqual(rolled.failed, ['worklane-x.service: activating (auto-restart), exit-code, 2 restarts', 'worklane-dashboard-x.service: activating (auto-restart), exit-code, 2 restarts']);
});

test('health: restarts, auto-restart, or a failed result while not active are a crash loop; a stale result on an active unit is not', () => {
  const unit = (state: string, extra: Partial<{ sub: string; restarts: number; result: string }> = {}) => ({ state, sub: '', restarts: 0, result: 'success', ...extra });
  assert.equal(u.health([{ at: 0, states: { a: unit('activating') } }, { at: 5_000, states: { a: unit('activating', { restarts: 1 }) } }], 0, 5_000), 'failed', 'restarted since the first sample');
  assert.equal(u.health([{ at: 0, states: { a: unit('activating', { sub: 'auto-restart' }) } }], 0, 0), 'failed');
  assert.equal(u.health([{ at: 0, states: { a: unit('activating', { result: 'exit-code' }) } }], 0, 0), 'failed');
  assert.equal(u.health([{ at: 0, states: { a: unit('active', { result: 'exit-code' }) } }], 0, 0), 'wait', 'active now: the result is from before the restart');
  assert.equal(u.health([{ at: 0, states: { a: unit('active', { restarts: 3 }) } }, { at: 31_000, states: { a: unit('active', { restarts: 3 }) } }], 0, 31_000), 'healthy', 'a restart count from before is the baseline');
  assert.deepEqual(u.parseShow('ActiveState=activating\nSubState=auto-restart\nNRestarts=4\nResult=exit-code\n'), { state: 'activating', sub: 'auto-restart', restarts: 4, result: 'exit-code' });
});

test('redact: tokens, keys and secret assignments in a journal never reach the log', () => {
  const text = [`token ghp_${'b'.repeat(36)}`, `Authorization: Bearer abcdefghijklmnop`, 'API_KEY=hunter2hunter2', 'password: "x y z"', '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', 'sk-ant-api03-abcdefghijk'].join('\n');
  const r = u.redact(text);
  for (const leak of ['ghp_', 'abcdefghijklmnop', 'hunter2', 'x y z', 'MIIE', 'sk-ant-api03']) assert.ok(!r.includes(leak), leak);
});

test('the journal: every run prints the event, the short sha and the reason; updates.jsonl still gets it once', async () => {
  const sha = 'b9634df0'.padEnd(40, '1');
  const why = 'required check "Claude sign-in probe (real users)" hasn\'t run on this commit';
  assert.equal(u.journalLine('waiting', sha, why), `waiting b9634df: ${why}`);
  assert.equal(u.journalLine('refused', sha, 'check "test" ended failure'), 'refused b9634df: check "test" ended failure');
  assert.equal(u.journalLine('held', sha, 'rolled back at 2026-10-13T01:00:00Z; held until a newer commit'), 'held b9634df: rolled back at 2026-10-13T01:00:00Z; held until a newer commit');
  assert.equal(u.journalLine('waiting', null, 'no release tag vX.Y.Z yet'), 'waiting: no release tag vX.Y.Z yet', 'no commit to name');
  assert.equal(u.journalLine('build_failed', sha, 'npm ERR!\n  code 1\n'), 'build_failed b9634df: npm ERR! code 1', 'one line');
  assert.ok(u.journalLine('refused', sha, 'x'.repeat(5000)).length < 1100, 'capped');
  // No secret reaches the journal: a clone URL's credentials, a token in a build's output.
  const leaky = u.journalLine('refused', null, `updates.json repo_url isn't a GitHub repository: https://someone:hunter2hunter2@git.example.com/x.git token=abc123abc123 ghp_${'b'.repeat(36)}`);
  for (const leak of ['hunter2', 'someone', 'abc123', 'ghp_']) assert.ok(!leaky.includes(leak), `${leak}: ${leaky}`);
  assert.match(leaky, /https:\/\/\[redacted\]@git\.example\.com\/x\.git/);

  // The updater's own note (realDeps wires this one): three runs waiting on the same commit for the same reason.
  let state: unknown = null;
  const logs: Record<string, unknown>[] = [];
  const out: string[] = [];
  const note = u.makeNote({ readState: () => state, writeState: (s) => (state = s), log: (e) => logs.push(e), print: (l) => out.push(l) });
  for (let i = 0; i < 3; i++) assert.equal(note('waiting', sha, why), 'waiting');
  assert.deepEqual(out, Array(3).fill(`waiting b9634df: ${why}`), 'the journal says why on every run');
  assert.deepEqual(logs, [{ event: 'waiting', to: sha, reason: why }], 'updates.jsonl: once per commit and reason');
  note('refused', sha, 'check "test" ended failure');
  assert.equal(out.at(-1), 'refused b9634df: check "test" ended failure');
  assert.equal(logs.length, 2, 'a new event or reason is logged again');

  // A whole run, through run(): what reaches stdout for a wait carries the commit and the reason.
  const m = machine({ fetchJson: async (url: string) => (url.includes('/compare/') ? { status: 'ahead', ahead_by: 1, behind_by: 0 } : { check_runs: [ok('test', { status: 'in_progress', conclusion: null })] }) });
  const printed: string[] = [];
  let st: unknown = null;
  const deps = { ...m.deps, note: u.makeNote({ readState: () => st, writeState: (s) => (st = s), log: () => {}, print: (l) => printed.push(l) }) };
  assert.equal(await u.run(deps), 'waiting');
  assert.equal(await u.run(deps), 'waiting');
  assert.deepEqual(printed, Array(2).fill(`waiting ${NEW.slice(0, 7)}: required check "test" is in_progress`));
});

test('the installed updater prints one line per run: the note\'s line with its reason, else the bare result', () => {
  const src = readFileSync(updaterSrc, 'utf8');
  assert.match(src, /note: makeNote\(\{[^\n]*\bprint \}\),/, 'realDeps: the note prints through the same print as the result');
  assert.match(src, /run\(realDeps\(print\)\)\.then\(\n\s+\(r\) => said \|\| print\(r\),/, 'never the bare word after a line that says why');
});

/** A built tree as tsc and npm leave it: the bin targets 0644, some files private. */
function builtTree(bin: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'opt-'));
  const opt = join(root, 'opt');
  const build = join(root, 'build');
  mkdirSync(opt);
  mkdirSync(join(build, 'src', 'dist', 'src'), { recursive: true });
  mkdirSync(join(build, 'src', 'dist', 'web'), { recursive: true });
  mkdirSync(join(build, 'src', 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(build, 'src', 'dist', 'src', 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o644 });
  writeFileSync(join(build, 'src', 'dist', 'src', 'other.js'), '#!/usr/bin/env node\n', { mode: 0o644 });
  writeFileSync(join(build, 'src', 'dist', 'web', 'index.html'), '<html></html>', { mode: 0o600 });
  writeFileSync(join(build, 'src', 'node_modules', 'dep', 'index.js'), '', { mode: 0o600 });
  writeFileSync(join(build, 'src', 'package.json'), JSON.stringify({ name: 'x', bin }), { mode: 0o600 });
  chmodSync(join(build, 'src', 'node_modules', 'dep'), 0o700);
  return { opt, build, dest: join(opt, NEW), owner: `${process.getuid!()}:${process.getgid!()}` };
}

test('installTree: every package.json bin target is made 0755, and every file is readable by every user', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const t = builtTree({ worklane: 'dist/src/cli.js', helper: 'dist/src/other.js' });
  u.installTree(NEW, t.opt, t.build, t.owner);
  for (const b of ['dist/src/cli.js', 'dist/src/other.js']) assert.equal(statSync(join(t.dest, b)).mode & 0o777, 0o755, `${b}: the services exec it through /usr/local/bin`);
  for (const f of ['dist/web/index.html', 'node_modules/dep/index.js', 'package.json']) assert.equal(statSync(join(t.dest, f)).mode & 0o777, 0o644, f);
  assert.equal(statSync(join(t.dest, 'node_modules', 'dep')).mode & 0o777, 0o755);
  // An install left by the earlier updater (bin not executable) is redone, not skipped as already there.
  chmodSync(join(t.dest, 'dist', 'src', 'cli.js'), 0o644);
  u.installTree(NEW, t.opt, t.build, t.owner);
  assert.equal(statSync(join(t.dest, 'dist', 'src', 'cli.js')).mode & 0o777, 0o755);
  // A single-string bin counts too.
  const s = builtTree('dist/src/cli.js');
  u.installTree(NEW, s.opt, s.build, s.owner);
  assert.equal(statSync(join(s.dest, 'dist', 'src', 'cli.js')).mode & 0o777, 0o755);
});

test('installTree refuses a tree whose bin target is missing, and run() switches nothing', { skip: process.platform === 'win32' && 'POSIX modes' }, async () => {
  const t = builtTree({ worklane: 'dist/src/cli.js', gone: 'dist/src/gone.js' });
  assert.throws(() => u.installTree(NEW, t.opt, t.build, t.owner), /can't be started: bin dist\/src\/gone\.js is missing/);
  assert.ok(!existsSync(t.dest), 'nothing installed');
  assert.deepEqual(readdirSync(t.opt), [], 'no temp tree left');
  const m = machine({
    installTree: () => {
      throw new Error("the built tree can't be started: bin dist/src/cli.js is not executable (mode 644)");
    },
  });
  assert.equal(await u.run(m.deps), 'build_failed');
  assert.match(String(m.logs.at(-1)!.reason), /not executable/);
  assert.ok(!m.calls.some((c) => c.startsWith('switchTo') || c.startsWith('systemctl restart')));
});

test('the installed updater\'s paths are fixed in its source', () => {
  const src = readFileSync(updaterSrc, 'utf8');
  for (const line of ["const CONFIG = '/etc/worklane/updates.json';", "const LOG = '/var/lib/worklane/updates.jsonl';", "const OPT = '/opt/worklane';"]) assert.ok(src.includes(line), line);
  assert.doesNotMatch(src, /process\.env\./, 'nothing from the environment');
});

test('setup: off by default, units validated before they\'re installed, a timer every 10 minutes', () => {
  const s = readFileSync(join(repoRoot, 'scripts', 'setup', 'updates.sh'), 'utf8');
  // The config it writes (off) is built by lib.sh's updates_config_json, which updates.sh calls.
  assert.match(readFileSync(join(repoRoot, 'scripts', 'setup', 'lib.sh'), 'utf8'), /updates_config_json\(\) \{[\s\S]*?enabled: false/);
  assert.match(s, /updates_config_json "\$origin"/);
  assert.match(s, /systemd-analyze verify "\$check"/);
  assert.match(s, /mv -f "\$tmp" "\/etc\/systemd\/system\/\$file"/);
  assert.match(s, /OnUnitActiveSec=10min/);
  // Either channel: the unit doesn't claim main (#465).
  const description = /put_unit worklane-update\.service "\[Unit\]\nDescription=(.*)/.exec(s)![1]!;
  assert.doesNotMatch(description, /install main when/);
  assert.match(description, /signed release or main commit/);
  assert.match(s, /install -o root -g root -m 0755 "\$src" "\$tmp"/);
  const analyze = process.platform === 'linux' && spawnSync('systemd-analyze', ['--version']).status === 0;
  if (analyze) {
    for (const m of s.matchAll(/put_unit (worklane-update\.(?:service|timer)) "([\s\S]*?)"\n/g)) {
      const f = join(mkdtempSync(join(tmpdir(), 'unit-')), m[1]!);
      writeFileSync(f, `${m[2]}\n`);
      const r = spawnSync('systemd-analyze', ['verify', f], { encoding: 'utf8' });
      assert.doesNotMatch(r.stderr, new RegExp(`${m[1]!.replace('.', '\\.')}:\\d+:`), `${m[1]} parses`);
    }
  }
});

test('the dashboard\'s reader: settings and the log, torn lines skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upd-'));
  writeFileSync(join(dir, 'updates.json'), JSON.stringify({ enabled: true, repo_url: 'https://github.com/example-org/engine.git', required_checks: ['test', 3] }));
  assert.deepEqual(updateSettings(join(dir, 'updates.json')), { enabled: true, channel: 'main', repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'], canary: null });
  assert.equal(updateSettings(join(dir, 'none.json')), null);
  writeFileSync(join(dir, 'log'), `${JSON.stringify({ at: '1', event: 'installed', from: OLD, to: NEW })}\nnope\n${JSON.stringify({ at: '2', event: 'other' })}\n${JSON.stringify({ at: '3', event: 'rolled_back' })}\n`);
  assert.deepEqual(updateLog(join(dir, 'log')).map((e) => e.event), ['installed', 'rolled_back']);
  writeFileSync(join(dir, 'log2'), `${JSON.stringify({ at: '4', event: 'held', to: NEW, reason: 'rolled back' })}\n`);
  assert.deepEqual(updateLog(join(dir, 'log2')).map((e) => e.event), ['held'], 'held entries reach the dashboard');
});

// The real build and install, on a disposable Linux CI runner with systemd and passwordless sudo: the machine's own
// sudo on purpose (#991, machineTool); elsewhere its stand-in answers, and these skip.
const SUDO = machineTool('sudo');
const systemCi = process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true' && spawnSync(SUDO, ['-n', 'systemctl', '--version']).status === 0;
const sudo = (args: string[], timeout = 120_000) => spawnSync(SUDO, ['-n', ...args], { encoding: 'utf8', timeout });

test('acceptance: built as a DynamicUser and installed, the engine is readable by and starts as other users, exec\'d through a symlink like the services do', { skip: !systemCi && 'needs a disposable Linux CI runner with systemd', timeout: 30 * 60_000 }, (t) => {
  const node = process.execPath;
  if (sudo(['-u', 'nobody', node, '--version']).status !== 0) return t.skip(`nobody can't run ${node}`);
  const id = `wl-acc-${process.pid}`;
  // This checkout's committed tree as a one-commit repo (CI checkouts are shallow, which git won't push
  // from); the build unit has ProtectHome and a private /tmp, so its copy lives under /var/lib.
  const work = mkdtempSync(join(tmpdir(), 'src-'));
  const tree = join(work, 'tree');
  const bare = join(work, 'repo.git');
  const run = (cmd: string, args: string[], cwd?: string) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  run('mkdir', ['-p', tree]);
  run('sh', ['-c', 'git -C "$1" archive HEAD | tar -x -C "$2"', '_', repoRoot, tree]);
  run('git', ['init', '-q', '-b', 'main'], tree);
  run('git', ['add', '-A'], tree);
  run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'acceptance'], tree);
  const sha = run('git', ['rev-parse', 'HEAD'], tree);
  run('git', ['clone', '-q', '--bare', tree, bare]);
  const src = `/var/lib/${id}-src.git`;
  const state = `${id}-build`;
  const opt = `/var/lib/${id}-opt`;
  const bin = `/var/lib/${id}-bin`;
  const user = id;
  try {
    assert.equal(sudo(['cp', '-a', bare, src]).status, 0);
    assert.equal(sudo(['chmod', '-R', 'a+rX', src]).status, 0);
    // The dynamic user doesn't own the source repo: let git clone it (on this disposable runner only).
    assert.equal(sudo(['git', 'config', '--system', '--add', 'safe.directory', src]).status, 0);
    const build = sudo(u.buildCommand(`file://${src}`, sha, state), 25 * 60_000);
    assert.equal(build.status, 0, `build: ${(build.stderr ?? '').slice(-2000)}`);
    assert.equal(sudo(['install', '-d', '-o', 'root', '-g', 'root', '-m', '0755', opt, bin]).status, 0);
    const install = sudo([node, '-e', `require(${JSON.stringify(updaterSrc)}).installTree(${JSON.stringify(sha)}, ${JSON.stringify(opt)}, ${JSON.stringify(`/var/lib/${state}`)})`]);
    assert.equal(install.status, 0, `install: ${install.stderr}`);
    const dest = join(opt, sha);
    const cli = join(dest, 'dist', 'src', 'cli.js');
    assert.equal(statSync(cli).mode & 0o777, 0o755);
    assert.equal(statSync(cli).uid, 0, 'root-owned');
    // /usr/local/bin/worklane points at current/dist/src/cli.js, and the units exec it directly.
    assert.equal(sudo(['ln', '-s', cli, join(bin, 'worklane')]).status, 0);
    assert.equal(sudo(['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', user]).status, 0);
    for (const who of ['nobody', user]) {
      const unreadable = sudo(['-u', who, 'find', join(dest, 'dist'), join(dest, 'node_modules'), join(dest, 'package.json'), '(', '-type', 'd', '!', '-executable', '-o', '!', '-readable', ')', '-print']);
      assert.equal(unreadable.status, 0, unreadable.stderr);
      assert.equal(unreadable.stdout.trim(), '', `${who} can't read: ${unreadable.stdout.slice(0, 500)}`);
      assert.equal(sudo(['-u', who, 'test', '-x', join(bin, 'worklane')]).status, 0, `${who}: test -x`);
      const help = sudo(['-u', who, 'env', `PATH=${dirname(node)}:/usr/bin:/bin`, join(bin, 'worklane'), '--help']);
      assert.equal(help.status, 0, `${who}: exec through the symlink: ${help.stderr}`);
      const imp = sudo(['-u', who, node, '-e', 'import(process.argv[1]).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })', join(dest, 'dist', 'src', 'service.js')]);
      assert.equal(imp.status, 0, `${who}: import service.js: ${imp.stderr}`);
    }
  } finally {
    sudo(['git', 'config', '--system', '--unset-all', 'safe.directory', src]);
    sudo(['userdel', user]);
    sudo(['rm', '-rf', src, opt, bin, `/var/lib/private/${state}`, `/var/lib/${state}`]);
  }
});

// #760: the updater replaces itself only after a healthy install from a release tag the run verified; never on main,
// never on a rollback; a refusal is in the installed line and the journal. (syncSelf itself: test/updater-self.test.ts)
test('run: the updater takes the release\'s updater only after a healthy install from a verified release tag, never on main or a rollback', async () => {
  type Self = { state: string; reason?: string };
  const onRelease = (selfResult: Self, verified: { ok: boolean; base?: string; object?: string; commit?: string; reason?: string } = { ok: true, base: 'c'.repeat(40), object: '3'.repeat(40), commit: NEW }) => {
    const m = machine();
    const self: string[][] = [];
    const warned: string[] = [];
    const base = m.deps.exec;
    Object.assign(m.deps, {
      config: () => ({ enabled: true, channel: 'release', allowed_signers: '/etc/worklane/allowed_signers', repo_url: 'https://github.com/example-org/engine.git', required_checks: ['test'] }),
      installedVersion: () => '0.4.1',
      verifyRelease: () => verified,
      exec: (file: string, args: string[]) => (file === 'git' ? `${'3'.repeat(40)}\trefs/tags/v0.5.0\n${NEW}\trefs/tags/v0.5.0^{}\n` : base(file, args)),
      selfUpdate: (signers: string, tag: string, sha: string) => (m.calls.push('selfUpdate'), self.push([signers, tag, sha]), selfResult),
      warn: (line: string) => warned.push(line),
    });
    return { ...m, self, warned };
  };
  const ok = onRelease({ state: 'updated' });
  assert.equal(await u.run(ok.deps), 'installed');
  assert.deepEqual(ok.self, [['/etc/worklane/allowed_signers', 'v0.5.0', NEW]], 'the verified tag, the engine just installed');
  const order = ok.calls.filter((c) => /^(switchTo|selfUpdate)/.test(c));
  assert.deepEqual(order, ['switchTo bbbb', 'selfUpdate'], 'after the switch and the health check');
  assert.deepEqual(ok.logs.find((l) => l.event === 'installed')!.updater, { state: 'updated' });
  // A refused one leaves it as it is (syncSelf), and says why in the installed line and the journal.
  const no = onRelease({ state: 'refused', reason: 'not newer' });
  assert.equal(await u.run(no.deps), 'installed');
  assert.deepEqual(no.logs.find((l) => l.event === 'installed')!.updater, { state: 'refused', reason: 'not newer' });
  assert.deepEqual(no.warned, ["the updater wasn't replaced: not newer"]);
  // A release whose services don't come up: rolled back, the updater never asked.
  const bad = onRelease({ state: 'updated' });
  bad.states[NEW] = ['failed'];
  assert.equal(await u.run(bad.deps), 'rolled_back');
  assert.deepEqual(bad.self, []);
  // An unverified tag: refused before anything is built, the updater never asked.
  const unsigned = onRelease({ state: 'updated' }, { ok: false, reason: "v0.5.0's signature doesn't verify" });
  assert.equal(await u.run(unsigned.deps), 'refused');
  assert.deepEqual(unsigned.self, []);
  // Main has no signature to check: never.
  const main = machine({ selfUpdate: () => assert.fail('selfUpdate on the main channel') });
  assert.equal(await u.run(main.deps), 'installed');
  assert.equal(main.logs.find((l) => l.event === 'installed')!.updater, undefined);
});

// ---- #764: the release verified is the release built: its own name, one tag object, no replace refs ----
// Real git and real ssh signatures (ssh-keygen) in temp dirs, as test/updater-self.test.ts does; the origin stands in
// for GitHub, and run()'s ls-remote is the real one on it.

const sshPosix = process.platform === 'win32' && 'ssh signing in POSIX shells';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const strExec = (f: string, a: string[]) => execFileSync(f, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const bufExec = (f: string, a: string[]) => execFileSync(f, a, { stdio: ['ignore', 'pipe', 'pipe'] });
const UPDATER_BODY = "// the release's updater\n";
/** A fresh path for a root-owned verification clone (verifyRelease creates it). */
const verifyClone = () => join(mkdtempSync(join(tmpdir(), 'rel764-verify-')), 'v.git');
/** Into the verification clone: the origin's `ref` under the same name, for a test to plant or swap to. */
const into = (gitDir: string, from: string, ref: string) => execFileSync('git', ['--git-dir', gitDir, 'fetch', '-q', from, `+${ref}:${ref}`], { stdio: 'ignore' });

/** An origin with a main commit and release commits off it (dist/ only unless `extra`), tagged signed, by a stranger, or unsigned. */
function signedOrigin() {
  const dir = mkdtempSync(join(tmpdir(), 'rel764-origin-'));
  const keys = mkdtempSync(join(tmpdir(), 'rel764-keys-'));
  const key = join(keys, 'release');
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'release', '-f', key]);
  // A real signature, by a key that isn't in allowed_signers.
  const stranger = join(keys, 'stranger');
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'stranger', '-f', stranger]);
  const signers = join(keys, 'allowed_signers');
  writeFileSync(signers, `owner@example.com namespaces="git" ${readFileSync(`${key}.pub`, 'utf8').trim()}\n`);
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Owner'], ['user.email', 'owner@example.com'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['gpg.format', 'ssh'], ['user.signingkey', key]]) git(dir, 'config', k!, v!);
  mkdirSync(join(dir, 'scripts', 'machine'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'machine', 'worklane-update.cjs'), UPDATER_BODY);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'main');
  const main = git(dir, 'rev-parse', 'HEAD');
  /** A commit off main, untagged: dist/ only, or with README.md too (`extra`), or another updater (`updater`). */
  const commit = (label: string, o: { extra?: boolean; updater?: string } = {}) => {
    git(dir, 'checkout', '-q', '--detach', main);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'cli.js'), `// ${label}\n`);
    if (o.extra) writeFileSync(join(dir, 'README.md'), `${label}\n`);
    if (o.updater) writeFileSync(join(dir, 'scripts', 'machine', 'worklane-update.cjs'), o.updater);
    git(dir, 'add', '-f', '-A');
    git(dir, 'commit', '-q', '-m', label);
    const c = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', '-f', 'main');
    return c;
  };
  /** refs/tags/<name> (moved if it exists) at `at`: signed by the release key, by the stranger's key, or unsigned. Returns its tag object. */
  const tag = (name: string, how: 'signed' | 'stranger' | 'unsigned', at: string) => {
    git(dir, '-c', `user.signingkey=${how === 'stranger' ? stranger : key}`, 'tag', '-f', how === 'unsigned' ? '-a' : '-s', name, '-m', name, at);
    return git(dir, 'rev-parse', `refs/tags/${name}`);
  };
  return { dir, signers, main, commit, tag };
}

/** run() on the release channel against the origin: the real ls-remote, then `between` (a push), then the real verifyRelease. */
function releaseMachine(o: ReturnType<typeof signedOrigin>, installedVersion: string, between: () => void = () => {}) {
  const m = machine();
  const gitDir = verifyClone();
  const base = m.deps.exec;
  Object.assign(m.deps, {
    config: () => ({ enabled: true, channel: 'release', allowed_signers: o.signers, repo_url: 'https://github.com/example-org/engine.git', required_checks: ['test'] }),
    installedVersion: () => installedVersion,
    exec: (file: string, args: string[]) => (file === 'git' ? strExec('git', ['ls-remote', '--tags', o.dir, 'refs/tags/v*']) : base(file, args)),
    verifyRelease: (_url: string, tag: string, signers: string) => (between(), u.verifyRelease(o.dir, tag, signers, strExec, gitDir)),
  });
  return { ...m, gitDir, built: () => m.calls.some((c) => /^(systemd-run|installTree|switchTo)/.test(c)) };
}

test('#764: an old signed release tag pushed under a higher version\'s ref name is refused, the reason logged, and nothing is built', { skip: sshPosix }, async () => {
  const o = signedOrigin();
  const oldTag = o.tag('v0.4.0', 'signed', o.commit('Release v0.4.0'));
  const current = o.commit('Release v0.5.0');
  o.tag('v0.5.0', 'signed', current);
  // Someone who can push tags puts v0.4.0's signed tag object at refs/tags/v0.9.9: its signature is the owner's.
  git(o.dir, 'update-ref', 'refs/tags/v0.9.9', oldTag);
  assert.deepEqual(u.verifyRelease(o.dir, 'v0.9.9', o.signers, strExec, verifyClone()), { ok: false, reason: "v0.9.9's signed tag object names itself v0.4.0: a signed tag counts only under its own name" });
  const m = releaseMachine(o, '0.5.0');
  assert.equal(await u.run(m.deps), 'refused');
  assert.deepEqual(m.logs.map((l) => [l.event, l.reason]), [['refused', "v0.9.9's signed tag object names itself v0.4.0: a signed tag counts only under its own name"]]);
  assert.equal(m.built(), false, 'nothing built or switched');
  assert.equal(m.current(), OLD);
  // Without the renamed ref, v0.5.0 is the newest and not newer than the installed one: never back to v0.4.0.
  git(o.dir, 'update-ref', '-d', 'refs/tags/v0.9.9');
  assert.equal(await u.run(releaseMachine(o, '0.5.0').deps), 'current');
  // The control: a machine on v0.4.0 installs v0.5.0, the commit its signed tag object points at.
  const up = releaseMachine(o, '0.4.0');
  assert.equal(await u.run(up.deps), 'installed');
  assert.equal(up.current(), current);
});

test('#764: the tag ref moved in the verification clone after verify-tag is refused: every check is on the one object it resolved to', { skip: sshPosix }, () => {
  const o = signedOrigin();
  const signed = o.commit('Release v0.6.0');
  const good = o.tag('v0.6.0', 'signed', signed);
  // Another release commit off main, dist/ only, tagged v0.6.0 by a key that isn't allowed: it would pass every check
  // but the signature, so only a check made on the moved name could let it through.
  const other = o.tag('v0.6.0', 'stranger', o.commit('other'));
  git(o.dir, 'update-ref', 'refs/swap/other', other);
  git(o.dir, 'update-ref', 'refs/tags/v0.6.0', good);
  const gitDir = verifyClone();
  // The control: unmoved, it verifies (read field by field, so an updater that reports less still gets this far).
  const control = u.verifyRelease(o.dir, 'v0.6.0', o.signers, strExec, gitDir) as Record<string, unknown>;
  assert.deepEqual([control.ok, control.base], [true, o.main], String(control.reason));
  assert.deepEqual([control.object ?? good, control.commit ?? signed], [good, signed]);
  into(gitDir, o.dir, 'refs/swap/other');
  let swapped = false;
  // A second writer in the clone: the ref moves the moment verify-tag has passed on the signed object.
  const racing = (f: string, a: string[]) => {
    const out = strExec(f, a);
    if (!swapped && a.includes('verify-tag')) {
      execFileSync('git', ['--git-dir', gitDir, 'update-ref', 'refs/tags/v0.6.0', other]);
      swapped = true;
    }
    return out;
  };
  const r = u.verifyRelease(o.dir, 'v0.6.0', o.signers, racing, gitDir);
  assert.equal(swapped, true, 'the ref moved after verify-tag');
  assert.deepEqual(r, { ok: false, reason: `v0.6.0 moved while it was being verified (from ${good.slice(0, 7)} to ${other.slice(0, 7)})` });
});

test('#764: a tag moved on the origin between ls-remote and the fetch is refused: the commit ls-remote reported must be the one verified, and nothing is built', { skip: sshPosix }, async () => {
  const o = signedOrigin();
  // What ls-remote sees: an unsigned v0.6.0. Then, before the fetch, v0.6.0 is pushed again, signed, at another commit.
  const unsigned = o.commit('Release v0.6.0, unsigned');
  const seen = o.tag('v0.6.0', 'unsigned', unsigned);
  const signed = o.commit('Release v0.6.0');
  let pushed = '';
  const m = releaseMachine(o, '0.5.0', () => void (pushed ||= o.tag('v0.6.0', 'signed', signed)));
  assert.equal(await u.run(m.deps), 'refused');
  assert.ok(pushed, 'the tag moved between ls-remote and the fetch');
  assert.deepEqual(m.logs.map((l) => [l.event, l.to, l.reason]), [['refused', unsigned, `v0.6.0 moved between ls-remote and its verification: ls-remote said tag object ${seen.slice(0, 7)} at ${unsigned.slice(0, 7)}, the one verified is ${pushed.slice(0, 7)} at ${signed.slice(0, 7)}`]]);
  assert.equal(m.built(), false, 'the unsigned commit ls-remote saw is never built');
  assert.equal(m.current(), OLD);
  // The control: with nothing moved, the same signed tag installs, built from the commit ls-remote and the check agree on.
  const again = releaseMachine(o, '0.5.0');
  assert.equal(await u.run(again.deps), 'installed');
  assert.equal(again.current(), signed);
});

test('#764: a replace ref planted in the verification clone doesn\'t change the verdict: a release commit is checked by its own bytes', { skip: sshPosix }, () => {
  const o = signedOrigin();
  // A signed release whose commit changes more than dist/, with a replace ref standing a clean commit in for it.
  const dirty = o.commit('Release v0.6.0', { extra: true });
  o.tag('v0.6.0', 'signed', dirty);
  const clean = o.commit('clean');
  git(o.dir, 'update-ref', 'refs/swap/clean', clean);
  const a = verifyClone();
  assert.match((u.verifyRelease(o.dir, 'v0.6.0', o.signers, strExec, a) as { reason: string }).reason, /changes more than dist\/: README\.md/);
  into(a, o.dir, 'refs/swap/clean');
  execFileSync('git', ['--git-dir', a, 'update-ref', `refs/replace/${dirty}`, clean]);
  assert.equal(execFileSync('git', ['--git-dir', a, 'diff', '--name-only', o.main, dirty], { encoding: 'utf8' }).trim(), 'dist/cli.js', 'the plant is live for a plain git read');
  assert.deepEqual(u.verifyRelease(o.dir, 'v0.6.0', o.signers, strExec, a), { ok: false, reason: "v0.6.0's release commit changes more than dist/: README.md" });
});

test('#764: replace refs planted in the verification clone change neither the tag object and commit verified nor the updater read from it', { skip: sshPosix }, () => {
  const o = signedOrigin();
  // A good signed release, its tag object replaced by another signed v0.6.1 at another commit, and its commit by one
  // with another updater: the object and commit verified are the real ones, and so is the updater read.
  const real = o.commit('Release v0.6.1');
  const realTag = o.tag('v0.6.1', 'signed', real);
  const otherTag = o.tag('v0.6.1', 'signed', o.commit('Release v0.6.1, again'));
  git(o.dir, 'update-ref', 'refs/swap/tag', otherTag);
  git(o.dir, 'update-ref', 'refs/tags/v0.6.1', realTag);
  const evil = o.commit('evil', { updater: '// not the release\'s updater\n' });
  git(o.dir, 'update-ref', 'refs/swap/evil', evil);
  const b = verifyClone();
  const control = u.verifyRelease(o.dir, 'v0.6.1', o.signers, strExec, b) as Record<string, unknown>;
  assert.deepEqual([control.ok, control.base], [true, o.main], `the control, before the plant: ${String(control.reason)}`);
  const before = u.verifiedUpdater(o.signers, 'v0.6.1', real, bufExec, b);
  assert.deepEqual(before.ok ? [before.commit, before.bytes.toString()] : before.reason, [real, UPDATER_BODY], 'the control, before the plant');
  into(b, o.dir, 'refs/swap/tag');
  into(b, o.dir, 'refs/swap/evil');
  // The release commit replaced by one with another updater: the updater read is still the real commit's.
  execFileSync('git', ['--git-dir', b, 'update-ref', `refs/replace/${real}`, evil]);
  assert.notEqual(execFileSync('git', ['--git-dir', b, 'show', `${real}:scripts/machine/worklane-update.cjs`], { encoding: 'utf8' }), UPDATER_BODY, 'the plant is live for a plain git read');
  const self = u.verifiedUpdater(o.signers, 'v0.6.1', real, bufExec, b);
  assert.deepEqual(self.ok ? [self.commit, self.bytes.toString()] : self.reason, [real, UPDATER_BODY], 'the updater read is the real commit\'s');
  // The tag object replaced too, by another signed v0.6.1 at another commit: the object and commit verified are the real ones.
  execFileSync('git', ['--git-dir', b, 'update-ref', `refs/replace/${realTag}`, otherTag]);
  assert.notEqual(execFileSync('git', ['--git-dir', b, 'rev-parse', `${realTag}^{commit}`], { encoding: 'utf8' }).trim(), real, 'the plant is live for a plain git read');
  assert.deepEqual(u.verifyRelease(o.dir, 'v0.6.1', o.signers, strExec, b), { ok: true, base: o.main, object: realTag, commit: real }, 'the real tag object and commit');
  const again = u.verifiedUpdater(o.signers, 'v0.6.1', real, bufExec, b);
  assert.deepEqual(again.ok ? [again.commit, again.bytes.toString()] : again.reason, [real, UPDATER_BODY], 'and the updater, with both planted');
});
