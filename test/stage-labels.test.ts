import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageLabelsMarkdown } from '../src/failure-modes.js';
import type { AgentRunner, RunRequest, RunResult } from '../src/runner.js';
import { codeStage, JUDGE_STAGES, labelFailedRun, labelFailedRuns, type FailedRun } from '../src/stage-label.js';

const run = (id: string, more: Partial<FailedRun> = {}): FailedRun => ({ run: id, issue: 7, role: 'worker', ended: 'checks failed', why: 'x', events: ['run.started', 'run.finished'], doneWhen: [], commands: [], steps: 'Bash npm test: error', final: 'done', ...more });

/** A judge that answers from a table keyed by run id, and records each request. */
function judge(answers: Record<string, unknown>, extra: Partial<RunResult> = {}) {
  const calls: RunRequest[] = [];
  const runner: AgentRunner = {
    async run(req) {
      calls.push(req);
      const id = /Run (\S+) \(/.exec(req.prompt)![1]!;
      return { reason: 'succeeded', detail: '', structured: answers[id], costUsd: 0.02, turns: 1, model: req.model, ...extra };
    },
  };
  return { runner, calls };
}
const always = { cwd: '/tmp', allowed: () => true };

test('one judge call per failed run: no tools, only the judge labels in the schema and prompt, a sonnet default', async () => {
  const { runner, calls } = judge({ r1: { stage: 'wrong or incomplete change', reason: 'fixed one caller of two' } });
  const l = await labelFailedRun(run('r1', { why: 'tests failed' }), { runner, ...always });
  assert.deepEqual(l, { run: 'r1', stage: 'wrong or incomplete change', reason: 'fixed one caller of two', by: 'judge', costUsd: 0.02 });
  assert.equal(calls.length, 1);
  const req = calls[0]!;
  assert.equal(req.model, 'sonnet');
  assert.deepEqual(req.allowedTools, []);
  assert.ok(req.disallowedTools!.includes('Bash') && req.disallowedTools!.includes('WebFetch') && req.disallowedTools!.includes('Read'));
  assert.deepEqual((req.jsonSchema as { properties: { stage: { enum: string[] } } }).properties.stage.enum, [...JUDGE_STAGES]);
  assert.doesNotMatch(req.prompt, /- environment\/harness:/, 'the code-only label is never offered');
  assert.match(req.prompt, /- verification: it ran the checks but misread or ignored/);
  assert.match(req.prompt, /tests failed/);
  assert.match(req.prompt, /EARLIEST/);
});

test('environment/harness is set in code for a startup-failure, transient-retry, stuck or console-stop event, with no judge call', async () => {
  const { runner, calls } = judge({});
  for (const e of ['run.startup_failed', 'run.transient_retry', 'run.stuck', 'console.run_stopped']) {
    const l = await labelFailedRun(run('r', { events: ['run.started', e, 'run.finished'], doneWhen: ['npm test'] }), { runner, ...always });
    assert.deepEqual([l?.stage, l?.by, l?.costUsd], ['environment/harness', 'code', 0], e);
  }
  const startup = await labelFailedRun(run('r', { ended: 'startup failure' }), { runner, ...always });
  assert.equal(startup?.stage, 'environment/harness');
  assert.equal(calls.length, 0);
});

test("verification is set in code when the run ran none of the done_when commands, with no judge call; even over the cap", async () => {
  const { runner, calls } = judge({});
  const l = await labelFailedRun(run('r', { doneWhen: ['npm run typecheck', 'node --test test/a.test.js'], commands: ['git status', 'npm run build'] }), { runner, cwd: '/tmp', allowed: () => false });
  assert.deepEqual([l?.stage, l?.by, l?.reason], ['verification', 'code', "the run didn't run any of the issue's done_when commands"]);
  assert.equal(calls.length, 0);
});

test("the judge's answer can't remove the code label: a judge that would say otherwise is never asked", async () => {
  const { runner, calls } = judge({ r: { stage: 'wrong files', reason: 'the judge would say this' } });
  const ranNothing = run('r', { doneWhen: ['npm test'], commands: ['npm run build'] });
  const l = await labelFailedRun(ranNothing, { runner, ...always });
  assert.deepEqual([l?.stage, l?.by], ['verification', 'code']);
  const [batch] = await labelFailedRuns([ranNothing], { runner, ...always });
  assert.deepEqual([batch?.stage, batch?.by], ['verification', 'code']);
  assert.equal(calls.length, 0);
});

test('a run that ran its checks can still get verification from the judge (misread or ignored the results)', async () => {
  const { runner, calls } = judge({ r: { stage: 'verification', reason: 'npm test failed and the final message says it passed' } });
  const l = await labelFailedRun(run('r', { doneWhen: ['npm test'], commands: ['npm test'] }), { runner, ...always });
  assert.deepEqual([l?.stage, l?.by], ['verification', 'judge']);
  assert.equal(calls.length, 1);
});

test('a run that ran a done_when command (any line, spacing aside), or an issue without done_when commands, goes to the judge', () => {
  assert.equal(codeStage(run('r', { doneWhen: ['npm run build\nnpm  run typecheck'], commands: ['cd app && npm run typecheck 2>&1 | tail'] })), null);
  assert.equal(codeStage(run('r', { doneWhen: [], commands: [] })), null);
});

test('an answer outside the judge labels (the code-only one included), or a failed judge run, is no label', async () => {
  for (const stage of ['bad luck', 'environment/harness']) {
    const { runner } = judge({ r1: { stage, reason: 'x' } });
    assert.equal(await labelFailedRun(run('r1'), { runner, ...always }), null, stage);
  }
  const failed = judge({ r1: { stage: 'wrong files', reason: 'x' } }, { reason: 'budget_exhausted' });
  assert.equal(await labelFailedRun(run('r1'), { runner: failed.runner, ...always }), null);
});

test('the cap stops further judge calls; each call reports its cost', async () => {
  const answers = Object.fromEntries(['a', 'b', 'c', 'd'].map((id) => [id, { stage: 'wrong files', reason: id }]));
  const { runner, calls } = judge(answers);
  let spent = 0;
  const cap = 0.05;
  const labels = await labelFailedRuns(['a', 'b', 'c', 'd'].map((id) => run(id)), { runner, cwd: '/tmp', allowed: () => spent + 0.02 <= cap, onCost: (u) => (spent += u) });
  assert.deepEqual(labels.map((l) => l.run), ['a', 'b']);
  assert.equal(calls.length, 2, 'no call once the cap is reached');
  assert.equal(await labelFailedRun(run('e'), { runner, cwd: '/tmp', allowed: () => false }), null);
  assert.equal(calls.length, 2);
});

test('fixture runs labelled, then grouped in the weekly report by stage with per-instance counts and examples', async () => {
  const { runner, calls } = judge({
    a: { stage: 'wrong files', reason: 'edited the client when the bug is in the server' },
    c: { stage: 'wrong files', reason: 'changed the docs only' },
  });
  const fixtures = [
    run('a', { doneWhen: ['npm test'], commands: ['npm test'] }),
    run('b', { doneWhen: ['npm test'], commands: ['git diff'] }),
    run('c'),
    run('d', { events: ['run.transient_retry'] }),
  ];
  const labels = await labelFailedRuns(fixtures, { runner, ...always });
  assert.equal(calls.length, 2, 'only a and c needed the judge');
  const inst: Record<string, string> = { a: 'alpha', b: 'alpha', c: 'beta', d: 'beta' };
  const md = stageLabelsMarkdown(labels.map((l) => ({ ...l, instance: inst[l.run]! }))).join('\n');
  assert.match(md, /\(4 labelled\)/);
  assert.match(md, /- wrong files: 2 \(alpha 1, beta 1\)/);
  assert.match(md, /- verification: 1 \(alpha 1\)/);
  assert.match(md, /- environment\/harness: 1 \(beta 1\)/);
  assert.match(md, /\/runs\/a: edited the client/);
  assert.doesNotMatch(md, /right files, wrong place/, 'a stage with no runs is left out');
  assert.ok(md.indexOf('wrong files') < md.indexOf('verification'), 'stages in the fixed order');
  assert.deepEqual(stageLabelsMarkdown([]), ['**Where failed runs first went wrong, last 7 days** (0 labelled)', '- no failed runs labelled']);
});
