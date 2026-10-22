// #890 round 14 (the round-13 reviews):
// - F1, a regression against main: round 13 made each task-checkout place before working out a run's denials, and
//   the places came from every config the run reads, its own checkout's (which its agent can write) among them. So an
//   agent-written `tests.worktree.root` made the coordinator create a directory anywhere, `.git/hooks/pre-commit`
//   included, which broke every commit (measured by the second review). Now only the coordinator's own places (its
//   start config's root and the engine's own) are made, by the coordinator at its start; working out a run's denials
//   creates nothing. A place another config names is hidden whole when it exists, never made.
// - F2: an alternate object store inside another worktree kept that worktree from being hidden whole (measured under
//   bwrap). A run whose store chain reaches into a task-checkout place or another worktree is now refused, by name.
import { exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { runReadDenials } from '../src/read-denials.js';
import { FakeRunner } from '../src/runner.js';

const linux = process.platform === 'linux';
const skip = !linux && "sandbox-runtime's Linux rules, where CI runs";
const bwrapRuns = linux && spawnSync('bwrap', ['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0;
const SRT = join(repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox');
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Set `tests.worktree.root` in the config folder of `checkout`, as an agent can in its own checkout. */
function setRoot(checkout: string, root: string) {
  const f = join(checkout, '.worklane', 'tests.yaml');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^ {2}root: .*$/m, `  root: ${JSON.stringify(root)}`));
}

test('#890 r14 (F1): a worktree root an agent wrote makes nothing, wherever it points', { skip }, () => {
  const { dir } = exampleProject();
  const own = join(dir, '.claude', 'worktrees', 'o');
  git(dir, 'worktree', 'add', '-q', '-b', 'o', own, 'HEAD');
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const away = mkdtempSync(join(tmpdir(), 'away-'));
  symlinkSync(away, join(own, 'link'));
  const cases: [string, string, string][] = [
    // [written in, root, the directory it would have made]
    [own, join(away, 'abs', 'x', 'y'), join(away, 'abs')],
    [own, '.git/hooks/pre-commit', join(dir, '.git', 'hooks', 'pre-commit')],
    [own, '.claude/worktrees/o/link/made', join(away, 'made')],
    [own, '../x', join(dirname(dir), 'x')],
    [own, join(home, '.gitconfig'), join(home, '.gitconfig')],
    // The main checkout's working tree, which a main-checkout role can write.
    [dir, '../y', join(dirname(dir), 'y')],
  ];
  for (const [where, root, made] of cases) {
    setRoot(where, root);
    runReadDenials({ cwd: own, home, repo: dir });
    assert.equal(existsSync(made), false, `${root} written in ${where === own ? 'the run\'s checkout' : 'the main checkout'} made ${made}`);
    setRoot(where, '.claude/worktrees');
  }
  // The commits still work: nothing was made under .git/hooks.
  assert.equal(spawnSync('git', ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: dir }).status, 0);
});

test('#890 r14 (F1): the coordinator makes its own places at its start, and every run hides them whole', { skip }, async () => {
  const { dir } = exampleProject();
  const base = mkdtempSync(join(tmpdir(), 'coord-'));
  const cfg = loadConfig(dir);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const places = [join(dir, cfg.tests.worktree.root), join(projectStateDir(dir), 'worktrees')];
  for (const p of places) assert.equal(existsSync(p), false);
  const c = new Coordinator({ cfg, log: new EventLog(join(base, 'events.db')), backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), runner: new FakeRunner(() => ({ reason: 'succeeded', detail: '', costUsd: 0, turns: 0, model: 'm' })), repo: dir, instance: 'alice', stateDir: join(base, 'state'), slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await c.recover();
  for (const p of places) assert.ok(existsSync(p), `${p} made at start`);
  const r = runReadDenials({ cwd: dir, home: mkdtempSync(join(tmpdir(), 'home-')), repo: dir });
  if ('error' in r) assert.fail(r.error);
  assert.deepEqual([...((r as { sandboxOnly?: string[] }).sandboxOnly ?? [])].sort(), [...places].sort());
});

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

test('#890 r14 (F2): an alternate store inside another worktree refuses the run, by name; without it the sibling stays hidden', { skip, timeout: 120_000 }, async () => {
  const { dir } = exampleProject();
  const a = join(dir, '.claude', 'worktrees', 'a');
  const b = join(dir, '.claude', 'worktrees', 'b');
  git(dir, 'worktree', 'add', '-q', '-b', 'a', a, 'HEAD');
  git(dir, 'worktree', 'add', '-q', '-b', 'b', b, 'HEAD');
  writeFileSync(join(b, 'notes.txt'), 'SIBLING-B\n');
  const task = join(mkdtempSync(join(tmpdir(), 'task-')), 't.json');
  writeFileSync(task, JSON.stringify({ id: 't', done_when: [{ manual: 'x' }], hidden: ['evals/**'] }));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  // Control: the sibling is one entry, and unreadable under bwrap.
  const ok = runReadDenials({ cwd: a, home, repo: dir, taskFile: task });
  if ('error' in ok) assert.fail(ok.error);
  assert.ok(ok.paths.includes(b), JSON.stringify(ok.paths));
  if (bwrapRuns) {
    const out = spawnSync('bash', ['-c', await wrap([...ok.paths, ...((ok as { sandboxOnly?: string[] }).sandboxOnly ?? [])], a, `cat ${join(b, 'notes.txt')} 2>/dev/null; echo DONE`)], { cwd: a, encoding: 'utf8', timeout: 60_000 });
    assert.match(out.stdout, /DONE/, out.stderr);
    assert.doesNotMatch(out.stdout, /SIBLING-B/);
  }
  // A main-checkout role names a directory inside sibling b as an alternate store of the repository.
  writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), `${join(b, 'src')}\n`);
  const r = runReadDenials({ cwd: a, home, repo: dir, taskFile: task });
  assert.ok('error' in r, `refused: ${JSON.stringify(r).slice(0, 400)}`);
  assert.match(r.error, /store/);
  assert.ok(r.error.includes(join(b, 'src')), r.error);
});
