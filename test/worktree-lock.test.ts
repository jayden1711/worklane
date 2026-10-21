// #890 round 12: every task worktree the coordinator makes is locked (`git worktree lock`), and unlocked only in its
// own removal path. WHY: since round 10 a run's sandbox hides every other task checkout, so inside it a sibling's
// `.git` looks missing and `git worktree prune` (or gc) run there removed every sibling's record, which broke every
// running task worktree (measured, round 10). git never prunes a locked worktree. A write deny on the records instead
// broke every worker's commit (measured, round 11), so none is used: `git gc` and commits keep working.
// Existing installs: a worktree the coordinator owns from before is locked the next time it makes one.
import { exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReadDenials } from '../src/read-denials.js';
import { createWorktree, removeWorktree, worktreePath, type WorktreeOptions } from '../src/worktrees.js';

const linux = process.platform === 'linux';
const bwrapRuns = linux && spawnSync('bwrap', ['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0;
const SRT = join(repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox');

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const records = (dir: string) => readdirNames(join(dir, '.git', 'worktrees'));
function readdirNames(d: string): string[] {
  return existsSync(d) ? readdirSync(d).sort() : [];
}
/** The paths `git worktree list` marks locked. */
const locked = (dir: string) => {
  const out: string[] = [];
  let at = '';
  for (const l of git(dir, 'worktree', 'list', '--porcelain').split('\n')) {
    if (l.startsWith('worktree ')) at = l.slice(9);
    if (l === 'locked' || l.startsWith('locked ')) out.push(at);
  }
  return out;
};

function fixture() {
  const { dir } = exampleProject();
  const o: WorktreeOptions = { repo: dir, root: '.claude/worktrees', stateDir: mkdtempSync(join(tmpdir(), 'wt-state-')), setup: [] };
  return { dir, o };
}

test('#890 r12: a worktree the coordinator makes is locked, and its own removal still removes it cleanly', () => {
  const { dir, o } = fixture();
  const { path } = createWorktree(o, 'issue-1', 'b1', 'HEAD');
  assert.deepEqual(locked(dir), [path]);
  assert.equal(removeWorktree(o, 'issue-1'), true);
  assert.equal(existsSync(path), false);
  assert.ok(!git(dir, 'worktree', 'list', '--porcelain').includes(path));
  assert.deepEqual(records(dir), []);
});

test('#890 r12: git worktree prune and gc keep a task worktree whose checkout looks missing (as a hidden sibling does)', () => {
  const { dir, o } = fixture();
  const a = createWorktree(o, 'issue-1', 'b1', 'HEAD').path;
  const b = createWorktree(o, 'issue-2', 'b2', 'HEAD').path;
  // As inside another run's sandbox, where both are hidden whole.
  renameSync(a, `${a}-away`);
  renameSync(b, `${b}-away`);
  git(dir, 'worktree', 'prune');
  git(dir, 'gc', '-q', '--prune=now');
  renameSync(`${a}-away`, a);
  renameSync(`${b}-away`, b);
  assert.equal(records(dir).length, 2);
  for (const p of [a, b]) assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: p }).status, 0, `git works in ${p}`);
});

test('#890 r12: a worktree the coordinator owns from before is locked the next time it makes one', () => {
  const { dir, o } = fixture();
  const old = worktreePath(o, 'issue-9');
  git(dir, 'worktree', 'add', '-q', '-b', 'b9', old, 'HEAD');
  // Another session's worktree, not in the ownership record: never touched.
  const foreign = join(dir, '.claude', 'worktrees', 'someone-else');
  git(dir, 'worktree', 'add', '-q', '-b', 'other', foreign, 'HEAD');
  mkdirSync(o.stateDir, { recursive: true });
  writeFileSync(join(o.stateDir, 'worktrees.json'), JSON.stringify([old]));
  assert.deepEqual(locked(dir), []);
  const { path } = createWorktree(o, 'issue-1', 'b1', 'HEAD');
  assert.deepEqual(locked(dir).sort(), [old, path].sort());
  assert.ok(JSON.parse(readFileSync(join(o.stateDir, 'worktrees.json'), 'utf8')).includes(old));
});

/** `command` as sandbox-runtime's Linux wrapper wraps it with these read entries, writing only in `allowWrite`. */
async function wrap(entries: string[], allowWrite: string[], command: string): Promise<string> {
  const utils = await import(join(SRT, 'sandbox-utils.js'));
  const glob = await import(join(SRT, 'read-deny-glob.js'));
  const lin = await import(join(SRT, 'linux-sandbox-utils.js'));
  const denyOnly: string[] = [];
  const unlistable = new Set<string>();
  for (const e of entries) {
    const stripped: string = utils.removeTrailingGlobSuffix(e);
    if (utils.containsGlobChars(stripped)) denyOnly.push(...(glob.expandReadDenyGlobLinux(e, allowWrite, unlistable) as string[]));
    else denyOnly.push(stripped);
  }
  return lin.wrapCommandWithSandboxLinux({ command, needsNetworkRestriction: false, readConfig: { denyOnly, allowWithinDeny: [], unlistableDenyDirs: [...unlistable] }, writeConfig: { allowOnly: allowWrite, denyWithinAllow: [] }, binShell: 'bash' });
}

test('#890 r12: inside the real sandbox, prune and gc from a main-checkout run and a worktree run leave every sibling record, a late one too; a worker still commits', { skip: !bwrapRuns && 'bubblewrap can\'t start here', timeout: 180_000 }, async () => {
  const { dir, o } = fixture();
  git(dir, 'config', 'user.email', 'a@example.com');
  git(dir, 'config', 'user.name', 'A');
  const own = createWorktree(o, 'issue-1', 'b1', 'HEAD').path;
  const sib = createWorktree(o, 'issue-2', 'b2', 'HEAD').path;
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const fromMain = runReadDenials({ cwd: dir, home, repo: dir });
  const fromOwn = runReadDenials({ cwd: own, home, repo: dir });
  if ('error' in fromMain || 'error' in fromOwn) assert.fail(JSON.stringify([fromMain, fromOwn]));
  // Made after both runs started.
  const late = createWorktree(o, 'issue-3', 'b3', 'HEAD').path;
  const entries = (d: { paths: string[]; sandboxOnly?: string[] }) => [...d.paths, ...(d.sandboxOnly ?? [])];
  const common = join(dir, '.git');
  const runs = [
    { cwd: dir, allowWrite: [dir], d: fromMain },
    // A worker's sandbox may write the common git directory: it commits itself.
    { cwd: own, allowWrite: [own, common], d: fromOwn },
  ];
  for (const r of runs) {
    const cmd = 'git worktree prune -v 2>&1; echo PRUNE=$?; git gc -q 2>&1; echo GC=$?';
    const out = spawnSync('bash', ['-c', await wrap(entries(r.d), r.allowWrite, cmd)], { cwd: r.cwd, encoding: 'utf8', timeout: 120_000 });
    assert.equal(out.status, 0, (out.stderr ?? '').slice(0, 300));
    assert.match(out.stdout, /PRUNE=0/);
    assert.match(out.stdout, /GC=0/, out.stdout);
    assert.doesNotMatch(out.stdout, /Removing worktrees/, out.stdout);
    assert.equal(records(dir).length, 3, `records after a run in ${r.cwd}: ${records(dir)}`);
    for (const p of [own, sib, late]) assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: p }).status, 0, `git works in ${p}`);
  }
  const commit = spawnSync('bash', ['-c', await wrap(entries(fromOwn), [own, common], 'echo x > made.txt && git add made.txt && git commit -q -m made && echo COMMIT-OK')], { cwd: own, encoding: 'utf8', timeout: 60_000 });
  assert.match(commit.stdout, /COMMIT-OK/, `${commit.stdout} ${commit.stderr}`);
  assert.equal(git(own, 'log', '-1', '--format=%s'), 'made');
  // And the coordinator's own removal path still removes them.
  for (const n of ['issue-1', 'issue-2', 'issue-3']) assert.equal(removeWorktree(o, n), true, n);
  assert.deepEqual(records(dir), []);
});
