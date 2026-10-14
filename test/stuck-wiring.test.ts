// The stuck-run guard wired in: the runner stops a stuck run only in mode on, the run record keeps the streak,
// the coordinator watches the worker and evaluators in the instance's mode (dry-run by default) and records each
// verdict, and a stuck stop is a failed attempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventSchemas, type EventPayload, type StoredEvent } from '../src/events/types.js';
import { classifyRuns } from '../src/failure-modes.js';
import { InstanceSettings } from '../src/instance.js';
import { readRun, runsForIssue } from '../src/run-record.js';
import { CliRunner, FakeRunner, type RunRequest } from '../src/runner.js';
import { currentValue, SETTING_KEYS, stuckMode } from '../src/settings.js';
import type { StuckVerdict } from '../src/stuck.js';
import { STUCK_ROLES, stuckOption } from '../src/coordinator/stuck-guard.js';
import { BUG, coordinator, fixture, readAll, realFix, skip, writeRepro } from './repro-state-graph/harness.js';

const posixOnly = process.platform === 'win32' && 'POSIX stand-in for claude';

/** A stand-in claude that makes the same failing Bash call `n` times, then ends with a result. */
function repeater(n: number) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-stuck-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.once('data', async () => {
  for (let i = 0; i < ${n}; i++) {
    say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' + i, name: 'Bash', input: { command: 'npm test' } }] } });
    say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' + i, is_error: true, content: 'Error: exit code 1' }] } });
    await new Promise((r) => setTimeout(r, 30));
  }
  say({ type: 'result', subtype: 'success', is_error: false, result: 'gave up', num_turns: ${n}, total_cost_usd: 0.01 });
  process.exit(0);
});
`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin };
}

const req = (cwd: string, stateDir: string, over: Partial<RunRequest> = {}): RunRequest => ({ role: 'worker', prompt: 'Fix it.', cwd, stateDir, issue: 7, model: 'm', allowedTools: [], maxTurns: 50, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, ...over });
const runner = (bin: string, dir: string) => new CliRunner('cli', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: join(dir, 'cfg') }, bin);

test('mode on: the runner stops the run at the 8th identical failure, reason stuck; the record shows the streak', { skip: posixOnly }, async () => {
  const s = repeater(20);
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const seen: [string, string, number][] = [];
  const r = await runner(s.bin, s.dir).run(req(s.dir, state, { stuck: { mode: 'on', onVerdict: (v, a) => seen.push([v.kind, a, v.failures]) } }));
  assert.equal(r.reason, 'stuck');
  assert.match(r.detail, /stopped as stuck: the same Bash call failed 8 times in a row/);
  assert.equal(r.stuck?.failures, 8);
  assert.deepEqual(seen, [['flag', 'log', 5], ['stop', 'stop', 8]]);
  const rec = readRun(state, runsForIssue(state, 7)[0]!.id)!;
  assert.equal(rec.reason, 'stuck');
  assert.ok(rec.stuck && rec.stuck.failures >= 8 && rec.stuck.failures < 20, `the record shows the streak, cut short by the stop: ${JSON.stringify(rec.stuck)}`);
  assert.equal(rec.stuck.tool, 'Bash');
});

test('dry-run: the same run only logs and runs to its end; the record still shows the streak; off records nothing', { skip: posixOnly }, async () => {
  const s = repeater(10);
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const seen: [string, string][] = [];
  const r = await runner(s.bin, s.dir).run(req(s.dir, state, { stuck: { mode: 'dry-run', onVerdict: (v, a) => seen.push([v.kind, a]) } }));
  assert.equal(r.reason, 'succeeded');
  assert.equal(r.stuck, undefined);
  assert.deepEqual(seen, [['flag', 'log'], ['stop', 'log']]);
  assert.equal(readRun(state, runsForIssue(state, 7)[0]!.id)!.stuck?.failures, 10);
  const off = mkdtempSync(join(tmpdir(), 'state-'));
  const r2 = await runner(s.bin, s.dir).run(req(s.dir, off, { stuck: { mode: 'off' } }));
  assert.equal(r2.reason, 'succeeded');
  assert.equal(readRun(off, runsForIssue(off, 7)[0]!.id)!.stuck, undefined);
});

test('the instance setting: dry-run unless the policy says otherwise; only off, dry-run or on; listed with the settings', () => {
  assert.equal(stuckMode({}), 'dry-run');
  assert.equal(stuckMode({ stuck_guard: 'on' }), 'on');
  assert.equal(stuckMode({ stuck_guard: 'off' }), 'off');
  assert.equal(InstanceSettings.safeParse({ stuck_guard: 'sometimes' }).success, false);
  assert.ok((SETTING_KEYS as readonly string[]).includes('stuck_guard'));
  assert.equal(currentValue(fixture().cfg, { stuck_guard: 'on' }, 'stuck_guard'), 'on');
});

test('the guard watches the worker and evaluators only, in the given mode; off, or a caller-set guard, adds nothing', () => {
  const r = (role: string, over: Partial<RunRequest> = {}) => ({ role, prompt: '', cwd: '.', model: 'm', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 1, timeoutMs: 1, ...over }) as RunRequest;
  const who = { issue: 3, role: 'worker' };
  const events: EventPayload<'run.stuck'>[] = [];
  const opt = stuckOption(r('worker'), 'dry-run', who, () => 'run-1', (p) => events.push(p));
  assert.equal(opt.stuck?.mode, 'dry-run');
  const v: StuckVerdict = { kind: 'flag', tool: 'Bash', input: '{"command":"npm test"}', repeats: 5, failures: 5 };
  opt.stuck!.onVerdict!(v, 'log');
  assert.deepEqual(events, [{ issue: 3, role: 'worker', run: 'run-1', kind: 'flag', mode: 'dry-run', action: 'log', tool: 'Bash', input: '{"command":"npm test"}', repeats: 5, failures: 5 }]);
  assert.ok(EventSchemas['run.stuck'].safeParse(events[0]).success, 'a valid run.stuck event');
  for (const role of ['evaluator-verdict', 'evaluator-repro']) assert.ok(stuckOption(r(role), 'on', who, () => null, () => {}).stuck, role);
  for (const role of ['investigator', 'planner', 'researcher', 'chat', 'ci-fix']) assert.deepEqual(stuckOption(r(role), 'on', who, () => null, () => {}), {}, role);
  assert.deepEqual(stuckOption(r('worker'), 'off', who, () => null, () => {}), {});
  assert.deepEqual(stuckOption(r('worker', { stuck: { mode: 'on' } }), 'dry-run', who, () => null, () => {}), {}, "the caller's own guard is kept");
  assert.deepEqual([...STUCK_ROLES].sort(), ['evaluator-repro', 'evaluator-verdict', 'worker']);
});

test('the coordinator runs the worker under the guard in dry-run by default and records each verdict as run.stuck', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count non-positive quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const modes: Record<string, string | undefined> = {};
  const runnerFake = new FakeRunner((r) => {
    modes[r.role] = r.stuck?.mode;
    if (r.role === 'evaluator-repro') return { structured: writeRepro(r) };
    if (r.role === 'worker') {
      r.stuck?.onVerdict?.({ kind: 'flag', tool: 'Bash', input: 'npm test', repeats: 5, failures: 5 }, 'log');
      return { structured: realFix(r) };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(r) } };
  });
  const c = coordinator(f, runnerFake);
  await c.tick();
  await c.idle();
  assert.deepEqual([modes.worker, modes['evaluator-repro'], modes['evaluator-verdict']], ['dry-run', 'dry-run', 'dry-run']);
  const ev = f.log.read(0, ['run.stuck']).map((e) => e.payload as EventPayload<'run.stuck'>);
  assert.deepEqual(ev.map((e) => [e.role, e.kind, e.mode, e.action]), [['worker', 'flag', 'dry-run', 'log']]);
  assert.equal(f.log.read(0, ['land.queued']).length, 1, 'a flag in dry-run changes nothing');
});

test('a stuck stop is a failed attempt: even with a passing change committed, the next attempt runs, told why', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count non-positive quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const workers: RunRequest[] = [];
  const runnerFake = new FakeRunner((r) => {
    if (r.role === 'evaluator-repro') return { structured: writeRepro(r) };
    if (r.role === 'worker') {
      workers.push(r);
      // The first attempt commits the real fix, then is stopped as stuck; the second has nothing more to do.
      if (workers.length === 1) return { reason: 'stuck', detail: 'stopped as stuck: the same Bash call failed 8 times in a row: npm test', structured: realFix(r) };
      return { structured: { summary: 'the fix is already committed' } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(r) } };
  });
  const c = coordinator(f, runnerFake, { settings: () => ({ settings: { stuck_guard: 'on' }, error: null }) });
  await c.tick();
  await c.idle();
  assert.equal(workers.length, 2, 'the stuck attempt was not taken');
  assert.equal(workers[0]!.stuck?.mode, 'on', "the instance's mode reaches the run");
  assert.match(workers[1]!.prompt, /previous attempt was stopped because it kept repeating the same failing call \(the same Bash call failed 8 times/);
  const started = f.log.read(0, ['run.started']).filter((e) => (e.payload as { role: string }).role === 'worker').map((e) => (e.payload as { attempt: number }).attempt);
  assert.deepEqual(started, [1, 2], 'the stuck run counted as attempt 1');
  assert.equal(f.log.read(0, ['run.finished']).map((e) => e.payload as EventPayload<'run.finished'>).find((p) => p.role === 'worker')?.reason, 'stuck');
  assert.equal(f.log.read(0, ['land.queued']).length, 1);
});

test('the weekly failure modes count a stuck stop as its own outcome, never a startup failure', () => {
  const T0 = Date.parse('2026-10-05T12:00:00Z');
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();
  let id = 0;
  const ev = (s: number, type: string, payload: object): StoredEvent => ({ id: ++id, ts: at(s), type: type as never, actor: 'c', source: 'coordinator', payload: payload as never });
  const runs = classifyRuns(
    [
      ev(0, 'run.started', { issue: 4, role: 'worker', model: 'm', worktree: '/w/issue-4', pid: 1, pgid: 1, attempt: 1 }),
      ev(20, 'run.finished', { issue: 4, role: 'worker', reason: 'stuck', detail: 'stopped as stuck: the same Bash call failed 8 times in a row: npm test' }),
    ],
    new Date(T0 - 86_400_000),
    new Date(T0 + 86_400_000),
  );
  assert.deepEqual(runs.map((r) => r.outcome), ['stuck']);
});
