import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TestsConfig } from '../src/config/schema.js';
import { CACHE_VARS, depCacheDir, depCacheEnv, prepareDepCache } from '../src/dep-cache.js';
import { poolFits, readPool, refillPool, takeFromPool } from '../src/worktree-pool.js';
import { createWorktree, ownedWorktrees, type WorktreeOptions } from '../src/worktrees.js';

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
const opts = (dir: string, extra: Partial<WorktreeOptions> = {}): WorktreeOptions => ({ repo: dir, root: '.claude/worktrees', stateDir: join(dir, '..', `state-${Math.random().toString(36).slice(2)}`), setup: [], ...extra });

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
