// #890 round 20 (both reviews of 1d90008f):
// - G1: removing an old `<cli>-*` worktree freed its name before the placeholder was made, so a main-checkout command
//   already running could plant a link there, by polling `ln -sT` or by `rmdir` and then `ln` (measured), and runs
//   that held the name as an entry lost Bash. The old name is never freed now: the worktree's directory is emptied in
//   place and its git record dropped.
// - Every caller: the link check and the kept list applied only to options that set them; the nightly baseline and
//   auto-config built options without them, and a worktree was written through a planted link (measured). Every
//   WorktreeOptions now comes from one helper that resolves the root once and carries the task directory.
import { exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { runReadDenials } from '../src/read-denials.js';
import * as nightly from '../src/nightly.js';
import * as autoConfig from '../src/auto-config.js';
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
const places = (repo: string, root: string) => (worktrees.worktreePlaces as unknown as (...a: unknown[]) => string[])(repo, root, null);
/** The one helper (round 20), called loosely so older trees still build. */
const helper = (o: Record<string, unknown>): WorktreeOptions => {
  const f = (worktrees as unknown as { worktreeOptions?: (o: Record<string, unknown>) => WorktreeOptions }).worktreeOptions;
  assert.equal(typeof f, 'function', 'worktreeOptions exists');
  return f!(o);
};

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

function started(wrapped: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn('bash', ['-c', wrapped], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', () => done({ stdout, stderr }));
  });
}

/** Root ".": an old worktree directly in the main checkout, owned and locked; a main-checkout run's denials. */
async function oldWorktreeHeld() {
  const { dir } = exampleProject();
  const o = { repo: dir, root: dir, rootResolved: true, taskDir: null, stateDir: mkdtempSync(join(tmpdir(), 'wt-state-')), setup: [] } as unknown as WorktreeOptions;
  const ps = places(dir, '.');
  for (const p of ps) mkdirSync(p, { recursive: true });
  const old = join(dir, `${BRAND.cli}-issue-5`);
  git(dir, 'worktree', 'add', '-q', '-b', 'b5', old, 'HEAD');
  git(dir, 'worktree', 'lock', old);
  mkdirSync(o.stateDir, { recursive: true });
  writeFileSync(join(o.stateDir, 'worktrees.json'), JSON.stringify([old]));
  const d = ok(denials({ cwd: dir, home: mkdtempSync(join(tmpdir(), 'home-')), repo: dir, places: ps }));
  assert.ok(d.paths.includes(old), 'the old worktree is an entry');
  return { dir, o, old, d };
}

async function stillTaken(dir: string, old: string, d: { paths: string[]; sandboxOnly?: string[] }) {
  assert.ok(lstatSync(old).isDirectory() && !lstatSync(old).isSymbolicLink(), 'the old name is still a real directory');
  const out = spawnSync('bash', ['-c', await wrap([...d.paths, ...(d.sandboxOnly ?? [])], dir, 'echo BASH-OK')], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  assert.match(out.stdout, /BASH-OK/, (out.stderr ?? '').slice(0, 300));
}

test('#890 r20 (G1): a running command polling `ln -sT` can\'t plant a link at an old worktree\'s name while it is removed', { skip: bwrapSkip, timeout: 120_000 }, async () => {
  const { dir, o, old, d } = await oldWorktreeHeld();
  const running = started(await wrap([...d.paths, ...(d.sandboxOnly ?? [])], dir, `for i in $(seq 1 4000); do ln -sT /usr ${old} 2>/dev/null && { echo PLANTED; break; }; sleep 0.001; done; echo DONE`), dir);
  await new Promise((r) => setTimeout(r, 500));
  createWorktree(o, 'issue-5', 'b5', 'HEAD');
  const out = await running;
  assert.match(out.stdout, /DONE/, out.stderr.slice(0, 300));
  await stillTaken(dir, old, d);
});

test('#890 r20 (G1): a running command can\'t rmdir an old worktree\'s name and plant a link there after it is removed', { skip: bwrapSkip, timeout: 120_000 }, async () => {
  const { dir, o, old, d } = await oldWorktreeHeld();
  const marker = join(dir, '.removed-marker');
  const running = started(await wrap([...d.paths, ...(d.sandboxOnly ?? [])], dir, `for i in $(seq 1 400); do [ -e ${marker} ] && break; sleep 0.01; done; rmdir ${old} 2>/dev/null; ln -sT /usr ${old} 2>/dev/null && echo PLANTED; echo DONE`), dir);
  await new Promise((r) => setTimeout(r, 500));
  createWorktree(o, 'issue-5', 'b5', 'HEAD');
  writeFileSync(marker, 'x');
  const out = await running;
  assert.match(out.stdout, /DONE/, out.stderr.slice(0, 300));
  await stillTaken(dir, old, d);
});

/** A configured root resolved once (its options built), then a link planted at it: nothing may be written through it. */
function plantedAfter(root: string, build: (repo: string, root: string) => WorktreeOptions) {
  const { dir } = exampleProject();
  mkdirSync(root, { recursive: true });
  const o = build(dir, root);
  const away = mkdtempSync(join(tmpdir(), 'away-'));
  renameSync(root, `${root}-was`);
  symlinkSync(away, root);
  return { dir, o, away };
}

test('#890 r20: options from the one helper refuse a worktree through a link planted after they were built', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'wts-'));
  const { o, away } = plantedAfter(join(base, 'wt'), (repo, root) => helper({ repo, root, stateDir: mkdtempSync(join(tmpdir(), 'wt-state-')), setup: [], taskDir: null }));
  assert.throws(() => createWorktree(o, 'a', 'a', 'HEAD'));
  assert.deepEqual(readdirSync(away), [], 'nothing written through the link');
});

test('#890 r20: the nightly baseline\'s worktree, through the coordinator\'s options, refuses a link planted after the start', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'wts-'));
  const make = (nightly as unknown as { baselineWorktree?: (...a: unknown[]) => unknown }).baselineWorktree;
  assert.equal(typeof make, 'function', 'the baseline worktree is made through one function');
  const { dir, o, away } = plantedAfter(join(base, 'wt'), (repo, root) => helper({ repo, root, stateDir: mkdtempSync(join(tmpdir(), 'wt-state-')), setup: [], taskDir: null }));
  const sha = git(dir, 'rev-parse', 'HEAD');
  assert.throws(() => make!(dir, loadConfig(dir), sha, undefined, o));
  assert.deepEqual(readdirSync(away), [], 'nothing written through the link');
});

test('#890 r20: auto-config\'s setup worktree options come from the one helper and refuse a link planted after they were built', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'wts-'));
  const build = (autoConfig as unknown as { setupWorktreeOptions?: (...a: unknown[]) => WorktreeOptions }).setupWorktreeOptions;
  assert.equal(typeof build, 'function', 'auto-config builds its options through one function');
  const { o, away } = plantedAfter(join(base, 'wt'), (repo, root) => build!(repo, root, mkdtempSync(join(tmpdir(), 'wt-state-'))));
  assert.equal((o as unknown as { rootResolved?: boolean }).rootResolved, true);
  assert.throws(() => createWorktree(o, 'setup', 'setup', 'HEAD'));
  assert.deepEqual(readdirSync(away), [], 'nothing written through the link');
  assert.equal(existsSync(join(away, `${BRAND.cli}-setup`)), false);
});
