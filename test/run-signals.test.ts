import { STDIN_LINE } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTransient, CliRunner, type RunRequest, type TransientRetry } from '../src/runner.js';

const posixOnly = process.platform === 'win32' && 'POSIX shell stand-in';

/** A stand-in claude: per run, `plan` says what it answers ('refresh': the token-refresh error; 'ok'); it holds `holdMs`. */
function standIn(plan: string[], holdMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-stub-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const dir = ${JSON.stringify(dir)};
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
${STDIN_LINE};
const f = path.join(dir, 'n'); const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0; fs.writeFileSync(f, String(n + 1));
const what = ${JSON.stringify(plan)}[Math.min(n, ${plan.length - 1})];
const end = Date.now() + ${holdMs}; while (Date.now() < end) {}
const result = (subtype, text, err) => console.log(JSON.stringify({ type: 'result', subtype, is_error: err, result: text, num_turns: 0, total_cost_usd: 0 }));
if (what === 'refresh') { result('error_during_execution', 'Failed to refresh OAuth token: another Claude Code process is refreshing it', true); process.exit(1); }
result('success', 'done', false);
`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin };
}

const req = (cwd: string, over: Partial<RunRequest> = {}): RunRequest => ({ role: 'worker', prompt: 'p', cwd, model: 'm', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, ...over });

test('transient causes are classified for the record', () => {
  const cases: [string, string, string][] = [
    ['failed', 'Failed to refresh OAuth token: another Claude Code process is refreshing it', 'token_refresh'],
    ['rate_limited', 'usage or rate limit reached', 'rate_limit'],
    ['failed', 'API Error: 429 Too Many Requests', 'rate_limit'],
    ['failed', 'API Error: 529 {"type":"overloaded_error"}', 'overloaded'],
    ['failed', 'API Error: 503 Service Unavailable', 'server_error'],
    ['failed', 'request failed: ECONNRESET', 'network'],
    ['failed', 'fetch failed', 'network'],
    ['failed', 'something else', 'other'],
  ];
  for (const [reason, detail, want] of cases) assert.equal(classifyTransient(reason, detail), want, detail);
});

test('each transient retry is reported: the try that failed, its cause and the wait', { skip: posixOnly }, async () => {
  const s = standIn(['refresh', 'refresh', 'ok']);
  let t = 0;
  const r = new CliRunner('cli', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: join(s.dir, 'cfg') }, s.bin, undefined, undefined, undefined, { now: () => t, sleep: async (ms) => ((t += ms), true) });
  const retries: TransientRetry[] = [];
  const out = await r.run(req(s.dir, { onTransientRetry: (x) => retries.push(x) }));
  assert.equal(out.reason, 'succeeded');
  assert.deepEqual(retries.map((x) => [x.attempt, x.cause, x.waitMs]), [[1, 'token_refresh', 60_000], [2, 'token_refresh', 120_000]]);
  assert.match(retries[0]!.detail, /refresh OAuth token/);
});

test('a run that waits for its Claude login reports how long; the first one in barely waits', { skip: posixOnly }, async () => {
  const s = standIn(['ok'], 400);
  const r = new CliRunner('cli', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: join(s.dir, 'cfg') }, s.bin);
  const waits: number[] = [];
  await Promise.all([r.run(req(s.dir, { onLockWait: (ms) => waits.push(ms) })), r.run(req(s.dir, { onLockWait: (ms) => waits.push(ms) }))]);
  waits.sort((a, b) => a - b);
  assert.equal(waits.length, 2);
  assert.ok(waits[0]! < 300, `first: ${waits[0]}`);
  assert.ok(waits[1]! >= 300, `second waited for the first run on the same login: ${waits[1]}`);
});
