// Loop control (src/coordinator/loop-control.ts): the attempt cap from agents.yaml (default 8), a read-only
// reflection before each retry, a reassign after 3 identical failures in a row, and the per-issue budget (an incident
// at 85%, stopped at 100%).
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_INCIDENT } from '../src/config/live.js';
import { AgentsConfig } from '../src/config/schema.js';
import { budgetState, checksFingerprint, failureFingerprint, identicalStreak, TASK_BUDGET_INCIDENT } from '../src/coordinator/loop-control.js';
import type { StoredEvent } from '../src/events/types.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { commitAll, coordinator, easyIssue, fixture, git, readAll, skip, type Fixture } from './repro-state-graph/harness.js';

const agentsCfg = (o: object = {}) => AgentsConfig.parse({ daily_budget_usd: 10, roles: {}, ...o });

test('config: max_attempts defaults to 8, is validated, and budget takes minutes and tokens', () => {
  assert.equal(agentsCfg().max_attempts, 8);
  assert.equal(agentsCfg({ max_attempts: 5 }).max_attempts, 5);
  for (const bad of [0, -1, 2.5, 21, 'eight']) assert.equal(AgentsConfig.safeParse({ daily_budget_usd: 10, roles: {}, max_attempts: bad }).success, false, String(bad));
  assert.deepEqual(agentsCfg({ budget: { task_minutes: 90, task_tokens: 2_000_000 } }).budget, { task_minutes: 90, task_tokens: 2_000_000 });
  for (const bad of [{ task_minutes: 0 }, { task_tokens: -5 }, { task_usd: 3 }]) assert.equal(AgentsConfig.safeParse({ daily_budget_usd: 10, roles: {}, budget: bad }).success, false, JSON.stringify(bad));
});

const ev = (type: string, payload: object): StoredEvent => ({ id: 0, ts: '2026-10-13T00:00:00Z', type, actor: 'c', source: 'coordinator', payload } as unknown as StoredEvent);
const failedEv = (fingerprint: string) => ev('attempt.failed', { issue: 1, attempt: 1, kind: 'stuck', fingerprint });

test('fingerprints: the same failure reads the same whatever its numbers, paths and quotes; the streak counts the run at the end', () => {
  assert.equal(failureFingerprint('stuck', 'Bash `npm test` failed 5 times after 12s in /tmp/a/b'), failureFingerprint('stuck', 'Bash `npm run t` failed 7 times after 40s in /var/x/y'));
  assert.notEqual(failureFingerprint('stuck', 'Bash failed'), failureFingerprint('rejected', 'Bash failed'));
  assert.equal(checksFingerprint([{ check: 'test: a.js', tail: 'expected 1 got 2' }]), checksFingerprint([{ check: 'test: a.js', tail: 'expected 3 got 4' }]));
  assert.deepEqual(identicalStreak([failedEv('a'), failedEv('a'), failedEv('a')]), { fingerprint: 'a', count: 3 });
  assert.deepEqual(identicalStreak([failedEv('a'), failedEv('a'), failedEv('b')]), { fingerprint: 'b', count: 1 });
  assert.deepEqual(identicalStreak([failedEv('a'), failedEv('a'), ev('issue.blocked', { issue: 1 }), failedEv('a')]), { fingerprint: 'a', count: 1 }, 'a block resets it');
  assert.deepEqual(identicalStreak([failedEv('a'), failedEv('a'), failedEv('a'), ev('task.reassigned', { issue: 1 }), failedEv('a')]), { fingerprint: 'a', count: 1 }, 'a reassign starts the count again');
  assert.equal(budgetState({ tokens: 849, minutes: 0 }, { task_tokens: 1000 }).level, 'ok');
  assert.equal(budgetState({ tokens: 850, minutes: 0 }, { task_tokens: 1000 }).level, 'warn');
  assert.equal(budgetState({ tokens: 10, minutes: 30 }, { task_tokens: 1000, task_minutes: 30 }).level, 'over', 'either budget stops it');
  assert.equal(budgetState({ tokens: 1e9, minutes: 1e9 }, undefined).level, 'ok', 'no budget: no cap');
});

// ---- wired: a coordinator over a real git remote and scripted agents

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];

type Script = (req: RunRequest, k: number) => void;

/** Scripted agents where every worker attempt is stopped by the stuck guard, with `detail(k)` for attempt k. */
function stuckAgents(detail: (k: number) => string, o: { worker?: Script; reflection?: (req: RunRequest) => object; workerResult?: object } = {}) {
  let k = 0;
  return new FakeRunner((req) => {
    if (req.role === 'worker') {
      k++;
      o.worker?.(req, k);
      return { reason: 'stuck', detail: `stopped as stuck: ${detail(k)}`, ...o.workerResult };
    }
    if (req.role === 'reflection') return { structured: o.reflection?.(req) ?? { what_failed: 'It repeated a failing call.', what_to_change: 'Read the code first.' } };
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(req) } };
  });
}

async function runOnce(f: Fixture, runner: FakeRunner, deps: Parameters<typeof coordinator>[2] = {}) {
  const n = f.backlog.open(easyIssue('Add a note', 'NOTE.md'));
  const c = coordinator(f, runner, deps);
  await c.tick();
  await c.idle();
  return n;
}

const workerCalls = (r: FakeRunner) => r.calls.filter((c) => c.role === 'worker');
const blockedWhy = (f: Fixture) => (f.log.read(0, ['issue.blocked']).at(-1)?.payload as { why: string } | undefined)?.why ?? '';

test('the cap: agents.yaml max_attempts, 8 by default, when the coordinator is given none', { skip }, async () => {
  const f = fixture();
  assert.equal(f.cfg.agents.max_attempts, 8, 'the example config gets the default');
  const runner = stuckAgents((k) => `Bash ${WORDS[k]}`);
  await runOnce(f, runner);
  assert.equal(workerCalls(runner).length, 8, 'eight different failures: eight attempts');
  assert.match(blockedWhy(f), /no passing change after 8 attempts/);

  const g = fixture();
  g.cfg.agents.max_attempts = 4;
  const r2 = stuckAgents((k) => `Bash ${WORDS[k]}`);
  await runOnce(g, r2);
  assert.equal(workerCalls(r2).length, 4);
  assert.match(blockedWhy(g), /no passing change after 4 attempts/);
});

test('reflection: a read-only run on the cheap tier before retry 2 (not before attempt 1), and its text reaches the attempt', { skip }, async () => {
  const f = fixture();
  f.cfg.agents.max_attempts = 2;
  const runner = stuckAgents((k) => `Bash ${WORDS[k]}`, { reflection: () => ({ what_failed: 'It ran the whole suite over and over.', what_to_change: 'Run only test/price.test.js, then read src/price.js.' }) });
  const n = await runOnce(f, runner);
  assert.deepEqual(runner.calls.map((c) => c.role).filter((r) => r === 'worker' || r === 'reflection'), ['worker', 'reflection', 'worker']);
  const reflection = runner.calls.find((c) => c.role === 'reflection')!;
  assert.equal(reflection.model, 'haiku', 'model routing: reflection on the cheap tier');
  for (const t of ['Edit', 'Write', 'Bash']) assert.ok(!reflection.allowedTools?.includes(t) && reflection.disallowedTools?.includes(t), `read-only: no ${t}`);
  assert.match(reflection.prompt, /Bash bravo/, 'it is told why the attempt failed');
  const second = workerCalls(runner)[1]!;
  assert.match(second.prompt, /What failed: It ran the whole suite over and over\./);
  assert.match(second.prompt, /What to change: Run only test\/price\.test\.js, then read src\/price\.js\./);
  assert.doesNotMatch(workerCalls(runner)[0]!.prompt, /What to change/);
  const costs = f.log.read(0, ['run.cost']).map((e) => e.payload as { issue: number; role: string });
  assert.ok(costs.some((c) => c.role === 'reflection' && c.issue === n), 'its cost is counted on the issue');
  assert.deepEqual(f.log.read(0, ['attempt.reflected']).map((e) => (e.payload as { attempt: number; ok: boolean }).ok), [true]);
});

test('3 identical failures in a row: reassigned to a fresh worktree on the escalated model; 3 more after that: blocked', { skip }, async () => {
  const f = fixture();
  f.cfg.agents.routing = { ...f.cfg.agents.routing, escalate_after: 5 };
  const seen: { k: number; leftover: boolean; head: string }[] = [];
  const runner = stuckAgents((k) => `Bash \`npm test\` failed after ${k * 7}s in /tmp/run-${k}/x`, {
    worker: (req, k) => {
      seen.push({ k, leftover: existsSync(join(req.cwd, 'WIP.md')), head: git(req.cwd, 'rev-parse', 'HEAD') });
      writeFileSync(join(req.cwd, 'WIP.md'), `attempt ${k}\n`);
      commitAll(req.cwd, `wip ${k}`);
    },
  });
  await runOnce(f, runner);
  const models = workerCalls(runner).map((c) => c.model);
  assert.equal(models.length, 6, 'three, the reassign, three more, then blocked');
  assert.deepEqual(models.slice(0, 3), ['sonnet', 'sonnet', 'sonnet']);
  assert.deepEqual(models.slice(3), ['opus', 'opus', 'opus'], 'escalated from the reassign on');
  const r = f.log.read(0, ['task.reassigned']);
  assert.equal(r.length, 1);
  assert.deepEqual((({ attempt, repeats, model }) => ({ attempt, repeats, model }))(r[0]!.payload as { attempt: number; repeats: number; model: string }), { attempt: 4, repeats: 3, model: 'opus' });
  assert.equal(seen[3]!.leftover, false, 'a fresh worktree: nothing earlier attempts left');
  assert.equal(seen[3]!.head, seen[0]!.head, 'back at the starting commit');
  assert.ok(seen[1]!.leftover, 'without a reassign the worktree carries on');
  assert.match(blockedWhy(f), /the same failure 3 times in a row, again after a reassign/);
});

test('2 identical failures and 1 different: no reassign, the attempts go on to the cap', { skip }, async () => {
  const f = fixture();
  f.cfg.agents.max_attempts = 5;
  const detail = ['', 'Bash same', 'Bash same', 'Bash other', 'Bash same', 'Bash same'];
  const runner = stuckAgents((k) => detail[k]!);
  await runOnce(f, runner);
  assert.equal(workerCalls(runner).length, 5);
  assert.equal(f.log.read(0, ['task.reassigned']).length, 0);
  assert.match(blockedWhy(f), /no passing change after 5 attempts/);
});

function sink() {
  const raised: { kind: string; key: string; detail: string }[] = [];
  const resolved: { kind: string; key: string }[] = [];
  return { raised, resolved, incidents: { raiseIncident: (kind: string, key: string, detail: string) => void raised.push({ kind, key, detail }), resolveIncident: (kind: string, key: string) => void resolved.push({ kind, key }) } };
}

test('budget: at 85% of the issue\'s tokens one incident is raised, however many checks follow; at 100% the task stops', { skip }, async () => {
  const f = fixture();
  f.cfg.agents.budget = { task_tokens: 1000 };
  const s = sink();
  // 300 tokens a worker run: 900 after three (90%: the incident), 1200 after four (stopped). Each failure differs.
  const runner = stuckAgents((k) => `Bash ${WORDS[k]}`, { workerResult: { tokens: { in: 250, out: 50 } } });
  const n = await runOnce(f, runner, { incidents: s.incidents });
  assert.equal(workerCalls(runner).length, 4, 'no attempt once the budget is spent');
  assert.equal(s.raised.length, 1, 'one incident');
  assert.equal(s.raised[0]!.kind, TASK_BUDGET_INCIDENT);
  assert.equal(s.raised[0]!.key, `alice#${n}`);
  assert.match(s.raised[0]!.detail, /900 of 1,000 tokens/);
  assert.deepEqual(f.log.read(0, ['task.budget']).map((e) => (e.payload as { level: string }).level), ['warn', 'over']);
  assert.match(blockedWhy(f), /stopped at its budget: 1,200 of 1,000 tokens \(budget\.task_tokens\), 120%/);
  // First the start-up resolve of a stale config_invalid (the default branch's config validated), then the budget's.
  assert.deepEqual(s.resolved, [{ kind: CONFIG_INCIDENT, key: 'alice' }, { kind: TASK_BUDGET_INCIDENT, key: `alice#${n}` }], 'resolved once the task has stopped');
});

test('budget: agent time counts each run (the coordinator times one claude reported no time for), and a run never outlasts what is left', { skip }, async () => {
  const f = fixture();
  f.cfg.agents.budget = { task_minutes: 10 };
  const s = sink();
  // 4 minutes a worker run: 8 after two (80%), 12 after three (stopped).
  const runner = stuckAgents((k) => `Bash ${WORDS[k]}`, { workerResult: { durationMs: 4 * 60_000 } });
  await runOnce(f, runner, { incidents: s.incidents });
  const calls = workerCalls(runner);
  assert.equal(calls.length, 3);
  assert.ok(calls[2]!.timeoutMs! <= 2 * 60_000 + 1000 && calls[2]!.timeoutMs! >= 60_000, `the third run gets what is left (${calls[2]!.timeoutMs} ms)`);
  assert.match(blockedWhy(f), /stopped at its budget: 12 of 10 minutes of agent time/);
  assert.equal(s.raised.length, 1, 'past 100% at once: still one incident');
});
