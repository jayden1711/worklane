import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, dirStore } from '../src/events/backup.js';
import { EventLog } from '../src/events/log.js';
import { RunRecorder } from '../src/run-record.js';
import { INSTANCE_UMASK } from '../src/service.js';
import { createWorktree, removeWorktree } from '../src/worktrees.js';
import { repoRoot } from './helpers.js';

// Mode bits are POSIX; on Windows access is by ACL and these helpers do nothing.
const skip = process.platform === 'win32' && 'POSIX modes';
const others = (p: string) => statSync(p).mode & 0o007;
const mode = (p: string) => statSync(p).mode & 0o777;

/** Run fn under a permissive umask, as a service with systemd's default (022) would. */
function underUmask<T>(mask: number, fn: () => T): T {
  const old = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(old);
  }
}

test('the coordinator\'s umask keeps its group (agents) and shuts out everyone else', () => {
  assert.equal(INSTANCE_UMASK & 0o007, 0o007, 'others: nothing');
  assert.equal(INSTANCE_UMASK & 0o070, 0, 'group: read and write kept');
});

test('the event log, its -wal and -shm, and its directory are closed to others, whatever the umask', { skip }, () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'state-')), 'state');
  const path = join(dir, 'events.db');
  const log = underUmask(0o022, () => new EventLog(path));
  underUmask(0o022, () => log.append('coordinator.tick', { instance: 'x', dispatched: 0, reconciled: 0 }, 'test'));
  for (const p of [dir, path, `${path}-wal`, `${path}-shm`]) {
    assert.ok(existsSync(p), p);
    assert.equal(others(p), 0, `${p} is ${mode(p).toString(8)}`);
  }
  assert.equal(mode(dir), 0o770);
  assert.equal(mode(path), 0o660);
});

test('opening an existing log tightens files an older engine left readable by others', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-'));
  const path = join(dir, 'events.db');
  new EventLog(path).append('coordinator.tick', { instance: 'x', dispatched: 0, reconciled: 0 }, 'test');
  for (const p of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(p)) chmodSync(p, 0o644);
  new EventLog(path);
  for (const p of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(p)) assert.equal(others(p), 0, `${p} is ${mode(p).toString(8)}`);
});

test('backups (directory and every file) are closed to others', { skip }, async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'state-')), 'backups');
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'state-')), 'events.db'));
  log.append('coordinator.tick', { instance: 'x', dispatched: 0, reconciled: 0 }, 'test');
  const r = await underUmask(0o022, () => backup(log, dirStore(root)));
  assert.ok(r.ok, r.error);
  assert.equal(others(root), 0, `backups/ is ${mode(root).toString(8)}`);
  assert.equal(others(join(root, r.key)), 0, `${r.key} is ${mode(join(root, r.key)).toString(8)}`);
});

test('worktrees.json and the runs/ directory are closed to others', { skip }, () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  const stateDir = join(mkdtempSync(join(tmpdir(), 'state-')), 'state');
  const o = { repo, root: '.claude/worktrees', stateDir, setup: [] };
  underUmask(0o022, () => createWorktree(o, 'issue-1', 'b1', 'HEAD'));
  assert.equal(others(join(stateDir, 'worktrees.json')), 0, `worktrees.json is ${mode(join(stateDir, 'worktrees.json')).toString(8)}`);
  removeWorktree(o, 'issue-1');

  const rec = underUmask(0o022, () => {
    const r = new RunRecorder(stateDir, { role: 'worker', model: 'm', cwd: join(repo, 'issue-1') });
    return r.finish({ reason: 'succeeded', costUsd: 0, turns: 1, model: 'm' });
  });
  assert.ok(rec);
  assert.equal(others(join(stateDir, 'runs')), 0, `runs/ is ${mode(join(stateDir, 'runs')).toString(8)}`);
  assert.equal(others(rec!), 0);
});

const setup = join(repoRoot, 'scripts', 'setup');
const sh = (f: string) => readFileSync(join(setup, f), 'utf8');

test('the coordinator and dashboard units set UMask=0007', () => {
  assert.match(sh('service.sh'), /^UMask=0007$/m);
  assert.equal((sh('dashboards.sh').match(/^UMask=0007$/gm) ?? []).length, 2, 'each instance dashboard and the hub');
});

test('dashboards.sh checks every state dir before it grants any ACL', () => {
  const s = sh('dashboards.sh');
  const firstAcl = s.indexOf('setfacl -m');
  const prePass = s.indexOf('refuse_if_open "$(state_of "$name")"');
  assert.ok(prePass > 0 && prePass < firstAcl, 'a pre-pass over all instances comes before the first setfacl');
  const grant = s.slice(s.lastIndexOf('refuse_if_open "$state"'), firstAcl);
  assert.ok(grant.length > 0 && !grant.includes('setfacl'), 'and again right before each grant');
});

test('refuse_if_open names every file open to others and refuses; a closed tree passes', { skip: process.platform === 'win32' && 'bash' }, () => {
  const state = join(mkdtempSync(join(tmpdir(), 'state-')), 'state');
  mkdirSync(join(state, 'backups'), { recursive: true });
  writeFileSync(join(state, 'events.db'), '');
  writeFileSync(join(state, 'backups', 'events-1.db'), '');
  writeFileSync(join(state, 'dashboard-token'), '');
  chmodSync(state, 0o700);
  chmodSync(join(state, 'events.db'), 0o644);
  chmodSync(join(state, 'backups'), 0o775);
  chmodSync(join(state, 'backups', 'events-1.db'), 0o664);
  chmodSync(join(state, 'dashboard-token'), 0o600);
  const run = () => spawnSync('bash', ['-c', 'source "$1"; refuse_if_open "$2" "grant wl-dash any access"; echo PASSED', '_', join(setup, 'lib.sh'), state], { encoding: 'utf8' });
  const bad = run();
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /refusing to grant wl-dash any access/);
  for (const f of ['events.db', 'backups', join('backups', 'events-1.db')]) assert.ok(bad.stderr.includes(join(state, f)), `names ${f}`);
  assert.ok(!bad.stderr.includes('dashboard-token'), 'a 0600 file is not named');
  assert.ok(!bad.stdout.includes('PASSED'));
  execFileSync('chmod', ['-R', 'o-rwx', state]);
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /PASSED/);
});
