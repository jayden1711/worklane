import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { KEEP_RUNS, readRun, RunRecorder, runIssue, runsForIssue, RUNS_DIR } from '../src/run-record.js';
import { CliRunner, stderrTail } from '../src/runner.js';
import { exampleProject, STDIN_LINE } from './helpers.js';

const cwd = join(tmpdir(), 'wt', 'issue-7');
const assistant = (...content: object[]) => ({ type: 'assistant', message: { content } });
const results = (...content: object[]) => ({ type: 'user', message: { content } });
const token = `ghp_${'b'.repeat(36)}`;

/** A short session: a passing and a failing command, a write, a read, and a final word. */
const session = [
  assistant({ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `npm test # with ${token}` } }),
  results({ type: 'tool_result', tool_use_id: 't1', content: Array.from({ length: 10 }, (_, i) => `ok ${i}`).join('\n') }),
  assistant({ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: join(cwd, 'src', 'a.ts') } }, { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: join(cwd, 'src', 'a.ts') } }),
  results({ type: 'tool_result', tool_use_id: 't2', content: 'file text' }, { type: 'tool_result', tool_use_id: 't3', content: 'edited' }),
  assistant({ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'npm run lint' } }),
  results({ type: 'tool_result', tool_use_id: 't4', is_error: true, content: [{ type: 'text', text: 'Exit code 2\nlint: 1 problem' }] }),
  assistant({ type: 'text', text: 'Fixed the rounding.' }),
];

test('a run record lists commands (status, exit code, first lines), files written and the final message, redacted', () => {
  const state = mkdtempSync(join(tmpdir(), 'runs-'));
  const r = new RunRecorder(state, { role: 'worker', model: 'm', cwd });
  for (const l of session) r.line(l);
  r.line('not an object at all');
  const file = r.finish({ reason: 'succeeded', costUsd: 0.4, turns: 5, model: 'claude-x' })!;
  assert.ok(file.startsWith(join(state, RUNS_DIR)));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600, 'readable only by the coordinator user');
  const rec = readRun(state, r.id)!;
  assert.equal(rec.issue, 7, 'from the worktree name');
  assert.deepEqual(
    rec.steps.map((s) => [s.kind, s.what, s.status, s.exitCode]),
    [
      ['command', 'npm test # with gh*_[REDACTED]', 'ok', 0],
      ['write', join('src', 'a.ts'), 'ok', null],
      ['command', 'npm run lint', 'error', 2],
    ],
  );
  assert.equal(rec.steps[0]!.output.split('\n').length, 6, 'first lines only');
  assert.deepEqual(rec.files, [join('src', 'a.ts')], 'relative to the worktree');
  assert.equal(rec.otherTools, 1, 'the read is counted, not listed');
  assert.equal(rec.final, 'Fixed the rounding.');
  assert.equal(rec.reason, 'succeeded');
  assert.ok(!JSON.stringify(rec).includes(token));
});

test('run records stay bounded: steps are capped (and say so), old records are pruned, bad ids read nothing', () => {
  const state = mkdtempSync(join(tmpdir(), 'runs-'));
  const r = new RunRecorder(state, { role: 'worker', model: 'm', cwd });
  for (let i = 0; i < 450; i++) r.line(assistant({ type: 'tool_use', id: `c${i}`, name: 'Bash', input: { command: `echo ${i} ${'x'.repeat(1000)}` } }));
  r.finish({ reason: 'failed', costUsd: 0, turns: 1, model: 'm' });
  const rec = readRun(state, r.id)!;
  assert.equal(rec.steps.length, 400);
  assert.equal(rec.truncated, true);
  assert.ok(rec.steps[0]!.what.length < 420, 'a long command is clipped');
  assert.equal(rec.steps[0]!.status, 'no result');
  for (let i = 0; i < KEEP_RUNS + 3; i++) new RunRecorder(state, { role: 'evaluator', model: 'm', cwd }, new Date(Date.UTC(2030, 0, 1, 0, 0, i))).finish({ reason: 'succeeded', costUsd: 0, turns: 1, model: 'm' });
  assert.equal(readdirSync(join(state, RUNS_DIR)).filter((f) => f.endsWith('.json')).length, KEEP_RUNS);
  assert.equal(readRun(state, r.id), null, 'the oldest went first');
  assert.equal(readRun(state, '../../etc/passwd'), null);
  assert.equal(readRun(state, '..'), null);
});

test('the issue comes from the worktree, else the task file, on any platform\'s paths', () => {
  assert.equal(runIssue('/srv/x/.claude/worktrees/issue-12'), 12);
  assert.equal(runIssue('C:\\work\\worktrees\\issue-3\\'), 3);
  assert.equal(runIssue('/srv/x/checkout', '/state/tasks/issue-9.json'), 9);
  assert.equal(runIssue('/srv/x/checkout'), null);
});

test('the runner records each run into the coordinator\'s state dir from the session it streams', { skip: process.platform === 'win32' && 'POSIX shell stand-in' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const bin = join(dir, 'claude');
  const lines = [...session, { type: 'result', subtype: 'success', result: 'All done.', total_cost_usd: 0.25, num_turns: 4 }].map((l) => JSON.stringify(l));
  writeFileSync(bin, `#!/usr/bin/env node\nif (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }\n${STDIN_LINE};\nfor (const l of ${JSON.stringify(lines)}) console.log(l);\n`);
  chmodSync(bin, 0o755);
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const r = await new CliRunner('cli', process.env, bin).run({ role: 'worker', prompt: 'p', model: 'm', cwd: dir, allowedTools: [], maxTurns: 5, maxBudgetUsd: 1, stallMs: 60_000, timeoutMs: 60_000, stateDir: state, issue: 21 });
  assert.equal(r.reason, 'succeeded', r.detail);
  const runs = runsForIssue(state, 21);
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0]!.role, runs[0]!.reason, runs[0]!.costUsd, runs[0]!.commands, runs[0]!.failedCommands], ['worker', 'succeeded', 0.25, 2, 1]);
  assert.equal(readRun(state, runs[0]!.id)!.final, 'All done.', 'the session\'s result is its final message');
  assert.deepEqual(runsForIssue(state, 22), []);
});

test('the dashboard serves an issue\'s runs and one run in full, with the token, from its own state dir', async () => {
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const r = new RunRecorder(state, { role: 'worker', model: 'm', cwd });
  for (const l of session) r.line(l);
  r.finish({ reason: 'succeeded', costUsd: 0.1, turns: 3, model: 'm' });
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(state, 'events.db'), stateDir: state, user: 'example-owner' });
  try {
    const base = d.url.split('/?')[0]!;
    const h = { authorization: `Bearer ${d.token}` };
    assert.equal((await fetch(`${base}/api/runs?issue=7`)).status, 401);
    const list = (await (await fetch(`${base}/api/runs?issue=7`, { headers: h })).json()) as { id: string; commands: number; steps?: unknown }[];
    assert.equal(list.length, 1);
    assert.equal(list[0]!.commands, 2);
    assert.equal(list[0]!.steps, undefined, 'the list leaves the steps out');
    const full = (await (await fetch(`${base}/api/runs/${list[0]!.id}`, { headers: h })).json()) as { steps: unknown[]; final: string };
    assert.equal(full.steps.length, 3);
    assert.equal(full.final, 'Fixed the rounding.');
    assert.equal((await fetch(`${base}/api/runs/..%2f..%2fevents`, { headers: h })).status, 404);
    assert.equal((await fetch(`${base}/api/runs?issue=nope`, { headers: h })).status, 400);
  } finally {
    await d.close();
  }
});

test('an error result with no text of its own reports the end of claude\'s stderr', { skip: process.platform === 'win32' && 'POSIX shell stand-in' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-stub-'));
  const bin = join(dir, 'claude');
  const result = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', num_turns: 0, total_cost_usd: 0 });
  writeFileSync(bin, `#!/usr/bin/env node\nif (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }\n${STDIN_LINE};\nconsole.error('starting');\nconsole.error('Error: sandbox required but unavailable');\nconsole.log(${JSON.stringify(result)});\nprocess.exit(1);\n`);
  chmodSync(bin, 0o755);
  const r = await new CliRunner('cli', { PATH: process.env.PATH ?? '' }, bin).run({ role: 'worker', prompt: 'p', cwd: dir, model: 'm', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000 });
  assert.equal(r.reason, 'failed');
  assert.match(r.detail, /^error_during_execution: starting\nError: sandbox required but unavailable$/);
});

test('stderrTail keeps the last non-empty lines, CRLF or LF', () => {
  assert.equal(stderrTail('a\r\nb\r\n\r\nc\r\n', 2), 'b\nc');
  assert.equal(stderrTail(''), '(nothing on stderr)');
});
