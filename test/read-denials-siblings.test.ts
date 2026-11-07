// #890 round 10, the owner's decision on B5glob (2026-10-21): every other task checkout is hidden from a run whole,
// as one entry, always. Patterns are worked out only in the run's own checkout and the main checkout.
// - B5glob (measured by the round-8 delta check): a committed `**/*.pem` with 3000 matching files in one worktree
//   made sandbox-runtime pass bwrap's 9000-argument limit when it wrapped any other run's command, so every Bash of
//   every other run failed. Now that worktree is one mount, and the matches beneath it add none.
// - A run reads nothing in a sibling checkout (a listed worktree, or a directory git no longer lists in the worktree
//   root), and reads its own checkout and the main checkout as before, apart from the denials.
// Checked with sandbox-runtime's own glob expansion and Linux wrapper (the library Claude Code's sandbox is built on),
// and, where bubblewrap can start here, by running the wrapped command.
import { exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReadDenials } from '../src/read-denials.js';

const linux = process.platform === 'linux';
const skip = !linux && "sandbox-runtime's Linux read-deny rules, where CI runs";
const bwrapRuns = linux && spawnSync('bwrap', ['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0;
const SRT = join(repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox');

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const paths = (r: ReturnType<typeof runReadDenials>) => {
  if ('error' in r) assert.fail(r.error);
  return r.paths;
};

/** The example project with `**\/*.pem` added to the main checkout's secret_paths, and two worktrees in its worktree root. */
function fixture() {
  const { dir } = exampleProject();
  const g = join(dir, '.worklane', 'guardrails.yaml');
  writeFileSync(g, readFileSync(g, 'utf8').replace(/^secret_paths:\n/m, 'secret_paths:\n  - "**/*.pem"\n'));
  writeFileSync(join(dir, '.env'), 'TOKEN=main\n');
  const w = join(dir, '.claude', 'worktrees', 'w');
  const own = join(dir, '.claude', 'worktrees', 'o');
  git(dir, 'worktree', 'add', '-q', '-b', 'w', w, 'HEAD');
  git(dir, 'worktree', 'add', '-q', '-b', 'o', own, 'HEAD');
  writeFileSync(join(own, '.env'), 'TOKEN=own\n');
  writeFileSync(join(w, 'notes.txt'), 'SIBLING\n');
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  return { dir, w, own, home };
}

/** The mount places sandbox-runtime makes of these entries (Linux), and the directories it couldn't list. */
async function expanded(entries: string[], allowWrite: string[]) {
  const utils = await import(join(SRT, 'sandbox-utils.js'));
  const glob = await import(join(SRT, 'read-deny-glob.js'));
  const denyOnly: string[] = [];
  const unlistable = new Set<string>();
  for (const e of entries) {
    const stripped: string = utils.removeTrailingGlobSuffix(e);
    if (utils.containsGlobChars(stripped)) denyOnly.push(...(glob.expandReadDenyGlobLinux(e, allowWrite, unlistable) as string[]));
    else denyOnly.push(stripped);
  }
  return { denyOnly, unlistable: [...unlistable], isAtOrUnder: utils.isAtOrUnder as (p: string, d: string) => boolean };
}

const hides = async (entries: string[], target: string) => {
  const { denyOnly, isAtOrUnder } = await expanded(entries, []);
  return denyOnly.filter((m) => existsSync(m)).some((m) => isAtOrUnder(real(target), real(m)));
};

/** `command` as sandbox-runtime's Linux wrapper wraps it for a run with these entries, writing only in `cwd`. */
async function wrap(entries: string[], cwd: string, command: string): Promise<string> {
  const lin = await import(join(SRT, 'linux-sandbox-utils.js'));
  const { denyOnly, unlistable } = await expanded(entries, [cwd]);
  return lin.wrapCommandWithSandboxLinux({ command, needsNetworkRestriction: false, readConfig: { denyOnly, allowWithinDeny: [], unlistableDenyDirs: unlistable }, writeConfig: { allowOnly: [cwd], denyWithinAllow: [] }, binShell: 'bash' });
}

const mountArgs = (wrapped: string) => (wrapped.match(/--(?:tmpfs|ro-bind|bind|dev-bind)\b/g) ?? []).length;

test('#890 r10 (B5glob): 3000 files a `**` secret glob matches in another worktree leave this run\'s sandbox bounded and its Bash working', { skip, timeout: 120_000 }, async () => {
  const { dir, w, own, home } = fixture();
  mkdirSync(join(w, 'keys'));
  for (let i = 0; i < 3000; i++) writeFileSync(join(w, 'keys', `k${'x'.repeat(40)}${i}.pem`), '');
  const entries = paths(runReadDenials({ cwd: own, home, repo: dir }));
  assert.ok(entries.includes(w), `the sibling is one entry: ${JSON.stringify(entries)}`);
  assert.ok(!entries.some((e) => e.startsWith(`${w}/`)), `nothing listed inside it: ${JSON.stringify(entries.filter((e) => e.startsWith(w)))}`);
  const command = `cat ${join(own, 'README.md')} > /dev/null && echo ok`;
  // Before round 10 this threw: "Sandbox profile has … bwrap arguments and bwrap accepts at most 9000".
  const wrapped = await wrap(entries, own, command);
  assert.ok(mountArgs(wrapped) < 500, `${mountArgs(wrapped)} mount arguments`);
  if (!bwrapRuns) return;
  const r = spawnSync('bash', ['-c', wrapped], { cwd: own, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, (r.stderr ?? '').slice(0, 400));
  assert.match(r.stdout, /ok/);
});

test('#890 r10: a run reads nothing in a sibling checkout; its own checkout and the main checkout read as before, apart from the denials', { skip, timeout: 120_000 }, async () => {
  const { dir, w, own, home } = fixture();
  // A checkout git no longer lists, left in the worktree root.
  const orphan = join(dir, '.claude', 'worktrees', 'orphan');
  mkdirSync(orphan);
  writeFileSync(join(orphan, 'notes.txt'), 'ORPHAN\n');
  for (const [cwd, siblings] of [[own, [w, orphan]], [dir, [w, own, orphan]]] as const) {
    const entries = paths(runReadDenials({ cwd, home, repo: dir }));
    for (const s of siblings) {
      assert.ok(entries.includes(s), `${s} is one entry for a run in ${cwd}: ${JSON.stringify(entries)}`);
      assert.ok(await hides(entries, join(s, 'README.md')), `${s}/README.md hidden from a run in ${cwd}`);
      assert.ok(await hides(entries, join(s, 'notes.txt')), `${s}/notes.txt hidden from a run in ${cwd}`);
    }
    for (const readable of [join(dir, 'README.md'), join(dir, 'package.json'), join(cwd, 'README.md')]) {
      assert.ok(!(await hides(entries, readable)), `${readable} readable from a run in ${cwd}`);
    }
    for (const secret of [join(dir, '.env'), join(cwd, '.env')]) if (existsSync(secret)) assert.ok(await hides(entries, secret), `${secret} hidden`);
    if (!bwrapRuns) continue;
    const r = spawnSync('bash', ['-c', await wrap(entries, cwd, `cat ${join(dir, 'README.md')} ${join(cwd, 'README.md')} > /dev/null && echo OWN-OK; for f in ${siblings.map((s) => join(s, 'notes.txt')).join(' ')} ${join(dir, '.env')}; do cat "$f" 2>/dev/null && echo "READ $f"; done; true`)], { cwd, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, (r.stderr ?? '').slice(0, 400));
    assert.match(r.stdout, /OWN-OK/);
    assert.doesNotMatch(r.stdout, /READ |SIBLING|ORPHAN|TOKEN=/, r.stdout);
  }
});
