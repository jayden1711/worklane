// #890 round 17 (the round-16 reviews; the coordinator's decision): under a start root that holds the main checkout
// (`..`, `.`), round 16 hid the engine's worktrees by a name pattern, `<root>/<cli>-*`, which the sandbox expands only
// when it wraps a command. So a command already running read a worktree made later, could rename one out of the
// pattern for good, and links planted under the pattern took Bash away (all measured by the second review). Now the
// coordinator makes its new worktrees under such a root in a directory of its own, `<root>/<cli>-worktrees`, made at
// start and hidden whole, so a mount covers even commands already running. (Round 18 dropped the pattern: each old
// worktree directory there is one whole entry, and a link or file so named is ignored, never refused; the last two
// tests here were changed to that.)
import { exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { runReadDenials } from '../src/read-denials.js';
import { createWorktree, worktreePath, worktreePlaces, type WorktreeOptions } from '../src/worktrees.js';

const linux = process.platform === 'linux';
const skip = !linux && "sandbox-runtime's Linux rules, where CI runs";
const bwrapRuns = linux && spawnSync('bwrap', ['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0;
const SRT = join(repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox');
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

type Denials = { paths: string[]; sandboxOnly?: string[] } | { error: string };
const denials = (o: Record<string, unknown>): Denials => runReadDenials(o as Parameters<typeof runReadDenials>[0]);
const ok = (d: Denials) => {
  if ('error' in d) assert.fail(d.error);
  return d;
};

/** `command` as sandbox-runtime's Linux wrapper wraps it with these read entries, writing only in `cwd`. */
async function wrap(entries: string[], cwd: string, command: string): Promise<string> {
  const utils = await import(join(SRT, 'sandbox-utils.js'));
  const glob = await import(join(SRT, 'read-deny-glob.js'));
  const lin = await import(join(SRT, 'linux-sandbox-utils.js'));
  const denyOnly: string[] = [];
  const unlistable = new Set<string>();
  for (const e of entries) {
    const stripped: string = utils.removeTrailingGlobSuffix(e);
    if (utils.containsGlobChars(stripped)) denyOnly.push(...(glob.expandReadDenyGlobLinux(e, [cwd], unlistable) as string[]));
    else denyOnly.push(stripped);
  }
  return lin.wrapCommandWithSandboxLinux({ command, needsNetworkRestriction: false, readConfig: { denyOnly, allowWithinDeny: [], unlistableDenyDirs: [...unlistable] }, writeConfig: { allowOnly: [cwd], denyWithinAllow: [] }, binShell: 'bash' });
}

/** Start `wrapped` now; resolve with its output when it ends. */
function started(wrapped: string, cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn('bash', ['-c', wrapped], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

/** The example project, with the coordinator's start root `root` (one that holds the main checkout). */
function coordinatorAt(root: string) {
  const { dir } = exampleProject();
  const o: WorktreeOptions = { repo: dir, root, stateDir: mkdtempSync(join(tmpdir(), 'wt-state-')), setup: [] };
  const places = worktreePlaces(dir, root);
  for (const p of places) mkdirSync(p, { recursive: true });
  return { dir, o, places, home: mkdtempSync(join(tmpdir(), 'home-')) };
}

for (const root of ['..', '.']) {
  test(`#890 r17: start root "${root}": a command already running when a worktree is made can't read it`, { skip: skip || (!bwrapRuns && 'bubblewrap can\'t start here'), timeout: 120_000 }, async () => {
    const { dir, o, places, home } = coordinatorAt(root);
    const own = createWorktree(o, 'issue-1', 'b1', 'HEAD').path;
    for (const [cwd, label, n] of [[own, 'worktree run', 2], [dir, 'main-checkout run', 3]] as const) {
      const late = worktreePath(o, `issue-${n}`);
      const d = ok(denials({ cwd, home, repo: dir, places }));
      // Wrapped (and its mounts fixed) before the worktree exists; it reads after.
      const running = started(await wrap([...d.paths, ...(d.sandboxOnly ?? [])], cwd, `sleep 3; cat ${join(late, 'notes.txt')} ${join(late, 'README.md')} 2>/dev/null; echo DONE`), cwd);
      await new Promise((r) => setTimeout(r, 500));
      createWorktree(o, `issue-${n}`, `b${n}`, 'HEAD');
      writeFileSync(join(late, 'notes.txt'), 'LATE\n');
      const out = await running;
      assert.match(out.stdout, /DONE/, `${label}: ${out.stderr.slice(0, 300)}`);
      assert.doesNotMatch(out.stdout, /LATE|Example project/, `${label} read the later worktree`);
    }
  });
}

test('#890 r17: start root ".": a running main-checkout command can\'t rename a later worktree out of reach', { skip: skip || (!bwrapRuns && 'bubblewrap can\'t start here'), timeout: 120_000 }, async () => {
  const { dir, o, places, home } = coordinatorAt('.');
  const late = worktreePath(o, 'issue-2');
  const moved = join(dir, 'zz-moved');
  const d = ok(denials({ cwd: dir, home, repo: dir, places }));
  const running = started(await wrap([...d.paths, ...(d.sandboxOnly ?? [])], dir, `sleep 3; mv ${late} ${moved} 2>/dev/null; echo DONE`), dir);
  await new Promise((r) => setTimeout(r, 500));
  createWorktree(o, 'issue-2', 'b2', 'HEAD');
  const out = await running;
  assert.match(out.stdout, /DONE/, out.stderr.slice(0, 300));
  assert.equal(existsSync(moved), false, 'moved out of the hidden place');
  assert.ok(existsSync(join(late, 'README.md')), 'still where the coordinator made it');
});

test('#890 r17: a link planted under the engine\'s worktree names is neither followed nor hidden', { skip }, () => {
  // Round 17 refused this run; since round 18 (no name pattern) a link there is ignored: nothing mounts where it leads.
  const { dir, places, home } = coordinatorAt('.');
  const planted = join(dir, `${BRAND.cli}-evil`);
  symlinkSync('/usr', planted);
  const d = ok(denials({ cwd: dir, home, repo: dir, places }));
  for (const e of [...d.paths, ...(d.sandboxOnly ?? [])]) assert.ok(e !== planted && e !== '/usr' && !e.includes(`${BRAND.cli}-*`), `entry ${e}`);
});

test('#890 r17: a repository path that is a link to a directory named like the engine\'s worktrees, under a root of "..", never hides the main checkout', { skip }, () => {
  // Round 17 refused this run; since round 18 (no name pattern) the real main checkout is simply never an entry.
  const { dir: made } = exampleProject();
  const real = join(dirname(made), `${BRAND.cli}-real`);
  renameSync(made, real);
  const link = join(dirname(made), 'proj');
  symlinkSync(real, link);
  const places = worktreePlaces(link, '..');
  for (const p of places) mkdirSync(p, { recursive: true });
  const d = ok(denials({ cwd: link, home: mkdtempSync(join(tmpdir(), 'home-')), repo: link, places }));
  for (const e of [...d.paths, ...(d.sandboxOnly ?? [])]) assert.ok(e !== real && e !== link && !e.includes(`${BRAND.cli}-*`), `entry ${e}`);
  // git still works in the real checkout.
  assert.equal(git(real, 'rev-parse', '--is-inside-work-tree'), 'true');
});
