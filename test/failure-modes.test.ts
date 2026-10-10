import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredEvent } from '../src/events/types.js';
import { classifyRuns, failureModes, failureModesMarkdown, normalizeCause, REPEATED } from '../src/failure-modes.js';
import type { RunRecord } from '../src/run-record.js';

let id = 0;
const T0 = Date.parse('2026-10-05T12:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ev = (s: number, type: string, payload: object): StoredEvent => ({ id: ++id, ts: at(s), type: type as never, actor: 'c', source: 'coordinator', payload: payload as never });
const sha = (c: string) => c.repeat(40);
const record = (runId: string, issue: number, role: string, s: number, e: number): RunRecord => ({ v: 1, id: runId, issue, role, model: 'm', startedAt: at(s), endedAt: at(e), reason: 'failed', costUsd: 0, turns: 0, steps: [], files: [], otherTools: 0, final: '', truncated: false });

/** A worker attempt: started at `s`, ended `secs` later with `reason`/`detail`, then what the coordinator recorded. */
function attempt(issue: number, n: number, s: number, secs: number, reason: string, detail: string, then: StoredEvent[] = [], turns = 0): StoredEvent[] {
  return [
    ev(s, 'run.started', { issue, role: 'worker', model: 'm', worktree: `/w/issue-${issue}`, pid: 1, pgid: 1, attempt: n }),
    ev(s + secs - 0.5, 'run.cost', { issue, role: 'worker', model: 'm', usd: 0, turns }),
    ev(s + secs, 'run.finished', { issue, role: 'worker', reason, detail }),
    ...then,
  ];
}

/**
 * The real case this report must catch: claude ended three times within 8-9 s each, nothing was committed, and
 * the issue was blocked as if the agent had tried and failed ("no passing change").
 */
function startupCase(issue = 7, base = 0, reason = 'failed', detail = 'error_during_execution: ') {
  const rejected = (s: number) => ev(s, 'change.rejected', { issue, why: 'no changes committed' });
  return [
    ev(base - 10, 'issue.claimed', { issue, instance: 'i', lease: sha('a'), base: sha('b'), owner: 'ada' }),
    ...attempt(issue, 1, base, 8, reason, detail, [rejected(base + 8.2)]),
    ...attempt(issue, 2, base + 9, 9, reason, detail, [rejected(base + 18.2)]),
    ...attempt(issue, 3, base + 18, 8, reason, detail, [rejected(base + 26.2), ev(base + 26.5, 'issue.blocked', { issue, owner: 'ada', why: 'no passing change after 3 attempts' })]),
  ];
}
const caseRecords = (issue = 7, base = 0) => [record('r1', issue, 'worker', base, base + 8), record('r2', issue, 'worker', base + 9, base + 18), record('r3', issue, 'worker', base + 18, base + 26)];
const week = { since: new Date(T0 - 7 * 86_400_000), until: new Date(T0 + 86_400_000) };

test('three fast failed runs with nothing committed are startup failures with one cause, not "no passing change"', () => {
  const runs = classifyRuns(startupCase(), week.since, week.until, caseRecords());
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map((r) => [r.outcome, r.seconds, r.attempt, r.runId]), [
    ['startup failure', 8, 1, 'r1'],
    ['startup failure', 9, 2, 'r2'],
    ['startup failure', 8, 3, 'r3'],
  ]);
  assert.equal(new Set(runs.map((r) => r.cause)).size, 1, 'one cause');
  assert.equal(runs[2]!.blocked, 'no passing change after 3 attempts');
});

test('the weekly section names and explains the case, links its runs, and proposes a fix strongest first', () => {
  const f = failureModes(startupCase(), { ...week, records: caseRecords() });
  assert.equal(f.top[0]!.outcome, 'startup failure');
  assert.equal(f.top[0]!.count, 3);
  assert.equal(f.proposals.length, 1);
  const pr = f.proposals[0]!;
  // Short options, ranked by the repo's rule (they're answered by name); what each does is in the receipts.
  assert.deepEqual(pr.options, ['make it impossible', 'test or lint', 'written rule', 'leave it']);
  assert.equal(pr.recommendation, 'make it impossible');
  assert.match(pr.receipts[0]!, /^make it impossible: before claiming, start claude once with the exact flags/);
  assert.match(pr.receipts[1]!, /^test or lint: a regression test/);
  assert.match(pr.receipts[2]!, /^written rule: document the cause/);
  assert.ok(pr.receipts.some((r) => r.includes('/runs/r1')));
  assert.ok(pr.receipts.some((r) => /no passing change after 3 attempts/.test(r)));
  const md = failureModesMarkdown(f).join('\n');
  assert.match(md, /\*\*How runs ended, last 7 days\*\* \(3 run\(s\)\)\n- startup failure: 3/);
  assert.match(md, /1\. startup failure, 3×: error_during_execution: \(no error text\)\. these runs ended within 9s with nothing committed: claude never got to work/);
  assert.match(md, /which hides this cause/);
  assert.match(md, /\[#7 worker attempt 1 \(8s\)\]\(\/runs\/r1\)/);
  assert.match(md, /\*\*Fixes proposed\*\* \(1, waiting for your decision; nothing changes until you answer\)\n- Repeated failure \(3 runs this week, startup failure\): error_during_execution: \(no error text\): recommended make it impossible: before claiming/);
});

test('the same case seen as quick "successes" that did nothing is still a startup failure', () => {
  const runs = classifyRuns(startupCase(7, 0, 'succeeded', 'Could not read any file.'), week.since, week.until);
  assert.deepEqual([...new Set(runs.map((r) => r.outcome))], ['startup failure']);
});

test('each way a run ends gets its own outcome', () => {
  const head = sha('c');
  const events = [
    ...attempt(1, 1, 0, 600, 'succeeded', 'done', [ev(601, 'change.proposed', { issue: 1, branch: 'b', base: sha('b'), head, files: ['a'], lines: 3, patch_hash: 'h' }), ev(700, 'check.result', { issue: 1, head, stage: 'verify', checks: [{ check: 'npm test', status: 'fail', exitCode: 1 }] })], 12),
    ...attempt(2, 1, 0, 600, 'succeeded', 'done', [ev(601, 'change.proposed', { issue: 2, branch: 'b', base: sha('b'), head, files: ['a'], lines: 3, patch_hash: 'h' }), ev(700, 'check.result', { issue: 2, head, stage: 'verify', checks: [{ check: 'npm test', status: 'pass', exitCode: 0 }] }), ev(800, 'eval.verdict', { issue: 2, head, patch_hash: 'h', patch_correct: false, test_correct: true, confidence: 'medium', advice: 'wrong file' })], 12),
    ...attempt(3, 1, 0, 600, 'succeeded', 'done', [ev(601, 'push.refused', { issue: 3, head, stage: 'change', reasons: ['changes .github/workflows/ci.yml'] })], 12),
    ...attempt(4, 1, 0, 600, 'succeeded', 'done', [ev(601, 'change.rejected', { issue: 4, why: 'no changes committed' })], 12),
    ...attempt(5, 1, 0, 600, 'succeeded', 'done', [ev(601, 'change.proposed', { issue: 5, branch: 'b', base: sha('b'), head, files: ['a'], lines: 3, patch_hash: 'h' }), ev(700, 'land.queued', { issue: 5, head, level: 'L1' })], 12),
    ...attempt(6, 1, 0, 30, 'rate_limited', 'usage or rate limit reached'),
    ...attempt(8, 1, 0, 7200, 'timed_out', 'killed: timed_out', [], 40),
    ...attempt(9, 1, 0, 1200, 'failed', 'error_max_turns: ', [ev(1201, 'change.proposed', { issue: 9, branch: 'b', base: sha('b'), head, files: ['a'], lines: 3, patch_hash: 'h' })], 200),
  ];
  const got = Object.fromEntries(classifyRuns(events, week.since, week.until).map((r) => [r.issue, r.outcome]));
  assert.deepEqual(got, { 1: 'checks failed', 2: 'evaluator rejected', 3: 'push refused', 4: 'no change', 5: 'proposed', 6: 'rate limited', 8: 'timed out', 9: 'failed' });
});

test('causes group the same error with different ids, numbers and paths', () => {
  const a = normalizeCause('Error: sandbox required but unavailable at /home/user/.claude/x.sock (pid 4412, after 8s)');
  const b = normalizeCause('Error: sandbox required but unavailable at C:\\Users\\you\\.claude\\y.sock (pid 17, after 12s)');
  assert.equal(a, b);
  assert.equal(normalizeCause(`fatal: bad object ${sha('d')}`), normalizeCause(`fatal: bad object ${sha('e')}`));
  assert.equal(normalizeCause('first line\r\nsecond line'), 'first line second line');
  assert.equal(normalizeCause(''), '(no error text)');
});

test(`fewer than ${REPEATED} of a cause, or runs outside the window, propose nothing`, () => {
  const two = startupCase().slice(0, 9);
  assert.equal(failureModes(two, week).proposals.length, 0);
  const old = startupCase(7, -10 * 86_400);
  assert.equal(failureModes(old, week).runs.length, 0);
  assert.deepEqual(failureModesMarkdown(failureModes([], week)), ['**How runs ended, last 7 days** (0 run(s))', '- no runs']);
});
