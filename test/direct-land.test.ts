// land_mode direct only on a protected default branch (src/direct-land.ts): refused at start-up when GitHub doesn't
// protect it or can't say, allowed when it does, and never a direct push once protection goes away at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { healthView } from '../src/health.js';
import { initInstance } from '../src/instance.js';
import { childEnv, which } from '../src/os/index.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { agentIsSelf, exampleProject, repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cli = join(repoRoot, 'dist', 'src', 'cli.js');
const posix = process.platform === 'win32' && 'POSIX stand-in gh';

const UNPROTECTED = "instance alpha not started: land_mode: direct pushes main itself, and example-org/example-shop has no branch protection, so nothing would stop a bad push; use land_mode: pr, or turn on branch protection";

/** One instance over the example project (file backlog), its policy and config set to `landMode`. */
function instance(landMode: 'direct' | 'pr') {
  const dir = mkdtempSync(join(tmpdir(), 'direct-land-'));
  const { dir: repo } = exampleProject();
  const cfg = join(repo, BRAND.configDir);
  writeFileSync(join(cfg, 'config.yaml'), readFileSync(join(cfg, 'config.yaml'), 'utf8').replace(/^backlog: github/m, 'backlog: file').replace(/^land_mode: pr/m, `land_mode: ${landMode}`));
  const home = initInstance('alpha', repo, 'example-org/example-shop', dir);
  agentIsSelf(home);
  writeFileSync(join(home, 'policy.yaml'), `version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nland_mode: ${landMode}\n`);
  mkdirSync(join(home, 'gh'));
  mkdirSync(join(home, 'claude'));
  writeFileSync(join(home, 'gh', 'token'), 'github_pat_alpha\n');
  return { dir, home };
}

/** A stand-in gh and GitHub API; the branch protection endpoint answers `protection` (an HTTP status). */
async function fakeGitHub(protection: number) {
  const bin = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\n[ "$1 $2" = "auth token" ] && cat "$GH_CONFIG_DIR/token"\n');
  chmodSync(join(bin, 'gh'), 0o755);
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path.endsWith('/protection')) {
      asked.push(path);
      res.writeHead(protection, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(protection === 200 ? { url: path } : { message: 'Branch not protected' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (path === '/user') return res.end(JSON.stringify({ login: 'repo-bot' }));
    if (path.startsWith('/repos/')) return res.end(JSON.stringify({ permissions: { admin: false, push: true } }));
    res.end(JSON.stringify([{ full_name: 'example-org/example-shop' }]));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { bin, api, asked, close: () => new Promise((r) => server.close(r)) };
}

const run = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ status: number | null; stderr: string }>((res) => {
    const p = spawn(process.execPath, [cli, ...args], { env, cwd: tmpdir() });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += String(d)));
    p.on('exit', (status) => res({ status, stderr }));
  });

async function start(landMode: 'direct' | 'pr', protection: number) {
  const { dir, home } = instance(landMode);
  const gh = await fakeGitHub(protection);
  const env = { ...childEnv(), PATH: `${gh.bin}${delimiter}${process.env.PATH}`, [`${BRAND.envPrefix}_INSTANCES_DIR`]: dir, [`${BRAND.envPrefix}_GITHUB_API`]: gh.api };
  try {
    const r = await run(['coordinator', 'run', '--instance', 'alpha', '--once'], env);
    const log = new EventLog(join(home, 'state', 'events.db'));
    try {
      return { ...r, asked: gh.asked.length, events: log.read() };
    } finally {
      log.close();
    }
  } finally {
    await gh.close();
  }
}

for (const status of [404, 403]) {
  test(`land_mode direct on a branch GitHub doesn't protect (${status}): the coordinator refuses to start, says why, and health and the dashboard show it`, { skip: posix }, async () => {
    const r = await start('direct', status);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes(UNPROTECTED), r.stderr);
    assert.equal(r.events.filter((e) => e.type === 'coordinator.started').length, 0, 'never started');
    const err = r.events.find((e) => e.type === 'coordinator.error')?.payload as { where: string; kind: string; message: string } | undefined;
    assert.deepEqual([err?.where, err?.kind, err?.message], ['start-up', 'direct_land_refused', UNPROTECTED], 'recorded: the dashboard lists coordinator errors');
    assert.equal(healthView(r.events, null).suggestions[0], UNPROTECTED, 'health says it first');
  });
}

test("land_mode direct when the protection can't be checked (GitHub errors): fail closed, the coordinator refuses to start", { skip: posix }, async () => {
  const r = await start('direct', 500);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /instance alpha not started: land_mode: direct pushes main itself, and example-org\/example-shop's branch protection couldn't be checked \(GitHub 500 reading main's protection\), so nothing is known to stop a bad push/);
  assert.equal(r.events.filter((e) => e.type === 'coordinator.started').length, 0, 'never started');
  assert.match(healthView(r.events, null).suggestions[0]!, /couldn't be checked/);
});

test('land_mode direct on a branch GitHub protects: the coordinator starts', { skip: posix }, async () => {
  const r = await start('direct', 200);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.asked, 1, 'the protection was asked at start-up');
  assert.equal(r.events.filter((e) => e.type === 'coordinator.started').length, 1);
  assert.equal(r.events.filter((e) => e.type === 'coordinator.error').length, 0);
});

test("land_mode pr on a branch GitHub doesn't protect: the coordinator starts as before (the main watch guards it)", { skip: posix }, async () => {
  const r = await start('pr', 404);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.events.filter((e) => e.type === 'coordinator.started').length, 1);
  assert.ok(!r.events.some((e) => e.type === 'coordinator.error' && (e.payload as { kind: string }).kind === 'direct_land_refused'));
});

// ------------------------------------------------------------- at runtime: every direct land asks again

const skip = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
const ISSUE = 'Totals count non-positive quantities.\n\n```done_when\n- test: test/price.test.js\n```\n';

function landFixture() {
  const base = mkdtempSync(join(tmpdir(), 'direct-land-run-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false']]) git(repo, 'config', k!, v!);
  const cfg = loadConfig(repo);
  cfg.project.land_mode = 'direct';
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  return { repo, cfg, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), log: new EventLog(join(base, 'events.db')), slotsDir, stateDir: join(base, 'state') };
}

const runner = () =>
  new FakeRunner((req: RunRequest) => {
    if (req.role === 'worker') {
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      git(req.cwd, 'add', '-A');
      git(req.cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fix');
      return { structured: { summary: 'fixed' } };
    }
    const base = /Base commit: ([0-9a-f]{40})/.exec(req.prompt)?.[1];
    const files = base ? git(req.cwd, 'diff', '--name-only', `${base}..HEAD`).split('\n').filter(Boolean) : [];
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: files } };
  });

/** A task built and queued to land, with `answer()` as the branch's protection on every ask. */
async function queued(answer: () => 'enforced' | 'none') {
  const f = landFixture();
  const asks: string[] = [];
  const protection = { protection: async (branch: string) => (asks.push(branch), answer()) };
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  const mainBefore = git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: runner(), repo: f.repo, instance: 'alpha', stateDir: f.stateDir, slotsDir: f.slotsDir, maxAttempts: 1, protection, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await c.tick();
  await c.idle();
  assert.equal(f.log.read(0, ['land.queued']).length, 1, 'queued to land');
  const main = () => git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
  return { f, c, asks, mainBefore, main };
}

test('land_mode direct on a protected branch lands, asking the protection before it pushes', { skip }, async () => {
  const { f, c, asks, mainBefore, main } = await queued(() => 'enforced');
  await c.tick();
  const r = f.log.read(0, ['land.result']).at(-1)?.payload as { outcome: string; landed: string } | undefined;
  assert.equal(r?.outcome, 'landed', JSON.stringify(r));
  assert.equal(main(), r!.landed);
  assert.notEqual(main(), mainBefore);
  assert.ok(asks.length >= 1 && asks.every((b) => b === 'main'), `asked before landing: ${asks.join(', ')}`);
});

test('protection removed while running: no direct push happens, it is reported, and it lands once protection is back', { skip }, async () => {
  let answer: 'enforced' | 'none' = 'enforced';
  const { f, c, mainBefore, main } = await queued(() => answer);
  answer = 'none';
  await c.tick();
  await c.tick();
  assert.equal(main(), mainBefore, 'main untouched: nothing pushed');
  assert.ok(!f.log.read(0, ['land.result']).some((e) => (e.payload as { outcome: string }).outcome === 'landed'));
  const errs = f.log.read(0, ['coordinator.error']).map((e) => e.payload as { where: string; kind: string; message: string });
  assert.equal(errs.length, 1, 'reported once, not every tick');
  assert.deepEqual([errs[0]!.where, errs[0]!.kind], ['direct land', 'direct_land_refused']);
  assert.match(errs[0]!.message, /nothing pushed: land_mode: direct pushes main itself, and .* has no branch protection/);
  assert.match(healthView(f.log.read(), null).suggestions[0]!, /nothing pushed: land_mode: direct/);
  answer = 'enforced';
  await c.tick();
  const r = f.log.read(0, ['land.result']).at(-1)?.payload as { outcome: string; landed: string };
  assert.equal(r.outcome, 'landed');
  assert.equal(main(), r.landed);
  assert.doesNotMatch(healthView(f.log.read(), null).suggestions[0]!, /nothing pushed/, 'cleared by the land');
});

test('protection removed between the gates and the push: the push itself is refused', { skip }, async () => {
  // Enforced for the ask before the gates, gone by the ask right before the push.
  let n = 0;
  const { f, c, mainBefore, main } = await queued(() => (++n <= 1 ? 'enforced' : 'none'));
  await c.tick();
  assert.equal(main(), mainBefore, 'nothing pushed');
  const r = f.log.read(0, ['land.result']).at(-1)?.payload as { outcome: string; detail: string };
  assert.equal(r.outcome, 'deferred');
  assert.match(r.detail, /not pushed: land_mode: direct pushes main itself/);
});
