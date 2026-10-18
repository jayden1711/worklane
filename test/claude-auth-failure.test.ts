// Issue #463: a Claude login the API refuses (401/403) failed every run silently for a day and a half. The runner
// now ends such a run `auth_failed` with Claude's words (src/claude-auth-failure.ts); one such run holds the login
// (a red claude_auth incident, no new runs on it, the chat says why) until a call on it succeeds; a periodic tiny
// real check (and the owner's re-check) is the way out; and a failed run's record and run.finished keep its why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliRunner, FakeRunner, type RunRequest } from '../src/runner.js';
import { AUTH_CHECK, AUTH_FAILED_CHAT_TEXT, AUTH_RECHECK_MS, authHoldsOf, isAuthFailure } from '../src/claude-auth-failure.js';
import { requestAuthRecheck } from '../src/claude-auth-recheck.js';
import { readRun, RUNS_DIR } from '../src/run-record.js';
import { instanceFindings, type InstanceFacts } from '../src/watchdog/probes.js';
import { IntakeConfig, type IntakeSource } from '../src/intake/report.js';
import type { EventPayload, StoredEvent } from '../src/events/types.js';
import { coordinator, easyIssue, fixture, readAll, realFix, skip } from './repro-state-graph/harness.js';
import { STDIN_LINE } from './helpers.js';
import { askChat } from '../src/chat.js';
import * as holds from '../src/governor-holds.js';

// A namespace import: on an engine without #567 the hold's test fails on its assertion, not the file on the export.
const { SIGN_IN_HOLD_REASON } = holds;

const posixOnly = process.platform === 'win32' && 'POSIX shell stand-in';
const TOKEN = 'sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789';

/** A stand-in claude: auth status names the account; a run prints `lines` and `stderr`, then exits `code`. */
function standIn(o: { lines: object[]; stderr?: string; code?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-auth-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'agents@example.com' })); process.exit(0); }
${STDIN_LINE};
for (const l of ${JSON.stringify(o.lines)}) console.log(JSON.stringify(l));
${o.stderr ? `console.error(${JSON.stringify(o.stderr)});` : ''}
process.exit(${o.code ?? 1});
`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin };
}

const req = (cwd: string, stateDir?: string): RunRequest => ({ role: 'worker', prompt: 'p', cwd, model: 'm', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, ...(stateDir ? { stateDir } : {}) });

async function run(o: Parameters<typeof standIn>[0], stateDir?: string) {
  const s = standIn(o);
  let t = Date.now();
  const waits: number[] = [];
  const r = new CliRunner('cli', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: join(s.dir, 'login') }, s.bin, undefined, undefined, undefined, { now: () => t, sleep: async (ms) => ((t += ms), waits.push(ms), true) });
  return { out: await r.run(req(s.dir, stateDir)), waits, dir: s.dir };
}

// ---- 1. the runner: auth_failed is its own reason

test('runner: a 401 error result ends the run auth_failed (not failed), with Claude\'s words and the login as claude auth status names it; never retried, no token kept', { skip: posixOnly }, async () => {
  const { out, waits, dir } = await run({
    lines: [
      { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] } },
      { type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', num_turns: 1, total_cost_usd: 0 },
    ],
    stderr: `request had Authorization: Bearer ${TOKEN}`,
  });
  assert.equal(out.reason, 'auth_failed');
  assert.match(out.detail, /^claude's login was refused \(HTTP 401\): Failed to authenticate\. API Error: 401 .*authentication_error/);
  assert.doesNotMatch(out.detail, /sk-ant-oat01-A/, 'the token is redacted');
  assert.deepEqual(out.login, { key: join(dir, 'login'), account: 'agents@example.com' });
  assert.deepEqual(waits, [], 'not a transient error: no retry');
});

test('runner: a 401 only on stderr, with no result at all, is auth_failed too', { skip: posixOnly }, async () => {
  const { out } = await run({ lines: [], stderr: 'Error: API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}' });
  assert.equal(out.reason, 'auth_failed');
  assert.match(out.detail, /OAuth token has expired/);
  assert.equal(out.login?.account, 'agents@example.com');
});

test('runner: a 403 (the API refusing the token) is auth_failed', { skip: posixOnly }, async () => {
  const { out } = await run({ lines: [{ type: 'result', subtype: 'success', is_error: true, api_error_status: 403, result: 'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not supported."}}', num_turns: 0, total_cost_usd: 0 }] });
  assert.equal(out.reason, 'auth_failed');
  assert.match(out.detail, /HTTP 403/);
});

test('runner: a usage limit (429) stays rate_limited, and a plain failure that mentions issue #401 stays failed: neither is a refused login', { skip: posixOnly }, async () => {
  const limited = await run({ lines: [{ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: "You've hit your limit · resets 3pm", num_turns: 0, total_cost_usd: 0 }] });
  assert.equal(limited.out.reason, 'rate_limited');
  const plain = await run({ lines: [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'the tests for issue #401 failed: expected 403 got 200', num_turns: 3, total_cost_usd: 0.1 }] });
  assert.equal(plain.out.reason, 'failed');
  const success = await run({ lines: [{ type: 'result', subtype: 'success', result: 'Fixed the 401 handling (authentication_error now maps to a login prompt).', num_turns: 3, total_cost_usd: 0.1 }], code: 0 });
  assert.equal(success.out.reason, 'succeeded', 'a success that talks about auth is a success');
  // The words alone: a token refresh is transient (retried), never a refused login; a bare number is nothing.
  assert.equal(isAuthFailure({ text: 'Failed to refresh OAuth token: 401' }), false);
  assert.equal(isAuthFailure({ text: 'see issue #401 and line 403' }), false);
  assert.equal(isAuthFailure({ text: 'Invalid API key · Please run /login' }), true);
  assert.equal(isAuthFailure({ apiErrorStatus: 500, text: 'API Error: 500 overloaded' }), false);
});

// ---- 5. the why is kept

test("a failed run's record keeps its detail (Claude's error text, redacted, capped); a success's doesn't", { skip: posixOnly }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const { out } = await run({ lines: [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', num_turns: 0, total_cost_usd: 0 }], stderr: `Error: sandbox required but unavailable; env had GITHUB_TOKEN=ghp_${'a'.repeat(36)} and ${TOKEN}` }, state);
  assert.equal(out.reason, 'failed');
  const files = readdirSync(join(state, RUNS_DIR)).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const rec = readRun(state, files[0]!.slice(0, -5))!;
  assert.match(rec.detail ?? '', /sandbox required but unavailable/);
  assert.doesNotMatch(rec.detail ?? '', /ghp_a{36}|sk-ant-oat01-A/, 'redacted');
  const ok = mkdtempSync(join(tmpdir(), 'state-'));
  await run({ lines: [{ type: 'result', subtype: 'success', result: 'done', num_turns: 1, total_cost_usd: 0.01 }], code: 0 }, ok);
  const okRec = readdirSync(join(ok, RUNS_DIR)).filter((f) => f.endsWith('.json'));
  assert.equal(readRun(ok, okRec[0]!.slice(0, -5))!.detail, undefined);
});

test("a failed worker run's run.finished event carries its detail, redacted", { skip }, async () => {
  const f = fixture();
  f.backlog.open(easyIssue('Add a.js', 'a.js'));
  const runner = new FakeRunner((r: RunRequest) => (r.role === 'worker' ? { reason: 'failed', detail: `error_during_execution: claude exited 1: ${TOKEN}`, turns: 2 } : {}));
  const c = coordinator(f, runner);
  await c.tick();
  await c.idle();
  const fin = f.log.read(0, ['run.finished']).map((e) => e.payload as EventPayload<'run.finished'>).find((p) => p.role === 'worker')!;
  assert.match(fin.detail, /error_during_execution: claude exited 1: sk-\[REDACTED\]/);
  assert.doesNotMatch(fin.detail, /sk-ant-oat01-A/);
});

// ---- 2. the red incident

const ev = (id: number, type: string, payload: object, ts = '2026-10-15T06:00:00.000Z') => ({ id, ts, type, actor: 'c', source: 'coordinator', payload }) as unknown as StoredEvent;
const facts = (events: StoredEvent[], now = Date.parse('2026-10-16T12:00:00Z')): InstanceFacts => ({ instance: 'alice', events, now, stop: null, auth: { loggedIn: true }, githubTokenError: null, emergency: false });
const failed = (id: number, key = '/home/example/.claude') => ev(id, 'claude_auth.failed', { key, login: 'agents@example.com', lane: 'default', issue: 4, role: 'worker', detail: "claude's login was refused (HTTP 401): Invalid API key · Please run /login" });
const recovered = (id: number, key = '/home/example/.claude', holdId = 1) => ev(id, 'claude_auth.recovered', { key, login: 'agents@example.com', via: 'check', role: 'login-check', held_ms: 1, hold_id: holdId });
const red = (f: InstanceFacts) => instanceFindings(f).filter((x) => x.kind === 'claude_auth');

test("watchdog: one auth_failed run raises a red claude_auth naming the login and Claude's message (a day later still: not bound to the last hour); an unrelated success elsewhere doesn't resolve it; a success on that login does", () => {
  const one = red(facts([failed(1)]));
  assert.equal(one.length, 1);
  assert.equal(one[0]!.key, 'alice:refused');
  assert.equal(one[0]!.severity, undefined, "the kind's own severity: red");
  assert.match(one[0]!.detail, /agents@example\.com .*Invalid API key · Please run \/login/);
  // Another login's success, and an ordinary run.finished succeeded (another instance's or a lane's), resolve nothing.
  assert.equal(red(facts([failed(1), recovered(2, '/home/example/.claude-eval'), ev(3, 'run.finished', { issue: 5, role: 'worker', reason: 'succeeded', detail: '' })])).length, 1);
  // A call on that login succeeded: resolved.
  assert.equal(red(facts([failed(1), recovered(2)])).length, 0);
  // A plain failure never raises it.
  assert.equal(red(facts([ev(1, 'run.finished', { issue: 5, role: 'worker', reason: 'failed', detail: 'tests failed' })])).length, 0);
});

// ---- 3. the pause, the chat's words, the way out

const ASKS = '200000000001';
const DASH = 'https://dashboard.example.test';

function fakeChat() {
  const posts: { where: string; text: string }[] = [];
  const src: IntakeSource & { posts: typeof posts } = { name: 'discord', posts, take: async () => [], reply: async (t, text) => (posts.push({ where: t.id, text }), true), openThread: async () => '900000', watch: () => {} };
  return src;
}

test('a refused login holds the instance: the task requeued (no attempt), no new runs on it while held (dispatch says why once; the ops channel once), the incident raised; the periodic tiny check ends it and work runs again', { skip }, async (t) => {
  const f = fixture();
  const issue = f.backlog.open(easyIssue('Add a.js', 'a.js'));
  let refused = true;
  const runner = new FakeRunner((r: RunRequest) => {
    if (r.role === 'login-check' || r.role === 'worker') {
      if (refused) return { reason: 'auth_failed', detail: "claude's login was refused (HTTP 401): Invalid API key · Please run /login", turns: 0, costUsd: 0, login: { key: 'claude', account: 'agents@example.com' } };
      return r.role === 'worker' ? { structured: realFix(r) } : { costUsd: 0.02 };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: readAll(r) } };
  });
  const chat = fakeChat();
  const config = IntakeConfig.parse({ version: 1, discord: { enabled: true, guild: '555555', channels: ['111111'], allowed_senders: ['100000000001'], people: { '100000000001': 'example-owner' }, asks_channel: ASKS, dashboard_url: DASH } });
  const incidents: string[] = [];
  const c = coordinator(f, runner, { settings: () => ({ settings: {}, error: null }), intake: { config: () => config, sources: [chat], pullMs: 0 }, incidents: { raiseIncident: (kind, key, detail) => void incidents.push(`raise ${kind} ${key} ${detail}`), resolveIncident: (kind, key) => void incidents.push(`resolve ${kind} ${key}`) } });
  const runs = (role: string) => runner.calls.filter((r) => r.role === role).length;
  for (let i = 0; i < 5; i++) {
    await c.tick();
    await c.idle();
    await c.checkIntake();
  }
  assert.equal(runs('worker'), 1, 'one refused run, then none: nothing starts on a held login');
  assert.equal(runs('login-check'), 0, 'no check before AUTH_RECHECK_MS');
  const holds = authHoldsOf(f.log.read());
  assert.equal(holds.length, 1);
  assert.equal(holds[0]!.login, 'agents@example.com');
  // Requeued, not failed or blocked, and no attempt counted.
  assert.equal(f.log.read(0, ['issue.blocked']).length, 0);
  const labels = (await f.backlog.get(issue)).labels;
  assert.ok(labels.includes('ready') && !labels.includes('agent:working'), labels.join(', '));
  assert.ok((await f.backlog.comments(issue)).some((m) => /Claude sign-in failed on this machine .* requeued/.test(m.body)));
  const holdReasons = f.log.read(0, ['governor.hold']).map((e) => (e.payload as { reason: string }).reason).filter((r) => /Claude sign-in failed/.test(r));
  assert.equal(holdReasons.length, 1, 'the dashboard hold reason, once');
  // #567: the reason reaches every viewer's state and the report posted on the repo, so it names no account; the
  // owners and writers see the login on the sign-in banner and the incident.
  assert.doesNotMatch(holdReasons[0]!, /agents@example\.com/);
  assert.equal(holdReasons[0], SIGN_IN_HOLD_REASON);
  const notices = chat.posts.filter((p) => p.where === ASKS && /Claude sign-in failed/.test(p.text));
  assert.equal(notices.length, 1, 'one ops notice');
  assert.match(notices[0]!.text, /agents@example\.com.*Invalid API key/s);
  assert.equal(incidents.filter((x) => x.startsWith('raise claude_auth alice:refused')).length, 1, 'the red incident, raised once');
  // A check while it still fails: still held, and the next one waits AUTH_RECHECK_MS again.
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start + AUTH_RECHECK_MS + 1000 });
  await c.tick();
  await c.idle();
  assert.equal(runs('login-check'), 1);
  const check = runner.calls.find((r) => r.role === 'login-check')!;
  assert.equal(check.model, AUTH_CHECK.model);
  assert.equal(check.maxBudgetUsd, AUTH_CHECK.maxBudgetUsd, 'a hard budget cap');
  assert.equal(check.maxTurns, 1);
  assert.deepEqual(check.allowedTools, []);
  await c.tick();
  await c.idle();
  assert.equal(runs('login-check'), 1, 'not again before AUTH_RECHECK_MS');
  assert.equal(runs('worker'), 1);
  // The login works again: the next check ends the hold, the incident resolves, and work runs and lands.
  refused = false;
  t.mock.timers.setTime(start + 2 * AUTH_RECHECK_MS + 2000);
  try {
    for (let i = 0; i < 4; i++) {
      await c.tick();
      await c.idle();
      await c.checkIntake();
    }
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(authHoldsOf(f.log.read()).length, 0);
  const rec = f.log.read(0, ['claude_auth.recovered']).map((e) => e.payload as EventPayload<'claude_auth.recovered'>);
  assert.equal(rec.length, 1);
  assert.equal(rec[0]!.via, 'check');
  assert.ok(incidents.includes('resolve claude_auth alice:refused'));
  assert.ok(runs('worker') > 1, 'dispatch resumed');
  const attempts = f.log.read(0, ['run.started']).map((e) => e.payload as EventPayload<'run.started'>).filter((p) => p.role === 'worker' && p.issue === issue).map((p) => p.attempt);
  assert.deepEqual(attempts.slice(0, 2), [1, 1], 'the refused run was no attempt: the task starts again at attempt 1');
  assert.ok(f.log.read(0, ['land.result']).some((e) => (e.payload as { outcome: string }).outcome === 'landed'), 'and the work landed');
  assert.equal(chat.posts.filter((p) => p.where === ASKS && /Claude sign-in works again/.test(p.text)).length, 1, 'one ops notice that it works again');
});

test("the owner's re-check runs the check at once (one a minute at most), and a check that fails keeps the hold", { skip }, async () => {
  const f = fixture();
  f.backlog.open(easyIssue('Add a.js', 'a.js'));
  const runner = new FakeRunner((r: RunRequest) => (r.role === 'worker' || r.role === 'login-check' ? { reason: 'auth_failed', detail: "claude's login was refused (HTTP 401): Invalid API key", turns: 0, costUsd: 0 } : {}));
  const c = coordinator(f, runner);
  await c.tick();
  await c.idle();
  assert.equal(authHoldsOf(f.log.read()).length, 1);
  requestAuthRecheck(f.stateDir, 'example-owner');
  await c.tick();
  await c.idle();
  const checks = () => runner.calls.filter((r) => r.role === 'login-check').length;
  assert.equal(checks(), 1, "the owner's re-check: at once");
  requestAuthRecheck(f.stateDir, 'example-owner');
  await c.tick();
  assert.equal(checks(), 1, 'one a minute at most');
  const checked = f.log.read(0, ['claude_auth.checked']).map((e) => e.payload as EventPayload<'claude_auth.checked'>);
  assert.deepEqual(checked.map((x) => [x.by, x.ok]), [['owner', false]]);
  assert.equal(authHoldsOf(f.log.read()).length, 1, 'still held');
  assert.equal(runner.calls.filter((r) => r.role === 'worker').length, 1);
});

test('the dashboard chat answers with the sign-in text while the login is held, and starts no run', { skip }, async () => {
  const f = fixture();
  f.log.append('claude_auth.failed', { key: 'claude', login: 'agents@example.com', lane: 'default', issue: null, role: 'worker', detail: 'refused' }, 'alice');
  const runner = new FakeRunner(() => ({}));
  const c = coordinator(f, runner);
  const asked = askChat({ stateDir: f.stateDir, question: 'what is running?', by: 'example-owner' });
  await c.checkChat();
  const answer = f.log.read(0, ['chat.turn']).map((e) => e.payload as EventPayload<'chat.turn'>);
  assert.equal(answer.length, 1);
  assert.equal(answer[0]!.refused, AUTH_FAILED_CHAT_TEXT);
  assert.ok(asked);
  assert.equal(runner.calls.length, 0);
});
