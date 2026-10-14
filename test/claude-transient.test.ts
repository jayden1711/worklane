import { STDIN_LINE } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliRunner, TRANSIENT_BUDGET_MS, withLoginLock, type RunRequest } from '../src/runner.js';

const posixOnly = process.platform === 'win32' && 'POSIX shell stand-in';
const REFRESH = 'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute';

/**
 * A stand-in claude in its own directory. `plan` lists, per run, what it does: 'refresh' (error result with the
 * token-refresh message), 'bad-flag' (error result, not transient), 'ok' (success). Runs past the plan repeat its
 * last entry. `authPlan` does the same for `claude auth status`: 'ok' or 'refresh'. Every call is logged.
 */
function standIn(plan: string[], authPlan: string[] = ['ok'], holdMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-stub-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const dir = ${JSON.stringify(dir)};
const log = (l) => fs.appendFileSync(path.join(dir, 'calls.log'), l + '\\n');
const next = (name, plan) => { const f = path.join(dir, name); const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0; fs.writeFileSync(f, String(n + 1)); return plan[Math.min(n, plan.length - 1)]; };
if (process.argv[2] === 'auth') {
  const a = next('auth.n', ${JSON.stringify(authPlan)});
  log('auth ' + a);
  if (a === 'refresh') { console.error(${JSON.stringify(REFRESH)}); process.exit(1); }
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
  process.exit(0);
}
${STDIN_LINE};
const what = next('run.n', ${JSON.stringify(plan)});
log('start ' + Date.now());
const end = Date.now() + ${holdMs};
while (Date.now() < end) {}
log('end ' + Date.now());
const result = (subtype, text, err) => console.log(JSON.stringify({ type: 'result', subtype, is_error: err, result: text, num_turns: 0, total_cost_usd: 0 }));
if (what === 'refresh') { result('error_during_execution', ${JSON.stringify(REFRESH)}, true); process.exit(1); }
if (what === 'bad-flag') { result('error_during_execution', 'error: unknown option --frobnicate', true); process.exit(1); }
result('success', 'done', false);
`,
  );
  chmodSync(bin, 0o755);
  const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');
  return { dir, bin, calls };
}

/** A clock that only moves when the runner waits: the waits are recorded instead of slept. */
function fakeTime() {
  let t = 0;
  const waits: number[] = [];
  return { waits, now: () => t, sleep: async (ms: number) => ((t += ms), waits.push(ms), true) };
}

const req = (cwd: string): RunRequest => ({ role: 'worker', prompt: 'p', cwd, model: 'm', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000 });
const runner = (bin: string, configDir: string, time = fakeTime()) => ({ time, r: new CliRunner('cli', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: configDir }, bin, undefined, undefined, undefined, { now: time.now, sleep: time.sleep }) });

test('a token-refresh failure at startup is waited out (1 min, then 2 min) and retried, without failing the run', { skip: posixOnly }, async () => {
  const s = standIn(['refresh', 'refresh', 'ok']);
  const { time, r } = runner(s.bin, join(s.dir, 'login'));
  const out = await r.run(req(s.dir));
  assert.equal(out.reason, 'succeeded');
  assert.equal(out.transient, undefined);
  assert.deepEqual(time.waits, [60_000, 120_000]);
});

test('a refresh that keeps failing is retried for about 30 minutes, then reported as transient with claude\'s text', { skip: posixOnly }, async () => {
  const s = standIn(['refresh']);
  const { time, r } = runner(s.bin, join(s.dir, 'login'));
  const out = await r.run(req(s.dir));
  assert.equal(out.reason, 'failed');
  assert.equal(out.transient, true);
  assert.match(out.detail, /Failed to refresh OAuth token/);
  assert.match(out.detail, /still failing after \d+ tries/);
  assert.deepEqual(time.waits.slice(0, 3), [60_000, 120_000, 300_000]);
  assert.ok(time.waits.reduce((a, b) => a + b, 0) <= TRANSIENT_BUDGET_MS);
});

test('a startup failure that is not transient is returned at once, not retried', { skip: posixOnly }, async () => {
  const s = standIn(['bad-flag']);
  const { time, r } = runner(s.bin, join(s.dir, 'login'));
  const out = await r.run(req(s.dir));
  assert.equal(out.reason, 'failed');
  assert.equal(out.transient, undefined);
  assert.deepEqual(time.waits, []);
  assert.match(out.detail, /unknown option/);
});

test('preflight: an auth status that fails on a token refresh is waited out before claude starts', { skip: posixOnly }, async () => {
  const s = standIn(['ok'], ['refresh', 'ok']);
  const { time, r } = runner(s.bin, join(s.dir, 'login'));
  const out = await r.run(req(s.dir));
  assert.equal(out.reason, 'succeeded');
  assert.deepEqual(time.waits, [60_000]);
  // claude itself started once, after the refresh cleared, never alongside the failing status.
  assert.deepEqual(s.calls().map((c) => c.split(' ')[0]), ['auth', 'auth', 'start', 'end']);
});

test('two runs on one Claude login never overlap; the second starts after the first ends', { skip: posixOnly }, async () => {
  const s = standIn(['ok'], ['ok'], 300);
  const login = join(s.dir, 'login');
  const a = runner(s.bin, login).r;
  const b = runner(s.bin, login).r;
  const [x, y] = await Promise.all([a.run(req(s.dir)), b.run(req(s.dir))]);
  assert.equal(x.reason, 'succeeded');
  assert.equal(y.reason, 'succeeded');
  assert.deepEqual(s.calls().filter((c) => !c.startsWith('auth')).map((c) => c.split(' ')[0]), ['start', 'end', 'start', 'end']);
});

test('the login lock serializes one key and leaves other keys free', async () => {
  const order: string[] = [];
  let releaseA!: () => void;
  const gateA = new Promise<void>((r) => (releaseA = r));
  const a = withLoginLock('/home/user/.claude', async () => {
    order.push('a start');
    await gateA;
    order.push('a end');
  });
  const b = withLoginLock('/home/user/.claude', async () => {
    order.push('b start');
  });
  const c = withLoginLock('/home/example/.claude', async () => {
    order.push('c start');
  });
  await c;
  assert.deepEqual(order, ['a start', 'c start'], 'another login runs while the first is held; the same login waits');
  releaseA();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a start', 'c start', 'a end', 'b start']);
  // A failing holder still releases the lock.
  await assert.rejects(withLoginLock('/home/user/.claude', async () => Promise.reject(new Error('boom'))));
  assert.equal(await withLoginLock('/home/user/.claude', async () => 'next'), 'next');
});
