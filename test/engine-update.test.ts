import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateLog, updateSettings } from '../src/updates.js';
import { repoRoot } from './helpers.js';

const updaterSrc = join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs');
type Run = { name: string; status: string; conclusion: string | null; started_at?: string; id?: number };
const u = createRequire(import.meta.url)(updaterSrc) as {
  repoFromUrl(url: string): { owner: string; repo: string } | null;
  fastForward(c: unknown): { ok: boolean; reason?: string };
  evaluateChecks(runs: Run[], required: string[]): { ok: boolean; final?: boolean; reason?: string };
  quiet(e: { name: string; pid: number | null }[], alive: (p: number) => boolean): { quiet: boolean; why?: string };
  parseUnits(s: string): string[];
  health(samples: { at: number; states: Record<string, string> }[], start: number, now: number): string;
  buildCommand(url: string, sha: string): string[];
  run(deps: object): Promise<string>;
  BUILD_SCRIPT: string;
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
  // A rerun that passed supersedes the earlier failure of the same check.
  assert.equal(u.evaluateChecks([ok('test', { conclusion: 'failure', started_at: '2026-01-01T00:00:00Z' }), ok('test', { started_at: '2026-01-01T01:00:00Z', id: 2 }), ok('lint')], req).ok, true);
  assert.deepEqual(u.evaluateChecks([ok('test')], []), { ok: false, final: true, reason: 'no required checks configured in updates.json' });
});

test('quiet only with no live agent or full-run lock and no emergency stop', () => {
  const alive = (p: number) => p === 42;
  assert.deepEqual(u.quiet([], alive), { quiet: true });
  assert.deepEqual(u.quiet([{ name: 'agent-0.lock', pid: 7 }, { name: 'slots.lock', pid: 42 }], alive), { quiet: true }, 'a dead holder and the slot guard don\'t count');
  assert.equal(u.quiet([{ name: 'agent-1.lock', pid: 42 }], alive).quiet, false);
  assert.equal(u.quiet([{ name: 'full-run.lock', pid: 42 }], alive).quiet, false);
  assert.equal(u.quiet([{ name: 'STOP', pid: null }], alive).quiet, false);
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
  const states: Record<string, string[]> = { [NEW]: ['active'], [OLD]: ['active'] };
  const deps = {
    config: () => ({ enabled: true, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'] }),
    installed: () => current,
    exec: (file: string, args: string[]) => {
      calls.push([file, ...args].join(' ').slice(0, 80));
      if (file === 'git') return `${NEW}\trefs/heads/main\n`;
      if (file === 'systemctl' && args[0] === 'list-units') return 'worklane-x.service loaded active running x\nworklane-dashboard-x.service loaded active running y\n';
      if (file === 'systemctl' && args[0] === 'show') return `${(states[current] ?? ['active'])[0]}\n`;
      return '';
    },
    fetchJson: async (url: string) => (url.includes('/compare/') ? { status: 'ahead', ahead_by: 1, behind_by: 0 } : { check_runs: [ok('test')] }),
    slots: () => [],
    alive: () => false,
    installTree: (sha: string) => calls.push(`installTree ${sha.slice(0, 4)}`),
    switchTo: (sha: string) => {
      current = sha;
      calls.push(`switchTo ${sha.slice(0, 4)}`);
    },
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    log: (e: Record<string, unknown>) => logs.push(e),
    note: (event: string, sha: string | null, reason: string) => (logs.push({ event, to: sha, reason }), event),
    ...over,
  };
  return { deps, calls, logs, states, current: () => current };
}

test('run: off does nothing; up to date does nothing', async () => {
  const m = machine({ config: () => ({ enabled: false }) });
  assert.equal(await u.run(m.deps), 'disabled');
  assert.deepEqual(m.calls, []);
  const same = machine({ installed: () => NEW });
  assert.equal(await u.run(same.deps), 'current');
  assert.ok(!same.calls.some((c) => c.startsWith('systemd-run')));
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
  assert.deepEqual(last.failed, ['worklane-x.service: failed', 'worklane-dashboard-x.service: failed']);
  assert.deepEqual(m.calls.filter((c) => c.startsWith('switchTo')), ['switchTo bbbb', 'switchTo aaaa']);
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

test('the installed updater\'s paths are fixed in its source', () => {
  const src = readFileSync(updaterSrc, 'utf8');
  for (const line of ["const CONFIG = '/etc/worklane/updates.json';", "const LOG = '/var/lib/worklane/updates.jsonl';", "const OPT = '/opt/worklane';"]) assert.ok(src.includes(line), line);
  assert.doesNotMatch(src, /process\.env\./, 'nothing from the environment');
});

test('setup: off by default, units validated before they\'re installed, a timer every 10 minutes', () => {
  const s = readFileSync(join(repoRoot, 'scripts', 'setup', 'updates.sh'), 'utf8');
  assert.match(s, /enabled: false/);
  assert.match(s, /systemd-analyze verify "\$check"/);
  assert.match(s, /mv -f "\$tmp" "\/etc\/systemd\/system\/\$file"/);
  assert.match(s, /OnUnitActiveSec=10min/);
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
  assert.deepEqual(updateSettings(join(dir, 'updates.json')), { enabled: true, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'] });
  assert.equal(updateSettings(join(dir, 'none.json')), null);
  writeFileSync(join(dir, 'log'), `${JSON.stringify({ at: '1', event: 'installed', from: OLD, to: NEW })}\nnope\n${JSON.stringify({ at: '2', event: 'other' })}\n${JSON.stringify({ at: '3', event: 'rolled_back' })}\n`);
  assert.deepEqual(updateLog(join(dir, 'log')).map((e) => e.event), ['installed', 'rolled_back']);
});
