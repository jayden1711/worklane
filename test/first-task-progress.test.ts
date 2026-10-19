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
import { mergeDecision, type MergeInput } from '../src/merge-policy.js';
import type { SetupProbe } from '../src/setup-steps.js';
import { asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

const H = 'abc1234';
const PR_URL = (n: number) => `https://github.com/example-org/example-shop/pull/${n}`;

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
  assert.equal(p.title, 'Round totals');
  assert.deepEqual(states(p), { claimed: 'done', worker: 'running', evaluator: 'waiting', pr: 'waiting', checks: 'waiting', merge: 'waiting' });
  assert.equal(stage(p, 'worker').estimate!.basis, 'guess', 'a running stage keeps its estimate');
  l.add('run.finished', P.finished(7))('eval.verdict', P.verdict(7))('pr.opened', P.opened(7, 41))('pr.status', P.status(7, 41, false, ['pass', 'pending']));
  p = firstTaskProgress(l.events, { local: true })!;
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

test('#741 every hold reason the merge policy emits has plain words; an unknown one shows as its own text, never empty', () => {
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
  assert.deepEqual([...kinds].sort(), [...HOLD_KINDS].sort(), 'every kind in the table is one the policy emits');
  const unknown = holdWords('a reason added later: with its own text', { local: true });
  assert.deepEqual(unknown.kind, 'other');
  assert.equal(unknown.why, 'a reason added later: with its own text');
  assert.ok(holdWords('', { local: false }).why.length > 0, 'never an empty line');
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
  p = firstTaskProgress(l.events, { local: true })!;
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
  }
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
  assert.equal(stage(p, 'evaluator').detail, 'did not approve it (confidence low)');
  l.add('run.started', P.started(7, 2));
  p = firstTaskProgress(l.events, { local: true })!;
  assert.equal(stage(p, 'worker').state, 'running');
  assert.equal(stage(p, 'worker').detail, 'attempt 2 started; no finish recorded yet');
  assert.equal(stage(p, 'evaluator').state, 'waiting', "attempt 1's verdict isn't attempt 2's");
  l.add('run.finished', P.finished(7, 'failed'));
  assert.equal(stage(firstTaskProgress(l.events, { local: true })!, 'worker').state, 'failed');
  l.add('issue.blocked', { issue: 7, owner: 'example-owner', why: 'the worker could not finish\nsecond line' });
  p = firstTaskProgress(l.events, { local: true })!;
  assert.deepEqual(p.blocked && p.blocked.why, 'the worker could not finish');
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
