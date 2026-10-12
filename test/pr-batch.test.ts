// PR-mode batching (src/coordinator/pr-batch.ts) over a real git remote and a fake test-run service: green batches,
// bisection of red ones, heads that change, restarts mid-batch, the batch size and the merge guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import type { PullRequest } from '../src/backlog/types.js';
import { batchSize, batchState, mayMerge, mergeTurn, passRate, PrBatcher, PR_BATCH_EVENTS, runsPerPr, type BatchEntry, type PrBatchConfig, type TestRunRequest, type TestRunResult, type TestRuns } from '../src/coordinator/pr-batch.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ID = ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false'];

/** A remote with main and `n` PR branches (each adds its own file), the coordinator's clone, a log and fake PRs. */
function world(n: number) {
  const base = mkdtempSync(join(tmpdir(), 'prbatch-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(base, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'README'), 'base\n');
  git(seed, 'add', 'README');
  git(seed, ...ID, 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const prs = new Map<number, PullRequest>();
  const push = (number: number, content: string) => {
    git(seed, 'checkout', '-q', '-B', `t/pr-${number}`, 'main');
    writeFileSync(join(seed, `pr-${number}.txt`), content);
    git(seed, 'add', `pr-${number}.txt`);
    git(seed, ...ID, 'commit', '-q', '-m', `PR ${number}: ${content}`);
    git(seed, 'push', '-q', '-f', 'origin', `t/pr-${number}`);
    return git(seed, 'rev-parse', 'HEAD');
  };
  for (let i = 1; i <= n; i++) {
    const headSha = push(i, `change ${i}\n`);
    prs.set(i, { number: i, url: `u/${i}`, head: `t/pr-${i}`, headSha, base: 'main', draft: false, state: 'open', title: `PR ${i}`, mergeable: true, mergeableState: 'clean' });
  }
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  const log = new EventLog(join(base, 'events.db'));
  return { base, remote, repo, seed, log, prs, push };
}
type World = ReturnType<typeof world>;

/** A fake test-run service: a run fails tier `unit` when the commit holds a culprit's file (or `red(sha)` says so). */
function fakeRuns(w: World, o: { culprits?: number[]; red?: (sha: string) => boolean; during?: (req: TestRunRequest) => void; hang?: () => boolean; hangPost?: (sha: string) => boolean } = {}) {
  const runs: TestRunRequest[] = [];
  const posted: { sha: string; names: Record<string, string>; run: string }[] = [];
  let id = 0;
  const t: TestRuns = {
    async startTestRun(req) {
      runs.push(req);
      if (o.hang?.()) return new Promise<TestRunResult>(() => {});
      o.during?.(req);
      const files = git(w.repo, 'ls-tree', '--name-only', req.sha).split('\n');
      const bad = (o.culprits ?? []).filter((c) => files.includes(`pr-${c}.txt`));
      const red = bad.length > 0 || (o.red?.(req.sha) ?? false);
      return { id: `run-${++id}`, sha: req.sha, kind: 'full', ok: !red, tiers: [{ tier: 'lint', ok: true, durationMs: 5, summary: 'ok', logRef: 'l' }, { tier: 'unit', ok: !red, durationMs: 9, summary: red ? `fails with ${bad.map((b) => `pr-${b}`).join(',') || 'the base'}` : 'ok', logRef: `log://${id}` }] };
    },
    async postChecks(sha, result, names) {
      if (o.hangPost?.(sha)) return new Promise<void>(() => {});
      posted.push({ sha, names, run: result.id });
    },
    checkNames: () => ({ lint: 'full-lint', unit: 'full' }),
  };
  return { t, runs, posted };
}

const CFG: PrBatchConfig = { enabled: true, max: 8, shards: 1, fast_checks: ['fast'], full_checks: ['full'] };

function batcher(w: World, testRuns: TestRuns | null, cfg: Partial<PrBatchConfig> = {}, waitsForOwner?: (e: BatchEntry) => string | null) {
  const tested: number[] = [];
  const comments: { n: number; body: string }[] = [];
  const labels = new Map<number, Set<string>>();
  const b = new PrBatcher({
    log: w.log,
    instance: 'alice',
    repo: w.repo,
    remote: 'origin',
    branch: 'main',
    identity: { name: 'bot', email: 'bot@example.com' },
    config: () => ({ ...CFG, ...cfg }),
    testRuns,
    pullRequest: async (n) => ({ ...w.prs.get(n)! }),
    comment: async (n, body) => void comments.push({ n, body }),
    addLabels: async (n, ls) => void ls.forEach((l) => (labels.get(n) ?? labels.set(n, new Set()).get(n)!).add(l)),
    removeLabel: async (n, l) => void labels.get(n)?.delete(l),
    ownerOf: () => 'example-owner',
    tested: (e) => void tested.push(e.number),
    ...(waitsForOwner ? { waitsForOwner } : {}),
  });
  return { b, tested, comments, labels };
}

const entry = (w: World, n: number): BatchEntry => ({ issue: 100 + n, number: n, head: w.prs.get(n)!.headSha });
const steps = (w: World) => w.log.read(0, ['pr_batch.step']).map((e) => e.payload as EventPayload<'pr_batch.step'>);
const stepsOf = (w: World, step: string) => steps(w).filter((s) => s.step === step);
async function pass(b: PrBatcher) {
  b.tick();
  await b.idle();
}

test('a green batch: one full run of one merge commit of every PR, in queue order; the full check posted on each head; each handed to the merge policy', async () => {
  const w = world(3);
  const f = fakeRuns(w);
  const { b, tested } = batcher(w, f.t);
  for (const n of [2, 1, 3]) assert.ok(b.enqueue(entry(w, n)));
  assert.equal(b.enqueue(entry(w, 2)), false, 'queued once per head');
  await pass(b);
  assert.equal(f.runs.length, 1, 'one full run for the batch');
  const built = stepsOf(w, 'built')[0]!;
  assert.deepEqual(built.prs.map((p) => p.number), [2, 1, 3], 'the order they became ready');
  assert.deepEqual(f.runs[0], { repo: w.repo, sha: built.sha, kind: 'full', prs: [2, 1, 3] });
  assert.equal(git(w.repo, 'rev-parse', `${built.sha}^1^1^1`), built.base, 'one merge commit per PR, on the base');
  assert.deepEqual(git(w.repo, 'ls-tree', '--name-only', built.sha!).split('\n').sort(), ['README', 'pr-1.txt', 'pr-2.txt', 'pr-3.txt']);
  assert.deepEqual(f.posted.map((p) => p.sha), [2, 1, 3].map((n) => w.prs.get(n)!.headSha), 'the full check on each PR head');
  assert.ok(f.posted.every((p) => JSON.stringify(p.names) === JSON.stringify({ lint: 'full-lint', unit: 'full' })), 'the tier -> check name mapping');
  assert.deepEqual(tested, [2, 1, 3]);
  assert.equal(stepsOf(w, 'green').length, 1);
  assert.equal(stepsOf(w, 'finished').length, 1);
  assert.equal(b.state().queue.length, 0);
  for (const n of [1, 2, 3]) assert.ok(b.testedIn(n, w.prs.get(n)!.headSha));
  assert.throws(() => git(w.repo, 'rev-parse', '--verify', '-q', `refs/heads/${built.id}`), 'the batch branch is removed once finished');
});

test('a sharded batch: one run per shard of the same commit, combined; any red shard makes it red', async () => {
  const w = world(2);
  let shard = 0;
  const f = fakeRuns(w, { red: () => shard++ === 1 });
  const { b } = batcher(w, f.t, { shards: 3 });
  b.enqueue(entry(w, 1));
  await pass(b);
  assert.deepEqual(f.runs.slice(0, 3).map((r) => r.shard), [{ index: 1, total: 3 }, { index: 2, total: 3 }, { index: 3, total: 3 }]);
  assert.equal(new Set(f.runs.slice(0, 3).map((r) => r.sha)).size, 1, 'shards of one commit');
  assert.equal(stepsOf(w, 'red')[0]?.tier, 'unit');
});

test('a red batch bisects to the culprit, returns it with the failing tier, merges the green prefix and re-tests the rest', async () => {
  const w = world(4);
  const f = fakeRuns(w, { culprits: [3] });
  const { b, tested, comments, labels } = batcher(w, f.t);
  for (const n of [1, 2, 3, 4]) b.enqueue(entry(w, n));
  await pass(b);
  const culprit = stepsOf(w, 'culprit');
  assert.deepEqual(culprit.map((c) => [c.prs[0]!.number, c.tier]), [[3, 'unit']]);
  assert.match(comments.find((c) => c.n === 3)!.body, /`unit` tier failed with this PR on top of main at `.{8}` with #1, #2/);
  assert.ok(labels.get(3)?.has('ci-failing'));
  assert.deepEqual(tested, [1, 2], 'the green prefix (tested as its own batch) goes on');
  assert.deepEqual(stepsOf(w, 'requeued').flatMap((s) => s.prs.map((p) => p.number)), [4]);
  assert.deepEqual(b.state().queue.map((q) => q.number), [4]);
  assert.ok(b.returnedFor(3, w.prs.get(3)!.headSha));
  assert.equal(b.enqueue(entry(w, 3)), false, 'a returned head is not queued again');
  // root (4) red, the first 2 green, the first 3 red: #3.
  assert.deepEqual(f.runs.map((r) => r.prs), [[1, 2, 3, 4], [1, 2], [1, 2, 3]]);
  const prefix = stepsOf(w, 'checks_posted').map((s) => s.id);
  assert.ok(prefix.every((id) => batchState(w.log.read(0, [...PR_BATCH_EVENTS])).batches.get(id)!.parent === 'batch-1'));

  await pass(b);
  assert.deepEqual(f.runs.at(-1)!.prs, [4], 'the rest re-tested in a new batch');
  assert.deepEqual(tested, [1, 2, 4]);
  // A new head of the culprit is queued again.
  const fixed = w.push(3, 'change 3, fixed\n');
  w.prs.get(3)!.headSha = fixed;
  assert.ok(b.enqueue(entry(w, 3)));
});

test('a red batch of one whose base is red too: nothing is blamed, and the queue waits for the default branch to move', async () => {
  const w = world(1);
  const f = fakeRuns(w, { red: () => true });
  const { b, comments } = batcher(w, f.t);
  b.enqueue(entry(w, 1));
  await pass(b);
  assert.equal(stepsOf(w, 'culprit').length, 0);
  assert.equal(stepsOf(w, 'error')[0]!.tier, '(base)');
  assert.equal(comments.length, 0);
  assert.deepEqual(b.state().queue.map((q) => q.number), [1]);
  assert.equal(b.state().baseRed, stepsOf(w, 'built')[0]!.base);
});

test('a head that changes drops the PR from its batch: before the build, and during the run (the rest is tested again without it)', async () => {
  const w = world(3);
  const before = w.prs.get(1)!.headSha;
  w.prs.get(1)!.headSha = w.push(1, 'change 1 again\n');
  let moved = false;
  const f = fakeRuns(w, {
    during: () => {
      if (moved) return;
      moved = true;
      w.prs.get(2)!.headSha = w.push(2, 'change 2 again\n');
    },
  });
  const { b, tested } = batcher(w, f.t);
  b.enqueue({ issue: 101, number: 1, head: before });
  b.enqueue(entry(w, 2));
  b.enqueue(entry(w, 3));
  await pass(b);
  const dropped = stepsOf(w, 'dropped').map((s) => s.prs[0]!.number);
  assert.deepEqual(dropped, [1, 2]);
  assert.deepEqual(stepsOf(w, 'built')[0]!.prs.map((p) => p.number), [2, 3], 'the stale head never made it in');
  assert.equal(f.posted.length, 0, 'nothing posted from a batch a PR left');
  assert.deepEqual(tested, []);
  assert.deepEqual(b.state().queue.map((q) => q.number), [3]);
  await pass(b);
  assert.deepEqual(f.runs.at(-1)!.prs, [3]);
  assert.deepEqual(tested, [3]);
  assert.equal(b.testedIn(2, w.prs.get(2)!.headSha), null);
});

test('a restart mid-run abandons the batch; its PRs are batched again and each is posted and handed on once', async () => {
  const w = world(2);
  let hang = true;
  const f1 = fakeRuns(w, { hang: () => hang });
  const one = batcher(w, f1.t);
  one.b.enqueue(entry(w, 1));
  one.b.enqueue(entry(w, 2));
  one.b.tick();
  await new Promise((r) => setTimeout(r, 300)); // the run never ends: the process "dies" here
  assert.equal(stepsOf(w, 'built').length, 1);
  hang = false;
  const f2 = fakeRuns(w);
  const two = batcher(w, f2.t);
  await pass(two.b);
  assert.deepEqual(stepsOf(w, 'abandoned').map((s) => s.id), ['batch-1']);
  assert.deepEqual(two.tested, [1, 2]);
  assert.equal(stepsOf(w, 'checks_posted').length, 2);
  await pass(two.b);
  assert.equal(f2.runs.length, 1, 'nothing left to run');
});

test('a restart after a green run but before every check was posted resumes it: each head posted and handed on exactly once', async () => {
  const w = world(3);
  const second = w.prs.get(2)!.headSha;
  const f1 = fakeRuns(w, { hangPost: (sha) => sha === second });
  const one = batcher(w, f1.t);
  for (const n of [1, 2, 3]) one.b.enqueue(entry(w, n));
  one.b.tick();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(one.tested, [1]);
  const f2 = fakeRuns(w);
  const two = batcher(w, f2.t);
  await pass(two.b);
  assert.equal(f2.runs.length, 0, 'not run again');
  assert.deepEqual(f2.posted.map((p) => p.sha), [2, 3].map((n) => w.prs.get(n)!.headSha));
  assert.deepEqual(two.tested, [2, 3]);
  const posted = stepsOf(w, 'checks_posted').map((s) => s.prs[0]!.number);
  assert.deepEqual(posted, [1, 2, 3], 'once each');
  assert.equal(stepsOf(w, 'resumed').length, 1);
  await pass(two.b);
  assert.deepEqual(stepsOf(w, 'checks_posted').length, 3);
});

test('no test-run service wired: nothing runs, the queue waits, one error says why', async () => {
  const w = world(1);
  const { b, tested } = batcher(w, null);
  b.enqueue(entry(w, 1));
  await pass(b);
  await pass(b);
  assert.deepEqual(tested, []);
  assert.equal(w.log.read(0, ['coordinator.error']).length, 1);
});

test('the merge guard: a fast check passing on the head and a passing full run from a batch that held exactly that head, or no merge', async () => {
  const w = world(2);
  const f = fakeRuns(w);
  const { b } = batcher(w, f.t);
  const fastOk = [{ name: 'fast', source: 'check_run' as const, status: 'completed', conclusion: 'success' }];
  const events = () => w.log.read(0, [...PR_BATCH_EVENTS]);
  const head = w.prs.get(1)!.headSha;
  assert.equal(mayMerge({ events: events(), number: 1, head, checks: fastOk, fastChecks: ['fast'] }).ok, false, 'no batch yet');
  b.enqueue(entry(w, 1));
  await pass(b);
  assert.deepEqual(mayMerge({ events: events(), number: 1, head, checks: fastOk, fastChecks: ['fast'] }), { ok: true, batch: 'batch-1' });
  assert.equal(mayMerge({ events: events(), number: 1, head, checks: [], fastChecks: ['fast'] }).ok, false, 'fast check missing');
  assert.equal(mayMerge({ events: events(), number: 1, head, checks: [{ ...fastOk[0]!, conclusion: 'failure' }], fastChecks: ['fast'] }).ok, false, 'fast check red');
  assert.equal(mayMerge({ events: events(), number: 1, head, checks: fastOk, fastChecks: [] }).ok, false, 'no fast check configured');
  assert.equal(mayMerge({ events: events(), number: 1, head: w.prs.get(2)!.headSha, checks: fastOk, fastChecks: ['fast'] }).ok, false, 'another head');
  assert.equal(mayMerge({ events: events(), number: 2, head: w.prs.get(2)!.headSha, checks: fastOk, fastChecks: ['fast'] }).ok, false, 'never batched');
});

test('batch size: the fewest full runs per PR at the recent pass rate, capped by max; the rate from history with a prior', () => {
  assert.equal(batchSize(0.9, 32), 7);
  assert.equal(batchSize(0.95, 32), 14);
  assert.equal(batchSize(0.8, 32), 4);
  assert.equal(batchSize(0.5, 32), 1);
  assert.equal(batchSize(0.99, 8), 8);
  assert.ok(runsPerPr(8, 0.9) < runsPerPr(1, 0.9));
  const empty = { posted: new Map<string, string>(), returned: new Map() };
  assert.equal(passRate(empty), 0.9);
  const posted = new Map(Array.from({ length: 30 }, (_, i) => [`${i}@a`, 'b'] as [string, string]));
  const returned = new Map(Array.from({ length: 10 }, (_, i) => [`${i}@c`, { step: 'culprit' }] as [string, EventPayload<'pr_batch.step'>]));
  assert.equal(passRate({ posted, returned }), (30 + 9) / 50);
});

test('a PR the policy leaves to the owner (high-risk, money-path) never shares a batch: it gets a batch of one, in its turn', async () => {
  const w = world(3);
  const f = fakeRuns(w);
  const { b, tested } = batcher(w, f.t, {}, (e) => (e.number === 2 ? 'high-risk: pricing (src/price.js)' : null));
  for (const n of [1, 2, 3]) b.enqueue(entry(w, n));
  await pass(b);
  assert.deepEqual(f.runs.map((r) => r.prs), [[1, 3]], 'the high-risk PR is split out');
  await pass(b);
  assert.deepEqual(f.runs.map((r) => r.prs), [[1, 3], [2]], 'then alone');
  assert.equal(stepsOf(w, 'built')[1]!.detail, 'alone: high-risk: pricing (src/price.js)');
  assert.deepEqual(tested, [1, 3, 2]);
});

/** Merge a PR head into main on the remote as GitHub's merge button would (a --no-ff merge commit); its sha. */
function ghMerge(w: World, n: number): string {
  git(w.seed, 'checkout', '-q', 'main');
  git(w.seed, 'pull', '-q', '--ff-only', 'origin', 'main');
  git(w.seed, ...ID, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${n}`, w.prs.get(n)!.headSha);
  git(w.seed, 'push', '-q', 'origin', 'main');
  git(w.repo, 'fetch', '-q', 'origin', 'main');
  return git(w.seed, 'rev-parse', 'HEAD');
}

/** Someone lands a commit on main by hand; its sha. */
function foreignCommit(w: World): string {
  git(w.seed, 'checkout', '-q', 'main');
  git(w.seed, 'pull', '-q', '--ff-only', 'origin', 'main');
  writeFileSync(join(w.seed, 'other.txt'), 'someone else\n');
  git(w.seed, 'add', 'other.txt');
  git(w.seed, ...ID, 'commit', '-q', '-m', 'landed by hand');
  git(w.seed, 'push', '-q', 'origin', 'main');
  git(w.repo, 'fetch', '-q', 'origin', 'main');
  return git(w.seed, 'rev-parse', 'HEAD');
}

const treeIn = (w: World) => (sha: string) => {
  try {
    return git(w.repo, 'rev-parse', `${sha}^{tree}`);
  } catch {
    return null;
  }
};

test('a green batch merges strictly in order, each onto exactly the main it was tested on; a foreign commit mid-merge stops it, and the rest is tested again', async () => {
  const w = world(3);
  const f = fakeRuns(w);
  const { b } = batcher(w, f.t);
  for (const n of [1, 2, 3]) b.enqueue(entry(w, n));
  await pass(b);
  const base = stepsOf(w, 'built')[0]!.base!;
  const turn = (n: number, tip: string) => mergeTurn({ events: w.log.read(), number: n, head: w.prs.get(n)!.headSha, tip, treeOf: treeIn(w) });
  assert.deepEqual(turn(1, base), { act: 'merge', batch: 'batch-1' });
  assert.equal(turn(2, base).act, 'wait', '#1 merges first');
  assert.equal(turn(1, 'e'.repeat(40)).act, 'stale', 'main moved before the first merge');
  const m1 = ghMerge(w, 1);
  w.log.append('merge.done', { issue: 101, number: 1, head: w.prs.get(1)!.headSha, sha: m1, url: 'u/1', title: 'PR 1' }, 'c');
  w.prs.get(1)!.state = 'merged';
  assert.deepEqual(turn(2, m1), { act: 'merge', batch: 'batch-1' }, 'onto the merge of #1, whose tree is the one the batch tested');
  // Someone lands a commit by hand before #2 merges: #2 and #3 are stale, and go back to be tested on the new main.
  const other = foreignCommit(w);
  const t2 = turn(2, other);
  assert.ok(t2.act === 'stale' && /something else landed/.test(t2.why), JSON.stringify(t2));
  assert.deepEqual(t2.prs.map((p) => p.number), [2, 3]);
  b.stale(t2.batch, t2.prs, t2.why);
  assert.equal(b.testedIn(2, w.prs.get(2)!.headSha), null, 'no longer counts as tested');
  assert.deepEqual(b.state().queue.map((q) => q.number), [2, 3], 'back in the queue, in order');
  await pass(b);
  assert.deepEqual(f.runs.at(-1)!.prs, [2, 3], 'tested again');
  assert.equal(stepsOf(w, 'built').at(-1)!.base, other, 'on the new main');
  assert.deepEqual(turn(2, other), { act: 'merge', batch: 'batch-2' });
});

test("a merge whose tree isn't the one the batch tested, or a PR ahead that left the batch, stops the rest", async () => {
  const w = world(3);
  const f = fakeRuns(w);
  const { b } = batcher(w, f.t);
  for (const n of [1, 2, 3]) b.enqueue(entry(w, n));
  await pass(b);
  const other = foreignCommit(w);
  // #1 "merged" as a commit with another tree.
  w.log.append('merge.done', { issue: 101, number: 1, head: w.prs.get(1)!.headSha, sha: other, url: 'u/1', title: 'PR 1' }, 'c');
  const t = mergeTurn({ events: w.log.read(), number: 2, head: w.prs.get(2)!.headSha, tip: other, treeOf: treeIn(w) });
  assert.ok(t.act === 'stale' && /not the one the batch tested/.test(t.why), JSON.stringify(t));
  // Another batch: #1 closed without merging, so #2 after it is stale.
  const v = world(2);
  const g = batcher(v, fakeRuns(v).t);
  for (const n of [1, 2]) g.b.enqueue(entry(v, n));
  await pass(g.b);
  v.log.append('pr.closed', { issue: 101, number: 1, merged: false }, 'c');
  const t3 = mergeTurn({ events: v.log.read(), number: 2, head: v.prs.get(2)!.headSha, tip: stepsOf(v, 'built')[0]!.base!, treeOf: treeIn(v) });
  assert.ok(t3.act === 'stale' && /left the batch/.test(t3.why), JSON.stringify(t3));
});
