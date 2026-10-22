// #890 round 19 (the round-18 final check; the coordinator's decisions):
// - G1: an old `<cli>-*` worktree removed while runs held it as an entry freed its name, and a link planted there made
//   srt mount over wherever it led (/usr), taking those runs' Bash (measured). Removing an old worktree now leaves an
//   empty directory of the coordinator's at the name, so nothing can be planted there.
// - G2: worktreeDir and the denials used different kept lists: a root that held only the task directory got new
//   worktrees directly under it (measured). One kept list, task directory included.
// - G3: an install whose configured worktree root is a link stopped making worktrees (measured). The root is resolved
//   to its real path once, at the start, and used as the place; the link check is for links found later.
// - Links higher up a place's path that appear after the start are refused before any write (realpath against the
//   resolved place).
import { exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { runReadDenials } from '../src/read-denials.js';
import * as worktrees from '../src/worktrees.js';
import { createWorktree, type WorktreeOptions } from '../src/worktrees.js';

const linux = process.platform === 'linux';
const skip = !linux && "sandbox-runtime's Linux rules, where CI runs";
const bwrapSkip = skip || (!(linux && spawnSync('bwrap', ['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0) && 'bubblewrap can\'t start here');
const SRT = join(repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox');
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

type Denials = { paths: string[]; sandboxOnly?: string[] } | { error: string };
const denials = (o: Record<string, unknown>): Denials => runReadDenials(o as Parameters<typeof runReadDenials>[0]);
const ok = (d: Denials) => {
  if ('error' in d) assert.fail(d.error);
  return d;
};
// The helpers as this round shapes them (a task directory argument), called loosely so older trees still build.
const places = (repo: string, root: string, taskDir?: string) => (worktrees.worktreePlaces as unknown as (...a: unknown[]) => string[])(repo, root, taskDir);
const dirOf = (repo: string, root: string, taskDir?: string) => (worktrees.worktreeDir as unknown as (...a: unknown[]) => string)(repo, root, taskDir);
const options = (o: Record<string, unknown>) => ({ setup: [], stateDir: mkdtempSync(join(tmpdir(), 'wt-state-')), ...o }) as unknown as WorktreeOptions;

async function wrap(list: string[], cwd: string, command: string): Promise<string> {
  const utils = await import(join(SRT, 'sandbox-utils.js'));
  const glob = await import(join(SRT, 'read-deny-glob.js'));
  const lin = await import(join(SRT, 'linux-sandbox-utils.js'));
  const denyOnly: string[] = [];
  const unlistable = new Set<string>();
  for (const e of list) {
    const stripped: string = utils.removeTrailingGlobSuffix(e);
    if (utils.containsGlobChars(stripped)) denyOnly.push(...(glob.expandReadDenyGlobLinux(e, [cwd], unlistable) as string[]));
    else denyOnly.push(stripped);
  }
  return lin.wrapCommandWithSandboxLinux({ command, needsNetworkRestriction: false, readConfig: { denyOnly, allowWithinDeny: [], unlistableDenyDirs: [...unlistable] }, writeConfig: { allowOnly: [cwd], denyWithinAllow: [] }, binShell: 'bash' });
}

test('#890 r19 (G1): root ".": an old worktree removed while a run holds it as an entry leaves its name taken; a link can\'t be planted there, and the run keeps Bash', { skip: bwrapSkip, timeout: 120_000 }, async () => {
  const { dir } = exampleProject();
  const o = options({ repo: dir, root: '.' });
  const ps = places(dir, '.');
  for (const p of ps) mkdirSync(p, { recursive: true });
  // An old worktree, as round 16 made it: directly under the root, owned and locked.
  const legacy = join(dir, `${BRAND.cli}-issue-5`);
  git(dir, 'worktree', 'add', '-q', '-b', 'b5', legacy, 'HEAD');
  git(dir, 'worktree', 'lock', legacy);
  mkdirSync(o.stateDir, { recursive: true });
  writeFileSync(join(o.stateDir, 'worktrees.json'), JSON.stringify([legacy]));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const d = ok(denials({ cwd: dir, home, repo: dir, places: ps }));
  assert.ok(d.paths.includes(legacy), 'the old worktree is an entry');
  createWorktree(o, 'issue-5', 'b5', 'HEAD');
  try {
    symlinkSync('/usr', legacy);
  } catch {
    // the name is taken: nothing planted
  }
  const out = spawnSync('bash', ['-c', await wrap([...d.paths, ...(d.sandboxOnly ?? [])], dir, 'echo BASH-OK')], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  assert.match(out.stdout, /BASH-OK/, (out.stderr ?? '').slice(0, 300));
  assert.equal(readdirSync(legacy).length, 0, 'an empty directory of the coordinator\'s at the old name');
});

test('#890 r19 (G2): a root that holds only the task directory gets the engine\'s own directory, from worktreeDir and the denials alike', { skip }, () => {
  const { dir } = exampleProject();
  const tasks = join(dirname(dir), 'tasks');
  mkdirSync(tasks);
  const taskFile = join(tasks, 'issue-1.json');
  writeFileSync(taskFile, JSON.stringify({ id: 'issue-1', done_when: [{ manual: 'x' }] }));
  assert.equal(dirOf(dir, tasks, tasks), join(tasks, `${BRAND.cli}-worktrees`));
  const ps = places(dir, tasks, tasks);
  assert.ok(ps.includes(join(tasks, `${BRAND.cli}-worktrees`)), JSON.stringify(ps));
  for (const p of ps) mkdirSync(p, { recursive: true });
  const d = ok(denials({ cwd: dir, home: mkdtempSync(join(tmpdir(), 'home-')), repo: dir, taskFile, places: ps }));
  assert.ok(d.sandboxOnly?.includes(join(tasks, `${BRAND.cli}-worktrees`)), JSON.stringify(d.sandboxOnly));
});

test('#890 r19 (G3): a configured worktree root that is a link works, as on main: worktrees are made and runs start', { skip }, () => {
  const { dir } = exampleProject();
  const big = join(dirname(dir), 'bigdisk');
  mkdirSync(big);
  const link = join(dirname(dir), 'wt');
  symlinkSync(big, link);
  const { path } = createWorktree(options({ repo: dir, root: link }), 'a', 'a', 'HEAD');
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: path }).status, 0);
  const ps = places(dir, link);
  for (const p of ps) mkdirSync(p, { recursive: true });
  ok(denials({ cwd: dir, home: mkdtempSync(join(tmpdir(), 'home-')), repo: dir, places: ps }));
});

test('#890 r19: a link that appears higher up a resolved place\'s path is refused before any write', { skip }, () => {
  const { dir } = exampleProject();
  const ps = places(dir, '.claude/worktrees');
  for (const p of ps) mkdirSync(p, { recursive: true });
  const place = ps[0]!;
  // After the start, `.claude` becomes a link to somewhere else.
  const away = mkdtempSync(join(tmpdir(), 'away-'));
  renameSync(join(dir, '.claude'), join(away, 'moved'));
  mkdirSync(join(away, 'other', 'worktrees'), { recursive: true });
  symlinkSync(join(away, 'other'), join(dir, '.claude'));
  assert.throws(() => (worktrees as unknown as { makePlace: (p: string) => void }).makePlace(place));
  const r = denials({ cwd: dir, home: mkdtempSync(join(tmpdir(), 'home-')), repo: dir, places: ps });
  assert.ok('error' in r, JSON.stringify(r).slice(0, 300));
  assert.throws(() => createWorktree(options({ repo: dir, root: place, rootResolved: true }), 'b', 'b', 'HEAD'));
  assert.equal(existsSync(join(away, 'other', 'worktrees', `${BRAND.cli}-b`)), false, 'nothing made through the link');
});
