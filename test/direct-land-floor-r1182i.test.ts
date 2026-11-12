import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// R1182i (final check) attacks on #1182: is an approval given at landing bound to the output it was asked about?
// Ported from the review's JavaScript, assertions unchanged.

const skip = !which('gitleaks') && 'gitleaks not installed';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const REVIEW = (wait: string[]) => ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } }, merge: { wait_categories: wait } });
const LANDING_FLOOR = ": held for the owner (direct land's merge-policy floor, checked again at landing)";

function fixture(mode: 'direct' | 'pr', wait: string[] = []) {
  const base = mkdtempSync(join(tmpdir(), 'r1182i-'));
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
const results = (f: Fixture) => f.log.read(0, ['land.result']).map((e) => e.payload as EventPayload<'land.result'>);
const asked = (f: Fixture) => f.log.read(0, ['decision.asked']).map((e) => e.payload as EventPayload<'decision.asked'>).filter((q) => q.kind === 'land');
const ciOnMain = (f: Fixture) => {
  try {
    return git(f.base, '--git-dir', f.remote, 'show', 'main:.gitlab-ci.yml');
  } catch {
    return null;
  }
};

test('I1: the owner approves the landing question; the pre-land output then changes; the changed output lands with no new question', { skip }, async () => {
  const f = fixture('direct');
  const payload = join(f.base, 'payload.txt');
  writeFileSync(payload, 'test: { script: [echo safe] }\n');
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, { 'tools/gen.mjs': `import { readFileSync, writeFileSync } from 'node:fs';\nwriteFileSync('.gitlab-ci.yml', readFileSync(${JSON.stringify(payload)}));\n` });
  await cycle(f);
  const q = asked(f).at(-1);
  assert.ok(q?.receipts.some((r) => r.startsWith('high-risk: ci-config (.gitlab-ci.yml)')), `held and asked at landing: ${JSON.stringify({ results: results(f), q })}`);
  // Between the question and the next land, what the step writes changes (any step whose output isn't a pure function of the batch).
  writeFileSync(payload, 'test: { script: [echo pwned] }\n');
  f.log.append('decision.answered', { id: q!.id, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  await cycle(f);
  await cycle(f);
  const s = JSON.stringify({ results: results(f), asked: asked(f).length, ci: ciOnMain(f) });
  assert.ok(!(ciOnMain(f) ?? '').includes('pwned'), `ci-config content the owner was never asked about landed on a landing approval for other content: ${s}`);
});

// ---- landFloor directly: a landing approval on one entry covers another entry's later output ----
function event(f: Fixture, o: { issue: number; head: string; base: string; files: string[]; level: 'L0' | 'L3'; reasons?: string[]; approved?: boolean }) {
  f.log.append('change.proposed', { issue: o.issue, branch: `b${o.issue}`, base: o.base, head: o.head, files: o.files, lines: 1, patch_hash: 'x' }, 'coordinator');
  f.log.append('review.level_set', { issue: o.issue, head: o.head, level: o.level, reasons: o.reasons ?? [] }, 'coordinator');
  if (o.approved) {
    const id = `q${o.issue}${o.head.slice(0, 6)}`;
    f.log.append('decision.asked', { id, kind: 'land', issue: o.issue, owner: 'example-owner', question: 'Approve?', options: ['approve', 'reject'], recommendation: 'reject', receipts: [] }, 'coordinator');
    f.log.append('decision.answered', { id, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  }
  const q = { issue: o.issue, head: o.head, level: o.level } as EventPayload<'land.queued'>;
  f.log.append('land.queued', q, 'coordinator');
  return q;
}
type Floor = { held: string[] };
const landFloor = (f: Fixture, tip: string, head: string, applied: EventPayload<'land.queued'>[]): Floor => (coord(f) as unknown as { landFloor(p: string, t: string, h: string, a: unknown[]): Floor }).landFloor(f.repo, tip, head, applied);

test('I2: entry A approved at landing for ci-config output; batched later with C (approved at review time), C-driven ci output is pushed unasked', () => {
  const f = fixture('direct');
  const r = f.repo;
  const tip = git(r, 'rev-parse', 'HEAD');
  const commit = (m: string) => {
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', m);
    return git(r, 'rev-parse', 'HEAD');
  };
  // A: an ordinary change; the landing floor held the ci file a pre-land step wrote then, and the owner approved that.
  writeFileSync(join(r, 'src', 'a.js'), 'export const a = 1;\n');
  const a = commit('A');
  git(r, 'checkout', '-q', tip);
  // C: approved at review time (L3 for its own reason); a different change, whose pre-land output is a different ci file.
  writeFileSync(join(r, 'src', 'c.js'), 'export const c = 1;\n');
  const c = commit('C');
  git(r, 'checkout', '-q', '-B', 'land', a);
  git(r, 'cherry-pick', `${tip}..${c}`);
  writeFileSync(join(r, '.gitlab-ci.yml'), 'test: { script: [echo pwned-by-C] }\n');
  const head = commit('pre-land output');
  const reason = 'high-risk: ci-config (.gitlab-ci.yml)';
  const qa = event(f, { issue: 1, head: a, base: tip, files: ['src/a.js'], level: 'L3', reasons: [`${reason}${LANDING_FLOOR}`], approved: true });
  const qc = event(f, { issue: 2, head: c, base: tip, files: ['src/c.js'], level: 'L3', approved: true });
  // Control: C alone is held (no review-time approval covers output).
  const alone = landFloor(f, tip, head, [qc]);
  assert.ok(alone.held.some((h) => h.startsWith(reason)), `control: ${JSON.stringify(alone)}`);
  const fl = landFloor(f, tip, head, [qa, qc]);
  assert.ok(fl.held.length > 0, `A's earlier landing approval (path only) covers ci output in a new batch with C: ${JSON.stringify(fl)}`);
});
