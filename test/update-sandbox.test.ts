// The engine updater checks the test sandbox after an install (scripts/machine/<cli>-update.cjs): an instance whose
// startup sandbox check passed before the update and fails after the restart rolls the update back and holds it; one
// with no test runs, or already failing, never does; no result in time keeps the install and says so (or holds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { StoredEvent } from '../src/events/types.js';
import { sandboxVerdict as startupVerdict } from '../src/testrun/status.js';
import { updateLog } from '../src/updates.js';
import { updateFindings } from '../src/watchdog/probes.js';
import { KINDS } from '../src/watchdog/index.js';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { checkHelper, HELPER_PROTOCOL } from '../src/testrun/helper.js';
import type { RunHost } from '../src/testrun/host.js';
import { repoRoot } from './helpers.js';

type Inst = { unit: string; name: string; user: string; env: string[] };
type Status = { configured: boolean; last: { ok: boolean; detail: string; at: string } | null } | null;
type Verify = { passed: string[]; failed: { instance: string; detail: string }[]; unconfirmed: string[] };
const u = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as {
  run(deps: object): Promise<string>;
  sandboxCommand(inst: Inst, sha: string, opt?: string): string[];
  parseSandbox(out: unknown): Status;
  sandboxVerdict(before: Status, after: Status, restartedAt: number): 'skip' | 'wait' | 'pass' | 'fail';
  sandboxWaitMs(cfg: unknown): number;
  SANDBOX_INCIDENT: string;
  SANDBOX_POLL_MS: number;
  HELPERS: Helper[];
  syncHelpers(engineDir: string, helpers?: Helper[]): { path: string; state: string }[];
};
type Helper = { dest: string; src: string; check: string };

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const MIN = 60_000;
const T0 = Date.parse('2026-10-13T20:00:00Z');
const at = (ms: number) => new Date(ms).toISOString();
const FAIL = 'FAIL: the sandbox could not write its own /tmp (exit 226)';
const show = (name: string) => `User=wl-${name}\nEnvironment=PATH=/usr/local/bin:/usr/bin:/bin\nExecStart={ path=/usr/local/bin/worklane ; argv[]=/usr/local/bin/worklane coordinator run --instance ${name} ; ignore_errors=no }\n`;

/** What an instance's restarted coordinator says: its check's result, `after` ms after the restart; never: nothing. */
type Says = { ok: boolean; detail?: string; after?: number } | 'never';
/** An instance: its status before the update (null: unreadable), and what its new process says. */
type InstanceSpec = { before: Status; says: Says };
const passedBefore: Status = { configured: true, last: { ok: true, detail: 'ok', at: at(T0 - 60 * MIN) } };

/**
 * A machine with these instances, updating from OLD to NEW. Every unit comes up healthy on either engine. The fake
 * sandboxStatus is the instance's own log: the old verdict until its new process has said.
 */
function machine(instances: Record<string, InstanceSpec>, cfg: Record<string, unknown> = {}, over: { syncHelpers?: (sha: string) => { path: string; state: string }[]; onStatusAfterRestart?: () => void } = {}) {
  const calls: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const incidents: string[] = [];
  const asked: string[] = [];
  let engine = OLD;
  let clock = T0;
  let held: { sha: string; at: string; failed: string[] } | null = null;
  let restartedAt: number | null = null;
  const names = Object.keys(instances);
  const units = names.map((n) => `worklane-${n}.service`);
  const deps = {
    config: () => ({ enabled: true, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'], ...cfg }),
    installed: () => engine,
    exec: (file: string, args: string[]) => {
      if (file === 'git') return `${NEW}\trefs/heads/main\n`;
      if (file === 'systemctl' && args[0] === 'list-units') return units.map((x) => `${x} loaded active running x`).join('\n');
      if (file === 'systemctl' && args[0] === 'show' && args[2] === 'User,Environment,ExecStart') return show(/worklane-([a-z]+)\./.exec(args[3]!)![1]!);
      if (file === 'systemctl' && args[0] === 'show') return 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n';
      if (file === 'systemctl' && (args[0] === 'restart' || args[0] === 'stop')) {
        calls.push(`${args[0]} on ${engine.slice(0, 4)}`);
        if (args[0] === 'restart' && engine === NEW) restartedAt = clock;
        return '';
      }
      if (file === 'systemd-run' && args.includes('migrate')) return `${JSON.stringify({ ok: true, applied: [{ kind: 'state', path: 'x', from: 1, to: 2 }], made: [{ kind: 'state', path: '/srv/x/events.db', backup: '/srv/x/events.db.bak' }] })}\n`;
      if (file === 'systemd-run' && args.includes('/bin/sh')) return (calls.push(`restore ${args[args.indexOf('-p') + 1]!.replace('User=wl-', '')}`), '');
      return '';
    },
    fetchJson: async (url: string) => (url.includes('/compare/') ? { status: 'ahead', ahead_by: 1, behind_by: 0 } : { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', started_at: '1', id: 1 }] }),
    slots: () => [],
    alive: () => false,
    installTree: () => {},
    syncHelpers: (sha: string) => (calls.push(`syncHelpers ${sha.slice(0, 4)}`), over.syncHelpers ? over.syncHelpers(sha) : [{ path: '/usr/local/libexec/worklane-testrun', state: 'updated' }]),
    switchTo: (sha: string) => ((engine = sha), calls.push(`switchTo ${sha.slice(0, 4)}`)),
    now: () => clock,
    sleep: async (ms: number) => void (clock += ms),
    log: (e: Record<string, unknown>) => logs.push({ at: at(clock), ...e }),
    held: () => held,
    hold: (e: { sha: string; at: string; failed: string[] }) => void (held = e),
    configChangedAt: () => 0,
    note: (event: string, sha: string | null, reason: string) => (logs.push({ at: at(clock), event, to: sha, reason }), event),
    sandboxStatus: (inst: Inst, sha: string): Status => {
      assert.equal(sha, NEW, "the new engine's command reads the log");
      const spec = instances[inst.name]!;
      asked.push(`${inst.name}${restartedAt === null ? ' before' : ''}`);
      if (restartedAt === null || spec.before === null) return spec.before;
      over.onStatusAfterRestart?.();
      const s = spec.says;
      if (s === 'never' || clock < restartedAt + (s.after ?? 0)) return spec.before;
      return { configured: true, last: { ok: s.ok, detail: s.detail ?? (s.ok ? 'ok' : FAIL), at: at(restartedAt + (s.after ?? 0)) } };
    },
    raiseIncident: (kind: string, key: string, detail: string, fix: string) => void incidents.push(`raise ${kind} ${key}: ${detail} | ${fix}`),
    resolveIncident: (kind: string, key: string) => void incidents.push(`resolve ${kind} ${key}`),
  };
  const last = (event: string) => [...logs].reverse().find((l) => l.event === event) as (Record<string, unknown> & { reason?: string; sandbox?: Verify }) | undefined;
  return { deps, calls, logs, incidents, asked, engine: () => engine, held: () => held, last, clock: () => clock, restartedAt: () => restartedAt };
}

test('passed before, fails after the restart: rolled back to the previous engine, helpers and backups too, the commit held, the reason names the instance and what the check said', async () => {
  const m = machine({ alice: { before: passedBefore, says: { ok: false, detail: `${FAIL}\n  GH_TOKEN=ghs_${'a'.repeat(36)}` } }, bob: { before: passedBefore, says: { ok: true } } });
  assert.equal(await u.run(m.deps), 'rolled_back');
  assert.equal(m.engine(), OLD, 'the previous engine');
  assert.deepEqual(m.calls, ['stop on aaaa', 'syncHelpers bbbb', 'switchTo bbbb', 'restart on bbbb', 'stop on bbbb', 'restore alice', 'restore bob', 'syncHelpers aaaa', 'switchTo aaaa', 'restart on aaaa'], 'the existing rollback: backups put back, the old engine\'s helpers, the old engine, restarted');
  assert.equal(m.held()!.sha, NEW, 'the new commit is held: not retried by itself');
  const rb = m.last('rolled_back')!;
  assert.equal(rb.reason, `rollback: the test sandbox check passed before the update and fails after it: alice: ${FAIL} GH_TOKEN=[redacted]`);
  assert.ok(!JSON.stringify(m.logs).includes('ghs_'), 'no secret in the log');
  assert.deepEqual([rb.from, rb.to, rb.held, rb.back], [NEW, OLD, true, 'healthy']);
  assert.equal(m.last('installed'), undefined, 'never called installed');
  // The incident: the watchdog's update_rollback, from that log line, as for every rollback today.
  const dir = mkdtempSync(join(tmpdir(), 'upd-'));
  writeFileSync(join(dir, 'updates.jsonl'), m.logs.map((l) => JSON.stringify(l)).join('\n'));
  const findings = updateFindings(updateLog(join(dir, 'updates.jsonl')));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.kind, 'update_rollback');
  assert.match(findings[0]!.detail, /was rolled back and is held: rollback: the test sandbox check passed before the update and fails after it: alice: FAIL: the sandbox could not write its own \/tmp \(exit 226\)/);
  // Held: the next run doesn't try it again.
  assert.equal(await u.run(m.deps), 'held');
  assert.equal(m.engine(), OLD);
});

test('passed before, passes after: installed, and only on a result newer than the restart', async () => {
  // The new process takes 25 seconds after the units settled to say: the old "ok" in the log is not taken for it.
  const m = machine({ alice: { before: passedBefore, says: { ok: true, after: 55_000 } } });
  assert.equal(await u.run(m.deps), 'installed');
  assert.equal(m.engine(), NEW);
  assert.ok(m.clock() >= m.restartedAt()! + 55_000, 'it waited for the restarted process\'s own result');
  assert.ok(m.asked.filter((a) => a === 'alice').length >= 2, 'asked again until it came');
  assert.deepEqual(m.last('installed')!.sandbox, { passed: ['alice'], unconfirmed: [] });
  assert.equal(m.held(), null);
  assert.deepEqual(m.incidents, [`resolve ${u.SANDBOX_INCIDENT} alice`]);
  assert.equal(u.sandboxVerdict(passedBefore, passedBefore, T0), 'wait', 'a verdict from before the restart');
  assert.equal(u.sandboxVerdict(passedBefore, { configured: true, last: { ok: true, detail: '', at: at(T0) } }, T0), 'pass');
  assert.equal(u.sandboxVerdict(passedBefore, { configured: true, last: { ok: false, detail: 'x', at: at(T0 + 1) } }, T0), 'fail');
  assert.equal(u.sandboxVerdict(passedBefore, null, T0), 'wait', 'unreadable now: not a verdict');
});

test('no test runs configured, no result before, unreadable before, or already failing before: never waited for, never a rollback', async () => {
  const failing: Status = { configured: true, last: { ok: false, detail: FAIL, at: at(T0 - 60 * MIN) } };
  const specs: Record<string, InstanceSpec> = {
    plain: { before: { configured: false, last: null }, says: 'never' }, // no test_run in its tests.yaml
    stale: { before: { configured: false, last: { ok: true, detail: 'ok', at: at(T0 - 9000 * MIN) } }, says: 'never' }, // test runs taken out of its config since
    fresh: { before: { configured: true, last: null }, says: { ok: false } }, // configured, never started with them
    unread: { before: null, says: { ok: false } },
    broken: { before: failing, says: { ok: false } }, // failing before: the watchdog's test_sandbox incident has it
  };
  const m = machine(specs);
  const began = m.clock();
  assert.equal(await u.run(m.deps), 'installed');
  assert.equal(m.engine(), NEW);
  assert.deepEqual(m.asked, ['plain before', 'stale before', 'fresh before', 'unread before', 'broken before'], 'asked once before the switch, and not again');
  assert.equal(m.last('installed')!.sandbox, undefined);
  assert.deepEqual([m.held(), m.incidents], [null, []]);
  assert.ok(m.clock() - began < 2 * MIN, 'no sandbox wait on top of the health check');
  for (const [name, s] of Object.entries(specs)) assert.equal(u.sandboxVerdict(s.before, { configured: true, last: { ok: false, detail: FAIL, at: at(T0 + 1) } }, T0), 'skip', name);
});

test('no result in time: the install stands and an incident says it couldn\'t be confirmed; the wait is bounded and configurable', async () => {
  const m = machine({ alice: { before: passedBefore, says: 'never' }, bob: { before: passedBefore, says: { ok: true } } });
  assert.equal(await u.run(m.deps), 'installed');
  assert.equal(m.engine(), NEW, 'kept: no evidence of a regression');
  assert.equal(m.held(), null);
  assert.deepEqual(m.last('installed')!.sandbox, { passed: ['bob'], unconfirmed: ['alice'] });
  assert.equal(m.incidents.length, 2);
  assert.equal(m.incidents[0], `resolve ${u.SANDBOX_INCIDENT} bob`);
  assert.match(m.incidents[1]!, /^raise update_sandbox_unconfirmed alice: after the update to bbbbbbb, alice gave no test sandbox result within 5 minutes of its restart/);
  const waited = m.clock() - m.restartedAt()!;
  assert.ok(waited >= 5 * MIN && waited < 6 * MIN, `the default 5 minutes, then it stops: ${waited}`);
  assert.equal(u.sandboxWaitMs({}), 5 * MIN);
  for (const junk of [0, -1, '3', null]) assert.equal(u.sandboxWaitMs({ sandbox_wait_minutes: junk }), 5 * MIN);
  // A shorter wait from updates.json.
  const short = machine({ alice: { before: passedBefore, says: 'never' } }, { sandbox_wait_minutes: 1 });
  assert.equal(await u.run(short.deps), 'installed');
  const w = short.clock() - short.restartedAt()!;
  assert.ok(w >= 1 * MIN && w < 2 * MIN, String(w));
  assert.match(short.incidents[0]!, /within 1 minutes of its restart/);
  assert.deepEqual(KINDS.update_sandbox_unconfirmed, { title: "An engine update couldn't confirm the test sandbox", severity: 'amber' });
});

test('sandbox_on_timeout: hold: no result in time rolls back and holds; a failure still names the failing instance', async () => {
  const m = machine({ alice: { before: passedBefore, says: 'never' } }, { sandbox_on_timeout: 'hold', sandbox_wait_minutes: 2 });
  assert.equal(await u.run(m.deps), 'rolled_back');
  assert.equal(m.engine(), OLD);
  assert.equal(m.held()!.sha, NEW);
  assert.equal(m.last('rolled_back')!.reason, 'rollback: no test sandbox result from alice within 2 minutes of the restart (sandbox_on_timeout: hold)');
  // Anything but "hold" proceeds.
  const other = machine({ alice: { before: passedBefore, says: 'never' } }, { sandbox_on_timeout: 'rollback-please', sandbox_wait_minutes: 1 });
  assert.equal(await u.run(other.deps), 'installed');
  // A failure doesn't wait out the others' timeout, and is what the reason gives.
  const f = machine({ alice: { before: passedBefore, says: 'never' }, bob: { before: passedBefore, says: { ok: false } } }, { sandbox_on_timeout: 'hold' });
  assert.equal(await u.run(f.deps), 'rolled_back');
  assert.equal(f.last('rolled_back')!.reason, `rollback: the test sandbox check passed before the update and fails after it: bob: ${FAIL}`);
  assert.ok(f.clock() - f.restartedAt()! < 2 * MIN, 'rolled back at the first failure');
});

test('the command: the new engine\'s sandbox-status as the instance\'s own user, and its answer; no answer is unknown, never a verdict', () => {
  const inst: Inst = { unit: 'worklane-alice.service', name: 'alice', user: 'wl-alice', env: ['PATH=/usr/bin'] };
  const cmd = u.sandboxCommand(inst, NEW);
  assert.deepEqual(cmd.slice(0, 2), ['systemd-run', '--wait']);
  assert.ok(cmd.includes('User=wl-alice'), 'never as root');
  assert.deepEqual(cmd.slice(-6), ['node', `/opt/worklane/${NEW}/dist/src/cli.js`, 'sandbox-status', '--instance', 'alice', '--json']);
  const ok = { ok: true, configured: true, last: { ok: false, detail: FAIL, at: at(T0) } };
  assert.deepEqual(u.parseSandbox(`a warning line\n${JSON.stringify(ok)}\n`), { configured: true, last: { ok: false, detail: FAIL, at: at(T0) } });
  assert.deepEqual(u.parseSandbox(JSON.stringify({ ok: true, configured: false, last: null })), { configured: false, last: null });
  for (const bad of ['', 'not json', JSON.stringify({ ok: false, error: 'no instance "x"' }), undefined]) assert.equal(u.parseSandbox(bad), null, String(bad));
  assert.deepEqual(u.parseSandbox(JSON.stringify({ ok: true, configured: true, last: { ok: 'yes', at: 'x' } })), { configured: true, last: null }, 'a malformed verdict is none');
});

test('the instance\'s startup verdict, from its events: the sandbox check\'s newest result, or an outdated helper', () => {
  let id = 0;
  const ev = (type: string, payload: unknown, ts: string) => ({ id: ++id, ts, type, actor: 'coordinator', source: 'system', payload }) as unknown as StoredEvent;
  assert.equal(startupVerdict([]), null, 'no test runs: it never said');
  const first = [ev('testrun.helper', { ok: true, have: 5, need: 5, detail: '' }, at(T0)), ev('testrun.sandbox', { ok: true, detail: 'ok' }, at(T0 + 1000))];
  assert.deepEqual(startupVerdict(first), { ok: true, detail: 'ok', at: at(T0 + 1000) });
  // The incident: the next start's check fails.
  const second = [...first, ev('testrun.helper', { ok: true, have: 5, need: 5, detail: '' }, at(T0 + MIN)), ev('testrun.sandbox', { ok: false, detail: FAIL }, at(T0 + MIN + 1000))];
  assert.deepEqual(startupVerdict(second), { ok: false, detail: FAIL, at: at(T0 + MIN + 1000) });
  // An outdated helper skips the check and refuses every run: that start's verdict is a failure too.
  const third = [...first, ev('testrun.helper', { ok: false, have: 4, need: 5, detail: 'the helper speaks protocol 4, this engine needs 5' }, at(T0 + 2 * MIN))];
  assert.deepEqual(startupVerdict(third), { ok: false, detail: 'the helper speaks protocol 4, this engine needs 5', at: at(T0 + 2 * MIN) });
});

/**
 * A machine's root helpers on disk, and two engines' copies of every one in HELPERS: the old engine's are this
 * repo's own files, the new engine's differ in bytes (the test-run helper speaks the next protocol, as a helper
 * change does). syncHelpers is the updater's real one, on these paths.
 */
function helperWorld() {
  const root = mkdtempSync(join(tmpdir(), 'upd-helpers-'));
  const libexec = join(root, 'libexec');
  mkdirSync(libexec);
  const helpers = u.HELPERS.map((h) => ({ ...h, dest: join(libexec, basename(h.dest)) }));
  const bytes: Record<string, Record<string, Buffer>> = { [OLD]: {}, [NEW]: {} };
  for (const h of u.HELPERS) {
    const own = readFileSync(join(repoRoot, h.src));
    const next = /worklane-testrun\.sh$/.test(h.src) ? Buffer.from(own.toString('utf8').replace(/^PROTOCOL=\d+$/m, `PROTOCOL=${HELPER_PROTOCOL + 1}`)) : Buffer.concat([own, Buffer.from(h.check === 'node' ? '\n// the next engine\'s\n' : '\n# the next engine\'s\n')]);
    assert.ok(!own.equals(next), `${h.src}: the new engine's copy differs`);
    for (const [sha, b] of [[OLD, own], [NEW, next]] as const) {
      const f = join(root, 'opt', sha, h.src);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, b);
      bytes[sha]![h.src] = b;
    }
  }
  // Installed as the setup scripts leave them: the old engine's copies, each with its own mode.
  const modes = [0o755, 0o750, 0o555];
  helpers.forEach((h, i) => {
    writeFileSync(h.dest, bytes[OLD]![h.src]!);
    chmodSync(h.dest, modes[i % modes.length]!);
  });
  const stat = () => helpers.map((h) => ((st) => ({ uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 }))(statSync(h.dest)));
  const onDisk = (sha: string) => helpers.every((h) => readFileSync(h.dest).equals(bytes[sha]![h.src]!));
  /** The engine's own protocol check (src/testrun/helper.ts), asking the test-run helper on disk for its version. */
  const protocol = () => {
    const testrun = helpers.find((h) => /testrun$/.test(h.dest))!;
    const host = { helperVersion: async () => ((r) => ({ version: Number(r.stdout.trim()), stderr: r.stderr }))(spawnSync('bash', [testrun.dest, 'alice', 'version'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })) } as unknown as RunHost;
    return checkHelper(host, 'alice');
  };
  return { root, libexec, helpers, stat, onDisk, protocol, sync: (sha: string) => u.syncHelpers(join(root, 'opt', sha), helpers) };
}

const posix = process.platform !== 'win32';

test('the sandbox rollback puts every root helper back: byte for byte the old engine\'s, same owner and mode, before the old engine restarts; its protocol check passes', { skip: !posix && 'POSIX modes and bash' }, async () => {
  const h = helperWorld();
  assert.ok(u.HELPERS.length >= 3 && h.helpers.length === u.HELPERS.length, 'every helper in HELPERS');
  const before = h.stat();
  assert.deepEqual(await h.protocol().then((p) => [p.ok, p.have]), [true, HELPER_PROTOCOL], 'the old engine and its helper agree to begin with');
  let sawNew = false;
  const atRestart: boolean[] = [];
  const m = machine({ alice: { before: passedBefore, says: { ok: false } } }, {}, {
    syncHelpers: (sha) => h.sync(sha),
    // The new engine is running here: every helper on disk is its copy, and the old engine would refuse the test-run one.
    onStatusAfterRestart: () => void (sawNew = h.onDisk(NEW)),
  });
  // What is on disk each time the units are restarted.
  const exec = m.deps.exec;
  m.deps.exec = (file: string, args: string[]) => {
    if (file === 'systemctl' && args[0] === 'restart') atRestart.push(h.onDisk(m.engine()));
    return exec(file, args);
  };
  assert.equal(await u.run(m.deps), 'rolled_back');
  assert.ok(sawNew, 'the install had replaced every helper with the new engine\'s bytes');
  assert.ok(h.onDisk(OLD), 'after the rollback every helper is byte for byte the old engine\'s copy');
  assert.deepEqual(h.stat(), before, 'the same owner, group and mode as before the update');
  assert.deepEqual(await h.protocol().then((p) => [p.ok, p.have, p.detail]), [true, HELPER_PROTOCOL, ''], 'the old engine\'s protocol check passes on the helper on disk');
  assert.deepEqual(atRestart, [true, true], 'each engine started beside its own helpers: the old one\'s were back before its restart');
  assert.deepEqual(m.calls.slice(-4), ['stop on bbbb', 'restore alice', 'syncHelpers aaaa', 'switchTo aaaa', 'restart on aaaa'].slice(-4), 'stop, backups, helpers, switch, restart');
  const rb = m.last('rolled_back') as Record<string, unknown>;
  assert.deepEqual((rb.helpers as { path: string; state: string }[]).map((x) => [basename(x.path), x.state]).sort(), u.HELPERS.map((x) => [basename(x.dest), 'updated']).sort(), 'the log names each helper put back');
  assert.equal(rb.helpers_error, undefined);
  assert.doesNotMatch(String(rb.reason), /could NOT be put back/);
});

test('a helper that can\'t be put back is not a clean rollback: the reason, the hold and the incident say so first', { skip: (!posix || process.getuid?.() === 0) && 'needs POSIX permissions as a non-root user' }, async () => {
  const h = helperWorld();
  const m = machine({ alice: { before: passedBefore, says: { ok: false } } }, {}, {
    syncHelpers: (sha) => h.sync(sha),
    // After the new engine's helpers went in, the directory stops taking writes: the way back fails.
    onStatusAfterRestart: () => chmodSync(h.libexec, 0o555),
  });
  try {
    assert.equal(await u.run(m.deps), 'rolled_back');
  } finally {
    chmodSync(h.libexec, 0o755);
  }
  assert.equal(m.engine(), OLD, 'the engine still goes back');
  assert.ok(h.onDisk(NEW), 'the new engine\'s helpers are still on disk');
  assert.equal((await h.protocol()).ok, false, 'and the old engine refuses the test-run helper');
  const rb = m.last('rolled_back') as Record<string, unknown>;
  assert.match(String(rb.reason), /^rollback: the old engine's root helpers could NOT be put back \(couldn't replace .*worklane-[a-z-]+ with .*\); its test runs are off until they are: sudo bash \/opt\/worklane\/current\/scripts\/setup\/test-user\.sh update-helper; rollback: the test sandbox check passed before the update and fails after it: alice: /);
  assert.match(String(rb.helpers_error), /couldn't replace/);
  assert.match(m.held()!.failed[0]!, /could NOT be put back/);
  const dir = mkdtempSync(join(tmpdir(), 'upd-'));
  writeFileSync(join(dir, 'updates.jsonl'), m.logs.map((l) => JSON.stringify(l)).join('\n'));
  const findings = updateFindings(updateLog(join(dir, 'updates.jsonl')));
  assert.equal(findings[0]!.kind, 'update_rollback');
  assert.match(findings[0]!.detail, /was rolled back and is held: rollback: the old engine's root helpers could NOT be put back/);
});
