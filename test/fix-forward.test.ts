// Fix-forward (src/fix-forward.ts, src/coordinator/fix-forward.ts) on its own, with a fake default branch: the culprit
// bisected among several merged PRs (by their own checks, an Actions re-run, or a test run), revert-first paths
// reverted at once, a fix that turns the branch green (no revert), failed fixes up to max_attempts then the revert,
// the merge hold, and the ops posts once each within the limit. The coordinator wiring, with real git, is in
// test/fix-forward-coordinator.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import type { CommitCheck, RerunJobs } from '../src/backlog/types.js';
import { nextStep } from '../src/bisect.js';
import { FixForward, greenKey, redKey } from '../src/coordinator/fix-forward.js';
import type { TestRuns, TestRunRequest } from '../src/coordinator/pr-batch.js';
import { DEFAULT_REVIEW } from '../src/coordinator/shared.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload, EventType } from '../src/events/types.js';
import { candidateVerdict, episodes, FIX_FORWARD_LABEL, revertFirstReasons } from '../src/fix-forward.js';
import { computeLevel } from '../src/review.js';

const sha = (n: number) => n.toString(16).padStart(40, 'c');
const check = (conclusion: string, id: number, name = 'ci'): CommitCheck => ({ name, source: 'check_run', status: 'completed', conclusion, id });
const running = (id: number): CommitCheck => ({ name: 'ci', source: 'check_run', status: 'in_progress', conclusion: null, id });

/**
 * A default branch: the last green commit, then one merge commit per PR (#11, #12, ...), the last one red. `files`:
 * what each PR's commit changes (by its index, 1-based). The red commit's `ci` failed, its log readable.
 */
function fixture(o: { prs: number; files?: Record<number, string[]>; cfg?: { max_attempts?: number; revert_first_paths?: string[] }; testRuns?: TestRuns; rerun?: boolean; limited?: number } = { prs: 1 }) {
  const dir = mkdtempSync(join(tmpdir(), 'fix-forward-'));
  const log = new EventLog(join(dir, 'events.db'));
  const backlog = new FileBacklog(join(dir, 'backlog.json'), 'bot');
  const line = [sha(100), ...Array.from({ length: o.prs }, (_, i) => sha(101 + i))];
  const red = line.at(-1)!;
  const idx = (s: string) => line.indexOf(s);
  const reruns: number[][] = [];
  if (o.rerun !== false)
    backlog.rerunFailedJobs = async (ids) => {
      reruns.push(ids);
      return new Map<number, RerunJobs>(ids.map((id) => [id, { ok: true, run: 9 }]));
    };
  const posts: { key: string; text: string }[] = [];
  let limited = o.limited ?? 0;
  const reverts: { culprit: string; number: number | null; title: string; evidence: string }[] = [];
  const giveUps: string[] = [];
  const emit = <T extends EventType>(type: T, p: EventPayload<T>) => log.append(type, p, 'test');
  const ff = new FixForward({
    log,
    actor: 'inst',
    backlog,
    branch: 'main',
    repo: 'example/repo',
    clone: dir,
    git: {
      tip: () => line.at(-1)!,
      parent: (s) => (idx(s) > 0 ? line[idx(s) - 1]! : null),
      isAncestor: (a, b) => idx(a) >= 0 && idx(b) >= 0 && idx(a) <= idx(b),
      firstParents: (from, to) => line.slice(idx(from) + 1, idx(to) + 1),
      subject: (s) => `Merge pull request #${10 + idx(s)} from example/branch-${idx(s)}`,
      files: (s) => o.files?.[idx(s)] ?? [`src/part-${idx(s)}.js`],
      diff: (s) => `diff --git a/src/part-${idx(s)}.js b/src/part-${idx(s)}.js\n+export const changed = ${idx(s)};`,
    },
    config: () => ({ max_attempts: 2, revert_first_paths: [], ...o.cfg }),
    required: () => ['ci'],
    probeTimeoutMin: () => 90,
    testRuns: o.testRuns ?? null,
    tiers: () => [{ name: 'unit', kind: 'fast' }],
    categories: (files) => computeLevel({ files: files.map((path) => ({ path, added: 1, removed: 0 })), labels: [], moneyPaths: [/^src\/ledger\//] }, DEFAULT_REVIEW).categories,
    revert: async (r) => {
      reverts.push({ culprit: r.culprit, number: r.number, title: r.title, evidence: r.evidence });
      const pr = await backlog.openPr(`wl/revert-${r.number}`, 'main', `Revert #${r.number}`, r.evidence);
      return { url: pr.url, number: pr.number };
    },
    giveUp: async (g) => {
      giveUps.push(g.reason);
    },
    post: async (key, text) => {
      if (limited > 0) {
        limited--;
        return 'limited';
      }
      if (!posts.some((p) => p.key === key)) posts.push({ key, text });
      return 'sent';
    },
    pollMs: () => 0,
  });
  // The commit before the PRs was green after its own merge.
  emit('merge.main_result', { issue: 1, number: 10, sha: line[0]!, outcome: 'green', failed: [] });
  backlog.setChecks(red, [check('failure', 500)]);
  backlog.setJobLog(500, 'not ok 1 - report totals\nTypeError: totalCents is not a function');
  /** A new commit on the default branch (a merge of PR `number`, the harness's when `harness`), with `ci` as given. */
  const land = (o2: { number: number; issue?: number; ci: 'success' | 'failure' | null; harness?: boolean }) => {
    const s = sha(200 + line.length);
    line.push(s);
    if (o2.harness) {
      emit('merge.done', { issue: o2.issue ?? o2.number, number: o2.number, head: sha(300 + line.length), sha: s, url: `https://github.com/example/repo/pull/${o2.number}`, title: `PR ${o2.number}` });
      if (o2.ci) emit('merge.main_result', { issue: o2.issue ?? o2.number, number: o2.number, sha: s, outcome: o2.ci === 'success' ? 'green' : 'red', failed: o2.ci === 'success' ? [] : ['ci'] });
    } else if (o2.ci) backlog.setChecks(s, [check(o2.ci, 600 + line.length)]);
    return s;
  };
  const start = () => ff.start({ sha: red, number: 10 + o.prs, failed: ['ci'] });
  /** The fix task's PR opens (as the landing step records it). */
  const fixPr = async (issue: number) => {
    const pr = await backlog.openPr(`wl/issue-${issue}`, 'main', `Fix (#${issue})`, 'the fix');
    emit('pr.opened', { issue, number: pr.number, url: pr.url, head: sha(400 + issue), draft: true });
    return pr.number;
  };
  const ep = () => episodes(log.read()).at(-1)!;
  const types = () => log.read().map((e) => e.type).filter((t) => t.startsWith('fix_forward.'));
  return { log, backlog, ff, line, red, fixPr, reruns, posts, reverts, giveUps, emit, land, start, ep, types };
}

test('bisect step (src/bisect.ts, shared with CI): the oldest bad commit whose first parent is good; binary search between', () => {
  assert.deepEqual(nextStep([{ sha: 'a1', verdict: 'bad' }]), { state: 'found', culprit: 'a1', good: null });
  assert.deepEqual(nextStep([{ sha: 'a1', verdict: 'untested' }, { sha: 'a2', verdict: 'untested' }, { sha: 'a3', verdict: 'bad' }]), { state: 'test', sha: 'a1' });
  assert.deepEqual(nextStep([{ sha: 'a1', verdict: 'good' }, { sha: 'a2', verdict: 'pending' }, { sha: 'a3', verdict: 'bad' }]), { state: 'wait', sha: 'a2' });
  assert.deepEqual(nextStep([{ sha: 'a1', verdict: 'skip' }, { sha: 'a2', verdict: 'bad' }]), { state: 'range', from: 'a1', to: 'a2' });
});

test("a candidate's verdict from its own checks: bad on a failure, good when all pass, untested when cancelled (CI moved on)", () => {
  assert.equal(candidateVerdict([{ name: 'ci', outcome: 'fail' }]), 'bad');
  assert.equal(candidateVerdict([{ name: 'ci', outcome: 'pass' }]), 'good');
  assert.equal(candidateVerdict([{ name: 'ci', outcome: 'pending' }]), 'pending');
  assert.equal(candidateVerdict([{ name: 'ci', outcome: 'cancelled' }]), 'untested');
  assert.equal(candidateVerdict([{ name: 'ci', outcome: 'missing' }]), 'untested');
});

test('revert first: the configured globs, the money path, auth and secrets; anything else is fixed forward', () => {
  const cats = (files: string[]) => computeLevel({ files: files.map((path) => ({ path, added: 1, removed: 0 })), labels: [], moneyPaths: [/^src\/ledger\//] }, DEFAULT_REVIEW).categories;
  const r = (files: string[], globs: string[] = []) => revertFirstReasons({ files, globs, categories: cats(files) });
  assert.deepEqual(r(['src/report.js']), []);
  assert.match(r(['src/ledger/post.js']).join(), /money-path: src\/ledger\/post\.js/);
  assert.match(r(['src/auth/session.js']).join(), /touches auth/);
  assert.match(r(['.env.production']).join(), /touches secrets/);
  assert.match(r(['db/schema.sql'], ['db/**']).join(), /revert_first_paths: db\/schema\.sql/);
});

test('a culprit is named by bisect among 3 merged PRs: each commit tested on its own (Actions re-runs of its cancelled checks)', async () => {
  const t = fixture({ prs: 3 });
  // CI cancelled the runs on the first two merges when the next one landed (cancel-in-progress).
  t.backlog.setChecks(t.line[1]!, [check('cancelled', 11)]);
  t.backlog.setChecks(t.line[2]!, [check('cancelled', 12)]);
  await t.start();
  const s = t.ep().started;
  assert.equal(s.last_green, t.line[0]);
  assert.deepEqual(s.candidates.map((c) => c.number), [11, 12, 13], 'the three merged PRs, oldest first');
  assert.deepEqual(t.reruns, [[11]], 'binary search: the first untested candidate nearest the middle, re-run on its own commit');
  assert.equal(t.ep().culprit, null);
  // Its re-run passes: good. The next candidate's re-run fails: bad, and its first parent is good.
  t.backlog.setChecks(t.line[1]!, [check('success', 21)]);
  await t.ff.step();
  assert.deepEqual(t.reruns, [[11], [12]]);
  t.backlog.setChecks(t.line[2]!, [running(22)]);
  await t.ff.step();
  assert.equal(t.ep().culprit, null, 'not decided while the re-run runs');
  t.backlog.setChecks(t.line[2]!, [check('failure', 22)]);
  await t.ff.step();
  const c = t.ep().culprit!;
  assert.deepEqual({ culprit: c.culprit, number: c.number, how: c.how, revert_first: c.revert_first }, { culprit: t.line[2], number: 12, how: 'bisect', revert_first: [] });
  assert.equal(t.ep().tested.get(t.line[1]!)!.verdict, 'good');
  // The fix task names the culprit, carries the failing log, the culprit's diff and the merged PRs.
  const a = t.ep().attempts[0]!.attempt;
  const issue = await t.backlog.get(a.issue);
  assert.equal(issue.title, 'Fix main: ci red since #12');
  assert.deepEqual(issue.labels, ['ready', FIX_FORWARD_LABEL]);
  assert.match(issue.body, /\*\*Culprit:\*\* culprit #12: Merge pull request #12 .*\(bisected/);
  assert.match(issue.body, /TypeError: totalCents is not a function/, 'the failing log');
  assert.match(issue.body, /\+export const changed = 2;/, "the culprit's diff");
  assert.match(issue.body, /- #11 .*\(good\)[\s\S]*- #12 .*\(bad\)[\s\S]*- #13 .*\(red\)/, 'the merged PRs, with what the bisect found');
  assert.match(issue.body, /```done_when\n- suite: full\n```/);
  assert.ok(t.ff.isFixTask(a.issue));
  // The ops channel: main is red, with the culprit.
  assert.equal(t.posts.length, 1);
  assert.match(t.posts[0]!.text, /^\*\*main is red\*\*: ci on `cccccccc`, culprit #12 \(Merge pull request #12/);
});

test('bisect by the instance\'s own test runs when the failing check is a test-run check', async () => {
  const runs: TestRunRequest[] = [];
  const testRuns: TestRuns = {
    async startTestRun(req) {
      runs.push(req);
      const ok = req.sha === sha(101); // the first merge is fine, the second breaks it
      return { id: `r${runs.length}`, sha: req.sha, kind: req.kind, ok, outcome: 'done', tiers: [{ tier: 'unit', ok, durationMs: 1, summary: ok ? 'ok' : '1 failing', logRef: 'log://1' }] };
    },
    async postChecks() {},
    checkNames: () => ({ unit: 'test-run/unit' }),
  };
  const t = fixture({ prs: 3, testRuns, rerun: false });
  t.backlog.setChecks(t.red, [check('failure', 500, 'test-run/unit')]);
  await t.ff.start({ sha: t.red, number: 13, failed: ['test-run/unit'] });
  for (let i = 0; i < 6 && !t.ep().culprit; i++) {
    await new Promise((r) => setImmediate(r));
    await t.ff.step();
  }
  assert.deepEqual(runs.map((r) => r.sha), [t.line[1], t.line[2]], 'each candidate on its own commit');
  assert.equal(t.ep().culprit!.number, 12);
  assert.equal(t.ep().tested.get(t.line[2]!)!.via, 'test_run');
});

test('one merged PR since the last green: it is the culprit, nothing to test', async () => {
  const t = fixture({ prs: 1 });
  t.backlog.setChecks(t.line[0]!, [check('success', 1)]);
  await t.start();
  assert.deepEqual({ how: t.ep().culprit!.how, number: t.ep().culprit!.number }, { how: 'only', number: 11 });
  assert.equal(t.ep().attempts.length, 1, 'a fix task, no revert');
  assert.equal(t.reverts.length, 0);
});

test('revert-first paths: a culprit touching auth is reverted at once, no fix tried', async () => {
  const t = fixture({ prs: 1, files: { 1: ['src/auth/session.js', 'src/report.js'] } });
  await t.start();
  assert.match(t.ep().culprit!.revert_first.join(), /touches auth: src\/auth\/session\.js/);
  assert.equal(t.ep().attempts.length, 0, 'no fix task');
  assert.equal(t.reverts.length, 1);
  assert.equal(t.reverts[0]!.number, 11);
  assert.match(t.reverts[0]!.evidence, /Why a revert: the culprit touches auth/);
  assert.equal(t.ep().finished!.outcome, 'reverted');
  await t.ff.step();
  assert.match(t.posts[0]!.text, /culprit #11.*Reverting it/);
});

test('revert-first paths: config.yaml fix_forward.revert_first_paths globs', async () => {
  const t = fixture({ prs: 1, files: { 1: ['db/schema.sql'] }, cfg: { revert_first_paths: ['db/**'] } });
  await t.start();
  assert.equal(t.reverts.length, 1);
  assert.equal(t.ep().attempts.length, 0);
});

test('a fix that turns the branch green: fixed, no revert; the hold lets only the fix PR merge until then', async () => {
  const t = fixture({ prs: 1 });
  await t.start();
  const a = t.ep().attempts[0]!.attempt;
  assert.match(String(t.ff.holds(999)), /main is red .*only its fix PR merges/, 'any other PR waits');
  assert.equal(t.ff.holds(a.issue), null, 'the fix PR may merge');
  const pr = await t.fixPr(a.issue);
  await t.ff.step();
  assert.ok((await t.backlog.comments(pr)).some((c) => /Culprit: #11 \(`cccccccc`\)/.test(c.body)), 'the culprit is attached to the fix PR');
  t.land({ number: pr, issue: a.issue, ci: 'success', harness: true });
  await t.ff.step();
  const fin = t.ep().finished!;
  assert.deepEqual({ outcome: fin.outcome, by: fin.by, attempts: fin.attempts, revert: fin.revert }, { outcome: 'fixed', by: pr, attempts: 1, revert: null });
  assert.equal(t.ep().green!.fixed_by, pr);
  assert.equal(t.reverts.length, 0, 'no revert');
  assert.equal(t.ff.open(), null);
  assert.equal(t.ff.holds(999), null, 'merges go on');
  assert.deepEqual(t.posts.map((p) => p.key), [redKey(t.red), greenKey(t.red)]);
  assert.match(t.posts[1]!.text, new RegExp(`^\\*\\*main is green again\\*\\* \\(fixed by #${pr}\\)`));
});

test('two failed fixes lead to the revert of the culprit, with the evidence; green again once it is merged', async () => {
  const t = fixture({ prs: 1 });
  await t.start();
  const a1 = t.ep().attempts[0]!.attempt;
  // Attempt 1 ends without a PR.
  t.emit('issue.blocked', { issue: a1.issue, owner: 'example-owner', why: 'the fix does not pass the coordinator\'s own checks' });
  await t.ff.step();
  assert.equal(t.ep().attempts[0]!.failed!.why, "the fix task was blocked: the fix does not pass the coordinator's own checks");
  const a2 = t.ep().attempts[1]!.attempt;
  assert.equal(a2.attempt, 2);
  assert.match((await t.backlog.get(a2.issue)).title, /\(attempt 2\)$/);
  assert.match((await t.backlog.get(a2.issue)).body, /Earlier fix attempts[\s\S]*attempt 1 \(#\d+\): the fix task was blocked/);
  assert.equal(t.ff.holds(a1.issue) !== null, true, "the failed attempt's PR no longer merges");
  // Attempt 2's PR merges, and the branch is still red.
  const pr = await t.fixPr(a2.issue);
  t.land({ number: pr, issue: a2.issue, ci: 'failure', harness: true });
  await t.ff.step();
  assert.match(t.ep().attempts[1]!.failed!.why, new RegExp(`its PR #${pr} merged as \`.{8}\`, and main is still red`));
  assert.equal(t.reverts.length, 1);
  assert.deepEqual({ culprit: t.reverts[0]!.culprit, number: t.reverts[0]!.number }, { culprit: t.red, number: 11 });
  assert.match(t.reverts[0]!.evidence, /no fix turned main green within 2 attempt/);
  assert.match(t.reverts[0]!.evidence, /attempt 1 .*blocked[\s\S]*attempt 2 .*still red/);
  const fin = t.ep().finished!;
  assert.equal(fin.outcome, 'reverted');
  assert.equal(fin.attempts, 2);
  // A human merges the revert; the branch is green again.
  t.backlog.setPr(fin.revert!.number, { merged: true, state: 'closed' });
  t.land({ number: fin.revert!.number, ci: 'success' });
  await t.ff.step();
  assert.equal(t.ep().green!.reverted, 11);
  assert.match(t.posts.at(-1)!.text, /^\*\*main is green again\*\* \(reverted #11\)/);
  assert.deepEqual(t.types().filter((x) => x === 'fix_forward.finished').length, 1, 'one outcome per red branch (the metrics count it)');
});

test('ops posts: once each, and within the limit (a full window posts on a later pass)', async () => {
  const t = fixture({ prs: 1, limited: 2 });
  await t.start();
  await t.ff.step();
  assert.equal(t.posts.length, 0, 'the window is full: nothing yet');
  await t.ff.step();
  assert.equal(t.posts.length, 1, 'posted once the window has room');
  for (let i = 0; i < 3; i++) await t.ff.step();
  assert.equal(t.posts.length, 1, 'never twice');
  const a = t.ep().attempts[0]!.attempt;
  const pr = await t.fixPr(a.issue);
  t.land({ number: pr, issue: a.issue, ci: 'success', harness: true });
  for (let i = 0; i < 3; i++) await t.ff.step();
  assert.deepEqual(t.posts.map((p) => p.key), [redKey(t.red), greenKey(t.red)]);
});

test('a red while the branch is already red is the same one: nothing new; no green commit known: gave up, auto-merge stopped', async () => {
  const t = fixture({ prs: 1 });
  await t.start();
  await t.ff.start({ sha: sha(999), number: 99, failed: ['ci'] });
  assert.equal(episodes(t.log.read()).length, 1);
  // Nothing green known before it: the commit before has failing checks, and the only green the log knows isn't an ancestor.
  const w = fixture({ prs: 1 });
  w.line.splice(0, 1, sha(777));
  w.backlog.setChecks(sha(777), [check('failure', 8)]);
  await w.start();
  assert.equal(w.ep().finished!.outcome, 'gave_up');
  assert.match(w.giveUps[0]!, /main was not green before it/);
  assert.equal(w.ep().attempts.length, 0);
  assert.equal(w.reverts.length, 0);
});
