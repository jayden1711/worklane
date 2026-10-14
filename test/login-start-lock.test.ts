// The Claude login's two locks (src/runner.ts): an interactive run (a chat or thread reply) proceeds while an agent
// run holds the login's run lock, agent runs still go one at a time, and no two claude starts on one login (the auth
// check and claude's start, where a due token is refreshed) ever overlap. A stand-in claude through the real
// CliRunner.
import { STDIN_LINE } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { CHAT_ROLE } from '../src/intake/chat.js';
import { CliRunner, type RunRequest } from '../src/runner.js';

const posixOnly = process.platform === 'win32' && 'POSIX shell stand-in';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in claude: `auth status` and each run's start (until its first assistant line, where a real claude has
 * refreshed a due token) are logged as intervals; then it holds for its role's time and answers.
 */
function standIn(holdMs: Record<string, number>) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-stub-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const log = (l) => fs.appendFileSync(path.join(${JSON.stringify(dir)}, 'calls.log'), l + '\\n');
const busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };
const role = process.env[${JSON.stringify(`${BRAND.envPrefix}_ROLE`)}] || 'none';
if (process.argv[2] === 'auth') {
  log('auth-start ' + Date.now() + ' ' + process.pid); busy(40); log('auth-end ' + Date.now() + ' ' + process.pid);
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
  process.exit(0);
}
${STDIN_LINE};
log('refresh-start ' + Date.now() + ' ' + process.pid + ' ' + role); busy(120); log('refresh-end ' + Date.now() + ' ' + process.pid + ' ' + role);
console.log(JSON.stringify({ type: 'assistant', message: { content: [] } }));
setTimeout(() => {
  log('done ' + Date.now() + ' ' + role);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, structured_output: { reply: 'From the stand-in.' } }));
}, ${JSON.stringify(holdMs)}[role] ?? 0);
`,
  );
  chmodSync(bin, 0o755);
  const lines = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map((l) => l.split(' '));
  return { dir, bin, lines };
}

const runReq = (cwd: string, role: string, interactive = false): RunRequest => ({ role, prompt: 'p', cwd, model: 'm', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, ...(interactive ? { interactive: true } : {}) });

test('lock: a chat run proceeds while an agent run holds the login; agent runs still go one at a time', { skip: posixOnly }, async () => {
  const s = standIn({ worker: 1500, [CHAT_ROLE]: 0 });
  const r = new CliRunner('cli', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: join(s.dir, 'login') }, s.bin);
  const agent = r.run(runReq(s.dir, 'worker'));
  const agent2 = r.run(runReq(s.dir, 'worker'));
  await sleep(300);
  const t0 = Date.now();
  const chat = await r.run(runReq(s.dir, CHAT_ROLE, true));
  assert.equal(chat.reason, 'succeeded');
  assert.ok(Date.now() - t0 < 1000, `the chat run finished in ${Date.now() - t0} ms, before the agent run let go of the login`);
  await Promise.all([agent, agent2]);
  const done = s.lines().filter((l) => l[0] === 'done');
  assert.deepEqual(done.map((l) => l[2]), [CHAT_ROLE, 'worker', 'worker'], 'the chat run ended first');
  // The two agent runs never overlapped (the run lock, as before).
  const starts = s.lines().filter((l) => l[0] === 'refresh-start' && l[3] === 'worker').map((l) => Number(l[1]));
  const ends = done.filter((l) => l[2] === 'worker').map((l) => Number(l[1]));
  assert.ok(starts[1]! >= ends[0]!, 'the second agent run started after the first ended');
});

test('lock: no two claude starts on one login overlap (auth check and token refresh), chat or agent', { skip: posixOnly }, async () => {
  const s = standIn({ worker: 600, [CHAT_ROLE]: 200 });
  const r = new CliRunner('cli', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: join(s.dir, 'login') }, s.bin);
  // All at once: an agent run and three chat runs, the way three runs once hit one refresh 0.1 s apart.
  const all = await Promise.all([r.run(runReq(s.dir, 'worker')), r.run(runReq(s.dir, CHAT_ROLE, true)), r.run(runReq(s.dir, CHAT_ROLE, true)), r.run(runReq(s.dir, CHAT_ROLE, true))]);
  assert.ok(all.every((x) => x.reason === 'succeeded'));
  // Every auth check and every start's token refresh, as intervals by process: no two of them ever overlap.
  const L = s.lines();
  const windows = new Map<string, [number, number]>();
  for (const l of L) {
    const m = l[0]!.match(/^(auth|refresh)-(start|end)$/);
    if (!m) continue;
    const key = `${m[1]} ${l[2]}`;
    const w = windows.get(key) ?? [0, 0];
    w[m[2] === 'start' ? 0 : 1] = Number(l[1]);
    windows.set(key, w);
  }
  const ws = [...windows.values()].sort((a, b) => a[0] - b[0]);
  assert.equal(ws.length, 8, 'four auth checks, four refreshes');
  for (let i = 1; i < ws.length; i++) assert.ok(ws[i]![0] >= ws[i - 1]![1], `one began at ${ws[i]![0]}, before another ended at ${ws[i - 1]![1]}`);
  // And the chat runs didn't wait for the agent run to end: they ran while it was holding the login.
  const done = L.filter((l) => l[0] === 'done');
  assert.equal(done.at(-1)![2], 'worker', 'the agent run, started first, ended last');
});
