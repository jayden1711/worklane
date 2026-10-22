import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TestsConfig } from '../src/config/schema.js';
import { CACHE_VARS, depCacheDir, depCacheEnv, prepareDepCache } from '../src/dep-cache.js';
import { sparsePatterns } from '../src/checkout.js';
import { poolFits, readPool, refillPool, setupKey, takeFromPool } from '../src/worktree-pool.js';
import { createWorktree, ownedWorktrees, worktreeOptions, type WorktreeOptions } from '../src/worktrees.js';

const posix = process.platform !== 'win32';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ada@example.com');
  git('config', 'user.name', 'Ada');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  return { dir, git, head: () => git('rev-parse', 'HEAD') };
}
const opts = (dir: string, extra: Partial<WorktreeOptions> = {}): WorktreeOptions => worktreeOptions({ repo: dir, root: '.claude/worktrees', stateDir: join(dir, '..', `state-${Math.random().toString(36).slice(2)}`), setup: [], taskDir: null, ...extra });

test('each instance gets its own dependency cache under its root, shared by its agents\' group (2770)', { skip: !posix && 'POSIX modes' }, () => {
  const a = join(mkdtempSync(join(tmpdir(), 'srv-')), 'one');
  const b = join(mkdtempSync(join(tmpdir(), 'srv-')), 'two');
  const gid = process.getgid!();
  const ca = prepareDepCache(a, gid);
  const cb = prepareDepCache(b, gid);
  assert.notEqual(ca.dir, cb.dir, 'never one cache for two instances');
  assert.ok(resolve(ca.dir).startsWith(resolve(a)));
  for (const sub of Object.values(CACHE_VARS)) {
    const st = statSync(join(ca.dir, sub));
    assert.equal(st.mode & 0o777, 0o770, `${sub}: the group fills it, others get nothing`);
    if (process.platform === 'linux') assert.equal(st.mode & 0o2000, 0o2000, 'setgid: files keep the group');
    assert.equal(st.gid, gid);
  }
  assert.deepEqual(Object.keys(ca.env).sort(), Object.keys(CACHE_VARS).sort());
  for (const v of Object.values(ca.env)) assert.ok(v.startsWith(ca.dir));
});

test('the cache variables reach the worktree setup steps', () => {
  const r = repo();
  const cacheEnv = depCacheEnv(depCacheDir(join(r.dir, '..', 'instance')));
  const o = opts(r.dir, { setup: [`node -e "require('fs').writeFileSync('seen.txt', process.env.PIP_CACHE_DIR || 'none')"`], cacheEnv });
  const { path, setupErrors } = createWorktree(o, 'issue-1', 'b1', 'HEAD');
  assert.deepEqual(setupErrors, []);
  assert.equal(readFileSync(join(path, 'seen.txt'), 'utf8'), cacheEnv.PIP_CACHE_DIR);
});

test('the pool fits only what leaves the free-disk floor', () => {
  assert.equal(poolFits(3, 1, 100), 3);
  assert.equal(poolFits(3, 5, 22), 2, '22 GB free, 10 kept: two 5 GB worktrees');
  assert.equal(poolFits(3, 1, 10.5), 0, 'at the floor: none');
  assert.equal(poolFits(2, 20, 100), 2, 'the floor is at least twice one worktree: 40 GB');
  assert.equal(poolFits(2, 40, 100), 0);
});

test('a pool on main: filled, taken where it stands on the task\'s branch, refreshed after a merge', async () => {
  const r = repo();
  const o = opts(r.dir, { setup: [`node -e "require('fs').writeFileSync('installed.txt', 'yes')"`] });
  const base = r.head();
  const first = await refillPool(o, { size: 2, base, estSizeGb: 1, freeGb: () => 100 });
  assert.equal(first.created.length, 2);
  assert.equal(readPool(o).length, 2);
  // A task at main takes one: same place, setup already done, now on the task's branch.
  const t = takeFromPool(o, base, 'worklane/issue-7');
  assert.ok(t);
  assert.ok(existsSync(join(t!.path, 'installed.txt')), 'set up before the task started');
  assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: t!.path, encoding: 'utf8' }).trim(), 'worklane/issue-7');
  assert.ok(ownedWorktrees(o).includes(t!.path), 'still ours, so the coordinator can remove it after the task');
  assert.equal(readPool(o).length, 1);
  // A task at another base gets nothing from the pool.
  assert.equal(takeFromPool(o, '0'.repeat(40), 'b'), null);
  // A merge moves main: the stale one goes, two new ones come.
  writeFileSync(join(r.dir, 'a.txt'), 'two\n');
  r.git('commit', '-q', '-am', 'two');
  const again = await refillPool(o, { size: 2, base: r.head(), estSizeGb: 1, freeGb: () => 100 });
  assert.equal(again.removed.length, 1);
  assert.equal(again.created.length, 2);
  assert.ok(readPool(o).every((e) => e.base === r.head()));
});

test('the pool never grows past the free disk, and a setup failure stops it', async () => {
  const r = repo();
  const o = opts(r.dir);
  assert.equal((await refillPool(o, { size: 3, base: r.head(), estSizeGb: 1, freeGb: () => 10.5 })).created.length, 0);
  const bad = opts(r.dir, { setup: ['node -e "process.exit(3)"'] });
  const out = await refillPool(bad, { size: 3, base: r.head(), estSizeGb: 1, freeGb: () => 100 });
  assert.equal(out.created.length, 0);
  assert.equal(out.errors.length, 1, 'one failure, not three tries');
  assert.equal(readPool(bad).length, 0);
});

test('a pooled worktree that changed since it was pooled is removed, never handed to a task', async () => {
  const r = repo();
  const o = opts(r.dir);
  const base = r.head();
  await refillPool(o, { size: 1, base, estSizeGb: 1, freeGb: () => 100 });
  writeFileSync(join(readPool(o)[0]!.path, 'a.txt'), 'tampered\n');
  assert.equal(takeFromPool(o, base, 'worklane/issue-8'), null);
  assert.equal(readPool(o).length, 0);
});

test('tests.yaml: the dependency cache is on and the pool off by default', () => {
  const t = TestsConfig.parse({ version: 1, runner: { kind: 'command', changed: 'a', full: 'b' } });
  assert.equal(t.worktree.dep_cache, true);
  assert.equal(t.worktree.pool, 0);
  assert.throws(() => TestsConfig.parse({ version: 1, runner: { kind: 'command', changed: 'a', full: 'b' }, worktree: { pool: 9 } }));
});

/** A repo with directories a project keeps out of its worktrees (design files, art) beside its code. */
function repoWithBinaries() {
  const r = repo();
  for (const [p, text] of [['docs/design/shot.png', 'png'], ['docs/notes.md', 'notes'], ['art/cards.zip', 'zip'], ['art/games.json', '{}'], ['web/public/assets/logo.png', 'logo'], ['assets/big.zip', 'zip'], ['src/app.js', 'app']] as const) {
    mkdirSync(join(r.dir, p, '..'), { recursive: true });
    writeFileSync(join(r.dir, p), `${text}\n`);
  }
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'binaries');
  return r;
}

test('sparse_exclude: an agent worktree leaves those directories out, and only those; the checkout it came from keeps everything', () => {
  const r = repoWithBinaries();
  const o = opts(r.dir, { sparseExclude: ['docs/design', 'assets/'] });
  const { path } = createWorktree(o, 'issue-3', 'worklane/issue-3', 'HEAD');
  const wgit = (...a: string[]) => execFileSync('git', a, { cwd: path, encoding: 'utf8' }).trim();
  assert.ok(!existsSync(join(path, 'docs', 'design')), 'docs/design left out');
  assert.ok(!existsSync(join(path, 'assets')), 'assets/ left out (the trailing slash is the same directory)');
  for (const p of ['docs/notes.md', 'art/games.json', 'art/cards.zip', 'src/app.js', 'a.txt']) assert.ok(existsSync(join(path, p)), `${p} is there`);
  assert.ok(existsSync(join(path, 'web', 'public', 'assets', 'logo.png')), 'only the top-level assets/: a nested one of the same name stays');
  assert.equal(wgit('status', '--porcelain'), '', 'nothing shows as deleted: the directories are left out, not removed');
  assert.match(wgit('ls-tree', '-r', '--name-only', 'HEAD'), /docs\/design\/shot\.png/, 'still in the commit');
  // The agent's work commits as usual, and what was left out stays in the branch untouched.
  writeFileSync(join(path, 'src', 'app.js'), 'changed\n');
  wgit('-c', 'user.email=a@example.com', '-c', 'user.name=A', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'change');
  assert.deepEqual(wgit('diff', '--name-only', 'HEAD~1', 'HEAD').split('\n'), ['src/app.js']);
  assert.match(wgit('ls-tree', '-r', '--name-only', 'HEAD'), /assets\/big\.zip/);
  // The coordinator's checkout and a worktree made without the setting are full.
  assert.ok(existsSync(join(r.dir, 'docs', 'design', 'shot.png')) && existsSync(join(r.dir, 'assets', 'big.zip')));
  assert.equal(spawnSync('git', ['config', '--get', 'core.sparseCheckout'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim(), '', 'the checkout itself is not sparse');
  assert.equal(r.git('status', '--porcelain'), '');
  const full = createWorktree(opts(r.dir), 'issue-4', 'worklane/issue-4', 'HEAD');
  assert.ok(existsSync(join(full.path, 'docs', 'design', 'shot.png')), 'another worktree is not affected');
});

test('sparse_exclude: a pooled worktree keeps leaving them out after it is taken onto a task branch', async () => {
  const r = repoWithBinaries();
  const o = opts(r.dir, { sparseExclude: ['art'] });
  await refillPool(o, { size: 1, base: r.head(), estSizeGb: 1, freeGb: () => 100 });
  const t = takeFromPool(o, r.head(), 'worklane/issue-9');
  assert.ok(t);
  assert.ok(!existsSync(join(t!.path, 'art')));
  assert.ok(existsSync(join(t!.path, 'src', 'app.js')));
});

test('worktree.setup_key: when main moves and the key files did not change, the pool follows main and keeps its install; a lockfile change sets it up again', async () => {
  const r = repo();
  writeFileSync(join(r.dir, 'package-lock.json'), '{"v":1}\n');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'lock');
  const counter = join(r.dir, '..', `setups-${Math.random().toString(36).slice(2)}`);
  writeFileSync(counter, '');
  // A setup that installs something untracked (as npm ci does) and counts its runs.
  const o = opts(r.dir, { setup: [`node -e "const fs=require('fs');fs.appendFileSync('${counter.replace(/\\/g, '/')}','x');fs.writeFileSync('installed.txt','yes')"`] });
  const key = (b: string) => setupKey(o, b, ['package-lock.json']);
  const first = await refillPool(o, { size: 1, base: r.head(), estSizeGb: 1, freeGb: () => 100, key });
  assert.equal(first.created.length, 1);
  const name = readPool(o)[0]!.name;
  // A merge that leaves the lockfile alone: the same worktree, now on the new main, its install kept, no setup.
  writeFileSync(join(r.dir, 'a.txt'), 'two\n');
  r.git('commit', '-q', '-am', 'two');
  const second = await refillPool(o, { size: 1, base: r.head(), estSizeGb: 1, freeGb: () => 100, key });
  assert.deepEqual([second.moved, second.created, second.removed], [[name], [], []]);
  const e = readPool(o)[0]!;
  assert.equal(e.base, r.head());
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: e.path, encoding: 'utf8' }).trim(), r.head());
  assert.equal(readFileSync(join(e.path, 'a.txt'), 'utf8'), 'two\n', 'the tracked files follow main');
  assert.ok(existsSync(join(e.path, 'installed.txt')), 'what setup installed stays');
  assert.equal(readFileSync(counter, 'utf8'), 'x', 'setup ran once');
  const t = takeFromPool(o, r.head(), 'worklane/issue-5');
  assert.ok(t, 'and a task takes it at the new main');
  // A lockfile change: a fresh setup, never a moved install.
  await refillPool(o, { size: 1, base: r.head(), estSizeGb: 1, freeGb: () => 100, key });
  writeFileSync(join(r.dir, 'package-lock.json'), '{"v":2}\n');
  r.git('commit', '-q', '-am', 'bump');
  const third = await refillPool(o, { size: 1, base: r.head(), estSizeGb: 1, freeGb: () => 100, key });
  assert.deepEqual([third.moved.length, third.created.length, third.removed.length], [0, 1, 1]);
  assert.equal(readFileSync(counter, 'utf8'), 'xxx');
});

test('worktree.setup_key: a pooled worktree that changed is not moved; without key files nothing moves', async () => {
  const r = repo();
  const o = opts(r.dir);
  const key = (b: string) => setupKey(o, b, ['a.txt']);
  await refillPool(o, { size: 1, base: r.head(), estSizeGb: 1, freeGb: () => 100, key });
  writeFileSync(join(readPool(o)[0]!.path, 'a.txt'), 'tampered\n');
  writeFileSync(join(r.dir, 'b.txt'), 'b\n');
  r.git('add', 'b.txt');
  r.git('commit', '-q', '-m', 'b');
  const out = await refillPool(o, { size: 1, base: r.head(), estSizeGb: 1, freeGb: () => 100, key });
  assert.deepEqual([out.moved.length, out.removed.length, out.created.length], [0, 1, 1], 'a changed worktree is replaced');
  assert.equal(setupKey(o, r.head(), []), null);
  // The key covers the setup itself and what the checkout leaves out, not just the files.
  assert.notEqual(setupKey(o, r.head(), ['a.txt']), setupKey({ ...o, setup: ['npm ci'] }, r.head(), ['a.txt']));
  assert.notEqual(setupKey(o, r.head(), ['a.txt']), setupKey({ ...o, sparseExclude: ['art'] }, r.head(), ['a.txt']));
});

test('tests.yaml checkout.sparse_exclude: plain directories inside the repo only, normalized, and none by default', () => {
  const t = (checkout: unknown) => TestsConfig.safeParse({ version: 1, runner: { kind: 'command', changed: 'a', full: 'b' }, checkout });
  assert.deepEqual(t(undefined).data?.checkout.sparse_exclude, []);
  assert.deepEqual(t({ sparse_exclude: ['docs/design/', 'art', 'assets'] }).data?.checkout.sparse_exclude, ['docs/design', 'art', 'assets']);
  for (const bad of ['../up', '/abs', 'a/../b', 'a//b', '.', 'docs/*', 'my dir', '-x', '.git', '.git/hooks', '', "it's", 'a\\b']) {
    assert.equal(t({ sparse_exclude: [bad] }).success, false, `refuses ${JSON.stringify(bad)}`);
  }
  assert.equal(t({ sparse_exclude: ['art', 'art/'] }).success, false, 'the same directory twice');
  assert.equal(t({ sparse_exclude: Array.from({ length: 33 }, (_, i) => `d${i}`) }).success, false, 'at most 32');
  assert.equal(t({ sparse: ['art'] }).success, false, 'unknown keys fail');
  assert.equal(sparsePatterns(['docs/design', 'art/']), '/*\n!/docs/design/\n!/art/\n');
  assert.deepEqual(TestsConfig.parse({ version: 1, runner: { kind: 'command', changed: 'a', full: 'b' } }).worktree.setup_key, []);
});
