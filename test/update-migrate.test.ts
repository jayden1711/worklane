// An unattended engine update never leaves instances down: the updater migrates every instance with the new
// engine (as its coordinator user, after a backup) between the build and the restart; a failed migration rolls
// everything back (old engine, restored files, services up), is recorded, held, and shown to the owner.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitingOnYou } from '../src/digest.js';
import { healthView } from '../src/health.js';
import { heldUpdate, updateLog, type UpdateEntry } from '../src/updates.js';
import { repoRoot } from './helpers.js';

type Inst = { unit: string; name: string; user: string; env: string[] };
const u = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as {
  parseInstance(unit: string, text: string): Inst | null;
  migrateCommand(inst: Inst, sha: string, opt?: string): string[];
  restoreCommand(inst: Inst, b: { backup: string; path: string }): string[];
  run(deps: object): Promise<string>;
};

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const show = (name: string) => `User=wl-${name}\nEnvironment=PATH=/usr/local/bin:/usr/bin:/bin\nExecStart={ path=/usr/local/bin/worklane ; argv[]=/usr/local/bin/worklane coordinator run --instance ${name} ; ignore_errors=no }\n`;

/**
 * A machine with two instances (alice, bob) and a dashboard. Each instance's files are at version 1 or 2; the old
 * engine only starts on version 1, the new one only on 2 (the coordinator's migration gate). `failFor` makes that
 * instance's migrate fail (it restores its own files, as migrate does).
 */
function machine(o: { failFor?: string; newEngineDown?: boolean } = {}) {
  const calls: string[] = [];
  const logs: Record<string, unknown>[] = [];
  let engine = OLD;
  let clock = 0;
  let held: { sha: string; failed: string[] } | null = null;
  const version: Record<string, number> = { alice: 1, bob: 1 };
  const running = new Set<string>();
  const units = ['worklane-alice.service', 'worklane-bob.service', 'worklane-dashboard-alice.service'];
  const up = (unit: string) => {
    const name = /^worklane-([a-z]+)\.service$/.exec(unit)?.[1];
    if (!name || !(name in version)) return !(engine === NEW && o.newEngineDown);
    return engine === NEW ? version[name] === 2 && !o.newEngineDown : version[name] === 1;
  };
  const deps = {
    config: () => ({ enabled: true, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'] }),
    installed: () => engine,
    exec: (file: string, args: string[]) => {
      const line = [file, ...args].join(' ');
      if (file === 'git') return `${NEW}\trefs/heads/main\n`;
      if (file === 'systemctl' && args[0] === 'list-units') return units.map((x) => `${x} loaded active running x`).join('\n');
      if (file === 'systemctl' && args[0] === 'show' && args[2] === 'User,Environment,ExecStart') return /dashboard/.test(args[3]!) ? 'User=wl-alice\nExecStart={ argv[]=/usr/local/bin/worklane dashboard --instance alice --service ; }\n' : show(/worklane-([a-z]+)\./.exec(args[3]!)![1]!);
      if (file === 'systemctl' && args[0] === 'show') return running.has(args[3]!) && up(args[3]!) ? 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n' : 'ActiveState=failed\nSubState=failed\nNRestarts=0\nResult=exit-code\n';
      if (file === 'systemctl' && (args[0] === 'restart' || args[0] === 'stop')) {
        calls.push(`${args[0]} ${args.slice(1).length}`);
        for (const x of args.slice(1)) (args[0] === 'restart' ? running.add(x) : running.delete(x));
        return '';
      }
      if (file === 'systemd-run' && args.includes('migrate')) {
        const name = args[args.indexOf('--instance') + 1]!;
        calls.push(`migrate ${name} as ${args[args.indexOf('-p') + 1]}${running.size ? ' WHILE RUNNING' : ''}${engine === NEW ? ' (switched already)' : ''}`);
        assert.ok(args.includes(`/opt/worklane/${NEW}/dist/src/cli.js`), 'the new engine migrates');
        if (o.failFor === name) {
          const e = new Error('Command failed: systemd-run') as Error & { stdout: string };
          e.stdout = `${JSON.stringify({ ok: false, error: 'tests.yaml: version 2 step failed: no key full_cmd', made: [], restored: [] })}\n`;
          throw e;
        }
        version[name] = 2;
        return `${JSON.stringify({ ok: true, applied: [{ kind: 'state', path: `/srv/${name}/state/events.db`, from: 1, to: 2 }], made: [{ kind: 'state', path: `/srv/${name}/state/events.db`, backup: `/srv/${name}/state/events.db.bak-v1-x` }] })}\n`;
      }
      if (file === 'systemd-run' && args.includes('/bin/sh')) {
        const user = args[args.indexOf('-p') + 1]!.replace('User=wl-', '');
        calls.push(`restore ${user}`);
        version[user] = 1;
        return '';
      }
      if (file === 'systemd-run') return ''; // the build
      if (file === 'journalctl') return 'x';
      calls.push(`? ${line}`);
      return '';
    },
    fetchJson: async (url: string) => (url.includes('/compare/') ? { status: 'ahead', ahead_by: 1, behind_by: 0 } : { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', started_at: '1', id: 1 }] }),
    slots: () => [],
    alive: () => false,
    installTree: () => calls.push('installTree'),
    syncHelpers: () => [],
    switchTo: (sha: string) => ((engine = sha), calls.push(`switchTo ${sha.slice(0, 4)}`)),
    now: () => clock,
    sleep: async (ms: number) => void (clock += ms),
    log: (e: Record<string, unknown>) => logs.push(e),
    held: () => held,
    hold: (e: { sha: string; failed: string[] }) => void (held = e),
    configChangedAt: () => 0,
    note: (event: string, sha: string | null, reason: string) => (logs.push({ event, to: sha, reason }), event),
  };
  const allUp = () => units.every((x) => running.has(x) && up(x));
  return { deps, calls, logs, engine: () => engine, version, held: () => held, allUp };
}

test('an update with a pending migration: services stopped, every instance migrated by the new engine as its own user, then switched; all running, migrated', async () => {
  const m = machine();
  assert.equal(await u.run(m.deps), 'installed');
  assert.deepEqual(m.calls, ['installTree', 'stop 3', 'migrate alice as User=wl-alice', 'migrate bob as User=wl-bob', 'switchTo bbbb', 'restart 3']);
  assert.equal(m.engine(), NEW);
  assert.deepEqual(m.version, { alice: 2, bob: 2 });
  assert.ok(m.allUp(), 'every instance and the dashboard running');
  assert.deepEqual(m.logs.at(-1), { event: 'installed', from: OLD, to: NEW, units: ['worklane-alice.service', 'worklane-bob.service', 'worklane-dashboard-alice.service'], migrated: [{ instance: 'alice', applied: 1 }, { instance: 'bob', applied: 1 }] });
});

test('a failed migration rolls back: the old engine, every instance restored, all running again; recorded and held', async () => {
  const m = machine({ failFor: 'bob' });
  assert.equal(await u.run(m.deps), 'rolled_back');
  assert.deepEqual(m.calls, ['installTree', 'stop 3', 'migrate alice as User=wl-alice', 'migrate bob as User=wl-bob', 'restore alice', 'restart 3']);
  assert.equal(m.engine(), OLD, 'never switched');
  assert.deepEqual(m.version, { alice: 1, bob: 1 }, "alice's migration restored from its backup; bob's migrate restored its own");
  assert.ok(m.allUp(), 'every instance running on the old engine');
  const last = m.logs.at(-1) as unknown as UpdateEntry & { back: string };
  assert.equal(last.event, 'rolled_back');
  assert.match(last.reason!, /^rollback: migration failed: bob: tests\.yaml: version 2 step failed/);
  assert.deepEqual(last.migration, { instance: 'bob', error: 'tests.yaml: version 2 step failed: no key full_cmd', restored: ['alice'], unrestored: [] });
  assert.equal(last.back, 'healthy');
  assert.equal(last.held, true);
  assert.equal(m.held()!.sha, NEW, 'held: not retried every 10 minutes');
  assert.equal(await u.run(m.deps), 'held');
  assert.ok(!m.calls.slice(6).some((c) => c.startsWith('migrate')), 'the held commit is not tried again');
});

test("the new engine not coming up after migrating: the migrations' backups go back before the old engine starts", async () => {
  const m = machine({ newEngineDown: true });
  assert.equal(await u.run(m.deps), 'rolled_back');
  assert.deepEqual(m.calls, ['installTree', 'stop 3', 'migrate alice as User=wl-alice', 'migrate bob as User=wl-bob', 'switchTo bbbb', 'restart 3', 'stop 3', 'restore alice', 'restore bob', 'switchTo aaaa', 'restart 3']);
  assert.deepEqual(m.version, { alice: 1, bob: 1 });
  assert.ok(m.allUp());
  assert.deepEqual((m.logs.at(-1) as { restored: string[] }).restored, ['alice', 'bob']);
});

test("the instance's own unit says how to run as it: user, environment, the instance's name; a dashboard unit is not an instance", () => {
  const i = u.parseInstance('worklane-alice.service', show('alice'))!;
  assert.deepEqual(i, { unit: 'worklane-alice.service', name: 'alice', user: 'wl-alice', env: ['PATH=/usr/local/bin:/usr/bin:/bin'] });
  assert.equal(u.parseInstance('worklane-dashboard-alice.service', 'User=wl-alice\nExecStart={ argv[]=/usr/local/bin/worklane dashboard --instance alice ; }'), null);
  assert.equal(u.parseInstance('worklane-x.service', 'User=root;rm\nExecStart={ argv[]=worklane coordinator run --instance x ; }'), null, 'only a plain user name');
  const cmd = u.migrateCommand(i, NEW);
  assert.deepEqual(cmd.slice(0, 7), ['systemd-run', '--wait', '--collect', '--pipe', '--quiet', '-p', 'User=wl-alice']);
  assert.deepEqual(cmd.slice(-7), ['/usr/bin/env', 'node', `/opt/worklane/${NEW}/dist/src/cli.js`, 'migrate', '--instance', 'alice', '--json']);
  assert.ok(cmd.includes('--setenv=PATH=/usr/local/bin:/usr/bin:/bin'), "the unit's environment");
  assert.ok(!cmd.includes('sudo'), 'no sudo: systemd-run as the unit runs');
  const r = u.restoreCommand(i, { backup: '/b', path: '/p' });
  assert.deepEqual(r.slice(-3), ['_', '/b', '/p'], 'the paths are arguments, never part of the script');
});

test('the owner sees it: a red machine-health item and a digest entry from the update log, until a later install', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upd-log-'));
  const rolled = { at: '2026-10-12T03:00:00.000Z', event: 'rolled_back', from: NEW, to: OLD, reason: 'rollback: migration failed: bob: tests.yaml: version 2 step failed', migration: { instance: 'bob', error: 'x' }, held: true };
  writeFileSync(join(dir, 'log'), `${JSON.stringify({ at: '2026-10-11T03:00:00.000Z', event: 'installed', from: null, to: OLD })}\n${JSON.stringify(rolled)}\n`);
  const log = updateLog(join(dir, 'log'));
  assert.deepEqual(heldUpdate(log), { at: rolled.at, sha: NEW, reason: rolled.reason, migration: true });
  assert.deepEqual(healthView([], null, { updates: log }).updateHold, { at: rolled.at, sha: NEW, reason: rolled.reason, migration: true });
  const d = waitingOnYou([], new Date('2026-10-12T12:00:00Z'), { updates: log });
  assert.deepEqual(d.items.map((i) => [i.kind, i.sha]), [['update_held', NEW]]);
  assert.match(d.items[0]!.detail, /^rollback: migration failed: bob: .*; the commit is held until a newer one/);
  // A later install ends it.
  const after = [...log, { at: '2026-10-13T03:00:00.000Z', event: 'installed', from: OLD, to: 'c'.repeat(40) } as UpdateEntry];
  assert.equal(heldUpdate(after), null);
  assert.deepEqual(waitingOnYou([], new Date('2026-10-13T12:00:00Z'), { updates: after }).items, []);
  assert.equal(healthView([], null, { updates: [] }).updateHold, null);
});
