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
import { questionLines } from '../src/coordinator/landing.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

// R1182t (adversarial) on #1182. T1: every judged-file name in the question and the level is shown as shownPath shows
// it, so names with a newline can't open an HTML comment that hides a bound file. T2: entries the owner approved
// together at landing are batched together again. Ported from the review's TypeScript (attacks-1182t, T1-T2), with
// assertions unchanged; T2 gains a closing check (the rebuilt batch is covered).

const skip = !which('gitleaks') && 'gitleaks not installed';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PRINT = 'landing floor, exactly this batch and these files: sha256 ';
const REVIEW = (wait: string[], l1: Record<string, number> = {}) =>
  ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [], ...l1 }, L2_notify: { when: [] }, L3_human: { when: [] } }, merge: { wait_categories: wait } });

function fixture(wait: string[] = [], l1: Record<string, number> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'r1182t-'));
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
  for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false'], ['core.precomposeunicode', 'false']]) git(repo, 'config', k!, v!);
  const cfg = loadConfig(repo);
  cfg.project.land_mode = 'direct';
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  cfg.review = REVIEW(wait, l1);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  return { base, remote, repo, cfg, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), log: new EventLog(join(base, 'events.db')), slotsDir, stateDir: join(base, 'state') };
}
type Fixture = ReturnType<typeof fixture>;
type Queued = EventPayload<'land.queued'>;
type Floor = { held: string[]; ask: unknown[]; seen: boolean; listed: string[]; print: string };
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
const landFloor = (f: Fixture, tip: string, head: string, applied: Queued[]) => (coord(f) as unknown as { landFloor(p: string, t: string, h: string, a: Queued[]): Floor }).landFloor(f.repo, tip, head, applied);
const onMain = (f: Fixture) => git(f.base, '--git-dir', f.remote, 'ls-tree', '-r', '--name-only', 'main').split('\n');
const asked = (f: Fixture) => f.log.read(0, ['decision.asked']).map((e) => e.payload as EventPayload<'decision.asked'>).filter((q) => q.kind === 'land');

let n = 0;
function levelAndApprove(f: Fixture, o: { issue: number; head: string; level: 'L1' | 'L3'; reasons?: string[]; approved?: boolean }) {
  f.log.append('review.level_set', { issue: o.issue, head: o.head, level: o.level, reasons: o.reasons ?? [] }, 'coordinator');
  if (o.approved) {
    const id = `r${o.issue}-${n++}`;
    f.log.append('decision.asked', { id, kind: 'land', issue: o.issue, owner: 'example-owner', question: 'Approve?', options: ['approve', 'reject'], recommendation: 'reject', receipts: [] }, 'coordinator');
    f.log.append('decision.answered', { id, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  }
}
function event(f: Fixture, o: { issue: number; head: string; base: string; files: string[]; level: 'L1' | 'L3'; approved?: boolean }): Queued {
  f.log.append('change.proposed', { issue: o.issue, branch: `b${o.issue}`, base: o.base, head: o.head, files: o.files, lines: 1, patch_hash: 'x' }, 'coordinator');
  levelAndApprove(f, o);
  const q = { issue: o.issue, head: o.head, level: o.level } as Queued;
  f.log.append('land.queued', q, 'coordinator');
  return q;
}
const approveAtLanding = (f: Fixture, q: Queued, fl: Floor) => levelAndApprove(f, { issue: q.issue, head: q.head, level: 'L3', reasons: [...fl.held.map((r) => `${r}: held`), ...fl.listed, `${PRINT}${fl.print}`], approved: true });
const put = (r: string, p: string, body: string) => {
  mkdirSync(dirname(join(r, p)), { recursive: true });
  writeFileSync(join(r, p), body);
};
const commitIn = (r: string) => (m: string) => {
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '--allow-empty', '-m', m);
  return git(r, 'rev-parse', 'HEAD');
};
/** Entry 1 (approved at review) adds src/ok.js; `output(write)` makes a land commit on top of it with what `write` puts. */
function withApproved(f: Fixture) {
  const r = f.repo;
  const tip = git(r, 'rev-parse', 'HEAD');
  const commit = commitIn(r);
  writeFileSync(join(r, 'src', 'ok.js'), 'export const ok = 1;\n');
  const a = commit('A');
  const qa = event(f, { issue: 1, head: a, base: tip, files: ['src/ok.js'], level: 'L3', approved: true });
  const output = (write: () => void, m = 'pre-land') => {
    git(r, 'checkout', '-q', '-f', a);
    write();
    return commit(m);
  };
  return { tip, qa, output };
}
const lines = (k: number, tag: string) => Array.from({ length: k }, (_, i) => `export const v${i} = ${JSON.stringify(tag)};`).join('\n') + '\n';
const CI = 'test: { script: [echo ok] }\n';


/**
 * What a GitHub comment shows, per CommonMark 4.6 (HTML block, start condition 2): a line starting (after at most three
 * spaces) with `<!--` begins an HTML block that runs to the first line containing `-->` (inclusive) or to the end, and
 * GitHub renders an HTML comment as nothing. Every other line is shown.
 */
function visible(md: string): string {
  const out: string[] = [];
  let hidden = false;
  for (const l of md.split('\n')) {
    if (!hidden && /^ {0,3}<!--/.test(l)) hidden = !l.includes('-->', l.indexOf('<!--') + 4);
    else if (hidden) hidden = !l.includes('-->');
    else out.push(l);
  }
  return out.join('\n');
}
/** The comment's receipts part as ask() (src/coordinator/base.ts) writes it: `- ${line}` joined by newlines. */
const asComment = (fl: Floor) => questionLines(fl.held.map((r) => `${r}: held`), fl.listed, 'review.level_set event 1').map((l) => `- ${l}`).join('\n');
const HIDE = '\n<!--';
const CLOSE = '~\n-->';
const CIRCLE = ['a', 'b', 'c', 'd'].map((x) => `.circleci/${x}.yml`);

test('T1 control: four ci files: the reason names 3 ("and 1 more"), the listing shows .circleci/d.yml', () => {
  const f = fixture();
  const { tip, qa, output } = withApproved(f);
  const h = output(() => CIRCLE.forEach((p) => put(f.repo, p, CI)));
  const fl = landFloor(f, tip, h, [qa]);
  assert.ok(fl.held.some((r) => /ci-config .*and 1 more/.test(r)), `control: ${JSON.stringify(fl.held)}`);
  assert.ok(!fl.held.some((r) => r.includes('d.yml')), 'control: the reason does not name d.yml');
  assert.ok(visible(asComment(fl)).includes('.circleci/d.yml'), 'control: the listing shows d.yml');
});

test('T1 (unit): two output names with a newline hide .circleci/d.yml from the rendered question; the approval binds it', () => {
  const f = fixture();
  const { tip, qa, output } = withApproved(f);
  const h1 = output(() => [...CIRCLE, HIDE, CLOSE].forEach((p) => put(f.repo, p, CI)));
  const fl1 = landFloor(f, tip, h1, [qa]);
  assert.equal(fl1.ask.length, 1, 'control: held and asked');
  const md = asComment(fl1);
  assert.ok(md.includes('.circleci/d.yml'), 'control: d.yml is in the raw text');
  // It is bound: the approval covers d.yml as it is, and a rewrite of it asks again.
  approveAtLanding(f, qa, fl1);
  assert.equal(landFloor(f, tip, h1, [qa]).ask.length, 0, 'control: the approval covers the identical land commit, d.yml included');
  const h2 = output(() => [...CIRCLE, HIDE, CLOSE].forEach((p) => put(f.repo, p, p === '.circleci/d.yml' ? 'evil: 1\n' : CI)));
  assert.equal(landFloor(f, tip, h2, [qa]).ask.length, 1, 'control: d.yml is bound (a rewrite is asked again)');
  assert.ok(visible(md).includes('.circleci/d.yml'), `HIDDEN: .circleci/d.yml is bound but not in what the owner sees:\n${visible(md)}`);
});

test('T1b (unit): a listed judged-file line carries a bidi override and a newline raw (shownPath would escape both)', () => {
  const f = fixture();
  const { tip, qa, output } = withApproved(f);
  const h = output(() => (put(f.repo, '.gitlab-ci.yml', CI), put(f.repo, 'docs/x‮md.lmy', 'x\n'), put(f.repo, 'docs/a\nb.md', 'x\n')));
  const fl = landFloor(f, tip, h, [qa]);
  assert.ok(fl.held.length, 'control: held');
  assert.ok(!fl.held.some((r) => r.includes('‮') || r.includes('a\nb')), 'control: the reasons escape them (shownPath)');
  const raw = fl.listed.filter((l) => l.includes('‮') || l.includes('\n'));
  assert.equal(raw.length, 0, `RAW NAMES in the question's file lines: ${JSON.stringify(raw)}`);
});

test('T1e (end to end): a pre-land step writes 4 ci files and two newline names; the owner approves a question whose rendered text never shows .circleci/d.yml, and it lands', { skip }, async () => {
  const f = fixture();
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  const gen = `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('.circleci', { recursive: true });
for (const p of ${JSON.stringify([...CIRCLE, HIDE, CLOSE])}) writeFileSync(p, ${JSON.stringify(CI)});
`;
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, { 'tools/gen.mjs': gen });
  for (let i = 0; i < 3 && !asked(f).length; i++) await cycle(f);
  assert.equal(asked(f).length, 1, 'control: asked once at landing');
  const body = (await f.backlog.comments(1)).map((c) => c.body).filter((b) => b.includes('decision needed')).at(-1)!;
  assert.ok(body.includes('.circleci/d.yml'), 'control: d.yml is in the raw comment');
  const shown = visible(body).includes('.circleci/d.yml');
  const q = asked(f).at(-1)!;
  f.log.append('decision.answered', { id: q.id, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  for (let i = 0; i < 2; i++) await cycle(f);
  const landed = onMain(f).includes('.circleci/d.yml');
  assert.ok(shown || !landed, `HIDDEN AND LANDED: .circleci/d.yml is on main after ${asked(f).length} approve(s) of a question whose rendered text never shows it:\n${visible(body)}`);
});

test('T2: an honest two-entry batch held at landing: both approved, yet buildBatch splits it (one L3 a batch) and each is asked again', () => {
  const f = fixture();
  f.cfg.tests.land.batch_max = 4;
  const r = f.repo;
  const tip = git(r, 'rev-parse', 'HEAD');
  const commit = commitIn(r);
  writeFileSync(join(r, 'src', 'ok.js'), 'export const ok = 1;\n');
  const a = commit('A');
  git(r, 'checkout', '-q', '-f', tip);
  writeFileSync(join(r, 'src', 'ok2.js'), 'export const ok2 = 1;\n');
  const b = commit('B');
  const q1 = event(f, { issue: 1, head: a, base: tip, files: ['src/ok.js'], level: 'L1' });
  const q2 = event(f, { issue: 2, head: b, base: tip, files: ['src/ok2.js'], level: 'L1' });
  const c = coord(f) as unknown as { buildBatch(q: Queued[]): Queued[] };
  assert.equal(c.buildBatch([q1, q2]).length, 2, 'control: two L1 entries form one batch');
  git(r, 'checkout', '-q', '-f', a);
  git(r, 'cherry-pick', b);
  put(r, '.gitlab-ci.yml', CI);
  const h12 = commit('pre-land {1,2}');
  const fl = landFloor(f, tip, h12, [q1, q2]);
  assert.equal(fl.ask.length, 2, 'control: both entries asked');
  // The owner approves both (decisions.ts queues an approved land at L3).
  const reasons = [...fl.held.map((x) => `${x}: held`), ...fl.listed, `${PRINT}${fl.print}`];
  const L3 = [q1, q2].map((q) => {
    levelAndApprove(f, { issue: q.issue, head: q.head, level: 'L3', reasons, approved: true });
    const p = { issue: q.issue, head: q.head, level: 'L3' } as Queued;
    f.log.append('land.queued', p, 'coordinator');
    return p;
  });
  assert.equal(landFloor(f, tip, h12, L3).ask.length, 0, 'control: the batch the owner approved is covered');
  const next = c.buildBatch(L3);
  git(r, 'checkout', '-q', '-f', a);
  put(r, '.gitlab-ci.yml', CI);
  const h1 = commit('pre-land {1}');
  const again = landFloor(f, tip, h1, next);
  assert.equal(next.length, 2, `SPLIT: the approved batch {1,2} is never built again (batch ${JSON.stringify(next.map((q) => q.issue))}); #1 alone is ${again.ask.length ? 'asked again' : 'covered'}`);
  // Not the review's: the batch rebuilt is the one the owner approved, so the identical land commit is covered.
  assert.equal(landFloor(f, tip, h12, next).ask.length, 0, 'the rebuilt batch {1,2} is covered by the one approval each');
});

test('T2b (not the review\'s): L3 entries approved separately (different landing prints) still go one per batch', () => {
  const f = fixture();
  f.cfg.tests.land.batch_max = 4;
  const r = f.repo;
  const tip = git(r, 'rev-parse', 'HEAD');
  const commit = commitIn(r);
  writeFileSync(join(r, 'src', 'ok.js'), 'export const ok = 1;\n');
  const a = commit('A');
  git(r, 'checkout', '-q', '-f', tip);
  writeFileSync(join(r, 'src', 'ok2.js'), 'export const ok2 = 1;\n');
  const b = commit('B');
  const q1 = event(f, { issue: 1, head: a, base: tip, files: ['src/ok.js'], level: 'L1' });
  const q2 = event(f, { issue: 2, head: b, base: tip, files: ['src/ok2.js'], level: 'L1' });
  const c = coord(f) as unknown as { buildBatch(q: Queued[]): Queued[] };
  // Each approved at landing on its own, so each level carries its own print.
  const L3 = [q1, q2].map((q, i) => {
    levelAndApprove(f, { issue: q.issue, head: q.head, level: 'L3', reasons: [`${PRINT}${String(i).repeat(64)}`], approved: true });
    const p = { issue: q.issue, head: q.head, level: 'L3' } as Queued;
    f.log.append('land.queued', p, 'coordinator');
    return p;
  });
  assert.deepEqual(c.buildBatch(L3).map((q) => q.issue), [1], 'one L3 a batch');
  // And an L3 entry approved at review time (no landing print) never joins another L3.
  const L3r = [q1, q2].map((q) => {
    levelAndApprove(f, { issue: q.issue, head: q.head, level: 'L3', approved: true });
    return { issue: q.issue, head: q.head, level: 'L3' } as Queued;
  });
  assert.deepEqual(c.buildBatch(L3r).map((q) => q.issue), [1], 'one review-time L3 a batch');
});
