// `export` / `import` (src/instance-move.ts): a laptop's config and history, carried to another machine as one file.
import { restoreIsolated } from './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { BRAND } from '../src/brand.js';
import { EventLog } from '../src/events/log.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { exportBundle, importBundle, readBundle } from '../src/instance-move.js';
import { tryLock } from '../src/locks.js';
import { engineCli, exampleProject } from './helpers.js';

const posix = process.platform === 'win32' && 'POSIX file modes';

test('native lock guard inodes never travel in exports or imports, even while the target owns a lock', () => {
  const state = mkdtempSync(join(tmpdir(), 'move-native-'));
  const { dir: root } = exampleProject();
  const guard = join(state, '.coordinator.lock.flock');
  const cfgGuard = join(root, BRAND.configDir, '.config.lock.flock');
  writeFileSync(guard, '', { mode: 0o444 });
  const orphanName = '.coordinator.lock.flock.123.0123456789abcdef.tmp';
  linkSync(guard, join(state, orphanName));
  writeFileSync(cfgGuard, '', { mode: 0o444 });
  const out = join(state, 'out.bundle');
  const exported = exportBundle({ stateDir: state, root, repo: null, host: 'fixture', out });
  const excluded = ['state/.coordinator.lock.flock', `state/${orphanName}`, 'config/.config.lock.flock'];
  for (const path of excluded) {
    assert.ok(!exported.files.includes(path));
    assert.ok(exported.left.some((entry) => entry.path === path && /native lock guard/.test(entry.why)));
  }
  const b = readBundle(out);
  b.files = excluded.map((path) => ({ path, data: Buffer.from('must not replace an inode').toString('base64') }));
  writeFileSync(out, gzipSync(JSON.stringify(b)).toString('base64'));
  const target = mkdtempSync(join(tmpdir(), 'move-native-target-'));
  const owned = tryLock(join(target, 'coordinator.lock'), 'import target');
  assert.ok('lock' in owned);
  linkSync(join(target, '.coordinator.lock.flock'), join(target, orphanName));
  try {
    const before = statSync(join(target, '.coordinator.lock.flock'));
    const imported = importBundle({ file: out, stateDir: target, root, instance: false });
    assert.equal(imported.skipped.length, 3);
    assert.deepEqual([statSync(join(target, '.coordinator.lock.flock')).dev, statSync(join(target, '.coordinator.lock.flock')).ino], [before.dev, before.ino]);
    assert.equal(statSync(join(target, '.coordinator.lock.flock')).mode & 0o777, 0o444);
    assert.equal(readFileSync(cfgGuard, 'utf8'), '');
    assert.ok(!('lock' in tryLock(join(target, 'coordinator.lock'), 'contender')));
  } finally { owned.lock.release(); }
});

/** A laptop's state: history, init's checklist, findings, and what must never travel. */
function laptop() {
  const stateDir = mkdtempSync(join(tmpdir(), 'move-state-'));
  const log = new EventLog(join(stateDir, 'events.db'));
  log.append('issue.seen', { issue: 4, title: 'Round totals', labels: ['ready'], author: 'o', owner: 'example-owner', actionable: true, why: '' }, 'coordinator');
  log.append('issue.seen', { issue: 5, title: 'Fix rounding', labels: ['ready'], author: 'o', owner: 'example-owner', actionable: true, why: '' }, 'coordinator');
  // Left open, as a running coordinator's would be: the snapshot is still whole.
  writeFileSync(join(stateDir, 'init.json'), '{"version":1,"mode":"local"}\n');
  writeFileSync(join(stateDir, 'main-watch.json'), '{"version":1,"mode":"github"}\n');
  writeFileSync(join(stateDir, 'dashboard-token'), 'secret-token-value\n');
  writeFileSync(join(stateDir, 'coordinator.lock'), '{"pid":1}');
  writeFileSync(join(stateDir, 'coordinator.log'), 'log\n');
  mkdirSync(join(stateDir, 'worktrees', 'w1'), { recursive: true });
  writeFileSync(join(stateDir, 'worktrees', 'w1', 'file'), 'x');
  return { stateDir, log };
}

test('export: one file with the history (a whole snapshot), the checklist and the config; never secrets, locks, logs or worktrees, each listed', { skip: posix }, () => {
  const { dir: root } = exampleProject();
  const l = laptop();
  const out = join(mkdtempSync(join(tmpdir(), 'move-out-')), 'b.bundle');
  const r = exportBundle({ stateDir: l.stateDir, root, repo: 'example-org/example-shop', host: 'laptop', out });
  l.log.close();
  assert.equal(statSync(out).mode & 0o777, 0o600, "the bundle is its maker's alone");
  assert.ok(r.files.includes('state/events.db') && r.files.includes('state/init.json') && r.files.includes('state/main-watch.json'));
  assert.ok(r.files.includes(`config/config.yaml`));
  assert.deepEqual(r.left.map((x) => [x.path, x.why]), [['state/coordinator.lock', 'a lock'], ['state/coordinator.log', 'a log'], ['state/dashboard-token', 'a secret'], ['state/worktrees/w1/file', "this machine's working files"]]);
  assert.doesNotMatch(readFileSync(out, 'utf8'), /secret-token-value/);
  const b = readBundle(out);
  assert.equal(b.from.repo, 'example-org/example-shop');
  assert.ok(!b.files.some((f) => /token|lock|\.log$|worktrees/.test(f.path)));
});

test("export: a killed owner-only write's staging file (.<name>.<16 hex>.new) is left out as a temporary file", () => {
  const { dir: root } = exampleProject();
  const l = laptop();
  l.log.close();
  writeFileSync(join(l.stateDir, '.init.json.0123456789abcdef.new'), '{"version":1,"mode":"half-written"}');
  mkdirSync(join(l.stateDir, 'intake'), { recursive: true });
  writeFileSync(join(l.stateDir, 'intake', '.alerts.json.fedcba9876543210.new'), '{}');
  const out = join(mkdtempSync(join(tmpdir(), 'move-out-')), 'b.bundle');
  const r = exportBundle({ stateDir: l.stateDir, root, repo: null, host: 'laptop', out });
  for (const path of ['state/.init.json.0123456789abcdef.new', 'state/intake/.alerts.json.fedcba9876543210.new']) {
    assert.ok(!r.files.includes(path), `${path} travelled`);
    assert.ok(r.left.some((x) => x.path === path && x.why === 'a temporary file'), `${path} isn't listed as left out`);
  }
  assert.ok(r.files.includes('state/init.json'), 'the file itself still travels');
});

test('import: the history and checklist into a fresh state dir, readable there; history of its own refused unless --force', { skip: posix }, () => {
  const { dir: root } = exampleProject();
  const l = laptop();
  const out = join(mkdtempSync(join(tmpdir(), 'move-out-')), 'b.bundle');
  exportBundle({ stateDir: l.stateDir, root, repo: 'example-org/example-shop', host: 'laptop', out });
  l.log.close();
  // A server's instance: a fresh state dir, its checkout already has the config (from git).
  const server = mkdtempSync(join(tmpdir(), 'move-server-'));
  const r = importBundle({ file: out, stateDir: server, root, instance: true });
  assert.deepEqual(r.skipped.map((s) => s.path), ['state/init.json'], "init's checklist stays the laptop's; the server walks its own");
  assert.deepEqual(r.configDiffers, [], 'the same config: nothing to commit');
  const events = new EventLog(join(server, 'events.db'));
  assert.deepEqual(events.read(0).map((e: { payload: unknown }) => (e.payload as { issue: number }).issue), [4, 5], 'the whole history');
  events.close();
  assert.equal(readFileSync(join(server, 'main-watch.json'), 'utf8'), '{"version":1,"mode":"github"}\n');
  assert.ok(!existsSync(join(server, 'dashboard-token')));
  // Again: the target has history now.
  assert.throws(() => importBundle({ file: out, stateDir: server, root, instance: true }), /already has history \(events\.db\): nothing imported\. Pass --force/);
  importBundle({ file: out, stateDir: server, root, instance: true, force: true });
  // A local target keeps init's checklist; a checkout with no config gets it; one whose config differs is told.
  const bare = mkdtempSync(join(tmpdir(), 'move-bare-'));
  const local = importBundle({ file: out, stateDir: mkdtempSync(join(tmpdir(), 'move-local-')), root: bare, instance: false });
  assert.ok(local.state.includes('state/init.json'));
  assert.ok(existsSync(join(bare, BRAND.configDir, 'config.yaml')) && local.config.includes('config/config.yaml'));
  writeFileSync(join(root, BRAND.configDir, 'config.yaml'), 'changed: true\n');
  const differs = importBundle({ file: out, stateDir: mkdtempSync(join(tmpdir(), 'move-d-')), root, instance: true });
  assert.deepEqual(differs.configDiffers, [`${BRAND.configDir}/config.yaml`]);
  assert.equal(readFileSync(join(root, BRAND.configDir, 'config.yaml'), 'utf8'), 'changed: true\n', 'the checkout\'s config is never overwritten');
});

test('import refuses what is not a bundle, a newer one, and a path out of its places', () => {
  const d = mkdtempSync(join(tmpdir(), 'move-bad-'));
  const write = (b: unknown) => {
    const f = join(d, `${Math.random()}.bundle`);
    writeFileSync(f, gzipSync(JSON.stringify(b)).toString('base64'));
    return f;
  };
  writeFileSync(join(d, 'junk'), 'not a bundle');
  assert.throws(() => readBundle(join(d, 'junk')), /is not a worklane export bundle/);
  const ok = { format: `${BRAND.cli}-bundle`, version: 1, createdAt: '', from: { repo: null, host: 'h' }, files: [] as { path: string; data: string }[] };
  assert.throws(() => readBundle(write({ ...ok, version: 2 })), /version 2 bundle; this engine reads version 1/);
  for (const path of ['state/../../etc/passwd', '/etc/passwd', 'other/x', 'state//x']) assert.throws(() => readBundle(write({ ...ok, files: [{ path, data: '' }] })), /refused, a path outside the bundle's places/, path);
  const target = mkdtempSync(join(tmpdir(), 'move-t-'));
  assert.throws(() => importBundle({ file: write({ ...ok, files: [{ path: 'state/../escape', data: '' }] }), stateDir: target, root: null, instance: false }));
  assert.ok(!existsSync(join(target, '..', 'escape')));
});

test('export / import through the CLI: a laptop checkout to another machine, no ssh, one file', { skip: posix }, () => {
  const { dir: root } = exampleProject();
  const laptopState = mkdtempSync(join(tmpdir(), 'move-cli-a-'));
  const serverState = mkdtempSync(join(tmpdir(), 'move-cli-b-'));
  const cli = (state: string, ...a: string[]) => spawnSync(process.execPath, [engineCli, ...a], { encoding: 'utf8', env: { ...process.env, [`${BRAND.envPrefix}_STATE_DIR`]: state } });
  // Some history on the laptop.
  process.env[`${BRAND.envPrefix}_STATE_DIR`] = laptopState;
  const dir = projectStateDir(root);
  restoreIsolated(`${BRAND.envPrefix}_STATE_DIR`);
  mkdirSync(dir, { recursive: true });
  const log = new EventLog(join(dir, 'events.db'));
  log.append('issue.seen', { issue: 7, title: 'Seven', labels: ['ready'], author: 'o', owner: 'example-owner', actionable: true, why: '' }, 'coordinator');
  log.close();
  writeFileSync(join(dir, 'dashboard-token'), 'never-travels\n');
  const out = join(mkdtempSync(join(tmpdir(), 'move-cli-out-')), 'shop.bundle');
  const e = cli(laptopState, 'export', '--root', root, '--out', out);
  assert.equal(e.status, 0, e.stderr);
  assert.match(e.stdout, /exported \d+ files to .*shop\.bundle \(yours only, 0600\)\n {2}left out state\/dashboard-token: a secret/);
  const i = cli(serverState, 'import', out, '--root', root);
  assert.equal(i.status, 0, i.stderr);
  assert.match(i.stdout, /imported \d+ state files into /);
  process.env[`${BRAND.envPrefix}_STATE_DIR`] = serverState;
  const there = projectStateDir(root);
  restoreIsolated(`${BRAND.envPrefix}_STATE_DIR`);
  const ev = new EventLog(join(there, 'events.db'));
  assert.deepEqual(ev.read(0).map((x: { payload: unknown }) => (x.payload as { issue: number }).issue), [7]);
  ev.close();
  assert.ok(!existsSync(join(there, 'dashboard-token')));
  const again = cli(serverState, 'import', out, '--root', root);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already has history/);
  assert.equal(cli(serverState, 'import').status, 2);
  rmSync(out);
});
