// #741: the first-run page's First task card, from the events the engine records: the filed issue's stages, its PR,
// and a held PR's reasons in plain words; estimates labelled with their basis; only the filed issue's events and only
// its PR's. Fixture events only (each checked against the event schema), and a dashboard over a temporary state dir
// with stand-in setup probes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { EventSchemas, type EventType, type StoredEvent } from '../src/events/types.js';
import { COORDINATOR_TICK_JITTER_MS, COORDINATOR_TICK_MS, FIRST_TASK_FILED, firstTaskProgress, type FirstTaskProgress } from '../src/first-task-progress.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { HOLD_KINDS, holdsInWords, holdWords } from '../src/hold-words.js';
import { HIGH_RISK_REASON, mergeDecision, type MergeInput } from '../src/merge-policy.js';
import type { SetupProbe } from '../src/setup-steps.js';
import { asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

const H = 'abc1234';
const REPO = 'example-org/example-shop';
const PR_URL = (n: number) => `https://github.com/${REPO}/pull/${n}`;

/** Event payloads as the coordinator writes them (each parsed with its schema, so a fixture can't drift from it). */
const P = {
  filed: (issue: number) => ({ login: 'example-owner', role: 'owner' as const, via: 'session' as const, instance: null, action: FIRST_TASK_FILED, detail: { issue, label_created: true } }),
  seen: (issue: number, title = `issue ${issue}`) => ({ issue, title, labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' }),
  claimed: (issue: number) => ({ issue, instance: 'local', lease: H, base: H, owner: 'example-owner' }),
  started: (issue: number, attempt = 1) => ({ issue, role: 'worker', model: 'sonnet', worktree: '/stand-in/worktree', pid: 1, pgid: 1, attempt }),
  finished: (issue: number, reason: 'succeeded' | 'failed' = 'succeeded') => ({ issue, role: 'worker', reason, detail: '' }),
  verdict: (issue: number, ok = true) => ({ issue, head: H, patch_hash: 'h', patch_correct: ok, test_correct: ok, confidence: ok ? ('high' as const) : ('low' as const), advice: '' }),
  opened: (issue: number, number: number, url = PR_URL(number)) => ({ issue, number, url, head: H, draft: false }),
  status: (issue: number, number: number, ready: boolean, outcomes: ('pass' | 'fail' | 'pending')[]) => ({ issue, number, head: H, ready, reasons: [], checks: outcomes.map((outcome, i) => ({ name: `check-${i}`, outcome })) }),
  decided: (issue: number, number: number, reasons: string[]) => ({ issue, number, head: H, auto: reasons.length === 0, reasons }),
  done: (issue: number, number: number) => ({ issue, number, head: H, sha: 'def5678', url: PR_URL(number), title: `issue ${issue}` }),
  closed: (issue: number, number: number, merged: boolean) => ({ issue, number, merged }),
  timing: (number: number, wall_ms: number) => ({ number, head: H, wall_ms, first_started: null, last_completed: null, why: null }),
};

/** A log of fixture events: each validated, ids in order, one minute apart unless a time is given. */
function log() {
  const events: StoredEvent[] = [];
  let t = Date.parse('2026-10-19T09:00:00.000Z');
  const add = (type: EventType, payload: object, o: { minutes?: number } = {}) => {
    EventSchemas[type].parse(payload);
    t += (o.minutes ?? 1) * 60_000;
    events.push({ id: events.length + 1, ts: new Date(t).toISOString(), type, actor: 'c', source: 'coordinator', payload } as unknown as StoredEvent);
    return add;
  };
  return { events, add };
}

/** An earlier task here (issue 3, PR 30), merged: none of its events is the first task's. */
function withEarlierTask() {
  const l = log();
  l.add('issue.claimed', P.claimed(3))('run.started', P.started(3))('run.finished', P.finished(3), { minutes: 10 })('eval.verdict', P.verdict(3), { minutes: 2 })('pr.opened', P.opened(3, 30), { minutes: 1 })('ci.pr_timing', P.timing(30, 5 * 60_000))('merge.done', P.done(3, 30));
  return l;
}

const stage = (p: FirstTaskProgress, id: string) => p.stages.find((s) => s.id === id)!;
const states = (p: FirstTaskProgress) => Object.fromEntries(p.stages.map((s) => [s.id, s.state]));

test('#741 nothing filed from the form: no card', () => {
  const l = withEarlierTask();
  assert.equal(firstTaskProgress(l.events, { local: true }), null);
  l.add('dashboard.audit', { ...P.filed(7), action: 'first_run.first_task_refused', detail: { why: 'x' } });
  assert.equal(firstTaskProgress(l.events, { local: true }), null, 'a refused filing is no first task');
});

test('#741 just filed: every stage waiting, each estimate naming its basis: the tick, the labelled guess, or none', () => {
  const l = withEarlierTask();
  l.add('dashboard.audit', P.filed(7));
  const p = firstTaskProgress(l.events, { local: true })!;
  assert.equal(p.issue, 7);
  assert.deepEqual(states(p), { claimed: 'waiting', worker: 'waiting', evaluator: 'waiting', pr: 'waiting', checks: 'waiting', merge: 'waiting' });
  assert.equal(p.outcome, 'open');
  assert.equal(p.pr, null, "the earlier task's PR is not this one's");
  assert.deepEqual(stage(p, 'claimed').estimate, { basis: 'tick', text: 'within about 65 s of the coordinator running: it looks for work every 60 s, plus up to 5 s' });
  for (const id of ['worker', 'evaluator', 'pr']) assert.deepEqual(stage(p, id).estimate, { basis: 'guess', text: '15-60 minutes from the claim to a PR, for these stages together; nothing times them' }, `${id}: the guess, labelled as one`);
  assert.deepEqual(stage(p, 'checks').estimate!.basis, 'none', 'no number made up for CI');
  assert.equal(stage(p, 'merge').estimate, null);
});

test('#741 the coordinator\'s tick in the estimate is the one src/service.ts sleeps', () => {
  const src = readFileSync(join(repoRoot, 'src', 'service.ts'), 'utf8');
  const m = src.match(/nap\.sleep\(\(opts\.intervalMs \?\? ([\d_]+)\) \+ Math\.random\(\) \* ([\d_]+)\)/);
  assert.ok(m, 'runSite still sleeps intervalMs (default) plus a random jitter between ticks');
  assert.equal(Number(m[1]!.replace(/_/g, '')), COORDINATOR_TICK_MS);
  assert.equal(Number(m[2]!.replace(/_/g, '')), COORDINATOR_TICK_JITTER_MS);
});

test('#741 the filed issue followed to its PR: claimed, the worker, the verdict, the PR (its link), checks, then merged', () => {
  const l = withEarlierTask();
  l.add('dashboard.audit', P.filed(7))('issue.seen', P.seen(7, 'Round totals'))('issue.claimed', P.claimed(7))('run.started', P.started(7));
  let p = firstTaskProgress(l.events, { local: true })!;
  assert.doesNotMatch(JSON.stringify(p), /Round totals/, 'no free text: not even the title');
  assert.deepEqual(states(p), { claimed: 'done', worker: 'running', evaluator: 'waiting', pr: 'waiting', checks: 'waiting', merge: 'waiting' });
  assert.equal(stage(p, 'worker').estimate!.basis, 'guess', 'a running stage keeps its estimate');
  l.add('run.finished', P.finished(7))('eval.verdict', P.verdict(7))('pr.opened', P.opened(7, 41))('pr.status', P.status(7, 41, false, ['pass', 'pending']));
  p = firstTaskProgress(l.events, { local: true, repo: REPO })!;
  assert.deepEqual(states(p), { claimed: 'done', worker: 'done', evaluator: 'done', pr: 'done', checks: 'running', merge: 'waiting' });
  assert.equal(stage(p, 'evaluator').detail, 'approved, confidence high');
  assert.deepEqual(p.pr, { number: 41, url: PR_URL(41) });
  assert.equal(stage(p, 'checks').detail, '1 passed, 1 pending');
  l.add('pr.status', P.status(7, 41, true, ['pass', 'pass']))('merge.decided', P.decided(7, 41, []))('merge.done', P.done(7, 41));
  p = firstTaskProgress(l.events, { local: true })!;
  assert.deepEqual(states(p), { claimed: 'done', worker: 'done', evaluator: 'done', pr: 'done', checks: 'done', merge: 'done' });
  assert.equal(p.outcome, 'merged');
  assert.deepEqual(p.holds, []);
  for (const s of p.stages) assert.equal(s.estimate, null, `${s.id}: a done stage has no estimate`);
});

test('#741 held: the merge stage says why in #706\'s plain words for each hold kind, and what lets it through; local mode words the kill switch as #729 does', () => {
  const l = log();
  const off = 'auto-merge is off for this instance (policy.yaml auto_merge)';
  const doubt = 'doubt: evaluator confidence medium: the test only covers one path';
  l.add('dashboard.audit', P.filed(7))('issue.claimed', P.claimed(7))('run.started', P.started(7))('run.finished', P.finished(7))('eval.verdict', P.verdict(7))('pr.opened', P.opened(7, 41))('pr.status', P.status(7, 41, true, ['pass']))('merge.decided', P.decided(7, 41, [off, doubt, 'doubt: the evaluator doubts the test']));
  const local = firstTaskProgress(l.events, { local: true })!;
  assert.equal(stage(local, 'merge').state, 'held');
  assert.equal(local.outcome, 'held');
  assert.deepEqual(local.holds.map((h) => h.kind), ['policy-off', 'doubt'], 'one line per kind');
  assert.deepEqual(local.holds[0], holdWords(off, { local: true }));
  assert.match(local.holds[0]!.why, /^Local mode: every PR waits for you\./);
  assert.doesNotMatch(JSON.stringify(local.holds), /policy\.yaml/, 'a local install has no policy.yaml to name');
  const instance = firstTaskProgress(l.events, { local: false })!;
  assert.match(instance.holds[0]!.why, /^Auto-merge is off for this instance/);
  for (const h of [...local.holds, ...instance.holds]) assert.ok(h.why && h.through, 'both sentences, never empty');
  // The raw reason (its evaluator text) is not on the card: the PR's hold comment has it.
  assert.doesNotMatch(JSON.stringify(local), /only covers one path/);
});

test('#741 every hold reason the merge policy emits has plain words; an unknown one shows fixed words, never its text', () => {
  const level = { level: 'L1' as const, reasons: [], categories: {} as Record<string, string[]> };
  const clean: MergeInput = { branch: 'feature/x', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level, waitCategories: ['auth'], limits: { max_lines: 400, max_files: 10 }, lines: 1, files: 1, verdict: { patch_correct: true, test_correct: true, confidence: 'high', design_change: false }, newTopLevel: [], ciFixRuns: 0, foreignPush: false, pushLimitHit: false };
  assert.deepEqual(mergeDecision(clean).reasons, [], 'the base input merges');
  const holds: Partial<MergeInput>[] = [
    { openedByHarness: false },
    { policyOn: false },
    { repoOn: false },
    { stopped: 'main went red after #40' },
    { level: { ...level, categories: { auth: ['src/auth.ts'] } } },
    { claimedProtected: true },
    { verdict: { ...clean.verdict!, design_change: true } },
    { newTopLevel: ['newpkg'] },
    { lines: 401 },
    { files: 11 },
    { verdict: null },
    { verdict: { ...clean.verdict!, confidence: 'medium' } },
    { ciFixRuns: 1 },
    { foreignPush: true },
    { pushLimitHit: true },
    { instructionEvals: ['eval: role worker changed but was not evaluated'] },
    { outsidePlan: ['not in the approved plan: high-risk: auth (src/auth.ts)'] },
  ];
  const kinds = new Set<string>();
  for (const over of holds) {
    const reasons = mergeDecision({ ...clean, ...over }).reasons;
    assert.ok(reasons.length, `${JSON.stringify(over)} holds`);
    for (const r of reasons)
      for (const local of [true, false]) {
        const w = holdWords(r, { local });
        assert.notEqual(w.kind, 'other', `"${r}" has words`);
        kinds.add(w.kind);
      }
  }
  for (const k of kinds) assert.ok(HOLD_KINDS.includes(k as never), k);
  const unknown = holdWords('a reason added later: /home/example/x with its own text', { local: true });
  assert.deepEqual(unknown, { kind: 'other', why: 'Another reason (see the Board).', through: "Read the PR's hold comment and decide." }, 'fixed words, never the text');
  assert.deepEqual(holdWords('', { local: false }), unknown, 'never an empty line');
  assert.deepEqual(holdsInWords(['big: 500 changed lines (over 400)', 'big: 20 files (over 10)'], { local: false }).length, 1);
});

test('#741 for the filed issue only: another issue\'s events, an earlier event about the same number, and another PR\'s merge never move its card', () => {
  const l = log();
  l.add('issue.claimed', P.claimed(7))('merge.done', P.done(7, 9)); // before the filing: not this task's
  l.add('dashboard.audit', P.filed(7));
  l.add('issue.claimed', P.claimed(8))('run.started', P.started(8))('eval.verdict', P.verdict(8))('pr.opened', P.opened(8, 99))('merge.done', P.done(8, 99));
  let p = firstTaskProgress(l.events, { local: true })!;
  assert.deepEqual(states(p), { claimed: 'waiting', worker: 'waiting', evaluator: 'waiting', pr: 'waiting', checks: 'waiting', merge: 'waiting' });
  assert.equal(p.pr, null);
  l.add('issue.claimed', P.claimed(7))('run.started', P.started(7))('run.finished', P.finished(7))('eval.verdict', P.verdict(7))('pr.opened', P.opened(7, 41));
  // A merge, a decision and a status of another PR that name this issue (an older PR of it): not this PR's.
  l.add('merge.decided', P.decided(7, 42, ['big: 1 files (over 0)']))('pr.status', P.status(7, 42, true, ['pass']))('merge.done', P.done(7, 42));
  p = firstTaskProgress(l.events, { local: true, repo: REPO })!;
  assert.deepEqual(p.pr, { number: 41, url: PR_URL(41) });
  assert.deepEqual(states(p), { claimed: 'done', worker: 'done', evaluator: 'done', pr: 'done', checks: 'waiting', merge: 'waiting' });
  // The latest filing is the one followed.
  l.add('dashboard.audit', P.filed(12));
  assert.equal(firstTaskProgress(l.events, { local: true })!.issue, 12);
});

test('#741 the PR link is GitHub\'s page of that PR in this repo, or none: never a script URL, another host, repo or PR', () => {
  for (const [url, want] of [
    [PR_URL(41), PR_URL(41)],
    [`${PR_URL(41)}/`, PR_URL(41)],
    ['javascript:alert(1)//41', null],
    ['http://github.com/example-org/example-shop/pull/41', null],
    ['https://github.example/example-org/example-shop/pull/41', null],
    ['https://someone@github.com/example-org/example-shop/pull/41', null],
    ['https://github.com/other-org/example-shop/pull/41', null],
    ['https://github.com/example-org/example-shop/issues/41', null],
    [PR_URL(42), null],
    [PR_URL(141), null],
    ['not a url', null],
  ] as const) {
    const l = log();
    l.add('dashboard.audit', P.filed(7))('pr.opened', P.opened(7, 41, url));
    const p = firstTaskProgress(l.events, { local: true, repo: 'example-org/example-shop' })!;
    assert.deepEqual(p.pr, { number: 41, url: want }, url);
    if (url === PR_URL(41)) assert.deepEqual(firstTaskProgress(l.events, { local: true })!.pr, { number: 41, url: null }, 'no repo given: no link (fail closed)');
  }
});

test('#741 a decision or a failed merge from an older head never stands: after a new push the merge stage waits for a fresh decision', () => {
  const B = 'b0b0b0b';
  const head = (h: string, ready: boolean, outcomes: ('pass' | 'fail' | 'pending')[]) => ({ ...P.status(7, 41, ready, outcomes), head: h });
  // Held at head A; a review fix pushes B, whose checks are pending.
  const held = log();
  held.add('dashboard.audit', P.filed(7))('pr.opened', P.opened(7, 41))('pr.status', P.status(7, 41, true, ['pass']))('merge.decided', P.decided(7, 41, ['design: the evaluator flagged a design change']))('pr.status', head(B, false, ['pending']));
  let p = firstTaskProgress(held.events, { local: true })!;
  assert.equal(stage(p, 'merge').state, 'waiting');
  assert.equal(stage(p, 'merge').detail, 'a new head: it waits for its checks and a fresh decision');
  assert.deepEqual(p.holds, [], "A's reasons are not B's");
  assert.equal(p.outcome, 'open');
  // Auto at A; B's checks then fail: never "will merge it".
  const auto = log();
  auto.add('dashboard.audit', P.filed(7))('pr.opened', P.opened(7, 41))('pr.status', P.status(7, 41, true, ['pass']))('merge.decided', P.decided(7, 41, []))('merge.failed', { issue: 7, number: 41, head: H, why: 'x' })('pr.status', head(B, false, ['fail']));
  p = firstTaskProgress(auto.events, { local: true })!;
  assert.deepEqual([stage(p, 'checks').state, stage(p, 'merge').state], ['failed', 'waiting']);
  assert.doesNotMatch(JSON.stringify(p), /will merge|merge try failed/);
  // A decision at the new head counts again.
  auto.add('merge.decided', { ...P.decided(7, 41, ['big: 1 files (over 0)']), head: B });
  assert.equal(stage(firstTaskProgress(auto.events, { local: true })!, 'merge').state, 'held');
});

/** Hold reasons as merge.decided carries them today, beyond mergeDecision's: each with free text a card must not show. */
const RAW_REASONS = [
  "GitHub can't merge it cleanly (dirty)",
  'merging failed 3 times: GitHub said 405 at /home/example/raw-a1',
  'GitHub was still computing whether it can merge after 9 polls',
  'merging the default branch into it conflicts, but GitHub still reports it mergeable after 9 polls',
  "can't find where this PR branched from origin/main, so the combination can't be checked",
  'combined with origin/main at abc12345 (which changed src/a.ts), the fast tests fail: ENOENT /home/example/raw-b2 / exit 1',
  'docs-only fast path: the ruleset\'s required check(s) test (fail) did not pass on GitHub',
  "conflict fix: the evaluator's confidence is medium, not high: evaluator text raw-c3",
  'conflict fix: changed outside the conflicted hunks: src/raw-d4.ts',
  'doubt: evaluator confidence medium: evaluator text raw-e5',
];

test('#741 the card shows no evaluator text, path or run detail: every hold kind merge.decided carries today has fixed words; a block is fixed words', () => {
  const l = log();
  l.add('dashboard.audit', P.filed(7))('issue.claimed', P.claimed(7))('run.started', P.started(7))('run.finished', P.finished(7))('eval.verdict', { ...P.verdict(7), advice: 'advice raw-f6' })('pr.opened', P.opened(7, 41))('pr.status', P.status(7, 41, true, ['pass']))('merge.decided', P.decided(7, 41, RAW_REASONS));
  const p = firstTaskProgress(l.events, { local: true, repo: 'example-org/example-shop' })!;
  assert.deepEqual(p.holds.map((h) => h.kind), ['cant-merge', 'merge-failed', 'mergeable-unknown', 'combined', 'ruleset', 'conflict-fix', 'doubt']);
  assert.ok(!p.holds.some((h) => h.kind === 'other'), 'every kind has words');
  assert.doesNotMatch(JSON.stringify(p), /raw-|\/home\/|ENOENT|evaluator text|origin\/main|src\//);
  l.add('issue.blocked', { issue: 7, owner: 'example-owner', why: 'worker run ended: failed (ENOENT /home/example/raw-g7/.git)' });
  assert.doesNotMatch(JSON.stringify(firstTaskProgress(l.events, { local: true })), /raw-|ENOENT|\/home\//);
});

/**
 * A source scan (by design, #741 round 2): every hold reason a source of merge.decided writes must start with a prefix
 * the words table knows, and every reason pushed from a variable must be one traced here. A new prefix, or a new
 * source, fails this test until it has words. `src`: the source text (a fixture in the proof below).
 */
type Region = { file: string; fn: string | null; traced: string[] };
const REASON_SOURCES: Region[] = [
  { file: 'src/merge-policy.ts', fn: null, traced: ['{ category', '...riskAndDesignReasons(', '...(i.instructionEvals', '...(i.outsidePlan'] },
  { file: 'src/coordinator/merge-flow.ts', fn: 'private async mergeOrWait(', traced: ['hold.why', 'why', 'gate.hold'] },
  { file: 'src/coordinator.ts', fn: 'protected async combinedGate(', traced: [] },
  { file: 'src/pr-rules.ts', fn: 'export function rulesetHold(', traced: [] },
  { file: 'src/conflicts.ts', fn: 'export function conflictWaitReasons(', traced: [] },
];
function bodyOf(src: string, fn: string | null): string {
  if (!fn) return src;
  const at = src.indexOf(fn);
  assert.ok(at >= 0, `${fn} is still there`);
  const i = src.lastIndexOf('{', src.indexOf('\n', at));
  for (let depth = 0, j = i; j < src.length; j++) {
    depth += src[j] === '{' ? 1 : src[j] === '}' ? -1 : 0;
    if (depth === 0) return src.slice(i, j + 1);
  }
  return src.slice(i);
}
function unworded(r: Region, src: string): string[] {
  const body = bodyOf(src, r.fn).replaceAll('${HIGH_RISK_REASON}', HIGH_RISK_REASON);
  const out: string[] = [];
  const lit = /(?:\.push\(\s*\[?|\.map\(\(\w+\) => |\bconst why = |\bwhy: |\bhold: )([`'"])((?:(?!\1)[^\\$]|\\.|\$(?!\{))*)/g;
  for (const m of body.matchAll(lit)) {
    const prefix = m[2]!;
    // A continuation line of a reason (an eval's "  - case ..." list), or a map that only passes text through
    // (`${c.name} ...` inside a reason), never starts a reason.
    if (prefix.startsWith('  - ') || (m[0].startsWith('.map') && !prefix)) continue;
    if (holdWords(prefix, { local: false }).kind === 'other') out.push(`${r.file}: "${prefix}"`);
  }
  for (const m of body.matchAll(/\.push\(\s*(?![`'"[])([^)\n]*)/g)) if (!r.traced.some((t) => m[1]!.startsWith(t))) out.push(`${r.file}: untraced push(${m[1]})`);
  return out;
}

test('#741 every hold reason any source of merge.decided writes has words (a source scan), and the scan catches a new prefix or source', () => {
  for (const r of REASON_SOURCES) assert.deepEqual(unworded(r, readFileSync(join(repoRoot, r.file), 'utf8')), [], r.file);
  // The proof, on fixture text (no repo file edited): a new prefix, and a reason pushed from a new variable.
  const policy = REASON_SOURCES[0]!;
  assert.deepEqual(unworded(policy, "if (x) reasons.push('stale: the base moved');"), ['src/merge-policy.ts: "stale: the base moved"']);
  assert.deepEqual(unworded(policy, 'reasons.push(`stale: ${n} commits behind`);'), ['src/merge-policy.ts: "stale: "']);
  const flow = REASON_SOURCES[1]!;
  assert.deepEqual(unworded(flow, 'private async mergeOrWait(w) {\n  d.reasons.push(newWhy);\n}'), ['src/coordinator/merge-flow.ts: untraced push(newWhy)']);
  assert.deepEqual(unworded(flow, 'private async mergeOrWait(w) {\n  const why = `held: ${x}`;\n}'), ['src/coordinator/merge-flow.ts: "held: "']);
});

test('#741 the card carries no run detail: not the worktree path, the run\'s error text, the evaluator\'s advice, nor who filed it', () => {
  const l = log();
  l.add('dashboard.audit', { ...P.filed(7), login: 'filer-login-5c1d' })('issue.claimed', P.claimed(7))('run.started', { ...P.started(7), worktree: '/home/example/private-worktree-9f2a' })('run.finished', { ...P.finished(7, 'failed'), detail: 'claude: token sk-stand-in-3e8b at /home/example/.claude' });
  l.add('run.started', P.started(7, 2))('run.finished', P.finished(7))('eval.verdict', { ...P.verdict(7), advice: 'advice text 7c0d' });
  const json = JSON.stringify(firstTaskProgress(l.events, { local: true }));
  assert.doesNotMatch(json, /9f2a|3e8b|\/home\/example|7c0d|5c1d/);
});

test('#741 no false progress: a retried worker makes the earlier verdict stale; a failed run, failing checks, a closed PR and a block say so', () => {
  const l = log();
  l.add('dashboard.audit', P.filed(7))('issue.claimed', P.claimed(7))('run.started', P.started(7))('run.finished', P.finished(7))('eval.verdict', P.verdict(7, false));
  let p = firstTaskProgress(l.events, { local: true })!;
  assert.equal(stage(p, 'evaluator').state, 'failed');
  assert.equal(stage(p, 'evaluator').detail, 'did not approve it, confidence low');
  l.add('run.started', P.started(7, 2));
  p = firstTaskProgress(l.events, { local: true })!;
  assert.equal(stage(p, 'worker').state, 'running');
  assert.equal(stage(p, 'worker').detail, 'attempt 2 started; no finish recorded yet');
  assert.equal(stage(p, 'evaluator').state, 'waiting', "attempt 1's verdict isn't attempt 2's");
  l.add('run.finished', P.finished(7, 'failed'));
  assert.equal(stage(firstTaskProgress(l.events, { local: true })!, 'worker').state, 'failed');
  l.add('issue.blocked', { issue: 7, owner: 'example-owner', why: 'the worker could not finish\nsecond line' });
  p = firstTaskProgress(l.events, { local: true })!;
  assert.ok(p.blocked);
  assert.doesNotMatch(JSON.stringify(p), /could not finish|second line/, 'the block is said in fixed words, never its reason');
  assert.equal(p.outcome, 'blocked');
  const c = log();
  c.add('dashboard.audit', P.filed(7))('pr.opened', P.opened(7, 41))('pr.status', P.status(7, 41, false, ['pass', 'fail']))('pr.closed', P.closed(7, 41, false));
  const q = firstTaskProgress(c.events, { local: true })!;
  assert.equal(stage(q, 'checks').state, 'failed');
  assert.equal(stage(q, 'checks').detail, '1 passed, 1 failed');
  assert.equal(stage(q, 'merge').state, 'failed');
  assert.equal(q.outcome, 'closed');
});

/** The machine as the setup checks see it: stand-ins only (no real gh, claude or service is asked). */
const probe: SetupProbe = { which: (c) => `/stand-in/${c}`, run: () => ({ status: 1, stdout: '{"loggedIn": false}', stderr: 'stand-in' }), serviceRunning: () => false, systemUnitActive: () => false, linger: () => null };

test('#741 GET /api/first-run: after File it, the card follows the filed issue (writers); a viewer is refused and gets no hold reason', async () => {
  const { dir } = exampleProject();
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  const eventsDb = join(stateDir, 'events.db');
  new EventLog(eventsDb).close();
  const backlog = new FileBacklog(join(mkdtempSync(join(tmpdir(), 'ftp-backlog-')), 'backlog.json'), 'example-owner');
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb, stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'ftp-slots-')), backlog: () => backlog, setupProbe: probe });
  const base = d.url.split('/?')[0]!;
  const h = (user: string) => ({ authorization: `Bearer ${d.token}`, ...asPerson(user), 'content-type': 'application/json' });
  const get = async (path: string, user: string) => {
    const r = await fetch(`${base}${path}`, { headers: h(user) });
    return { status: r.status, text: await r.text() };
  };
  try {
    const before = JSON.parse((await get('/api/first-run', 'example-owner')).text) as { firstTask?: unknown };
    assert.equal(before.firstTask, null, 'nothing filed yet: no card');
    const filed = await fetch(`${base}/api/first-run/first-task`, { method: 'POST', headers: h('example-owner'), body: JSON.stringify({ values: { title: 'First task', outcome: 'It works.', done_when: [{ command: 'true' }] }, confirm: true }) });
    const n = ((await filed.json()) as { number: number }).number;
    assert.ok(n > 0);
    const reason = 'auto-merge is off for this instance (policy.yaml auto_merge)';
    const log = new EventLog(eventsDb);
    try {
      log.append('issue.claimed', P.claimed(n), 'c');
      log.append('run.started', P.started(n), 'c');
      log.append('run.finished', P.finished(n), 'c');
      log.append('eval.verdict', P.verdict(n), 'c');
      log.append('pr.opened', P.opened(n, 41), 'c');
      log.append('pr.status', P.status(n, 41, true, ['pass']), 'c');
      log.append('merge.decided', P.decided(n, 41, [reason]), 'c');
    } finally {
      log.close();
    }
    for (const who of ['example-owner', 'example-collaborator']) {
      const r = await get('/api/first-run', who);
      assert.equal(r.status, 200, who);
      const t = (JSON.parse(r.text) as { firstTask: FirstTaskProgress }).firstTask;
      assert.equal(t.issue, n, `${who}: the filed issue`);
      assert.deepEqual(states(t), { claimed: 'done', worker: 'done', evaluator: 'done', pr: 'done', checks: 'done', merge: 'held' });
      assert.deepEqual(t.pr, { number: 41, url: PR_URL(41) });
      assert.deepEqual(t.holds, [holdWords(reason, { local: true })], 'a checkout is local mode: #729\'s words');
    }
    const viewer = await get('/api/first-run', 'someone-else');
    assert.equal(viewer.status, 403);
    assert.doesNotMatch(viewer.text, /auto-merge|waits for you|firstTask/);
  } finally {
    await d.close();
  }
});
