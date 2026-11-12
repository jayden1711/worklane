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

// R1182h adversarial attacks on PR #1182 (direct land's merge-policy floor, rechecked in landBatch).

const skip = !which('gitleaks') && 'gitleaks not installed';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const REVIEW = (wait: string[]) => ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } }, merge: { wait_categories: wait } });

function fixture(mode: 'direct' | 'pr', wait: string[] = []) {
  const base = mkdtempSync(join(tmpdir(), 'r1182h-'));
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
const GEN = { 'tools/gen.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('.gitlab-ci.yml', 'test: { script: [echo pwned] }\\n');\n" };

test('H1: an entry the owner approved at review time (L3 by the floor) lands a ci-config file its pre-land step writes, never asked about it', { skip }, async () => {
  const f = fixture('direct', ['app-non-money']);
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, GEN);
  const q = asked(f).at(-1);
  assert.ok(q, 'asked at review time (floor)');
  assert.ok(!q!.receipts.some((r) => r.includes('ci-config')), 'the review-time question never mentions ci-config');
  f.log.append('decision.answered', { id: q!.id, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  await cycle(f);
  await cycle(f);
  const s = JSON.stringify({ results: results(f), asked: asked(f).map((a) => a.receipts) });
  assert.ok(!onMain(f).includes('.gitlab-ci.yml'), `ci-config written by a pre-land step landed on an approval that never named it: ${s}`);
});

test('H2: restart mid-hold: a crash between land.result rejected and the question leaves the entry final with no question', { skip }, async () => {
  const f = fixture('direct');
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, GEN); // queued (L0), not landed yet? (it lands in the same tick's land step next tick)
  const orig = f.backlog.addLabels.bind(f.backlog);
  let crashed = false;
  (f.backlog as unknown as { addLabels: typeof orig }).addLabels = async (n: number, l: string[]) => {
    if (!crashed && l.includes('review:L3')) {
      crashed = true;
      throw new Error('simulated crash');
    }
    return orig(n, l);
  };
  await cycle(f);
  (f.backlog as unknown as { addLabels: typeof orig }).addLabels = orig;
  await cycle(f);
  await cycle(f);
  const s = JSON.stringify({ results: results(f), asked: asked(f).length });
  assert.ok(crashed, `the floor branch ran: ${s}`);
  assert.ok(!onMain(f).includes('.gitlab-ci.yml'), `landed: ${s}`);
  assert.ok(asked(f).length >= 1, `nothing pending the owner; the entry is final 'rejected' with no question: ${s}`);
});

// ---- landFloor directly, on crafted batches (mixed approved + unapproved) ----
function floorRepo(f: Fixture) {
  const r = f.repo;
  const tip = git(r, 'rev-parse', 'HEAD');
  const commit = (m: string) => {
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', m);
    return git(r, 'rev-parse', 'HEAD');
  };
  return { r, tip, commit };
}
function events(f: Fixture, o: { issue: number; head: string; base: string; files: string[]; level: 'L0' | 'L3'; approved?: boolean; approveAfter?: () => void }) {
  f.log.append('change.proposed', { issue: o.issue, branch: `b${o.issue}`, base: o.base, head: o.head, files: o.files, lines: 1, patch_hash: 'x' }, 'coordinator');
  f.log.append('review.level_set', { issue: o.issue, head: o.head, level: o.level, reasons: [] }, 'coordinator');
  if (o.approved) {
    const id = `q${o.issue}${o.head.slice(0, 6)}`;
    f.log.append('decision.asked', { id, kind: 'land', issue: o.issue, owner: 'example-owner', question: 'Approve?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'coordinator');
    o.approveAfter?.();
    f.log.append('decision.answered', { id, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  }
  const q = { issue: o.issue, head: o.head, level: o.level } as EventPayload<'land.queued'>;
  f.log.append('land.queued', q, 'coordinator');
  return q;
}
type Floor = { held: string[]; unapproved: unknown[]; seen: boolean };
const landFloor = (f: Fixture, tip: string, head: string, applied: EventPayload<'land.queued'>[]): Floor => (coord(f) as unknown as { landFloor(p: string, t: string, h: string, a: unknown[]): Floor }).landFloor(f.repo, tip, head, applied);

function mixed(f: Fixture, mutate: (r: string) => void) {
  const { r, tip, commit } = floorRepo(f);
  writeFileSync(join(r, '.gitlab-ci.yml'), 'test: { script: [echo approved] }\n');
  const a = commit('A: approved ci change');
  git(r, 'checkout', '-q', tip);
  writeFileSync(join(r, 'src', 'other.js'), 'export const o = 1;\n');
  const b = commit('B: ordinary');
  git(r, 'checkout', '-q', '-B', 'land', a);
  git(r, 'cherry-pick', tip + '..' + b);
  mutate(r);
  const head = commit('pre-land output');
  const qa = events(f, { issue: 1, head: a, base: tip, files: ['.gitlab-ci.yml'], level: 'L3', approved: true });
  const qb = events(f, { issue: 2, head: b, base: tip, files: ['src/other.js'], level: 'L0' });
  return landFloor(f, tip, head, [qa, qb]);
}

test('H3 control: pre-land rewrites the approved entry\'s ci file in a mixed batch: held', () => {
  const f = fixture('direct');
  const fl = mixed(f, (r) => writeFileSync(join(r, '.gitlab-ci.yml'), 'test: { script: [echo pwned] }\n'));
  assert.ok(fl.held.some((h) => h.includes('ci-config')), JSON.stringify(fl));
});

test('H3a: pre-land makes the approved ci file executable (mode-only) in a mixed batch: judged as approved', () => {
  const f = fixture('direct');
  const fl = mixed(f, (r) => chmodSync(join(r, '.gitlab-ci.yml'), 0o755));
  assert.ok(fl.held.some((h) => h.includes('ci-config')), `a mode change to an approved high-risk file passes as approved: ${JSON.stringify(fl)}`);
});

test('H3b: pre-land replaces the approved ci file with a symlink whose target is the approved bytes: judged as approved', () => {
  const f = fixture('direct');
  const fl = mixed(f, (r) => {
    const body = readFileSync(join(r, '.gitlab-ci.yml'), 'utf8');
    rmSync(join(r, '.gitlab-ci.yml'));
    symlinkSync(body, join(r, '.gitlab-ci.yml'));
  });
  assert.ok(fl.held.some((h) => h.includes('ci-config')), `a type change (file to symlink) of an approved high-risk file passes as approved: ${JSON.stringify(fl)}`);
});

test('H3c: pre-land writes a new ci file in a mixed batch (approved + unapproved): held', () => {
  const f = fixture('direct');
  const fl = mixed(f, (r) => {
    mkdirSync(join(r, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(r, '.github', 'workflows', 'x.yml'), 'on: push\n');
  });
  assert.ok(fl.held.some((h) => h.includes('ci-config')), JSON.stringify(fl));
});

test('H4: an approval for head H1, answered after a new level for the rebased head H2, does not count for H2', () => {
  const f = fixture('direct');
  const { r, tip, commit } = floorRepo(f);
  writeFileSync(join(r, '.gitlab-ci.yml'), 'v1\n');
  const h1 = commit('H1');
  git(r, 'checkout', '-q', tip);
  writeFileSync(join(r, '.gitlab-ci.yml'), 'v2\n');
  const h2 = commit('H2');
  // H1 asked; before the owner answers, H2 is proposed and set at L3; the owner then approves the H1 question.
  f.log.append('change.proposed', { issue: 1, branch: 'b1', base: tip, head: h1, files: ['.gitlab-ci.yml'], lines: 1, patch_hash: 'x' }, 'coordinator');
  f.log.append('review.level_set', { issue: 1, head: h1, level: 'L3', reasons: [] }, 'coordinator');
  f.log.append('decision.asked', { id: 'qh1', kind: 'land', issue: 1, owner: 'example-owner', question: 'Approve?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'coordinator');
  f.log.append('change.proposed', { issue: 1, branch: 'b1', base: tip, head: h2, files: ['.gitlab-ci.yml'], lines: 1, patch_hash: 'y' }, 'coordinator');
  f.log.append('review.level_set', { issue: 1, head: h2, level: 'L3', reasons: [] }, 'coordinator');
  f.log.append('decision.answered', { id: 'qh1', by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  const q = { issue: 1, head: h2, level: 'L3' } as EventPayload<'land.queued'>;
  f.log.append('land.queued', q, 'coordinator');
  const fl = landFloor(f, tip, h2, [q]);
  assert.ok(fl.held.some((h) => h.includes('ci-config')), `H1's approval reused for H2: ${JSON.stringify(fl)}`);
});

test('H5: a land gate (run after the pre-land commit) that commits a ci file itself: held', { skip }, async () => {
  const f = fixture('direct');
  f.cfg.tests.runner.changed = "node -e \"require('fs').writeFileSync('.gitlab-ci.yml','x: 1\\n')\" && git add -A && git -c user.name=g -c user.email=g@example.com commit -q -m late && node --test --test-reporter=spec";
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, {});
  await cycle(f);
  const s = JSON.stringify({ results: results(f), asked: asked(f).map((a) => a.receipts) });
  assert.ok(!onMain(f).includes('.gitlab-ci.yml'), `landed: ${s}`);
  assert.ok(asked(f).at(-1)?.receipts.some((r) => r.includes('ci-config')), s);
});
