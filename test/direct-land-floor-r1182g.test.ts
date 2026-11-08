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
import type { EventPayload, EventType } from '../src/events/types.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

// #716, R1182g: the final check's two tests on direct land's landing floor (mixed batches): byte-identity of an approved
// entry's files, and an approved entry deferred while the unapproved one in its batch goes to the owner.

const skip = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const REVIEW = (wait: string[]) => ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } }, merge: { wait_categories: wait } });
function fixture(wait: string[] = []) {
  const base = mkdtempSync(join(tmpdir(), 'r1182g-'));
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
  cfg.review = REVIEW(wait);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  return { base, remote, repo, cfg, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), log: new EventLog(join(base, 'events.db')), slotsDir, stateDir: join(base, 'state') };
}
type Fixture = ReturnType<typeof fixture>;
const ISSUE = 'Totals count non-positive quantities.\n\n```done_when\n- test: test/price.test.js\n```\n';
// Worker A (its title has ALPHA): the price fix plus `a`; worker B (BRAVO): only `b`.
const runner = (a: Record<string, string>, b: Record<string, string>) =>
  new FakeRunner((req: RunRequest) => {
    const isA = req.prompt.includes('ALPHA');
    const extra = isA ? a : b;
    if (req.role === 'worker') {
      if (isA) {
        const p = join(req.cwd, 'src', 'price.js');
        writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      }
      for (const [f, body] of Object.entries(extra)) {
        mkdirSync(dirname(join(req.cwd, f)), { recursive: true });
        writeFileSync(join(req.cwd, f), body);
      }
      git(req.cwd, 'add', '-A');
      git(req.cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fix');
      return { structured: { summary: 'fixed' } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: 'looks right', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: [...(isA ? ['src/price.js'] : []), ...Object.keys(extra)], design_change: false } };
  });
async function cycle(f: Fixture, a: Record<string, string> = {}, b: Record<string, string> = {}) {
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: runner(a, b), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, maxAttempts: 1, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await c.tick();
  await c.idle();
}
const onMain = (f: Fixture) => git(f.base, '--git-dir', f.remote, 'ls-tree', '-r', '--name-only', 'main').split('\n');
const mainFile = (f: Fixture, p: string) => {
  try {
    return git(f.base, '--git-dir', f.remote, 'show', `main:${p}`);
  } catch {
    return null;
  }
};
const ev = <T extends EventType>(f: Fixture, t: T) => f.log.read(0, [t]).map((e) => e.payload as EventPayload<T>);
const dump = (f: Fixture) =>
  JSON.stringify({ queued: ev(f, 'land.queued'), results: ev(f, 'land.result').map((r) => [r.issue, r.outcome, r.detail.slice(0, 160)]), levels: ev(f, 'review.level_set').map((l) => [l.issue, l.level, l.reasons]), asked: ev(f, 'decision.asked').filter((q) => q.kind === 'land').map((q) => [q.issue, q.recommendation, q.receipts]) });
const issueOf = (f: Fixture, title: string) => f.backlog.open({ title, body: ISSUE, author: 'example-owner', labels: ['ready'] });
const approveLast = (f: Fixture, issue: number) => {
  const q = ev(f, 'decision.asked').filter((x) => x.kind === 'land' && x.issue === issue).at(-1)!;
  f.log.append('decision.answered', { id: q.id, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
};
const CIX = 'approved: { script: [echo ok] }\n';

// G1: a mixed batch: an approved L3 entry (A: .gitlab-ci.yml) and an unapproved one (B). B's own code, run by a pre-land
// step, rewrites A's approved .gitlab-ci.yml. The sameness check catches it: nothing pushed, B to the owner, A deferred.
test("R1182g 1: a pre-land rewrite of an approved entry's file is judged again (sameness)", { skip }, async () => {
  const f = fixture([]);
  f.cfg.tests.land.pre = ['test ! -f tools/gen.mjs || node tools/gen.mjs'];
  const a = { '.gitlab-ci.yml': CIX };
  const b = { 'src/b.js': 'export const b = 1;\n', 'tools/gen.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('.gitlab-ci.yml', 'test: { script: [echo pwned] }\\n');\n" };
  issueOf(f, 'ALPHA totals');
  issueOf(f, 'BRAVO helper');
  await cycle(f, a, b);
  await cycle(f, a, b);
  const nA = ev(f, 'review.level_set').find((l) => l.level === 'L3')?.issue;
  assert.ok(nA, `A is L3 at level time: ${dump(f)}`);
  assert.ok(ev(f, 'land.queued').some((q) => q.issue !== nA), `B queued: ${dump(f)}`);
  approveLast(f, nA!);
  await cycle(f, a, b);
  assert.ok(!(mainFile(f, '.gitlab-ci.yml') ?? '').includes('pwned'), `B's pre-land output overwrote the approved CI file and landed: ${dump(f)}`);
  const res = ev(f, 'land.result');
  assert.ok(res.some((r) => r.issue === nA && r.outcome === 'deferred' && r.detail.includes('merge-policy floor')), `A deferred: ${dump(f)}`);
  const qB = ev(f, 'decision.asked').filter((x) => x.kind === 'land' && x.issue !== nA).at(-1);
  assert.ok(qB?.receipts.some((r) => r.startsWith('high-risk: ci-config (.gitlab-ci.yml)')), dump(f));
  assert.equal(qB?.recommendation, 'reject');
  // Next pass: A (approved) lands alone with its own CI file; B waits for the owner.
  await cycle(f, a, b);
  assert.equal(mainFile(f, '.gitlab-ci.yml'), CIX.trim(), dump(f));
  assert.ok(!onMain(f).includes('src/b.js'), `B not landed: ${dump(f)}`);
});

// G2: a mixed batch, approved A + unapproved B; a wait category added after both are queued catches B's file only.
// A's files are as at its head, so A doesn't make the floor fire; A is deferred, then lands.
test('R1182g 2: an approved entry in a held batch is deferred, then lands; the unapproved one goes to the owner', { skip }, async () => {
  const f = fixture([]);
  const a = { '.gitlab-ci.yml': CIX };
  const b = { 'src/b.js': 'export const b = 1;\n' };
  issueOf(f, 'ALPHA totals');
  issueOf(f, 'BRAVO helper');
  await cycle(f, a, b);
  await cycle(f, a, b);
  const nA = ev(f, 'review.level_set').find((l) => l.level === 'L3')?.issue;
  assert.ok(ev(f, 'land.queued').some((q) => q.issue !== nA) && !ev(f, 'land.result').length, `B queued, nothing landed yet: ${dump(f)}`);
  approveLast(f, nA!);
  f.cfg.review = REVIEW(['app-non-money']);
  await cycle(f, a, b);
  assert.ok(!onMain(f).includes('src/b.js'), dump(f));
  const res = ev(f, 'land.result');
  assert.ok(res.some((r) => r.issue === nA && r.outcome === 'deferred'), `A deferred: ${dump(f)}`);
  assert.ok(res.some((r) => r.issue !== nA && r.outcome === 'rejected'), `B rejected: ${dump(f)}`);
  const qB = ev(f, 'decision.asked').filter((x) => x.kind === 'land' && x.issue !== nA).at(-1);
  assert.ok(qB?.receipts.some((r) => r.startsWith('high-risk: app-non-money (src/b.js)')), `only B's own file judged: ${dump(f)}`);
  assert.ok(!qB!.receipts.some((r) => r.includes('.gitlab-ci.yml') || r.includes('price.js')), `A's approved files excluded: ${dump(f)}`);
  await cycle(f, a, b);
  assert.equal(mainFile(f, '.gitlab-ci.yml'), CIX.trim(), `A landed: ${dump(f)}`);
  assert.ok(!onMain(f).includes('src/b.js'));
  assert.equal(ev(f, 'decision.asked').filter((x) => x.kind === 'land' && x.issue === nA).length, 1, 'A asked once');
});
