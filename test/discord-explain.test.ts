// Decision and question threads in plain language (src/intake/explain.ts, src/coordinator/channel.ts): a summary on
// open that must match the decision record, questions answered in the thread (never an answer), and plain-language
// picks recorded only on the same person's confirming yes. Discord is a fake source; the model is a FakeRunner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { asks } from '../src/console/asks.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { askBack } from '../src/intake/channel.js';
import { REPLY_CHARS } from '../src/intake/discord.js';
import { checkSummary, recordBlock, SUMMARY_ROLE, THREAD_ROLE, type ThreadRecord } from '../src/intake/explain.js';
import { IntakeConfig, type IncomingReport, type IntakeSource } from '../src/intake/report.js';
import { IntakeMeter } from '../src/intake/store.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Placeholder ids and logins only.
const OWNER_ID = '100000000001';
const COFOUNDER_ID = '100000000002';
const TEAMMATE_ID = '100000000003';
const ASKS_CHANNEL = '200000000001';
const DASH = 'https://dashboard.example.test';
const REPO = 'example-org/example';

const CONFIG = IntakeConfig.parse({
  version: 1,
  discord: {
    enabled: true,
    guild: '555555',
    channels: ['111111'],
    allowed_senders: [OWNER_ID, COFOUNDER_ID, TEAMMATE_ID],
    people: { [OWNER_ID]: 'example-owner', [COFOUNDER_ID]: 'example-cofounder', [TEAMMATE_ID]: 'example-collaborator' },
    asks_channel: ASKS_CHANNEL,
    dashboard_url: DASH,
  },
});

const ROLES: Record<string, 'owner' | 'writer' | 'viewer'> = { 'example-owner': 'owner', 'example-cofounder': 'owner', 'example-collaborator': 'writer' };
const roleOf = async (login: string) => ROLES[login.toLowerCase()] ?? 'viewer';

function fakeChat() {
  const posts: { where: string; text: string }[] = [];
  const threads: { channel: string; text: string; name: string; id: string }[] = [];
  const batches: IncomingReport[][] = [];
  const src: IntakeSource & { posts: typeof posts; threads: typeof threads; batches: typeof batches } = {
    name: 'discord',
    posts,
    threads,
    batches,
    take: async () => batches.shift() ?? [],
    reply: async (t, text) => (posts.push({ where: t.id, text }), true),
    openThread: async (channel, text, name) => {
      const id = String(900000 + threads.length);
      threads.push({ channel, text, name, id });
      return id;
    },
    watch: () => {},
  };
  return src;
}

/** What the fake model returns, by role. */
type Script = Partial<Record<string, (req: RunRequest) => unknown>>;

function setup(script: Script = {}, o: { costUsd?: number } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'explain-'));
  const repo = join(base, 'checkout');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const cfg = loadConfig(repo);
  cfg.project.project.repo = REPO;
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const log = new EventLog(join(base, 'events.db'));
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  const chat = fakeChat();
  const runner = new FakeRunner((req) => ({ structured: script[req.role]?.(req) ?? { kind: 'needs_info' }, ...(o.costUsd !== undefined ? { costUsd: o.costUsd } : {}) }));
  const c = new Coordinator({
    cfg,
    log,
    backlog,
    runner,
    repo,
    instance: 'example',
    stateDir,
    slotsDir,
    machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) },
    settings: () => ({ settings: {}, error: null }),
    intake: { config: () => CONFIG, sources: [chat], pullMs: 0, roleOf },
  });
  const pass = async (...msgs: IncomingReport[]) => {
    chat.batches.push(msgs);
    await c.checkIntake();
  };
  const runsOf = (role: string) => runner.calls.filter((r) => r.role === role);
  return { base, repo, cfg, log, backlog, stateDir, c, chat, pass, runner, runsOf };
}

let seq = 0;
const reply = (from: string, thread: string, text: string): IncomingReport => ({
  source: 'discord',
  sourceId: `3100000000${++seq}`,
  sender: { source: 'discord', id: from },
  text,
  receivedAt: '2026-10-01T10:00:00.000Z',
  thread: { kind: 'thread', id: thread },
});
const of = (log: EventLog, type: 'decision.answered' | 'discord.reply' | 'dashboard.audit' | 'discord.explained' | 'discord.confirm' | 'run.cost') => log.read(0, [type]).map((e) => e.payload as Record<string, unknown>);
const inThread = (t: ReturnType<typeof setup>, thread: string) => t.chat.posts.filter((p) => p.where === thread).map((p) => p.text);

/** A held plan on a money path, as the coordinator would record it. */
async function moneyPlan(t: ReturnType<typeof setup>) {
  const issue = await t.backlog.createIssue('Round refunds to the cent', 'Refunds are computed in floating point and sometimes come out a cent off.', ['ready', 'money-path']);
  t.log.append('review.level_set', { issue, head: 'a'.repeat(40), level: 'L3', reasons: ['money_path: src/payments/refund.ts'] }, 'coordinator');
  t.log.append('plan.posted', { issue, plan: { approach: 'Compute refunds in integer cents.', steps: ['change the refund calculation', 'add tests for odd amounts'] }, held: true, reasons: ['money path'], comments_at: 0, decision: 'd-plan' }, 'coordinator');
  t.log.append('decision.asked', { id: 'd-plan', kind: 'plan', issue, owner: 'example-owner', question: `Approve the plan for #${issue}?`, options: ['approve', 'revise', 'reject'], recommendation: 'approve', receipts: [] }, 'coordinator');
  return issue;
}

/** A summary true to the money-path plan's record (issue 1). */
const goodSummary = (issue: number, over: Record<string, unknown> = {}) => ({
  problem: 'Refunds are sometimes a cent off because they are computed in floating point.',
  found: 'The agent plans to compute refunds in whole cents and add tests for odd amounts.',
  options: [
    { name: 'approve', effect: `A worker builds the plan for #${issue} next; you review the change before it lands. ${'It touches only the refund calculation. '.repeat(4)}` },
    { name: 'revise', effect: 'The planner reworks the plan with your notes, and you are asked again.' },
    { name: 'reject', effect: 'Nothing is built; the issue goes back to the backlog.' },
  ],
  recommendation: { option: 'approve', why: 'The plan is small, has tests for the odd amounts, and keeps the change in one module.' },
  risk: { level: 'L3', why: 'It changes how refunds are calculated, which is a money path.' },
  ...over,
});

// ---------------------------------------------------------------- 1. explain on open

test('explain: an opened decision thread gets a plain-language summary, split into messages of at most 500 characters, with the engine\'s own links', async () => {
  let issue = 0;
  const t = setup({ [SUMMARY_ROLE]: () => goodSummary(issue) });
  issue = await moneyPlan(t);
  await t.pass();
  const thread = t.chat.threads[0]!.id;
  const posts = inThread(t, thread);
  assert.ok(posts.length >= 2, 'more than one message');
  for (const p of posts) assert.ok(p.length <= REPLY_CHARS, `at most ${REPLY_CHARS}: ${p.length}`);
  const all = posts.join('\n');
  assert.match(all, new RegExp(`#${issue} Round refunds to the cent`), 'the issue, by number and title');
  assert.match(all, /a cent off/, 'the problem');
  assert.match(all, /\*\*approve\*\*: A worker builds[\s\S]*\*\*revise\*\*[\s\S]*\*\*reject\*\*/, 'what each option does');
  assert.match(all, /Recommended: approve\.\*\* The plan is small/, 'why the recommendation');
  assert.match(all, /Risk: L3\*\* \(money path\)/, 'the risk level, from the record');
  assert.ok(all.includes(`https://github.com/${REPO}/issues/${issue}`) && all.includes(`${DASH}/inbox`), 'the issue and dashboard links');
  assert.deepEqual(of(t.log, 'discord.explained').map((p) => p.used), ['summary']);
  // The run: the intake-summary role, no tools at all, on the routed model, from the record only.
  const [run] = t.runsOf(SUMMARY_ROLE);
  assert.deepEqual(run!.allowedTools, []);
  for (const tool of ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch']) assert.ok(run!.disallowedTools!.includes(tool), tool);
  assert.equal(run!.model, 'haiku');
  assert.match(run!.prompt, /"level": "L3"[\s\S]*"money path"/, 'the record holds the risk');
  assert.match(run!.prompt, /integer cents/, 'and the plan');
  await t.pass();
  assert.equal(t.runsOf(SUMMARY_ROLE).length, 1, 'once per thread');
  assert.equal(inThread(t, thread).length, posts.length, 'posted once');
});

test('explain: a summary that contradicts the record (an option, the recommendation, the risk, the issue, a link) posts the fixed template and the dashboard link instead', async () => {
  const bad: [string, (issue: number) => Record<string, unknown>][] = [
    ['an option left out', (n) => ({ options: goodSummary(n).options.slice(0, 2) })],
    ['an option the record lacks', (n) => ({ options: [...goodSummary(n).options, { name: 'defer', effect: 'Wait a week.' }] })],
    ['another recommendation', () => ({ recommendation: { option: 'reject', why: 'Too risky.' } })],
    ['another risk level', () => ({ risk: { level: 'L1', why: 'Small change.' } })],
    ['a level in the text', () => ({ problem: 'A small L1 fix to refunds.' })],
    ['another issue', () => ({ found: 'Same as #9, which was merged.' })],
    ['a link', () => ({ found: 'See http://example-mirror.test/plan for details.' })],
    ['a mention', () => ({ problem: '@everyone refunds are a cent off.' })],
    ['a sentence recommending another option', () => ({ found: 'We recommend reject until legal checks it.' })],
    ['a claim it is decided', () => ({ found: 'This has been approved already.' })],
  ];
  for (const [what, over] of bad) {
    let issue = 0;
    const t = setup({ [SUMMARY_ROLE]: () => goodSummary(issue, over(issue)) });
    issue = await moneyPlan(t);
    await t.pass();
    const posts = inThread(t, t.chat.threads[0]!.id);
    assert.equal(posts.length, 1, what);
    assert.match(posts[0]!, /^Decision needed \(plan on #1\):[\s\S]*Options: approve \/ revise \/ reject\. Recommended: approve\.[\s\S]*Details on the dashboard: https:\/\/dashboard\.example\.test\/inbox$/, what);
    const [e] = of(t.log, 'discord.explained');
    assert.equal(e!.used, 'template', what);
    assert.ok(typeof e!.why === 'string' && e!.why.length > 0, `${what}: why is recorded`);
  }
});

test('explain: checkSummary itself: the record is the truth, case aside; text the record gives no level for names none', () => {
  const r: ThreadRecord = { kind: 'question', issue: null, question: 'System or toggle?', options: ['system', 'toggle'], recommendation: 'system', risk: { level: null, notes: [] } };
  const ok = { problem: 'Dark mode.', found: '', options: [{ name: 'System', effect: 'Follows the OS.' }, { name: 'toggle', effect: 'A switch.' }], recommendation: { option: 'system', why: 'Less to maintain.' }, risk: { level: 'none', why: 'Nothing risky.' } };
  const got = checkSummary(ok, r, { dashboardUrl: `${DASH}/inbox` });
  assert.ok(got.ok);
  assert.match(got.posts.join('\n'), /\*\*System or toggle\?\*\* \(question\)[\s\S]*\*\*system\*\*: Follows the OS\./, 'options in the record\'s spelling');
  assert.equal(checkSummary({ ...ok, risk: { level: 'L2', why: '' } }, r, { dashboardUrl: DASH }).ok, false, 'a level where the record has none');
  assert.equal(checkSummary({ ...ok, found: 'Issue 4 asked for it.' }, r, { dashboardUrl: DASH }).ok, false, 'an issue where the record has none');
  assert.equal(checkSummary({ ...ok, found: 'Uses token ghp_' + 'a'.repeat(36) }, r, { dashboardUrl: DASH }).ok, false, 'a secret');
  assert.equal(checkSummary(null, r, { dashboardUrl: DASH }).ok, false);
  assert.match(recordBlock({ ...r, plan: 'key sk-ant-' + 'b'.repeat(30) }), /sk-\[REDACTED\]/, 'the record is redacted before the model sees it');
});

// ---------------------------------------------------------------- 2. questions in the thread

test('thread: an admin or writer asks a question; the bot answers from the record, and the question never answers the decision', async () => {
  let issue = 0;
  const t = setup({
    [SUMMARY_ROLE]: () => goodSummary(issue),
    // Even a model that says "approve" in every way it can: the answer is text, nothing else is read from it.
    [THREAD_ROLE]: (req) => (/approve change/.test(req.prompt) ? { intent: 'question', answer: `If you approve, a worker builds the plan for #${issue}: refunds in whole cents, with tests.`, option: 'approve', answer_decision: 'approve' } : { intent: 'question', answer: 'It changes how refunds are calculated in the payments code, which is a money path, so it is L3.' }),
  });
  issue = await moneyPlan(t);
  await t.pass();
  const thread = t.chat.threads[0]!.id;
  await t.pass(reply(OWNER_ID, thread, 'what does approve change?'));
  await t.pass(reply(TEAMMATE_ID, thread, 'why money path?'));
  assert.deepEqual(of(t.log, 'decision.answered'), [], 'no answer');
  assert.deepEqual(of(t.log, 'discord.confirm'), [], 'nothing waits for a confirmation either');
  assert.deepEqual(of(t.log, 'discord.reply').map((p) => [p.by, p.outcome]), [['example-owner', 'question'], ['example-collaborator', 'question']], 'a writer may ask about an owner decision too');
  const posts = inThread(t, thread);
  assert.ok(posts.includes(`If you approve, a worker builds the plan for #${issue}: refunds in whole cents, with tests.`));
  assert.ok(posts.at(-1)!.includes('money path, so it is L3'));
  // The run: the intake-thread role, no tools, the record and the message.
  const runs = t.runsOf(THREAD_ROLE);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0]!.allowedTools, []);
  assert.equal(runs[0]!.model, 'sonnet', 'kept on sonnet: its held-out score dropped on haiku');
  assert.match(runs[0]!.prompt, /"options": \[[\s\S]*"approve"[\s\S]*what does approve change\?/);
  // A yes after a question confirms nothing: there was no pick to confirm.
  await t.pass(reply(OWNER_ID, thread, 'yes'));
  assert.deepEqual(of(t.log, 'decision.answered'), []);
  assert.equal(inThread(t, thread).at(-1), askBack(['approve', 'revise', 'reject']));
});

test('thread: an answer that fails the checks (a link, a level the record lacks, a claim it is decided) is never posted', async () => {
  for (const answer of ['See http://example-mirror.test/x', 'It is only L1.', "I've approved it for you.", 'Ping <@100000000002> about it.']) {
    const t = setup({ [THREAD_ROLE]: () => ({ intent: 'question', answer }) });
    await moneyPlan(t);
    await t.pass();
    const thread = t.chat.threads[0]!.id;
    await t.pass(reply(OWNER_ID, thread, 'what does this change?'));
    assert.ok(!inThread(t, thread).includes(answer), answer);
    assert.equal(inThread(t, thread).at(-1), askBack(['approve', 'revise', 'reject']), answer);
    assert.deepEqual(of(t.log, 'decision.answered'), [], answer);
  }
});

// ---------------------------------------------------------------- 3. natural-language answers

test('thread: "yeah approve it" asks back "Confirm: approve?"; another person\'s yes doesn\'t count; only the same person\'s following yes records it', async () => {
  const t = setup({ [THREAD_ROLE]: (req) => (/yeah approve it/.test(req.prompt) ? { intent: 'choice', option: 'approve' } : { intent: 'other' }) });
  await moneyPlan(t);
  await t.pass();
  const thread = t.chat.threads[0]!.id;
  await t.pass(reply(OWNER_ID, thread, 'yeah approve it'));
  assert.deepEqual(of(t.log, 'decision.answered'), [], 'not yet');
  assert.match(inThread(t, thread).at(-1)!, /^Confirm: approve\? Reply \*\*yes\*\* to record it/);
  // Another admin's yes: not theirs to confirm.
  await t.pass(reply(COFOUNDER_ID, thread, 'yes'));
  assert.deepEqual(of(t.log, 'decision.answered'), [], "another person's yes records nothing");
  assert.match(inThread(t, thread).at(-1)!, /Only @example-owner can confirm their pick \(approve\); nothing is answered/);
  // The same person's yes: recorded through the decide path, audited via discord.
  await t.pass(reply(OWNER_ID, thread, 'yes'));
  assert.deepEqual(of(t.log, 'decision.answered'), [{ id: 'd-plan', by: 'example-owner', answer: 'approve', role: 'owner' }]);
  assert.deepEqual(of(t.log, 'dashboard.audit').map((a) => [a.login, a.via, a.action]), [['example-owner', 'discord', 'decision.answered']]);
  assert.match(inThread(t, thread).at(-1)!, /Decided: approve, by @example-owner/);
  assert.deepEqual(of(t.log, 'discord.confirm').map((p) => [p.by, p.option, p.stage]), [['example-owner', 'approve', 'asked'], ['example-owner', 'approve', 'confirmed']]);
  // First answer wins: a later pick is refused, naming who decided.
  await t.pass(reply(COFOUNDER_ID, thread, 'reject'));
  assert.equal(of(t.log, 'decision.answered').length, 1);
  assert.match(inThread(t, thread).at(-1)!, /already decided by @example-owner \(approve\)/);
});

test('thread: a pick is dropped by anything but a yes from its person, and exact option words still answer directly with no model run', async () => {
  const t = setup({ [THREAD_ROLE]: (req) => (/second one/.test(req.prompt) ? { intent: 'choice', option: 'revise' } : { intent: 'other' }) });
  await moneyPlan(t);
  await t.pass();
  const thread = t.chat.threads[0]!.id;
  await t.pass(reply(OWNER_ID, thread, 'go with the second one'));
  await t.pass(reply(OWNER_ID, thread, 'hmm, actually let me think about this more'));
  assert.equal(of(t.log, 'discord.confirm').at(-1)!.stage, 'dropped');
  await t.pass(reply(OWNER_ID, thread, 'yes'));
  assert.deepEqual(of(t.log, 'decision.answered'), [], 'the yes came after something else: no pick to confirm');
  const runs = t.runsOf(THREAD_ROLE).length;
  await t.pass(reply(OWNER_ID, thread, 'Reject.'));
  assert.deepEqual(of(t.log, 'decision.answered').map((a) => a.answer), ['reject']);
  assert.equal(t.runsOf(THREAD_ROLE).length, runs, 'exact words need no run');
});

test("thread: a writer's plain-language pick on an owner decision is a comment, never a confirmation", async () => {
  const t = setup({ [THREAD_ROLE]: () => ({ intent: 'choice', option: 'approve' }) });
  await moneyPlan(t);
  await t.pass();
  const thread = t.chat.threads[0]!.id;
  await t.pass(reply(TEAMMATE_ID, thread, 'yeah approve it'));
  await t.pass(reply(TEAMMATE_ID, thread, 'yes'));
  assert.deepEqual(of(t.log, 'decision.answered'), []);
  assert.deepEqual(of(t.log, 'discord.confirm'), []);
  assert.deepEqual(of(t.log, 'discord.reply').map((p) => p.outcome), ['comment', 'ambiguous'], 'the pick is a comment; a bare yes with nothing to confirm is asked back');
});

test('thread: a setup question ask works the same way: summary, then a pick confirmed by the same person', async () => {
  const t = setup({ [SUMMARY_ROLE]: () => ({ problem: 'Pick the region.', found: '', options: [{ name: 'eu', effect: 'Runs in the EU.' }, { name: 'us', effect: 'Runs in the US.' }], recommendation: { option: 'none', why: '' }, risk: { level: 'none', why: '' } }), [THREAD_ROLE]: () => ({ intent: 'choice', option: 'eu' }) });
  const a = asks(t.log).create({ instance: 'example', title: 'Which region for the database?', detail: 'Pick where it runs.', kind: 'question', options: ['eu', 'us'] }, 'coordinator');
  await t.pass();
  const thread = t.chat.threads[0]!.id;
  assert.ok(inThread(t, thread).join('\n').includes('**eu**: Runs in the EU.'));
  await t.pass(reply(OWNER_ID, thread, 'eu sounds right to me'));
  await t.pass(reply(OWNER_ID, thread, 'yes'));
  const answered = t.log.read(0, ['ask.answered']).map((e) => e.payload as { id: string; by: string; answer: string });
  assert.deepEqual(answered.map((x) => [x.id, x.by, x.answer]), [[a.id, 'example-owner', 'eu']]);
  assert.deepEqual(of(t.log, 'dashboard.audit').map((x) => [x.via, x.action]), [['discord', 'ask.answered']]);
});

// ---------------------------------------------------------------- 4. unchanged

test('unchanged: a high-risk land is still notice-only: no thread, no summary, and no reply anywhere answers it', async () => {
  const t = setup({ [SUMMARY_ROLE]: () => goodSummary(7), [THREAD_ROLE]: () => ({ intent: 'choice', option: 'approve' }) });
  t.log.append('decision.asked', { id: 'd-land', kind: 'land', issue: 7, owner: 'example-owner', question: 'Land #7?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'coordinator');
  await t.pass();
  assert.equal(t.chat.threads.length, 0);
  assert.equal(t.runsOf(SUMMARY_ROLE).length, 0, 'never explained');
  // A thread forged into the record answers nothing, in exact or plain words, and runs nothing.
  t.log.append('discord.posted', { key: 'decision:d-land', thread: '777777', ok: true }, 'coordinator');
  await t.pass(reply(OWNER_ID, '777777', 'yeah approve it'), reply(OWNER_ID, '777777', 'yes'), reply(OWNER_ID, '777777', 'approve'));
  assert.deepEqual(of(t.log, 'decision.answered'), []);
  assert.deepEqual(of(t.log, 'discord.confirm'), []);
  assert.deepEqual(of(t.log, 'discord.reply').map((p) => p.outcome), ['refused', 'refused', 'refused']);
  assert.equal(t.runsOf(THREAD_ROLE).length + t.runsOf(SUMMARY_ROLE).length, 0);
});

test('unchanged: a secret or root-step ask still posts only the dashboard link, with no summary', async () => {
  const t = setup({ [SUMMARY_ROLE]: () => goodSummary(1) });
  asks(t.log).create({ instance: 'example', title: 'Paste the payment key', detail: 'From the provider console.', kind: 'paste_secret', credential: 'pay-key', where: 'file' }, 'coordinator');
  await t.pass();
  assert.deepEqual(t.chat.posts.map((p) => p.text), [`A setup step needs you on the dashboard: ${DASH}/setup`]);
  assert.equal(t.runsOf(SUMMARY_ROLE).length, 0);
});

// ---------------------------------------------------------------- 5. costs

test("costs: summaries and thread runs count against intake.max_usd_per_day; over it, the template and an ask-back, with no run", async () => {
  let issue = 0;
  const t = setup({ [SUMMARY_ROLE]: () => goodSummary(issue), [THREAD_ROLE]: () => ({ intent: 'choice', option: 'approve' }) }, { costUsd: 0.3 });
  issue = await moneyPlan(t);
  await t.pass();
  const meter = () => new IntakeMeter(t.stateDir, { reports_per_sender_per_day: 10, drafts_per_day: 20, max_usd_per_day: 2 });
  assert.deepEqual(of(t.log, 'run.cost').map((c) => [c.role, c.usd]), [[SUMMARY_ROLE, 0.3]], 'recorded as spend');
  // Spend the rest of intake's day.
  meter().recordSpend(1.8);
  assert.equal(meter().canDraft().ok, false);
  t.log.append('decision.asked', { id: 'd-q', kind: 'question', issue: null, owner: 'example-owner', question: 'Dark mode: system or toggle?', options: ['system', 'toggle'], recommendation: 'system', receipts: [] }, 'coordinator');
  await t.pass();
  const second = t.chat.threads[1]!.id;
  assert.equal(t.runsOf(SUMMARY_ROLE).length, 1, 'no summary run over the cap');
  assert.match(inThread(t, second)[0]!, /^Decision needed \(question\)[\s\S]*Details on the dashboard/);
  assert.match(String(of(t.log, 'discord.explained').at(-1)!.why), /spend cap/);
  await t.pass(reply(OWNER_ID, second, 'yeah go with system'));
  assert.equal(t.runsOf(THREAD_ROLE).length, 0, 'no thread run over the cap');
  assert.match(inThread(t, second).at(-1)!, /I can't answer that here right now[\s\S]*Reply with exactly one of: system \/ toggle/);
  assert.deepEqual(of(t.log, 'decision.answered'), []);
});
