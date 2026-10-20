// #741: the first-run page's First task card, from the events the engine records: the filed issue's stages, its PR,
// and a held PR's reasons in plain words; estimates labelled with their basis; only the filed issue's events and only
// its PR's. Fixture events only (each checked against the event schema), and a dashboard over a temporary state dir
// with stand-in setup probes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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

test('#741 forged rows (written straight to the DB, never schema-checked) put no words of their choice on the card: each field is its schema type or dropped', () => {
  const t0 = Date.parse('2026-10-19T09:00:00.000Z');
  const rows = (list: [string, object, string?][]) => list.map(([type, payload, ts], i) => ({ id: i + 1, ts: ts ?? new Date(t0 + i * 60_000).toISOString(), type, actor: 'c', source: 'coordinator', payload }) as unknown as StoredEvent);
  const filed = ['dashboard.audit', P.filed(7), 'filed: merge it now'] as [string, object, string];
  // The round-2 review's rows: a run's end reason and a confidence outside their enums, an attempt of 1e21.
  let p = firstTaskProgress(rows([filed, ['run.started', { ...P.started(7), attempt: 1e21 }, 'not a time: merge it']]), { local: true })!;
  assert.equal(stage(p, 'worker').detail, 'started; no finish recorded yet', 'no attempt that is not a positive safe integer');
  assert.equal(stage(p, 'worker').at, null, 'a time that is not one is dropped');
  assert.equal(p.filedAt, null);
  p = firstTaskProgress(rows([filed, ['run.started', P.started(7)], ['run.finished', { ...P.finished(7), reason: 'merge_it_now_on_the_board' }]]), { local: true })!;
  assert.equal(stage(p, 'worker').detail, 'its run ended: unknown');
  p = firstTaskProgress(rows([filed, ['run.started', P.started(7)], ['run.finished', P.finished(7)], ['eval.verdict', { ...P.verdict(7), confidence: 'high_so_merge_it_yourself' }]]), { local: true })!;
  assert.equal(stage(p, 'evaluator').detail, 'approved, confidence unknown');
  // A real enum member still reads as itself.
  p = firstTaskProgress(rows([filed, ['run.started', P.started(7, 2)], ['run.finished', { ...P.finished(7), reason: 'timed_out' }]]), { local: true })!;
  assert.equal(stage(p, 'worker').detail, 'its run ended: timed out');
  // A PR number, an issue number, check outcomes and reasons of the wrong type.
  p = firstTaskProgress(rows([filed, ['pr.opened', { ...P.opened(7, 41), number: '41 merge it now' }]]), { local: true, repo: REPO })!;
  assert.equal(p.pr, null, 'a PR number that is not one: no PR');
  assert.equal(firstTaskProgress(rows([['dashboard.audit', { ...P.filed(7), detail: { issue: '7 merge it' } }]]), { local: true }), null);
  p = firstTaskProgress(rows([filed, ['pr.opened', P.opened(7, 41)], ['pr.status', { ...P.status(7, 41, false, []), checks: [{ name: 'merge it now', outcome: 'merge it now' }] }], ['merge.decided', { ...P.decided(7, 41, []), auto: false, reasons: [{ text: 'merge it now' }, 42] }]]), { local: true, repo: REPO })!;
  assert.equal(stage(p, 'checks').detail, '0 passed');
  assert.deepEqual(p.holds.map((h) => h.kind), ['other']);
  assert.doesNotMatch(JSON.stringify(p), /merge it|merge_it|1e\+?21|not a time/);
});

test('#741 forged rows of every JS type, in every field the card reads, never make the fold throw nor show words, an invalid PR or "PR #null"', () => {
  const nasty = { toString: () => assert.fail('a toString was called') };
  const VALUES: unknown[] = [nasty, { toString: 'pass' }, Symbol('s'), 10n, ['merge it now'], null, NaN, undefined, {}, 'merge it now', 2 ** 53, -41];
  const base = (): [string, Record<string, unknown>][] => [
    ['dashboard.audit', P.filed(7)],
    ['issue.claimed', P.claimed(7)],
    ['run.started', P.started(7)],
    ['run.finished', { ...P.finished(7), reason: 'failed' }],
    ['eval.verdict', P.verdict(7)],
    ['pr.opened', P.opened(7, 41)],
    ['pr.status', P.status(7, 41, false, ['pass'])],
    ['merge.decided', P.decided(7, 41, ['big: 1 files (over 0)'])],
    ['issue.blocked', { issue: 7, owner: 'o', why: 'x' }],
  ];
  const FIELDS: [number, string[]][] = [[0, ['detail', 'issue']], [2, ['attempt']], [3, ['reason']], [4, ['confidence']], [4, ['patch_correct']], [5, ['number']], [5, ['url']], [5, ['head']], [6, ['checks']], [6, ['checks', '0']], [6, ['checks', '0', 'outcome']], [6, ['ready']], [7, ['reasons']], [7, ['reasons', '0']], [7, ['auto']], [8, ['why']], [1, []]];
  for (const [row, path] of FIELDS)
    for (const v of [...VALUES, 'ts']) {
      const rows = base().map(([type, payload], i) => ({ id: i + 1, ts: new Date(Date.parse('2026-10-19T09:00:00Z') + i * 60_000).toISOString(), type, actor: 'c', source: 'coordinator', payload: structuredClone(payload) }) as unknown as StoredEvent);
      const at = rows[row]!;
      if (v === 'ts') (at as { ts: unknown }).ts = nasty;
      else if (!path.length) (at as { payload: unknown }).payload = v;
      else path.slice(0, -1).reduce((o: Record<string, unknown>, k) => o[k] as Record<string, unknown>, at.payload as unknown as Record<string, unknown>)[path.at(-1)!] = v;
      const p = firstTaskProgress(rows, { local: true, repo: REPO });
      const json = JSON.stringify(p); // a bigint or symbol carried through would throw here
      const where = `${row}.${path.join('.')} = ${typeof v === 'symbol' ? 'symbol' : typeof v === 'bigint' ? 'bigint' : JSON.stringify(v) ?? String(v)}`;
      assert.doesNotMatch(json ?? '', /merge it now|PR #null|PR #-|PR #9007/, where);
      if (p?.pr === null) assert.notEqual(stage(p, 'pr').state, 'done', `${where}: no PR, so not opened`);
    }
});

test('#741 a card that cannot be built drops the card only: the rest of GET /api/first-run (Start, the steps) still answers', async () => {
  const { dir } = exampleProject();
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  const eventsDb = join(stateDir, 'events.db');
  const log = new EventLog(eventsDb);
  log.append('dashboard.audit', P.filed(7), 'example-owner', 'human');
  log.append('issue.seen', P.seen(7, 'fold-throws-marker'), 'c');
  log.close();
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb, stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'ftp-slots-')), setupProbe: probe });
  // A fault injected into the fold only (the array of this issue's events), no repo file edited.
  const findLast = Array.prototype.findLast;
  const errors: unknown[] = [];
  const error = console.error;
  Array.prototype.findLast = function (this: unknown[], ...a: Parameters<typeof findLast>) {
    if (this.some((e) => (e as { payload?: { title?: unknown } })?.payload?.title === 'fold-throws-marker')) throw new Error('forced');
    return findLast.apply(this, a);
  } as typeof findLast;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    const get = async () => {
      const r = await fetch(`${d.url.split('/?')[0]}/api/first-run`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson('example-owner') } });
      return { status: r.status, body: (await r.json()) as { firstTask?: unknown; start?: unknown; setup?: unknown } };
    };
    const r = await get();
    assert.equal(r.status, 200);
    assert.equal(r.body.firstTask, null, 'the card is left out');
    assert.ok(r.body.start && r.body.setup, 'Start and the steps still answer');
    await get();
    assert.equal(errors.filter((e) => /First task card/.test(String((e as unknown[])[0]))).length, 1, 'logged once');
  } finally {
    Array.prototype.findLast = findLast;
    console.error = error;
    await d.close();
  }
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

/*
 * A source scan (by design, #741 rounds 2 and 3): every hold reason a source of merge.decided writes must start with a
 * prefix the words table knows, and every other value written to a reasons array (or a why/hold value) must be a
 * whole expression traced here. Every emitter of merge.decided and conflict_fix.finished must sit in a scanned region.
 * It fails closed: a new prefix, a new variable, a new kind of write (unshift, splice, a reassignment, an initializer)
 * or a new emitter fails until it is worded or traced. Known gaps, named and not chased (round 3): an index write
 * (`d.reasons[0] = ...`), `push.apply`, a shorthand `{ hold }` or a `hold` variable, `??=`, and an emitter by a
 * constant event type, by another method name, or by `emit?.(`. Also known gaps, which only cost plain words (the card then reads
 * "Another reason (see the Board)"): a traced helper or table lookup that itself changes what it returns, and reasons
 * passed in through a MergeInput field other than the traced ones.
 */
/** [file, the function's signature as it starts]: every function whose text writes merge.decided reasons. */
const REGIONS: [string, string][] = [
  ['src/merge-policy.ts', 'export function neverAutoMerge('],
  ['src/merge-policy.ts', 'export function instructionEvalReasons('],
  ['src/merge-policy.ts', 'export function riskAndDesignReasons('],
  ['src/merge-policy.ts', 'export function outsidePlanReasons('],
  ['src/merge-policy.ts', 'export function mergeDecision('],
  ['src/coordinator/merge-flow.ts', '  mergeDecisionFor(n: number'],
  ['src/coordinator/merge-flow.ts', 'private async mergeOrWait('],
  ['src/coordinator.ts', 'protected async combinedGate('],
  ['src/pr-rules.ts', 'export function rulesetHold('],
  ['src/conflicts.ts', 'export function conflictWaitReasons('],
  ['src/coordinator/fix-runs.ts', 'private async giveUpConflict('],
  ['src/coordinator/fix-runs.ts', 'private async conflictRun('],
];
/** Literal substitutions a reason starts with. */
const SUBST: Record<string, string> = { '${HIGH_RISK_REASON}': HIGH_RISK_REASON };
/**
 * Non-literal values allowed in a reasons array or a why/hold value: each a whole expression (one ending in "(" is a
 * call with any arguments), and the region that builds the reasons it carries in, when it does (that region must be
 * scanned).
 */
const TRACED: [string, string | null][] = [
  ['why', null], // mergeOrWait's const why: its literals are scanned
  ['hold.why', 'export function rulesetHold('],
  ['gate.hold', 'protected async combinedGate('],
  ['...neverAutoMerge(', 'export function neverAutoMerge('],
  ['...riskAndDesignReasons(', 'export function riskAndDesignReasons('],
  ['...(i.instructionEvals ?? [])', 'export function instructionEvalReasons('],
  ['...(i.outsidePlan ?? [])', 'export function outsidePlanReasons('],
  ['...(i.weakening ?? [])', null], // #783: `design: may weaken a check: ...`, built in src/merge-policy-weakening.ts
  ['...d.reasons', 'export function mergeDecision('],
  ['d.reasons', '  mergeDecisionFor(n: number'], // the emitter's own value: mergeDecisionFor's, then mergeOrWait's pushes
  ['...fix.reasons', 'private async conflictRun('],
  ['conflictWaitReasons(', 'export function conflictWaitReasons('],
  ['...diff', null], // an eval reason's continuation lines ("  - case ..."), after its scanned first line
  ['d.why', null], // merge.decided's why: WaitWhy[], whyHighRisk's plain words, not reasons
  ['whyHighRisk(', null],
  ['m.why.slice(0, 500)', null], // merge.failed's why, not a reason
  ['push.refused', null], // push.refused's reasons, another event
];

/** The index of the first char of `stops` at depth 0 from `i` (or of a closing bracket at depth 0), past strings and templates. */
function endAt(s: string, i: number, stops: string): number {
  for (let depth = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '/' && s[i + 1] === '/' && s[i - 1] !== '\\') i =s.indexOf('\n', i) < 0 ? s.length : s.indexOf('\n', i) - 1;
    else if (c === '/' && s[i + 1] === '*') i = s.indexOf('*/', i + 2) + 1;
    else if (c === "'" || c === '"') for (i++; i < s.length && s[i] !== c; i++) i += s[i] === '\\' ? 1 : 0;
    else if (c === '`') for (i++; i < s.length && s[i] !== '`'; i++) i = s[i] === '\\' ? i + 1 : s[i] === '$' && s[i + 1] === '{' ? endAt(s, i + 2, '') : i;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && stops.includes(c)) return i;
  }
  return i;
}
const exprAt = (s: string, i: number) => s.slice(i, endAt(s, i, ',;\n')).trim();
const traced = (v: string) => TRACED.some(([t]) => v === t || (t.endsWith('(') && v.startsWith(t) && endAt(v, t.length, '') === v.length - 1));
/** Each top-level element of an array literal `[...]`. */
function elements(v: string): string[] {
  const out: string[] = [];
  const close = endAt(v, 1, '');
  for (let i = 1; i < close; ) {
    const j = Math.min(endAt(v, i, ','), close);
    out.push(v.slice(i, j).trim());
    i = j + 1;
  }
  return out.filter(Boolean);
}
/** What is wrong with one value written to reasons (or a why/hold value): an unworded prefix, or an untraced value. */
function badValue(v: string): string[] {
  const lit = v.match(/^([`'"])((?:(?!\1)[^\\$]|\\.|\$(?!\{))*)/);
  if (lit) return lit[2]!.startsWith('  - ') || holdWords(lit[2]!, { local: false }).kind !== 'other' ? [] : [`"${lit[2]}"`];
  if (v.startsWith('[')) return elements(v).flatMap(badValue);
  return traced(v) ? [] : [`untraced ${v}`];
}
/** A region's text and where it starts; the signature must still be there. */
function region(src: string, sig: string, file: string): { at: number; text: string } {
  // Exactly once: a signature that also matches a call (or anything else) would scan the wrong lines.
  assert.equal(src.split(sig).length, 2, `${file}: "${sig}" is there exactly once`);
  const s = src.indexOf(sig);
  const at = src.lastIndexOf('{', src.indexOf('\n', s));
  return { at, text: src.slice(at, endAt(src, at + 1, '') + 1) };
}
/** Every problem in one file's regions: `files` maps a path to its source text (the repo's, or a fixture's). */
function scan(file: string, src: string): string[] {
  const out: string[] = [];
  for (const [f, sig] of REGIONS) {
    if (f !== file) continue;
    let body = region(src, sig, file).text;
    for (const [k, v] of Object.entries(SUBST)) body = body.replaceAll(k, v);
    const bad = (what: string[]) => out.push(...what.map((w) => `${file} ${sig} ${w}`));
    for (const m of body.matchAll(/\.push\(/g)) {
      const close = endAt(body, m.index + 6, '');
      for (let i = m.index + 6; i < close; ) {
        const j = Math.min(endAt(body, i, ','), close);
        bad(badValue(body.slice(i, j).trim()));
        i = j + 1;
      }
    }
    for (const m of body.matchAll(/\.(unshift|splice|concat)\(/g)) bad([`a write other than push: ${m[1]}(${exprAt(body, m.index + m[0].length)}`]);
    // An initializer or reassignment of a reasons array or a why, a reasons/why/hold property, a returned array.
    for (const m of body.matchAll(/(?<![\w.])(?:(?:const|let|var)\s+)?(d\.reasons|reasons|out|r|why)\s*(?::[^=\n;(]*)?=(?![=>])/g)) {
      const v = exprAt(body, m.index + m[0].length);
      // out and r name other things too (a result, a lookup): as reason arrays, only their array literals are writes.
      if ((m[1] === 'out' || m[1] === 'r') && !v.startsWith('[')) continue;
      bad(badValue(v));
    }
    for (const m of body.matchAll(/(?<![\w.?])(?<!(?:const|let|var)\s+)(?:reasons|why|hold)\s*:(?!:)/g)) bad(badValue(exprAt(body, m.index + m[0].length)));
    for (const m of body.matchAll(/\breturn\s+(?=\[)/g)) bad(badValue(exprAt(body, m.index + m[0].length)));
    // A reason built by mapping (outsidePlanReasons); a map that only passes text through ("${c.name}") starts none.
    for (const m of body.matchAll(/\.map\(\(\w+\) => (?=[`'"])/g)) {
      const v = exprAt(body, m.index + m[0].length);
      if (!/^`\$\{/.test(v)) bad(badValue(v));
    }
  }
  return out;
}
/** Every emitter of merge.decided or conflict_fix.finished outside a scanned region: `files` maps paths to source text. */
function emittersOutside(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, src] of Object.entries(files))
    for (const m of src.matchAll(/\b(?:emit|append)\(\s*['"`](?:merge\.decided|conflict_fix\.finished)['"`]/g)) {
      const inside = REGIONS.some(([f, sig]) => {
        if (f !== file || !src.includes(sig)) return false;
        const r = region(src, sig, file);
        return m.index > r.at && m.index < r.at + r.text.length;
      });
      // A conflict fix recorded with no reasons at all (recovery's "interrupted"): only when the argument right after
      // the event type is itself an object literal, the call's last argument, holding exactly `reasons: []` among its
      // top-level fields and no spread (never a wrapped payload: Object.assign({ reasons: [] }, x), f({ reasons: [] })).
      const after = m.index + m[0].length;
      const lead = src.slice(after).match(/^\s*,\s*(?=\{)/);
      const close = lead ? endAt(src, after + lead[0].length + 1, '') : -1;
      const last = lead !== null && /^\s*,?\s*\)/.test(src.slice(close + 1));
      const fields = last ? elements(src.slice(after + lead![0].length, close + 1)) : [];
      // Fail closed: every field a plain identifier key (or shorthand), never __proto__; a computed or quoted key, a
      // getter, a method or a comment before a key could set `reasons` again at runtime, so it loses the exemption.
      const plain = fields.every((f) => /^[A-Za-z_$][\w$]*(\s*:|$)/.test(f) && !/^__proto__\b/.test(f));
      const empty = last && plain && m[0].includes('conflict_fix') && fields.some((f) => /^reasons\s*:\s*\[\]$/.test(f)) && !fields.some((f) => /^reasons\b/.test(f) && !/^reasons\s*:\s*\[\]$/.test(f));
      if (!inside && !empty) out.push(`${file}: ${m[0]}`);
    }
  return out;
}
const srcFiles = (dir: string): string[] => readdirSync(join(repoRoot, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? srcFiles(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));

test('#741 every hold reason any source of merge.decided writes has words (a source scan); every emitter is scanned', () => {
  const files = Object.fromEntries(srcFiles('src').map((f) => [f, readFileSync(join(repoRoot, f), 'utf8')]));
  for (const file of new Set(REGIONS.map(([f]) => f))) assert.deepEqual(scan(file, files[file]!), [], file);
  assert.deepEqual(emittersOutside(files), [], 'every emitter of merge.decided and conflict_fix.finished is in a scanned region');
  for (const [t, built] of TRACED) if (built) assert.ok(REGIONS.some(([, sig]) => sig === built), `${t}: ${built} is scanned`);
});

test('#741 the scan fails closed: each way round it the round-2 review found (fixture text, no repo file edited)', () => {
  const at = (file: string, sig: string, body: string) => scan(file, `${sig}x) {\n${body}\n}\n`);
  const FLOW = 'src/coordinator/merge-flow.ts';
  const DEF = '  mergeDecisionFor(n: number) {\n';
  const flowFx = (body: string) => scan(FLOW, `${DEF}}\nprivate async mergeOrWait(w) {\n${body}\n}\n`);
  const cases: [string[], RegExp][] = [
    [flowFx('const why = this.staleWhy(polls);\nd.reasons.push(why);'), /untraced this\.staleWhy\(polls\)/],
    [flowFx('const why = STALE_WORDS[kind];\nd.reasons.push(why);'), /untraced STALE_WORDS\[kind\]/],
    [flowFx('d.reasons.push(whyStale);'), /untraced whyStale/],
    [flowFx('d.reasons.push(gate.holdText);'), /untraced gate\.holdText/],
    [flowFx("d.reasons.unshift('stale: x');"), /a write other than push: unshift/],
    [flowFx("d.reasons.splice(0, 0, 'stale: x');"), /a write other than push: splice/],
    [flowFx("d.reasons = [...d.reasons, 'stale: x'];"), /"stale: x"/],
    [scan(FLOW, `${DEF}  return { ...d, auto: false, reasons: [...d.reasons, ...fix.reasons, 'stale: base moved'] };\n}\nprivate async mergeOrWait(w) {\n}\n`), /"stale: base moved"/],
    [scan(FLOW, `${DEF}  d.reasons.push('stale: y');\n}\nprivate async mergeOrWait(w) {\n}\n`), /"stale: y"/],
    // A call of the function before its definition: the definition is what is scanned.
    [scan(FLOW, `const d = this.mergeDecisionFor(e.issue, e.number, pr);\n${DEF}  d.reasons.push('stale: def');\n}\nprivate async mergeOrWait(w) {\n}\n`), /"stale: def"/],
    [at('src/coordinator.ts', 'protected async combinedGate(', 'return { hold: HOLDS.stale };'), /untraced HOLDS\.stale/],
    [at('src/coordinator.ts', 'protected async combinedGate(', 'return { hold: staleHold(mainSha) };'), /untraced staleHold\(mainSha\)/],
    [at('src/pr-rules.ts', 'export function rulesetHold(', "return { act: 'hold', why: `stale: ${n}` };"), /"stale: "/],
  ];
  const policy = ['neverAutoMerge', 'instructionEvalReasons', 'riskAndDesignReasons', 'outsidePlanReasons'].map((f) => `export function ${f}(x) {\n}\n`).join('');
  const inPolicy = (body: string) => scan('src/merge-policy.ts', `${policy}export function mergeDecision(i) {\n${body}\n}\n`);
  cases.push(
    [inPolicy("if (x) reasons.push('stale: the base moved');"), /"stale: the base moved"/],
    [inPolicy('reasons.push(`stale: ${n} commits behind`);'), /"stale: "/],
    [inPolicy('reasons.push(...(i.instructionEvalsExtra ?? []));'), /untraced \.\.\.\(i\.instructionEvalsExtra \?\? \[\]\)/],
    [inPolicy("const reasons: string[] = ['stale: x', ...neverAutoMerge({ branch: i.branch })];"), /"stale: x"/],
    [scan('src/coordinator/fix-runs.ts', "private async giveUpConflict(x) {\n}\nprivate async conflictRun(x) {\n  const reasons = conflictWaitReasons({ outside });\n  reasons.push('stale: z');\n}\n"), /"stale: z"/],
  );
  for (const [found, want] of cases) assert.ok(found.some((f) => want.test(f)), `${want}: ${JSON.stringify(found)}`);
  // What stays allowed: a traced call with any arguments, and a worded literal.
  assert.deepEqual(flowFx("d.reasons.push(why);\nconst why = `GitHub was still computing whether it can merge after ${polls} polls`;"), []);
  // A new file that emits merge.decided (or conflict_fix.finished) outside every scanned region.
  assert.deepEqual(emittersOutside({ 'src/stale-watch.ts': "this.emit('merge.decided', { issue, number, head, auto: false, reasons: ['stale: x'] });" }), ["src/stale-watch.ts: emit('merge.decided'"]);
  assert.deepEqual(emittersOutside({ [FLOW]: `${DEF}}\nprivate async mergeOrWait(w) {\n  this.emit('merge.decided', {});\n}\n` }), []);
  // A signature found twice (a call that reads like it, a copy) would scan the wrong lines: refused.
  assert.throws(() => scan(FLOW, `${DEF}}\n${DEF}}\nprivate async mergeOrWait(w) {\n}\n`), /exactly once/);
  // The review's E1-E3, on merge-flow.ts's real text changed in memory only.
  const real = readFileSync(join(repoRoot, FLOW), 'utf8');
  const sigLine = real.slice(real.indexOf('  mergeDecisionFor(n: number'), real.indexOf('\n', real.indexOf('  mergeDecisionFor(n: number')) + 1);
  const into = (line: string) => scan(FLOW, real.replace(sigLine, `${sigLine}    ${line}\n`));
  assert.ok(real.includes('reasons: [...d.reasons, ...fix.reasons]'), 'the conflict-fix spread is where E1 changes it');
  assert.ok(scan(FLOW, real.replace('reasons: [...d.reasons, ...fix.reasons]', "reasons: [...d.reasons, ...fix.reasons, 'stale: the fix moved']")).some((f) => f.includes('"stale: the fix moved"')), 'E1');
  assert.ok(into("d.reasons.push('stale: the base moved');").some((f) => f.includes('"stale: the base moved"')), 'E2');
  assert.ok(into("return { ...d, auto: false, reasons: ['stale: x'] };").some((f) => f.includes('"stale: x"')), 'E3');
  // A conflict fix recorded elsewhere: only with no reasons at all.
  assert.deepEqual(emittersOutside({ 'src/x.ts': "this.emit('conflict_fix.finished', { outcome: 'interrupted', reasons: [], detail: 'x' });" }), []);
  assert.deepEqual(emittersOutside({ 'src/x.ts': "this.emit('conflict_fix.finished', { outcome: 'pushed', reasons: ['stale: x'], detail: 'x' });" }), ["src/x.ts: emit('conflict_fix.finished'"]);
  // The review's N7: a spread beside `reasons: []` could override it.
  assert.deepEqual(emittersOutside({ 'src/x.ts': "this.emit('conflict_fix.finished', { reasons: [], ...finished });" }), ["src/x.ts: emit('conflict_fix.finished'"]);
  // The round-4 review's N11a-c: a wrapped payload, or one followed by another argument, is never exempt.
  for (const call of ["Object.assign({ reasons: [] }, finished)", 'withReasons({ reasons: [] })', "{ outcome: 'interrupted', reasons: [] }, extra", 'pick({ reasons: [] }, finished), extra'])
    assert.deepEqual(emittersOutside({ 'src/x.ts': `this.emit('conflict_fix.finished', ${call});` }), ["src/x.ts: emit('conflict_fix.finished'"], call);
  // The round-5 probes: a second key that sets `reasons` again at runtime (computed, quoted, a getter, behind a
  // comment), and __proto__: none is exempt.
  for (const second of ["['reasons']: why", '[k]: why', "'reasons': why", '"reasons": why', 'get reasons() { return why }', "/* c */ 'reasons': why", "// c\n 'reasons': why", 'reasons() { return why }', '__proto__: finished'])
    assert.deepEqual(emittersOutside({ 'src/x.ts': `this.emit('conflict_fix.finished', { reasons: [], ${second} });` }), ["src/x.ts: emit('conflict_fix.finished'"], second);
  // A trailing comma after the one payload still reads as the last argument.
  assert.deepEqual(emittersOutside({ 'src/x.ts': "this.emit('conflict_fix.finished', { outcome: 'interrupted', reasons: [] },\n);" }), []);
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
