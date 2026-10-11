import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  health(samples: { at: number; states: Record<string, string | { state: string; sub: string; restarts: number; result: string }> }[], start: number, now: number): string;
  parseShow(s: string): { state: string; sub: string; restarts: number; result: string };
  redact(s: string): string;
  buildCommand(url: string, sha: string, state?: string): string[];
  installTree(sha: string, opt?: string, buildDir?: string, owner?: string): void;
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
  return { deps, calls, logs, states, current: () => current, held: () => heldEntry, setConfigAt: (t: number) => (configAt = t), setCurrent: (sha: string) => (current = sha) };
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
  assert.deepEqual(last.failed, ['worklane-x.service: failed (failed), exit-code', 'worklane-dashboard-x.service: failed (failed), exit-code']);
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

test('a rolled-back commit is held: not tried again until a newer commit, or updates are turned off and on after it', async () => {
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
  assert.match(String(m.logs.at(-1)!.reason), /rolled back at .*held until a newer commit, or until updates are turned off and on again/);
  assert.ok(!m.calls.slice(before).some((c) => c.startsWith('systemd-run') || c.startsWith('switchTo')));
  // Turning updates off and on (updates.json written after the rollback) releases it.
  m.setConfigAt(Date.parse(held.at) + 1000);
  m.states[NEW] = ['active'];
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
  writeFileSync(join(dir, 'log2'), `${JSON.stringify({ at: '4', event: 'held', to: NEW, reason: 'rolled back' })}\n`);
  assert.deepEqual(updateLog(join(dir, 'log2')).map((e) => e.event), ['held'], 'held entries reach the dashboard');
});

// The real build and install, on a disposable Linux CI runner with systemd and passwordless sudo.
const systemCi = process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true' && spawnSync('sudo', ['-n', 'systemctl', '--version']).status === 0;
const sudo = (args: string[], timeout = 120_000) => spawnSync('sudo', ['-n', ...args], { encoding: 'utf8', timeout });

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
