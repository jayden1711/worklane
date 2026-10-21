// The guard's deadline (src/hook-deadline.ts) and Claude Code's onFailure "block" on the guard's hook (Layer 2).
// WHY (#887 review): a guard hook that runs past its timeout is cancelled and the tool call goes ahead. The guard now
// refuses on its own when it hasn't decided in time, and every way the deciding process can end without a verdict is
// a refusal too: never an allow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { guardsFailClosed, runSettings, type HookEntry, type Settings } from '../src/agent-settings.js';
import { BRAND } from '../src/brand.js';
import { EVALUATE_ARG, GUARD_BUDGET_MS, OUTPUT_CAP, underDeadline, VERDICT_FD, type GuardAnswer } from '../src/hook-deadline.js';
import type { HookInput, HookOutput } from '../src/hook.js';
import { agentSettings, mergeSettings } from '../src/install.js';
import { runCorpus } from './hook-corpus.js';
import { repoRoot } from './helpers.js';

/** An evaluator that is node running `code` (CommonJS, as `node -e` runs it). */
const node = (code: string) => ({ file: process.execPath, args: ['-e', code] });
const verdict = (code: number) => `require('fs').writeSync(${VERDICT_FD}, '${code}\\n');`;
const denied = (a: GuardAnswer, why: RegExp, name = '') => {
  assert.equal(a.exitCode, 2, `${name}: exit code 2 blocks the call: ${a.stderr}`);
  const out = JSON.parse(a.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, why);
  assert.match(a.stderr, why);
  assert.ok(a.stderr.startsWith(`[${BRAND.cli}] `), a.stderr);
};

test('the budget is named, and leaves the hook two thirds of its timeout: 10 s of the PreToolUse hook\'s 30 s', () => {
  assert.equal(GUARD_BUDGET_MS, 10_000);
  for (const s of [agentSettings('/opt/e/dist/src/cli.js', [], [], []), mergeSettings({}, '/opt/e/dist/src/cli.js', [], [])]) {
    const h = s.hooks!.PreToolUse![0]!.hooks[0]!;
    assert.ok(h.timeout! * 1000 >= 3 * GUARD_BUDGET_MS, `the hook's timeout (${h.timeout} s) is at least three budgets`);
  }
  assert.equal(EVALUATE_ARG, '--evaluate');
});

test('a guard that decides in time is answered as it decided, its stdin passed on, its output byte for byte', async () => {
  const echo = `let s = ''; process.stdin.on('data', (c) => (s += c)); process.stdin.on('end', () => { process.stdout.write('out:' + s); process.stderr.write('é\\n'); ${verdict(0)} process.exit(0); });`;
  assert.deepEqual(await underDeadline(node(echo), '{"a":1}', 5_000), { stdout: 'out:{"a":1}', stderr: 'é\n', exitCode: 0 });
  assert.deepEqual(await underDeadline(node(echo), Readable.from(['{"b":', '2}']), 5_000), { stdout: 'out:{"b":2}', stderr: 'é\n', exitCode: 0 });
  // A refusal by exit code is the guard's own, passed on as written.
  assert.deepEqual(await underDeadline(node(`process.stderr.write('no\\n'); process.exit(2);`), '', 5_000), { stdout: '', stderr: 'no\n', exitCode: 2 });
  // A deny decision on stdout with exit 0, as the guard refuses most calls.
  const deny = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"x"}}';
  assert.deepEqual(await underDeadline(node(`process.stdout.write(${JSON.stringify(deny)}); ${verdict(0)} process.exit(0);`), '', 5_000), { stdout: deny, stderr: '', exitCode: 0 });
});

test('a guard stuck in synchronous code is refused at the deadline, and stopped', async () => {
  const t0 = performance.now();
  const a = await underDeadline(node('for (;;) {}'), '', 1_500);
  const ms = performance.now() - t0;
  denied(a, /did not decide within 1\.5 s; this tool call is refused/);
  assert.ok(ms >= 1_490 && ms < 4_000, `at the deadline (${Math.round(ms)} ms)`);
});

test('every way the guard can end without deciding is a refusal (exit 2 and deny), never an allow', async () => {
  const cases: [string, { file: string; args: string[] }, RegExp][] = [
    ['exit 0 without a verdict', node('process.exit(0)'), /ended without a verdict/],
    ['an event loop that drains without a verdict', node("process.stdout.write('')"), /ended without a verdict/],
    ['a verdict that says otherwise', node(`${verdict(2)} process.exit(0)`), /ended without a verdict/],
    ['a verdict of 0 with exit code 3', node(`${verdict(0)} process.exit(3)`), /ended with exit code 3/],
    ['a crash', node("throw new Error('boom')"), /ended with exit code 1: .*boom|ended with exit code 1/],
    ['the system-root refusal code', node('process.exit(78)'), /ended with exit code 78/],
    ['killed by a signal', node(`${verdict(0)} process.kill(process.pid, 'SIGKILL')`), /was killed \(SIGKILL\)/],
    ['a program that is not there', { file: join(repoRoot, 'no-such-guard'), args: [] }, /could not start/],
    ['stdout past the cap', node(`process.stdout.write('x'.repeat(${OUTPUT_CAP + 1}), () => { ${verdict(0)} process.exit(0); })`), /wrote more than/],
    ['stderr past the cap', node(`process.stderr.write('x'.repeat(${OUTPUT_CAP + 1}), () => { ${verdict(0)} process.exit(0); })`), /wrote more than/],
  ];
  for (const [name, evaluator, why] of cases) denied(await underDeadline(evaluator, '{}', 5_000), why, name);
});

test('a broken stdin is a refusal', async () => {
  const input = new Readable({ read() { this.destroy(new Error('gone')); } });
  denied(await underDeadline(node(`process.stdin.resume(); process.stdin.on('end', () => { ${verdict(0)} process.exit(0); });`), input, 5_000), /could not be read \(gone\)/);
});

// Layer 2: Claude Code's own setting. onFailure "block" counts a timeout, a failure to start, an exit code other than
// 0 or 2 and invalid output as exit code 2 (Claude Code 2.1.295 and later; the pin is 2.1.296, src/tool-install.ts).
test("the guard's PreToolUse hook says onFailure \"block\": in the agent settings install writes, a checkout's, and every run's --settings", () => {
  const pre = (s: Settings) => s.hooks!.PreToolUse!.flatMap((e) => e.hooks);
  for (const s of [agentSettings('/opt/e/dist/src/cli.js', [], [], []), mergeSettings({}, '/opt/e/dist/src/cli.js', [], [])]) {
    assert.deepEqual(pre(s).map((h) => h.onFailure), ['block']);
    // Only the guard: the other events' hooks are unchanged (a failing post-edit check never blocks the edit).
    for (const e of ['SessionStart', 'SessionEnd', 'PostToolUse']) assert.deepEqual(s.hooks![e]!.flatMap((x) => x.hooks).map((h) => h.onFailure), [undefined], e);
  }
  // Agent settings written before this (no onFailure, or "continue"): every run gets "block" anyway, the lane's hook too.
  const old: Settings = { disableAllHooks: false, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'ours', timeout: 30 }] }], SessionEnd: [{ hooks: [{ type: 'command', command: 'end' }] }] } };
  const lane = { hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'lane', onFailure: 'continue' }] }] } };
  const run = runSettings(old, lane, {});
  assert.deepEqual(run.hooks!.PreToolUse, [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'ours', timeout: 30, onFailure: 'block' }] },
    { matcher: '.*', hooks: [{ type: 'command', command: 'lane', onFailure: 'block' }] },
  ]);
  assert.deepEqual(run.hooks!.SessionEnd, [{ hooks: [{ type: 'command', command: 'end' }] }]);
  assert.deepEqual(old.hooks!.PreToolUse![0]!.hooks[0], { type: 'command', command: 'ours', timeout: 30 }, 'the instance settings object is not changed');
  // An entry without a hooks list is left as it is.
  assert.deepEqual(guardsFailClosed({ PreToolUse: [{ matcher: 'x' } as unknown as HookEntry] }), { PreToolUse: [{ matcher: 'x' }] });
});

test("the guard's process answers every corpus call exactly as recorded, through the deadline (p50 and p95 reported)", async (t) => {
  const want = JSON.parse(readFileSync(join(repoRoot, 'test', 'fixtures', 'hook-corpus.json'), 'utf8')) as Record<string, string>;
  const hookMain = join(repoRoot, 'dist', 'src', 'hook-main.js');
  const times: number[] = [];
  const viaProcess = (event: string, input: HookInput, env: NodeJS.ProcessEnv) =>
    new Promise<HookOutput>((resolve, reject) => {
      const t0 = performance.now();
      const child = spawn(process.execPath, [hookMain, event], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => {
        if (event === 'pre-tool-use') times.push(performance.now() - t0);
        resolve({ exitCode: code ?? -1, ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) });
      });
      child.stdin.end(JSON.stringify(input));
    });
  const got = await runCorpus(viaProcess);
  const changed = Object.keys(want).filter((k) => got[k] !== want[k]);
  assert.deepEqual(changed.map((k) => ({ case: k, was: want[k], now: got[k] })), [], `${changed.length} of ${Object.keys(want).length} answers changed`);
  times.sort((a, b) => a - b);
  const at = (q: number) => Math.round(times[Math.min(times.length - 1, Math.floor(q * times.length))]!);
  t.diagnostic(`${times.length} PreToolUse calls through the guard's process: p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${at(1)} ms`);
  assert.ok(at(0.95) < GUARD_BUDGET_MS / 5, `ordinary calls stay far inside the budget (p95 ${at(0.95)} ms)`);
});
