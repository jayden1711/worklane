// A remote name starting with `-` reaches git as an option (#952): `git fetch --upload-pack=<cmd> …` and
// `git ls-remote --upload-pack=<cmd> …` run <cmd>. Every module that takes a remote name from its caller refuses one
// that isn't a plain name (src/git-remote.ts) before any git call, so the command never runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { claim, readClaim, release, renew, type Lease } from '../src/claims.js';
import { LiveConfig, startConfig } from '../src/config/live.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { PrBatcher, type PrBatchDeps } from '../src/coordinator/pr-batch.js';
import { PrTestRuns, type PrTestRunDeps } from '../src/coordinator/test-runs.js';
import { gateGit } from '../src/deploy-gate/wire.js';
import { EventLog } from '../src/events/log.js';
import { gitRemote } from '../src/git-remote.js';
import { acceptGit, repoGit } from '../src/main-watch.js';
import { FakeRunner } from '../src/runner.js';
import { exampleProject } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A clone whose origin has main, and a remote name that would make git run `touch <marker>`. */
function world() {
  const p = exampleProject();
  const remote = join(p.dir, '..', 'origin.git');
  git(join(p.dir, '..'), 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(p.dir, 'remote', 'add', 'origin', remote);
  git(p.dir, 'push', '-q', 'origin', 'main');
  const marker = join(mkdtempSync(join(tmpdir(), 'remote-marker-')), 'ran');
  return { ...p, marker, evil: `--upload-pack=touch ${marker} #` };
}

const refused = /not a git remote name/;

test('gitRemote: plain names pass; a leading dash, an empty name, a space or a slash is refused', () => {
  for (const ok of ['origin', 'upstream', 'my-fork', 'fork_2', 'a.b', '0rigin']) assert.equal(gitRemote(ok), ok);
  for (const bad of ['-x', '--upload-pack=touch x', '', ' origin', 'a b', 'a/b', '.origin', '_x', 'origin\n', 'o\0']) assert.throws(() => gitRemote(bad), refused, JSON.stringify(bad));
});

test('the command a dash remote names really runs through git fetch here (the attack the checks below stop)', () => {
  const w = world();
  try {
    git(w.dir, 'fetch', '-q', w.evil, 'main');
  } catch {
    // git fails after running the command: what matters is that it ran.
  }
  assert.ok(existsSync(w.marker), 'git ran the upload-pack command');
});

test('main-watch: repoGit and acceptGit refuse a dash remote before fetching the tip', () => {
  const w = world();
  assert.throws(() => repoGit(w.dir, w.evil, 'main').tip(), refused);
  assert.throws(() => acceptGit(w.dir, w.evil, 'main').tip(), refused);
  assert.ok(!existsSync(w.marker));
  assert.match(repoGit(w.dir, 'origin', 'main').tip() ?? '', /^[0-9a-f]{40}$/);
});

test('deploy gate: gateGit refuses a dash remote before ls-remote and fetch', () => {
  const w = world();
  assert.throws(() => gateGit(w.dir, w.evil, 'main', 'deploy').fetch(), refused);
  assert.ok(!existsSync(w.marker));
});

test('live config: startConfig and LiveConfig refuse a dash remote before fetching the default branch', () => {
  const w = world();
  const cfg = loadConfig(w.dir);
  assert.throws(() => startConfig({ repo: w.dir, remote: w.evil, fallback: cfg }), refused);
  assert.throws(() => new LiveConfig({ repo: w.dir, remote: w.evil, branch: 'main' }).poll(cfg), refused);
  assert.ok(!existsSync(w.marker));
});

test('claims: readClaim, claim, renew and release refuse a dash remote before ls-remote, fetch or push', () => {
  const w = world();
  const lease: Lease = { instance: 'i', run_id: 'r', issue: 1, expires_at: new Date(Date.now() + 60_000).toISOString(), base: '' };
  const opts = { repo: w.dir, remote: w.evil };
  assert.throws(() => readClaim(1, opts), refused);
  assert.throws(() => claim(lease, opts), refused);
  assert.throws(() => renew(lease, '', opts), refused);
  assert.throws(() => release(1, '', opts), refused);
  assert.ok(!existsSync(w.marker));
  assert.equal(readClaim(1, { repo: w.dir }), null, 'origin still works');
});

test('coordinator, PR batcher and PR test runs refuse a dash remote when built, so none of their fetches can take it', () => {
  const w = world();
  const log = new EventLog(join(w.stateDir, 'events.db'));
  assert.throws(() => new Coordinator({ cfg: loadConfig(w.dir), log, backlog: new FileBacklog(join(w.dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: w.dir, instance: 'i', stateDir: w.stateDir, remote: w.evil }), refused);
  assert.throws(() => new PrBatcher({ log, instance: 'i', repo: w.dir, remote: w.evil, branch: 'main' } as unknown as PrBatchDeps), refused);
  assert.throws(() => new PrTestRuns({ log, actor: 'i', repo: w.dir, remote: w.evil } as unknown as PrTestRunDeps), refused);
  assert.ok(!existsSync(w.marker));
});
