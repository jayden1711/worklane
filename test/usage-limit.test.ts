// The Claude usage limit (src/usage-limit.ts): the reset time read from claude's own words; the runner ending a run
// that hits it at once (no transient retries); and the instance pausing on it: no retry storm, the task requeued
// (not failed), one notice with the reset time, and resuming on its own at the reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntakeConfig, type IntakeSource } from '../src/intake/report.js';
import { CliRunner, FakeRunner, type RunRequest } from '../src/runner.js';
import { usageByDay } from '../src/health.js';
import { DEFAULT_PAUSE_MS, limitHit, MIN_PAUSE_MS, pauseOf, resetInText, usageView } from '../src/usage-limit.js';
import type { EventPayload, StoredEvent } from '../src/events/types.js';
import { coordinator, easyIssue, fixture, readAll, realFix, skip } from './repro-state-graph/harness.js';
import { asPerson, exampleProject, exampleRoles, STDIN_LINE } from './helpers.js';
import { loadConfig } from '../src/config/load.js';
import { CONFIG_INCIDENT } from '../src/config/live.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';

const NOW = Date.parse('2026-10-13T10:20:00Z');

// ---- the reset time, from claude's words

test("the reset time: claude's rate_limit_event first, then its text (|epoch, \"resets in\", \"resets 3pm (zone)\"), else the default", () => {
  const at = (iso: string) => new Date(iso).toISOString();
  // The stream's rate_limit_event carries unix seconds.
  assert.deepEqual(limitHit({ info: { status: 'rejected', resetsAt: Date.parse('2026-10-13T15:00:00Z') / 1000, rateLimitType: 'five_hour' }, text: '', now: NOW }), { resetAt: at('2026-10-13T15:00:00Z'), source: 'claude', kind: 'five_hour' });
  // Older clients: "Claude AI usage limit reached|<unix seconds>".
  assert.equal(resetInText(`Claude AI usage limit reached|${Date.parse('2026-10-13T13:00:00Z') / 1000}`, NOW), Date.parse('2026-10-13T13:00:00Z'));
  assert.equal(resetInText('5-hour limit reached; resets in 2h 30m', NOW), NOW + 150 * 60_000);
  assert.equal(resetInText('limit reached, resets in 45 minutes', NOW), NOW + 45 * 60_000);
  // A time of day in a named zone: today if still ahead, else tomorrow.
  assert.equal(resetInText("You've hit your limit · resets 3pm (Europe/Paris)", NOW), Date.parse('2026-10-13T13:00:00Z'));
  assert.equal(resetInText("You've hit your limit · resets 9:30am (America/New_York)", NOW), Date.parse('2026-10-13T13:30:00Z'), 'daylight time: 06:20 there now, 09:30 still ahead');
  assert.equal(resetInText('resets 11am (UTC)', NOW), Date.parse('2026-10-13T11:00:00Z'));
  assert.equal(resetInText('resets 10am (UTC)', NOW), Date.parse('2026-10-14T10:00:00Z'), 'passed today: tomorrow');
  assert.equal(resetInText('Weekly limit reached · resets Oct 16, 9am (UTC)', NOW), Date.parse('2026-10-16T09:00:00Z'));
  assert.equal(resetInText('resets 3pm (Not/AZone)', NOW), null, 'an unknown zone: no time from the text');
  // No reset in the message, or one too far off to believe: the default wait.
  assert.deepEqual(limitHit({ text: 'Claude usage limit reached.', now: NOW }), { resetAt: new Date(NOW + DEFAULT_PAUSE_MS).toISOString(), source: 'default', kind: null });
  assert.equal(limitHit({ info: { resetsAt: NOW / 1000 + 30 * 86_400 }, text: '', now: NOW }).source, 'default');
  // A reset already passing is never "retry now".
  assert.equal(limitHit({ info: { resetsAt: NOW / 1000 - 5 }, text: '', now: NOW }).resetAt, new Date(NOW + MIN_PAUSE_MS).toISOString());
});

test('the pause in force is the last usage.paused with no usage.resumed after it; the usage view counts today', () => {
  const ev = (id: number, type: string, payload: object, ts = '2026-10-13T10:00:00.000Z') => ({ id, ts, type, actor: 'c', source: 'coordinator', payload }) as unknown as StoredEvent;
  const paused = ev(2, 'usage.paused', { reset_at: '2026-10-13T15:00:00.000Z', source: 'claude', kind: 'five_hour', issue: 4, role: 'worker', detail: 'x' });
  assert.equal(pauseOf([]), null);
  assert.deepEqual(pauseOf([paused]), { since: paused.ts, resetAt: '2026-10-13T15:00:00.000Z', source: 'claude', kind: 'five_hour', issue: 4, role: 'worker', id: 2 });
  assert.equal(pauseOf([paused, ev(3, 'usage.resumed', { reset_at: '2026-10-13T15:00:00.000Z', paused_ms: 1 })]), null);
  const hit = ev(1, 'usage.limit_hit', { issue: 4, role: 'worker', model: 'sonnet', provider: null, reset_at: '2026-10-13T15:00:00.000Z', source: 'claude', kind: null, detail: 'x' });
  const v = usageView([ev(0, 'run.started', { issue: 4 }), hit, paused, ev(5, 'run.started', { issue: 5 }, '2026-10-12T10:00:00.000Z')], NOW);
  assert.deepEqual(v.today, { runs: 1, limitHits: 1 });
  assert.equal(v.lastHit, hit.ts);
  assert.equal(v.paused?.id, 2);
});

test("health's \"Usage limit hits\" counts a hit recorded as usage.limit_hit (the run's caller requeues; there's no run.finished), and older logs' run.finished rate_limited", () => {
  const ev = (id: number, type: string, payload: object) => ({ id, ts: '2026-10-13T10:00:00.000Z', type, actor: 'c', source: 'coordinator', payload }) as unknown as StoredEvent;
  const days = usageByDay([
    ev(1, 'usage.limit_hit', { issue: 4, role: 'worker', model: 'sonnet', provider: null, reset_at: 'x', source: 'claude', kind: null, detail: 'x' }),
    ev(2, 'run.finished', { issue: 5, role: 'worker', reason: 'rate_limited', detail: 'older engine' }),
  ]);
  assert.equal(days[0]!.rateLimited, 2);
});

// ---- the runner: a run that hits the limit is one try

const posixOnly = process.platform === 'win32' && 'POSIX shell stand-in';
const RESET_S = Math.floor(Date.now() / 1000) + 3 * 3600;

/** A stand-in claude whose every run hits the usage limit, the way `what` says it; each start is logged. */
function limited(what: 'event' | 'text') {
  const dir = mkdtempSync(join(tmpdir(), 'claude-limit-'));
  const bin = join(dir, 'claude');
  const lines =
    what === 'event'
      ? [{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: RESET_S, rateLimitType: 'five_hour' } }, { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm", api_error_status: 429, num_turns: 0, total_cost_usd: 0 }]
      : [{ type: 'result', subtype: 'success', is_error: true, result: `Claude AI usage limit reached|${RESET_S}`, num_turns: 0, total_cost_usd: 0 }];
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
${STDIN_LINE};
fs.appendFileSync(path.join(${JSON.stringify(dir)}, 'calls.log'), 'start\\n');
for (const l of ${JSON.stringify(lines)}) console.log(JSON.stringify(l));
process.exit(1);
`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin, starts: () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').length };
}

const req = (cwd: string): RunRequest => ({ role: 'worker', prompt: 'p', cwd, model: 'm', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000 });

for (const what of ['event', 'text'] as const) {
  test(`runner: a run that hits the usage limit (${what === 'event' ? "claude's rate_limit_event" : 'only its words, "usage limit reached|<time>"'}) ends at once, rate_limited, with the reset time; never retried`, { skip: posixOnly }, async () => {
    const s = limited(what);
    const waits: number[] = [];
    let t = Date.now();
    const r = new CliRunner('cli', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: join(s.dir, 'login') }, s.bin, undefined, undefined, undefined, { now: () => t, sleep: async (ms) => ((t += ms), waits.push(ms), true) });
    const out = await r.run(req(s.dir));
    assert.equal(out.reason, 'rate_limited');
    assert.deepEqual(out.limit, { resetAt: new Date(RESET_S * 1000).toISOString(), source: 'claude', kind: what === 'event' ? 'five_hour' : null });
    assert.match(out.detail, what === 'event' ? /hit your limit/ : /usage limit reached/);
    assert.equal(s.starts(), 1, 'one try');
    assert.deepEqual(waits, [], 'no transient waits');
  });
}

// ---- the instance: pause, requeue, one notice, resume

const ASKS = '200000000001';
const DASH = 'https://dashboard.example.test';

function fakeChat() {
  const posts: { where: string; text: string }[] = [];
  const src: IntakeSource & { posts: typeof posts } = {
    name: 'discord',
    posts,
    take: async () => [],
    reply: async (t, text) => (posts.push({ where: t.id, text }), true),
    openThread: async () => '900000',
    watch: () => {},
  };
  return src;
}

test('a usage-limit hit pauses the instance: no retry storm, tasks requeued (not failed), one notice with the reset time; it resumes on its own at the reset', { skip }, async (t) => {
  const f = fixture();
  f.cfg.agents.roles.workers!.count = 2;
  const issues = [f.backlog.open(easyIssue('Add a.js', 'a.js')), f.backlog.open(easyIssue('Add b.js', 'b.js')), f.backlog.open(easyIssue('Add c.js', 'c.js'))];
  const resetAt = Math.floor(Date.now() / 1000) * 1000 + 2 * 3600_000;
  let limitedNow = true;
  const runner = new FakeRunner((r: RunRequest) => {
    if (r.role === 'worker') {
      if (limitedNow) return { reason: 'rate_limited', detail: "usage or rate limit reached: You've hit your limit", turns: 0, limit: limitHit({ info: { status: 'rejected', resetsAt: resetAt / 1000 }, text: '', now: Date.now() }) };
      return { structured: realFix(r) };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: readAll(r) } };
  });
  const chat = fakeChat();
  const config = IntakeConfig.parse({ version: 1, discord: { enabled: true, guild: '555555', channels: ['111111'], allowed_senders: ['100000000001'], people: { '100000000001': 'example-owner' }, asks_channel: ASKS, dashboard_url: DASH } });
  const c = coordinator(f, runner, { settings: () => ({ settings: {}, error: null }), intake: { config: () => config, sources: [chat], pullMs: 0 } });
  const workerRuns = () => runner.calls.filter((r) => r.role === 'worker').length;
  for (let i = 0; i < 5; i++) {
    await c.tick();
    await c.idle();
    await c.checkIntake();
  }
  // No storm: at most one run per free worker slot before the pause, and none after it, however many ticks.
  assert.ok(workerRuns() >= 1 && workerRuns() <= 2, `at most 2 worker runs (got ${workerRuns()})`);
  const paused = f.log.read(0, ['usage.paused']).map((e) => e.payload as EventPayload<'usage.paused'>);
  assert.equal(paused.length, 1, 'paused once');
  assert.equal(paused[0]!.reset_at, new Date(resetAt).toISOString());
  assert.equal(paused[0]!.source, 'claude');
  // Requeued, not failed or blocked, and no attempt counted against the task.
  assert.equal(f.log.read(0, ['issue.blocked']).length, 0, 'nothing blocked');
  for (const n of issues) {
    const labels = (await f.backlog.get(n)).labels;
    assert.ok(labels.includes('ready') && !labels.includes('blocked') && !labels.includes('agent:working'), `#${n} is ready again (${labels.join(', ')})`);
  }
  const hit = issues.filter((n) => f.log.read(0, ['issue.released']).some((e) => (e.payload as { issue: number }).issue === n));
  assert.ok(hit.length >= 1);
  assert.ok((await f.backlog.comments(hit[0]!)).some((m) => /Paused on the Claude usage limit until .* requeued/.test(m.body)));
  assert.ok(f.log.read(0, ['governor.hold']).some((e) => /paused on the Claude usage limit/.test((e.payload as { reason: string }).reason)), 'dispatch says why it holds');
  // One notice, in the asks channel, with the reset time and the dashboard view.
  const notices = chat.posts.filter((p) => p.where === ASKS && /usage limit/.test(p.text));
  assert.equal(notices.length, 1, 'one notice');
  assert.ok(notices[0]!.text.includes(paused[0]!.reset_at.slice(0, 16).replace('T', ' ')), notices[0]!.text);
  assert.ok(notices[0]!.text.includes(`${DASH}/overview`));
  // Before the reset nothing starts, even though the limit would now let it.
  limitedNow = false;
  const before = workerRuns();
  await c.tick();
  await c.idle();
  assert.equal(workerRuns(), before);
  // At the reset (only Date moves): it resumes on its own and the work runs.
  t.mock.timers.enable({ apis: ['Date'], now: resetAt + 1000 });
  try {
    for (let i = 0; i < 4; i++) {
      await c.tick();
      await c.idle();
      await c.checkIntake();
    }
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(f.log.read(0, ['usage.resumed']).length, 1, 'resumed once');
  assert.ok(workerRuns() > before, 'runs started again after the reset');
  assert.ok(f.log.read(0, ['land.result']).some((e) => (e.payload as { outcome: string }).outcome === 'landed'), 'and the work landed');
  assert.equal(chat.posts.filter((p) => p.where === ASKS && /usage limit/.test(p.text)).length, 1, 'still one notice');
});

test('the incident model, when there is one: raised once on the pause, resolved on the resume', { skip }, async (t) => {
  const f = fixture();
  f.backlog.open(easyIssue('Add a.js', 'a.js'));
  const resetAt = Date.now() + 3600_000;
  const runner = new FakeRunner((r: RunRequest) => (r.role === 'worker' ? { reason: 'rate_limited', detail: 'usage or rate limit reached', limit: { resetAt: new Date(resetAt).toISOString(), source: 'claude', kind: null } } : {}));
  const calls: string[] = [];
  const c = coordinator(f, runner, { incidents: { raiseIncident: (kind, key, detail) => void calls.push(`raise ${kind} ${key} ${detail}`), resolveIncident: (kind, key) => void calls.push(`resolve ${kind} ${key}`) } });
  await c.tick();
  await c.idle();
  await c.tick();
  await c.idle();
  // The start-up resolve of a stale config_invalid (the default branch's config validated), then the one raise.
  assert.equal(calls.length, 2);
  assert.equal(calls[0], `resolve ${CONFIG_INCIDENT} alice`);
  assert.match(calls[1]!, /^raise claude_usage_limit alice Claude usage limit reached; no new runs until /);
  t.mock.timers.enable({ apis: ['Date'], now: resetAt + 1000 });
  try {
    await c.tick();
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(calls.at(-1), 'resolve claude_usage_limit alice');
});

test("the coordinator's account-switched hook ends the pause of an instance moved to a new login after it began; none, and it stays paused", { skip }, async () => {
  // The hook's answer: when the instance last moved to a new login (null: never). Since #736 the service passes none
  // (the engine switches no account); the coordinator's hook is kept, and this holds what it does with one.
  // Whether the switch put the instance on a new login and resumed it: only then does it have a switch time.
  const switchLines = (check: 'done' | 'failed', resume: 'done' | 'failed') => check === 'done' && resume === 'done';
  // The switch is written once the pause has begun (its lines are stamped then), however long the setup took.
  const run = async (switched: (() => boolean) | null) => {
    const f = fixture();
    f.backlog.open(easyIssue('Add a.js', 'a.js'));
    const resetAt = Date.now() + 3600_000;
    let limited = true; // the old account's limit; the new login has none
    const runner = new FakeRunner((r: RunRequest) => (r.role === 'worker' && limited ? { reason: 'rate_limited', detail: 'usage or rate limit reached', limit: { resetAt: new Date(resetAt).toISOString(), source: 'claude', kind: null } } : {}));
    const calls: string[] = [];
    let switchedAt: string | null = null;
    const c = coordinator(f, runner, {
      incidents: { raiseIncident: (kind, key) => void calls.push(`raise ${kind} ${key}`), resolveIncident: (kind, key) => void calls.push(`resolve ${kind} ${key}`) },
      accountSwitched: () => switchedAt,
    });
    await c.tick();
    await c.idle();
    assert.ok(pauseOf(f.log.read(0)), 'paused on the limit');
    limited = switched === null;
    // The switch happens while it is paused (stamped then), then the coordinator starts again.
    const stamped = new Date(Date.now() + 2000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    switchedAt = switched?.() ? stamped : null;
    await c.tick();
    await c.idle();
    return { f, calls };
  };
  const ok = await run(() => switchLines('done', 'done'));
  assert.equal(pauseOf(ok.f.log.read(0)), null, 'no pause after a successful switch');
  const resumed = ok.f.log.read(0, ['usage.resumed']).map((e) => e.payload as EventPayload<'usage.resumed'>);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]!.reason, 'account switched');
  assert.equal(ok.calls.at(-1), 'resolve claude_usage_limit alice', 'the incident resolved through the same hook');
  const failed = await run(() => switchLines('failed', 'failed'));
  assert.ok(pauseOf(failed.f.log.read(0)), 'a failed check keeps the pause');
  assert.equal(failed.f.log.read(0, ['usage.resumed']).length, 0);
  // Only the start-up resolve of a stale config_invalid; no resolve after it.
  assert.equal(failed.calls[0], `resolve ${CONFIG_INCIDENT} alice`);
  assert.ok(!failed.calls.slice(1).some((x) => x.startsWith('resolve')));
  const none = await run(null);
  assert.ok(pauseOf(none.f.log.read(0)), 'no switch: paused until the reset');
});

test("/api/usage: the pause in force (its reset, for the countdown) and today's usage, for everyone with a role; no run detail", async () => {
  const { dir, stateDir } = exampleProject();
  const eventsDb = join(mkdtempSync(join(tmpdir(), 'usage-api-')), 'events.db');
  const log = new EventLog(eventsDb);
  const reset = new Date(Date.now() + 3600_000).toISOString();
  log.append('run.started', { issue: 3, role: 'worker', model: 'sonnet', worktree: '/w', pid: 1, pgid: 1, attempt: 1 }, 'coordinator');
  log.append('usage.limit_hit', { issue: 3, role: 'worker', model: 'sonnet', provider: null, reset_at: reset, source: 'claude', kind: 'five_hour', detail: 'secret-ish detail' }, 'coordinator');
  log.append('usage.paused', { reset_at: reset, source: 'claude', kind: 'five_hour', issue: 3, role: 'worker', detail: 'secret-ish detail' }, 'coordinator');
  log.close();
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb, stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'usage-slots-')) });
  try {
    for (const who of ['example-owner', 'someone-else']) {
      const res = await fetch(`${d.url.split('/?')[0]}/api/usage`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(who) } });
      assert.equal(res.status, 200, who);
      const body = (await res.json()) as { paused: { resetAt: string; source: string } | null; today: { runs: number; limitHits: number } };
      assert.deepEqual(body.paused && { resetAt: body.paused.resetAt, source: body.paused.source }, { resetAt: reset, source: 'claude' });
      assert.deepEqual(body.today, { runs: 1, limitHits: 1 });
      assert.doesNotMatch(JSON.stringify(body), /secret-ish/, 'no run detail');
    }
  } finally {
    await d.close();
  }
});
