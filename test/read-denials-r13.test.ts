// #890 round 13 (the round-9–12 delta check):
// - Worktrees the coordinator owns from before locking came in are locked when it starts (its recovery), not only at
//   the next worktree it makes: `tests.worktree.pool` defaults to 0, so nothing may be made at start, and the first
//   prune run inside an agent's sandbox would remove the unlocked records.
// - A task-checkout place that isn't there when a run starts is made then, so it is hidden whole: a main-checkout run
//   that started before the first worktree existed could read, and overflow on, that worktree (measured by the delta).
// - A long error keeps its last words: a cut at 200 characters turned "so it isn't read" into "so it is".
import { exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { runReadDenials } from '../src/read-denials.js';
import { FakeRunner } from '../src/runner.js';

const linux = process.platform === 'linux';
const skip = !linux && "sandbox-runtime's Linux rules and mkfifo, where CI runs";
const bwrapRuns = linux && spawnSync('bwrap', ['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0;
const SRT = join(repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox');
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

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

test('#890 r13: the coordinator locks the worktrees it owns when it starts, before any is made', async () => {
  const { dir } = exampleProject();
  const base = mkdtempSync(join(tmpdir(), 'coord-'));
  const cfg = loadConfig(dir);
  const stateDir = join(base, 'state');
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  // One it made before this release (unlocked), and another session's, which it never touches.
  const old = join(dir, cfg.tests.worktree.root, 'old-task');
  const foreign = join(dir, cfg.tests.worktree.root, 'someone-else');
  git(dir, 'worktree', 'add', '-q', '-b', 'old', old, 'HEAD');
  git(dir, 'worktree', 'add', '-q', '-b', 'other', foreign, 'HEAD');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'worktrees.json'), JSON.stringify([old]));
  assert.deepEqual(locked(dir), []);
  const c = new Coordinator({ cfg, log: new EventLog(join(base, 'events.db')), backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), runner: new FakeRunner(() => ({ reason: 'succeeded', detail: '', costUsd: 0, turns: 0, model: 'm' })), repo: dir, instance: 'alice', stateDir, slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await c.recover();
  assert.deepEqual(locked(dir), [old]);
  // As a hidden sibling looks inside a sandbox: a prune now keeps it.
  renameSync(old, `${old}-away`);
  git(dir, 'worktree', 'prune');
  renameSync(`${old}-away`, old);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: old }).status, 0);
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

test('#890 r13: a main-checkout run that starts before any worktree exists has the worktree root made and hidden whole; the first worktree made later can\'t be read or overflow it', { skip, timeout: 120_000 }, async () => {
  const { dir } = exampleProject();
  const g = join(dir, '.worklane', 'guardrails.yaml');
  writeFileSync(g, readFileSync(g, 'utf8').replace(/^secret_paths:\n/m, 'secret_paths:\n  - "**/*.pem"\n'));
  const place = join(dir, '.claude', 'worktrees');
  assert.equal(existsSync(place), false);
  const r = runReadDenials({ cwd: dir, home: mkdtempSync(join(tmpdir(), 'home-')), repo: dir });
  if ('error' in r) assert.fail(r.error);
  const d = r as { paths: string[]; sandboxOnly?: string[] };
  assert.ok(existsSync(place), 'the place is made');
  assert.ok(d.sandboxOnly?.includes(place), JSON.stringify(d.sandboxOnly));
  // The first worktree, made after the run started, filled by its own agent.
  const first = join(place, 'first');
  git(dir, 'worktree', 'add', '-q', '-b', 'first', first, 'HEAD');
  mkdirSync(join(first, 'keys'));
  for (let i = 0; i < 3000; i++) writeFileSync(join(first, 'keys', `k${'x'.repeat(40)}${i}.pem`), '');
  writeFileSync(join(first, 'notes.txt'), 'FIRST\n');
  // Before round 13 the wrap threw past bwrap's 9000 arguments, and without the pem files the notes were read.
  const wrapped = await wrap([...d.paths, ...(d.sandboxOnly ?? [])], dir, `cat README.md > /dev/null && echo MAIN-OK; cat ${join(first, 'notes.txt')} 2>/dev/null; true`);
  if (!bwrapRuns) return;
  const out = spawnSync('bash', ['-c', wrapped], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  assert.equal(out.status, 0, (out.stderr ?? '').slice(0, 300));
  assert.match(out.stdout, /MAIN-OK/);
  assert.doesNotMatch(out.stdout, /FIRST/);
});

test('#890 r13: a long refusal keeps its last words', { skip }, () => {
  const { dir } = exampleProject();
  const wt = join(mkdtempSync(join(tmpdir(), 'long-')), 'w'.repeat(160));
  git(dir, 'worktree', 'add', '-q', '-b', 'long', wt, 'HEAD');
  renameSync(join(wt, '.git'), join(wt, '.git-was'));
  execFileSync('mkfifo', [join(wt, '.git')]);
  const r = runReadDenials({ cwd: wt, home: '/h', repo: dir });
  assert.ok('error' in r, JSON.stringify(r));
  assert.match(r.error, /so it isn't read\)/, r.error);
});
