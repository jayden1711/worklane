// #890 round 18 (the round-17 reviews; the coordinator's decisions):
// - F1/R1: a task whose worktree was made under a `..` or `.` root before round 17 was made again at its old path,
//   where only a name pattern covered it, so a command already running read it (measured). Every worktree the
//   coordinator makes now goes in worktreeDir(); the old path only finds, locks, reuses or removes one.
// - F2/R3: the pattern `<root>/<cli>-*` is gone. Each old `<cli>-*` directory there at the run's start is one whole
//   entry; anything else so named (a link, a plain file such as an npm tarball) is neither hidden nor refused, so a
//   link planted while runs go on takes nobody's Bash, and a tarball beside the repository refuses nothing.
// - R2: one test of "this root holds the main checkout or the common git dir" for worktreeDir and the denials: a root
//   that holds only the common git dir (a separate git dir) gets the engine's own directory too.
// - N1: a coordinator place that is itself a link refuses the run.
import { exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { runReadDenials } from '../src/read-denials.js';
import { createWorktree, worktreeDir, worktreePlaces, type WorktreeOptions } from '../src/worktrees.js';

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
const entries = (d: { paths: string[]; sandboxOnly?: string[] }) => [...d.paths, ...(d.sandboxOnly ?? [])];

/** `command` as sandbox-runtime's Linux wrapper wraps it with these read entries, writing only in `cwd`. */
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

function coordinatorAt(root: string) {
  const { dir } = exampleProject();
  const o: WorktreeOptions = { repo: dir, root, stateDir: mkdtempSync(join(tmpdir(), 'wt-state-')), setup: [] };
  const places = worktreePlaces(dir, root);
  for (const p of places) mkdirSync(p, { recursive: true });
  return { dir, o, places, home: mkdtempSync(join(tmpdir(), 'home-')) };
}

for (const root of ['..', '.']) {
  test(`#890 r18 (F1): root "${root}": an owned worktree from before round 17 is made again in the engine's directory, unreadable to a command already running`, { skip: bwrapSkip, timeout: 120_000 }, async () => {
    const { dir, o, places, home } = coordinatorAt(root);
    // As round 16 made it: directly under the root, owned and locked.
    const legacy = join(dir, root, `${BRAND.cli}-issue-5`);
    git(dir, 'worktree', 'add', '-q', '-b', 'b5', legacy, 'HEAD');
    git(dir, 'worktree', 'lock', legacy);
    mkdirSync(o.stateDir, { recursive: true });
    writeFileSync(join(o.stateDir, 'worktrees.json'), JSON.stringify([join(dirname(legacy), `${BRAND.cli}-issue-5`)]));
    const d = ok(denials({ cwd: dir, home, repo: dir, places }));
    const fresh = join(worktreeDir(dir, root), `${BRAND.cli}-issue-5`);
    const running = started(await wrap(entries(d), dir, `sleep 3; for p in ${legacy} ${fresh}; do cat $p/notes.txt 2>/dev/null; done; echo DONE`), dir);
    await new Promise((r) => setTimeout(r, 500));
    const { path } = createWorktree(o, 'issue-5', 'b5', 'HEAD');
    assert.equal(path, fresh, 'made in the engine\'s own directory');
    writeFileSync(join(path, 'notes.txt'), 'REMADE\n');
    const out = await running;
    assert.match(out.stdout, /DONE/, out.stderr.slice(0, 300));
    assert.doesNotMatch(out.stdout, /REMADE/);
  });
}

test('#890 r18 (F2): root ".": a link planted under the engine\'s names while runs go on takes nobody\'s Bash', { skip: bwrapSkip, timeout: 120_000 }, async () => {
  const { dir, places, home } = coordinatorAt('.');
  const d = ok(denials({ cwd: dir, home, repo: dir, places }));
  symlinkSync('/usr', join(dir, `${BRAND.cli}-evil`));
  const out = spawnSync('bash', ['-c', await wrap(entries(d), dir, 'echo BASH-OK')], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  assert.match(out.stdout, /BASH-OK/, (out.stderr ?? '').slice(0, 300));
  // And a run started after it: the link is neither hidden nor refused.
  const after = ok(denials({ cwd: dir, home, repo: dir, places }));
  const out2 = spawnSync('bash', ['-c', await wrap(entries(after), dir, 'echo BASH-OK')], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  assert.match(out2.stdout, /BASH-OK/, (out2.stderr ?? '').slice(0, 300));
});

test('#890 r18 (R3): a plain file named like the engine\'s worktrees beside the repository refuses nothing', { skip }, () => {
  const { dir, places, home } = coordinatorAt('..');
  writeFileSync(join(dirname(dir), `${BRAND.cli}-cli-0.5.3.tgz`), 'x');
  ok(denials({ cwd: dir, home, repo: dir, places }));
});

test('#890 r18 (R2): a root that holds only the common git dir (a separate git dir) gets the engine\'s own directory', { skip }, () => {
  const { dir } = exampleProject();
  const store = join(dirname(dir), 'store');
  mkdirSync(store);
  renameSync(join(dir, '.git'), join(store, 'example.git'));
  writeFileSync(join(dir, '.git'), `gitdir: ${join(store, 'example.git')}\n`);
  git(dir, 'config', 'core.worktree', dir);
  assert.equal(worktreeDir(dir, store), join(store, `${BRAND.cli}-worktrees`));
  const places = worktreePlaces(dir, store);
  assert.ok(places.includes(join(store, `${BRAND.cli}-worktrees`)), JSON.stringify(places));
  for (const p of places) mkdirSync(p, { recursive: true });
  const d = ok(denials({ cwd: dir, home: mkdtempSync(join(tmpdir(), 'home-')), repo: dir, places }));
  assert.ok(d.sandboxOnly?.includes(join(store, `${BRAND.cli}-worktrees`)), JSON.stringify(d.sandboxOnly));
});

test('#890 r18 (N1): a coordinator place that is a link refuses the run', { skip }, () => {
  const { dir } = exampleProject();
  const away = mkdtempSync(join(tmpdir(), 'away-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  symlinkSync(away, join(dir, '.claude', 'worktrees'));
  const places = worktreePlaces(dir, '.claude/worktrees');
  for (const p of places.slice(1)) mkdirSync(p, { recursive: true });
  const r = denials({ cwd: dir, home: mkdtempSync(join(tmpdir(), 'home-')), repo: dir, places });
  assert.ok('error' in r, JSON.stringify(r).slice(0, 300));
  assert.match(r.error, /link/);
});
