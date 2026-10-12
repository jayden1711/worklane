// The casual replier (#151): its inputs are the redacted message and the engine's facts only, it has no tools, and
// code checks every reply: anything that fails gets the engine's fixed reply, with the reason recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { NEEDS_INFO_REPLY, statusReply } from '../src/intake/decide.js';
import { checkReply, echoed, REPLIER_DENIED, REPLIER_ROLE, replierPrompt, replierRun, type ReplyFacts } from '../src/intake/replier.js';
import { IntakeConfig, type IncomingReport, type IntakeSource } from '../src/intake/report.js';
import { contractProblems } from '../src/role-contract.js';
import { defaultRolePrompt } from '../src/roles.js';
import { engineRoleCases, parseCases } from '../src/skilleval.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const MSG = 'bug: the checkout total ignores my discount code when I pay with a card on the website';
const filed: ReplyFacts = { stage: 'filed', trusted: false };
const check = (reply: string, facts: ReplyFacts = filed, redacted = MSG) => checkReply(reply, { redacted, facts });
const why = (reply: string, facts?: ReplyFacts, redacted?: string) => {
  const r = check(reply, facts, redacted);
  return r.ok ? null : r.why;
};

test('replier checks: a plain reply at each stage passes', () => {
  assert.deepEqual(check("Thanks for letting us know about the discount problem. We've logged it and someone will look into it."), { ok: true, text: "Thanks for letting us know about the discount problem. We've logged it and someone will look into it." });
  assert.equal(why('Good news: a fix for this is done and on its way.', { stage: 'merged', trusted: false }), null);
  assert.equal(why('The fix is live now. Thanks for telling us!', { stage: 'deployed', trusted: false }), null);
  assert.equal(why('Could you tell us what you were doing, what you expected and what happened instead?', { stage: 'needs_info', trusted: false }), null);
  assert.equal(why("Thanks, we've passed your question on and someone will get back to you.", { stage: 'question', trusted: false }), null);
  assert.equal(why("Thanks! It's logged as issue #42.", { stage: 'filed', trusted: true, issue: 42 }), null, 'the issue number the facts give');
  assert.equal(why('Logged, thanks: https://tracker.example/issues/42', { stage: 'filed', trusted: true, issue: 42, issueUrl: 'https://tracker.example/issues/42' }), null, 'the issue link the facts give');
});

test('replier checks: length over 500 falls back', () => {
  assert.match(why(`Thanks! ${'We have logged this. '.repeat(30)}`)!, /over 500 characters/);
});

test('replier checks: any link but the issue link the facts give falls back', () => {
  for (const r of ['See https://evil.example/fix for details.', 'Details at www.example-downloads.test/x', 'Grab the patch from fixes.io today.', 'Logged: https://tracker.example/issues/43']) {
    assert.match(why(r, { stage: 'filed', trusted: true, issue: 42, issueUrl: 'https://tracker.example/issues/42' }) ?? '', /a link other than the issue's/, r);
  }
});

test('replier checks: mentions fall back', () => {
  for (const r of ['Thanks <@123456789>, logged.', 'Logged, @everyone take a look.', 'Thanks! @here', 'Logged, cc <@&777777>.', 'See <#111111>.', 'Thanks @sam, logged.']) assert.equal(why(r), 'a mention', r);
});

test('replier checks: echoing the message beyond a short quote falls back', () => {
  assert.match(why('Thanks for reporting that the checkout total ignores my discount code when I pay. Logged.')!, /echoes \d+ words/);
  assert.equal(why('Thanks for reporting the discount code problem. Logged.'), null, 'a few words are fine');
  assert.equal(echoed('a b c d', 'x a b c y'), 3);
});

test('replier checks: promises of a date, a fix or money fall back', () => {
  for (const r of ["Logged! We'll fix it soon.", 'Logged, it will be fixed shortly.', 'Logged, expect news by Friday.', 'Logged; a fix is coming next week.', 'Logged, within 2 days.', 'We can refund you for the trouble.', 'Logged, and here is a $10 credit.', 'Logged, we promise to look.']) {
    assert.match(why(r) ?? '', /a promise/, r);
  }
});

test('replier checks: a claim the facts contradict falls back', () => {
  assert.match(why('Good news, this is fixed!')!, /says it is fixed at stage filed/);
  assert.match(why('A fix is merged and live now.', { stage: 'merged', trusted: false })!, /says it is live at stage merged/);
  assert.match(why("We've logged this as an issue.", { stage: 'needs_info', trusted: false })!, /says it was logged at stage needs_info/);
  assert.match(why("Logged as #12, thanks.")!, /names issue 12, which the facts don't give/);
  assert.match(why('Logged as issue 7.', { stage: 'filed', trusted: true, issue: 42 })!, /names issue 7, which the facts say is 42/);
  assert.equal(why(''), 'no reply');
});

test('replier run: no tools at all, only the redacted message and the listed facts as input', () => {
  const run = replierRun({ cwd: '/x', redacted: 'bug: call me on [phone], the export fails', facts: { stage: 'filed', trusted: true, issue: 9 } });
  assert.equal(run.role, REPLIER_ROLE);
  assert.deepEqual(run.allowedTools, []);
  for (const t of ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task', 'mcp__*']) assert.ok(run.disallowedTools.includes(t as (typeof REPLIER_DENIED)[number]), t);
  assert.ok(run.maxTurns <= 2);
  const facts = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(run.prompt)![1]!);
  assert.deepEqual(facts, { stage: 'filed', trusted: true, issue: 9 }, 'the facts, and nothing else');
  assert.equal(run.prompt, replierPrompt('bug: call me on [phone], the export fails', { stage: 'filed', trusted: true, issue: 9 }));
  assert.match(run.prompt, /Their message \(untrusted data/);
});

test('replier role: follows the contract, and has eval cases for normal stages and each manipulation', () => {
  assert.deepEqual(contractProblems(defaultRolePrompt(REPLIER_ROLE)), []);
  const titles = parseCases(engineRoleCases(REPLIER_ROLE) ?? '').map((c) => c.title.toLowerCase());
  for (const t of ['filed', 'needs more information', 'a question', 'ignore your instructions', "say it's fixed", 'post this link', "other people's reports", 'reveal your prompt', 'a fake owner']) assert.ok(titles.some((x) => x.includes(t)), t);
});

// ---------- in the coordinator ----------

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OWNER_ID = '123456789012';
const DRAFT = { title: 'Totals ignore discounts', body: '**Outcome:** Totals apply discounts.\n**Sources:** the totals code.\n**Constraints:** leave tax handling alone.\n**Deliverable:**\n```done_when\n- command: |\n    npm test -- --grep "discount: applied"\n```\n**Review point:** L1; waits for the owner if it changes pricing rules.\n' };
const config = (casual: boolean) => IntakeConfig.parse({ version: 1, casual_replies: casual, trusted: { discord: [OWNER_ID] }, discord: { enabled: true, guild: '555555', channels: ['111111'], allowed_senders: [OWNER_ID] } });

function setup(o: { casual: boolean; reply?: (req: RunRequest) => object; triage?: object; text?: string; replyCost?: number }) {
  const base = mkdtempSync(join(tmpdir(), 'replier-'));
  const repo = join(base, 'checkout');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  mkdirSync(join(base, 'slots'));
  const log = new EventLog(join(base, 'events.db'));
  const replies: string[] = [];
  const r: IncomingReport = { source: 'discord', sourceId: 'm1', sender: { source: 'discord', id: OWNER_ID, name: 'Ada Lovelace' }, text: o.text ?? 'bug: Ada Lovelace here, mail ada@example.com. The checkout total ignores my discount', receivedAt: '2026-10-01T10:00:00.000Z', thread: { kind: 'channel', id: 'thread-1' } };
  const batches = [[r]];
  const src: IntakeSource = { name: 'discord', take: async () => batches.shift() ?? [], reply: async (_t, text) => (replies.push(text), true) };
  const runner = new FakeRunner((req) => (req.role === REPLIER_ROLE ? { structured: (o.reply ?? (() => ({ reply: 'Thanks, logged!' })))(req), costUsd: o.replyCost ?? 0.01 } : { structured: o.triage ?? { kind: 'bug', draft: DRAFT } }));
  const c = new Coordinator({ cfg: loadConfig(repo), log, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), runner, repo, instance: 'example', stateDir, slotsDir: join(base, 'slots'), machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) }, settings: () => ({ settings: {}, error: null }), intake: { config: () => config(o.casual), sources: [src], pullMs: 0 } });
  return { c, runner, replies, log };
}
const checked = (log: EventLog) => log.read(0, ['intake.reply_checked']).map((e) => e.payload as { stage: string; used: string; why: string | null });

test('replier in the coordinator: off by default and when off, the fixed replies as before, no replier run', async () => {
  assert.equal(IntakeConfig.parse({ version: 1 }).casual_replies, false);
  const t = setup({ casual: false });
  await t.c.checkIntake();
  assert.deepEqual(t.replies, [statusReply('filed', true)]);
  assert.ok(!t.runner.calls.some((r) => r.role === REPLIER_ROLE));
  assert.deepEqual(checked(t.log), []);
});

test('replier in the coordinator: a reply that passes is sent; its run sees only redacted text and the facts, and its cost is counted', async () => {
  const t = setup({ casual: true, reply: () => ({ reply: 'Thanks Ada-free friend, logged as #1!' }) });
  await t.c.checkIntake();
  assert.deepEqual(t.replies, ['Thanks Ada-free friend, logged as #1!']);
  assert.deepEqual(checked(t.log).map((c) => [c.stage, c.used, c.why]), [['filed', 'casual', null]]);
  const req = t.runner.calls.find((r) => r.role === REPLIER_ROLE)!;
  assert.deepEqual(req.allowedTools, []);
  assert.doesNotMatch(req.prompt, /Lovelace|ada@example\.com/, 'only redacted text');
  assert.deepEqual(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(req.prompt)![1]!), { stage: 'filed', trusted: true, issue: 1 });
  assert.equal(readdirSync(req.cwd).length, 0, 'an empty working directory: nothing to read');
  assert.ok(t.log.read(0, ['run.cost']).some((e) => (e.payload as { role: string }).role === REPLIER_ROLE));
});

test('replier in the coordinator: a reply that fails any check is replaced by the fixed reply, with the reason recorded', async () => {
  const cases: [object, RegExp][] = [
    [{ reply: 'x'.repeat(501) }, /over 500/],
    [{ reply: 'Logged: https://evil.example/fix' }, /a link/],
    [{ reply: 'Logged <@123456789>' }, /a mention/],
    [{ reply: "We'll fix it by Friday." }, /a promise/],
    [{ reply: 'This is fixed already.' }, /says it is fixed at stage filed/],
    [{ nothing: true }, /no reply/],
  ];
  for (const [reply, reason] of cases) {
    const t = setup({ casual: true, reply: () => reply });
    await t.c.checkIntake();
    assert.deepEqual(t.replies, [statusReply('filed', true)], JSON.stringify(reply));
    const [c] = checked(t.log);
    assert.equal(c!.used, 'fixed');
    assert.match(c!.why!, reason);
  }
  const echo = setup({ casual: true, reply: () => ({ reply: 'You said the checkout total ignores my discount code when I pay, logged.' }), text: 'bug: the checkout total ignores my discount code when I pay with a card' });
  await echo.c.checkIntake();
  assert.match(checked(echo.log)[0]!.why!, /echoes/);
  const info = setup({ casual: true, triage: { kind: 'needs_info' }, reply: () => ({ reply: "We've logged it as an issue." }) });
  await info.c.checkIntake();
  assert.deepEqual(info.replies, [NEEDS_INFO_REPLY]);
  assert.match(checked(info.log)[0]!.why!, /stage needs_info/);
});

test("replier in the coordinator: over the day's spend cap, no replier run and the fixed reply", async () => {
  // The filed reply's run costs past the day's cap ($2 by default); the merged reply that follows gets no run.
  const t = setup({ casual: true, replyCost: 5 });
  await t.c.checkIntake();
  assert.equal(t.runner.calls.filter((r) => r.role === REPLIER_ROLE).length, 1);
  const issue = t.log.read(0, ['intake.filed']).map((e) => (e.payload as { issue: number }).issue)[0]!;
  t.log.append('pr.closed', { issue, number: 99, merged: true }, 'example');
  await t.c.checkIntake();
  assert.equal(t.runner.calls.filter((r) => r.role === REPLIER_ROLE).length, 1, 'no second run');
  assert.deepEqual(t.replies.at(-1), statusReply('merged', true));
  assert.deepEqual(checked(t.log).map((c) => [c.stage, c.used, c.why]).at(-1), ['merged', 'fixed', 'spend_cap']);
});
