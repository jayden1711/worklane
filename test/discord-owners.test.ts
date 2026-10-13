// Discord as the owner's complete channel (docs/intake.md 2.1.4-2.1.6): high-risk (L3) approvals by the owners listed
// in discord.owners, naming the number; setup steps' one-time dashboard links by DM; one bot token for several
// instances on one machine, each in its own server and channels. Discord itself is never called: a fake source, or
// the real adapter with a fake socket and fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { asks } from '../src/console/asks.js';
import { issueSetupLink, useSetupLink, LINK_TTL_MS } from '../src/console/links.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { parseHighRisk } from '../src/intake/channel.js';
import { claimDiscord, discordClash, writeDiscordClaim } from '../src/intake/discord-claims.js';
import { identifyGate, IDENTIFY_SPACING_MS } from '../src/intake/discord-gate.js';
import { DiscordIntake, type Socket } from '../src/intake/discord.js';
import { mayApproveHighRisk } from '../src/intake/people.js';
import { IntakeConfig, type IncomingReport, type IntakeSource, type ReplyOptions } from '../src/intake/report.js';
import { intakeForInstance } from '../src/intake/wire.js';
import { FakeRunner } from '../src/runner.js';
import { asPerson, repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Placeholder ids and logins only.
const OWNER_ID = '100000000001';
const COFOUNDER_ID = '100000000002';
const TEAMMATE_ID = '100000000003';
const ADMIN_ID = '100000000006';
const ASKS_CHANNEL = '200000000001';
const GUILD_A = '300000000001';
const GUILD_B = '300000000002';
const DASH = 'https://dashboard.example.test';

/** Two listed owners (admins) and a listed writer (whom the start-up check would refuse); one admin not listed. */
const CONFIG = IntakeConfig.parse({
  version: 1,
  discord: {
    enabled: true,
    guild: GUILD_A,
    channels: ['111111'],
    allowed_senders: [OWNER_ID, COFOUNDER_ID, TEAMMATE_ID, ADMIN_ID],
    people: { [OWNER_ID]: 'example-owner', [COFOUNDER_ID]: 'example-cofounder', [TEAMMATE_ID]: 'example-collaborator', [ADMIN_ID]: 'example-admin' },
    owners: [OWNER_ID, COFOUNDER_ID, TEAMMATE_ID],
    asks_channel: ASKS_CHANNEL,
    dashboard_url: DASH,
  },
});

const ROLES: Record<string, 'owner' | 'writer' | 'viewer'> = { 'example-owner': 'owner', 'example-cofounder': 'owner', 'example-admin': 'owner', 'example-collaborator': 'writer' };
const roleOf = async (login: string) => ROLES[login.toLowerCase()] ?? 'viewer';

class FakeSocket implements Socket {
  sent: { op: number; d: unknown }[] = [];
  private fns: Record<string, ((ev: { data?: unknown; code?: number }) => void)[]> = {};
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  addEventListener(type: string, fn: (ev: { data?: unknown; code?: number }) => void) {
    (this.fns[type] ??= []).push(fn);
  }
  frame(f: object) {
    for (const fn of this.fns.message ?? []) fn({ data: JSON.stringify(f) });
  }
}

/** A chat source that records every post (with its mentions), thread and DM. */
function fakeChat() {
  const posts: { where: string; text: string; mentions: string[] }[] = [];
  const threads: { channel: string; text: string; name: string; id: string }[] = [];
  const dms: { user: string; text: string }[] = [];
  const batches: IncomingReport[][] = [];
  const src: IntakeSource & { posts: typeof posts; threads: typeof threads; dms: typeof dms; batches: typeof batches } = {
    name: 'discord',
    posts,
    threads,
    dms,
    batches,
    take: async () => batches.shift() ?? [],
    reply: async (t, text, opts?: ReplyOptions) => (posts.push({ where: t.id, text, mentions: opts?.mentions ?? [] }), true),
    openThread: async (channel, text, name) => {
      const id = String(900000 + threads.length);
      threads.push({ channel, text, name, id });
      return id;
    },
    watch: () => {},
    dm: async (user, text) => (dms.push({ user, text }), true),
  };
  return src;
}

function setup(o: { source?: IntakeSource; config?: IntakeConfig } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'owner-channel-'));
  const repo = join(base, 'checkout');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const cfg = loadConfig(repo);
  cfg.project.required_checks = ['ci'];
  cfg.project.combined_check = false;
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const eventsDb = join(base, 'events.db');
  const log = new EventLog(eventsDb);
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  const chat = fakeChat();
  const source = o.source ?? chat;
  const c = new Coordinator({
    cfg,
    log,
    backlog,
    runner: new FakeRunner(() => ({ structured: { kind: 'needs_info' } })),
    repo,
    instance: 'example',
    stateDir,
    slotsDir,
    machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) },
    settings: () => ({ settings: {}, error: null }),
    intake: { config: () => o.config ?? CONFIG, sources: [source], pullMs: 0, roleOf, name: 'example' },
  });
  const pass = async (...msgs: IncomingReport[]) => {
    if (source === chat) chat.batches.push(msgs);
    await c.checkIntake();
  };
  const watchPrs = () => (c as unknown as { watchPrs(): Promise<void> }).watchPrs();
  return { base, repo, cfg, log, eventsDb, backlog, stateDir, slotsDir, c, chat, pass, watchPrs };
}

let seq = 0;
const reply = (from: string, thread: string, text: string): IncomingReport => ({
  source: 'discord',
  sourceId: `4000000000${++seq}`,
  sender: { source: 'discord', id: from },
  text,
  receivedAt: '2026-10-01T10:00:00.000Z',
  thread: { kind: 'thread', id: thread },
});
const landAsk = (log: EventLog, id: string, issue: number) =>
  log.append('decision.asked', { id, kind: 'land', issue, owner: 'example-owner', question: `Approve landing #${issue} (L3)?`, options: ['approve', 'reject'], recommendation: 'approve', receipts: ['head aaaaaaaa'] }, 'coordinator');
const of = (log: EventLog, type: string) => log.read(0, [type as never]).map((e) => e.payload as Record<string, unknown>);

/** A PR this instance opened, ready (evaluator approved, its required check green), that the merge policy left to an owner. */
async function waitingPr(t: ReturnType<typeof setup>) {
  const issue = await t.backlog.createIssue('Change the payout rounding', 'body', ['ready']);
  const head = 'a'.repeat(40);
  const pr = await t.backlog.openPr('wl/issue-1', 'main', 'Change the payout rounding (#1)', 'body', { headSha: head });
  t.log.append('pr.opened', { issue, number: pr.number, url: pr.url, head, draft: false }, 'coordinator');
  t.log.append('eval.verdict', { issue, head, patch_hash: 'p', patch_correct: true, test_correct: true, confidence: 'high', advice: '' }, 'coordinator');
  t.backlog.setChecks(head, [{ name: 'ci', source: 'check_run', status: 'completed', conclusion: 'success', id: 1 }]);
  t.log.append('merge.decided', { issue, number: pr.number, head, auto: false, reasons: ['high-risk: money path (src/payout.js)'] }, 'coordinator');
  await t.pass();
  const thread = t.chat.threads.find((x) => x.name === `merge #${pr.number}`);
  assert.ok(thread, 'the waiting PR has its own thread');
  return { issue, number: pr.number, head, thread: thread.id };
}

// ---------------------------------------------------------------- 1. high-risk approvals

test('owners: an L3 approval needs the number and an owner; plain "approve" is asked back; it is audited via discord', async () => {
  const t = setup();
  landAsk(t.log, 'd-land', 7);
  await t.pass();
  const th = t.chat.threads.find((x) => x.name === 'high-risk merge #7');
  assert.ok(th, 'with discord.owners, a high-risk merge gets a thread');
  assert.match(th.text, /exactly "approve 7"/);
  await t.pass(reply(OWNER_ID, th.id, 'approve'));
  assert.deepEqual(of(t.log, 'decision.answered'), [], 'a plain approve approves nothing');
  assert.match(t.chat.posts.at(-1)!.text, /Reply with exactly "approve 7"/);
  await t.pass(reply(OWNER_ID, th.id, 'Approve #7.'));
  assert.deepEqual(of(t.log, 'decision.answered'), [{ id: 'd-land', by: 'example-owner', answer: 'approve', role: 'owner' }]);
  assert.deepEqual(of(t.log, 'dashboard.audit').map((p) => [p.login, p.via, p.action]), [['example-owner', 'discord', 'decision.answered']]);
  assert.deepEqual(parseHighRisk('approve'), { act: 'approve', number: null });
  assert.deepEqual(parseHighRisk('/wl approve PR #12'), { act: 'approve', number: 12 });
  assert.equal(parseHighRisk('approve 12 and 13'), null);
});

test("owners: a non-owner's approve is refused, and a mapped writer can't approve L3 even when listed: their reply is a comment", async () => {
  const t = setup();
  const issue = await t.backlog.createIssue('Payout rounding', 'body', ['ready']);
  landAsk(t.log, 'd-land', issue);
  await t.pass();
  const th = t.chat.threads.find((x) => x.name === `high-risk merge #${issue}`)!;
  // An admin of the repo, mapped, but not in discord.owners.
  await t.pass(reply(ADMIN_ID, th.id, `approve ${issue}`));
  // A writer listed in discord.owners (the start-up check refuses this; the reply is refused anyway).
  await t.pass(reply(TEAMMATE_ID, th.id, `approve ${issue}`));
  assert.deepEqual(of(t.log, 'decision.answered'), [], 'never an answer');
  assert.deepEqual(of(t.log, 'discord.reply').map((p) => [p.by, p.outcome]), [['example-admin', 'comment'], ['example-collaborator', 'comment']]);
  assert.match(t.chat.posts.at(-1)!.text, /Noted as a comment from @example-collaborator\. Only an owner listed for Discord approvals/);
  assert.equal(mayApproveHighRisk(CONFIG, ADMIN_ID, 'owner'), false);
  assert.equal(mayApproveHighRisk(CONFIG, TEAMMATE_ID, 'writer'), false);
  assert.equal(mayApproveHighRisk(CONFIG, OWNER_ID, 'owner'), true);
});

test('owners: once approved, every other owner is pinged in that thread (only there, only owners)', async () => {
  const t = setup();
  landAsk(t.log, 'd-land', 7);
  await t.pass();
  const th = t.chat.threads.find((x) => x.name === 'high-risk merge #7')!;
  const before = t.chat.posts.length;
  await t.pass(reply(COFOUNDER_ID, th.id, 'approve 7'));
  const pinged = t.chat.posts.slice(before).filter((p) => p.mentions.length);
  assert.deepEqual(pinged.map((p) => [p.where, p.mentions]), [[th.id, [OWNER_ID, TEAMMATE_ID]]], 'the other listed owners, in the thread');
  assert.match(pinged[0]!.text, /Approved by @example-cofounder/);
  assert.ok(t.chat.posts.slice(0, before).every((p) => !p.mentions.length), 'no other post pings anyone');

  // The adapter itself pings only discord.owners, and only in its own threads.
  const bodies: { url: string; body: { content: string; allowed_mentions: { parse: string[]; users?: string[] } } }[] = [];
  const net = (async (url: string, init: RequestInit) => (bodies.push({ url, body: JSON.parse(String(init.body)) }), { ok: true, json: async () => ({}) })) as unknown as typeof fetch;
  const d = new DiscordIntake({ token: 'tok', guild: GUILD_A, channels: ['111111'], allowedSenders: [OWNER_ID], prefixes: [], owners: [OWNER_ID, COFOUNDER_ID], fetch: net, connect: () => new FakeSocket(), setInterval: () => 1, clearInterval: () => {} });
  d.watch('900001');
  await d.reply('900001', 'Approved.', [COFOUNDER_ID, ADMIN_ID]);
  await d.reply('111111', 'In a channel.', [COFOUNDER_ID]);
  assert.deepEqual(bodies[0]!.body.allowed_mentions, { parse: [], users: [COFOUNDER_ID] }, 'a non-owner is never pinged');
  assert.match(bodies[0]!.body.content, new RegExp(`<@${COFOUNDER_ID}>$`));
  assert.deepEqual(bodies[1]!.body.allowed_mentions, { parse: [] }, 'outside its own thread, nobody');
});

test('owners: a wrong number or a stale head is refused, with the reason', async () => {
  const t = setup();
  landAsk(t.log, 'd-land', 7);
  await t.pass();
  const th = t.chat.threads.find((x) => x.name === 'high-risk merge #7')!;
  await t.pass(reply(OWNER_ID, th.id, 'approve 8'));
  assert.match(t.chat.posts.at(-1)!.text, /This thread is about #7, not #8; nothing is approved/);
  // The change was redone after the decision: its head is not the one decided on.
  t.log.append('review.level_set', { issue: 7, head: 'b'.repeat(40), level: 'L3', reasons: ['money path'] }, 'coordinator');
  await t.pass(reply(OWNER_ID, th.id, 'approve 7'));
  assert.match(t.chat.posts.at(-1)!.text, /Not approved: #7 was changed again since this decision \(a new head\)/);
  assert.deepEqual(of(t.log, 'decision.answered'), []);

  // A PR whose head moved since the decision.
  const p = setup();
  const w = await waitingPr(p);
  p.backlog.setPr(w.number, { headSha: 'c'.repeat(40) });
  await p.pass(reply(OWNER_ID, w.thread, `approve ${w.number}`));
  assert.match(p.chat.posts.at(-1)!.text, /Not approved: the head of PR #\d+ moved since the decision/);
  assert.deepEqual(of(p.log, 'merge.approved'), []);
});

test('owners: an approved PR merges through the normal merge path on the next pass; a stopped auto-merge (the main watch) refuses it', async () => {
  const stopped = setup();
  const s = await waitingPr(stopped);
  writeFileSync(join(stopped.stateDir, 'auto-merge-stopped.json'), JSON.stringify({ reason: 'main watch: an unaccounted commit' }));
  await stopped.pass(reply(OWNER_ID, s.thread, `approve ${s.number}`));
  assert.match(stopped.chat.posts.at(-1)!.text, /Not approved: auto-merge is stopped on this instance/);
  assert.deepEqual(of(stopped.log, 'merge.approved'), []);

  const t = setup();
  const w = await waitingPr(t);
  await t.watchPrs();
  assert.ok(!t.backlog.prs()[0]!.merged, 'waiting for an owner: not merged');
  await t.pass(reply(OWNER_ID, w.thread, `approve ${w.number}`));
  assert.deepEqual(of(t.log, 'merge.approved'), [{ issue: w.issue, number: w.number, head: w.head, by: 'example-owner', via: 'discord' }]);
  assert.deepEqual(of(t.log, 'dashboard.audit').map((p) => [p.login, p.via, p.action]), [['example-owner', 'discord', 'merge.approved']]);
  await t.watchPrs();
  assert.ok(t.backlog.prs()[0]!.merged, 'merged on the next pass');
  assert.deepEqual((of(t.log, 'merge.done')[0] as { head: string }).head, w.head, 'pinned to the approved head');
  assert.match(t.backlog.prs()[0]!.comments.at(-1)!.body, /Merged on @example-owner's approval \(an owner, from Discord; audited\)/);
  await t.pass();
  assert.match(t.chat.posts.at(-1)!.text, /Merged: PR #\d+ is on the default branch/);
  await t.pass(reply(COFOUNDER_ID, w.thread, `approve ${w.number}`));
  assert.match(t.chat.posts.at(-1)!.text, /already decided by @example-owner/);
});

// ---------------------------------------------------------------- 2. setup steps: a one-time link by DM

/** The real adapter over a fake socket and fetch, recording every request it makes. */
function adapter(owners: string[]) {
  const sock = new FakeSocket();
  const sent: { url: string; body: string }[] = [];
  let id = 600000;
  const net = (async (url: string, init: RequestInit) => (sent.push({ url, body: String(init.body ?? '') }), { ok: true, json: async () => ({ id: String(++id) }) })) as unknown as typeof fetch;
  const d = new DiscordIntake({ token: 'tok', guild: GUILD_A, channels: ['111111'], allowedSenders: [OWNER_ID, COFOUNDER_ID, ADMIN_ID], prefixes: [], owners, connect: () => sock, fetch: net, setInterval: () => 1, clearInterval: () => {} });
  d.start();
  const source: IntakeSource = { name: 'discord', take: async () => d.take(), reply: (t, text, o) => d.reply(t.id, text, o?.mentions), openThread: (c, text, name, from) => d.openThread(c, text, name, from), watch: (t) => d.watch(t), dm: (u, text) => d.dm(u, text) };
  const say = (from: string, channel: string, content: string, guild: string | null = GUILD_A) => sock.frame({ op: 0, s: ++seq, t: 'MESSAGE_CREATE', d: { id: String(700000 + ++seq), channel_id: channel, ...(guild ? { guild_id: guild } : {}), content, author: { id: from } } });
  return { d, sock, sent, source, say };
}

test('owners: a secret ask never posts its content to Discord; an owner who replies "link" gets a one-time link by DM, and nothing typed is kept', async () => {
  // Made at run time, so no secret-looking literal sits in the repo.
  const SECRET = `planted${randomBytes(12).toString('hex')}`;
  const a = adapter(CONFIG.discord.owners);
  const t = setup({ source: a.source });
  const ask = asks(t.log).create({ kind: 'paste_secret', instance: 'example', title: 'Paste the chat bot token', detail: `The value is ${SECRET}`, credential: 'intake-discord', where: `credentials.yaml ${SECRET}` });
  await t.pass();
  const thread = (of(t.log, 'discord.posted').find((p) => p.key === `ask:${ask.id}`) as { thread: string }).thread;
  assert.ok(thread, 'with discord.owners, the step has a thread to ask for the link in');
  // The owner types the secret there by mistake, a non-owner asks for the link, then the owner does.
  a.say(OWNER_ID, thread, SECRET);
  a.say(ADMIN_ID, thread, 'link');
  a.say(OWNER_ID, thread, 'link');
  await t.pass();
  const dms = a.sent.filter((s) => s.url.endsWith('/users/@me/channels'));
  assert.deepEqual(dms.map((s) => JSON.parse(s.body).recipient_id), [OWNER_ID], 'one DM, to the owner who asked');
  const dm = JSON.parse(a.sent[a.sent.indexOf(dms[0]!) + 1]!.body) as { content: string; allowed_mentions: unknown };
  const link = dm.content.match(new RegExp(`${DASH}/setup/link/example/([A-Za-z0-9_-]{43})`));
  assert.ok(link, `a link with the token in its path: ${dm.content}`);
  assert.doesNotMatch(dm.content, /\?/, 'no query a proxy could log');
  assert.match(dm.content, /"Paste the chat bot token"/, 'the title, and nothing else of the ask');
  assert.doesNotMatch(dm.content, /intake-discord|credentials\.yaml|The value/);
  // Nothing of the secret anywhere: not in any Discord payload, not in an event, not in the private raw store.
  const discord = [...a.sent.map((s) => `${s.url}\n${s.body}`), ...a.sock.sent.map((f) => JSON.stringify(f))].join('\n');
  assert.ok(!discord.includes(SECRET), 'never sent to Discord');
  const dmBody = a.sent[a.sent.indexOf(dms[0]!) + 1]!;
  assert.ok(a.sent.filter((s) => s !== dmBody).every((s) => !s.body.includes('Paste the chat bot token')), 'only the DM carries the title; no channel or thread post does');
  assert.ok(!JSON.stringify(t.log.read().filter((e) => e.type !== 'ask.created')).includes(SECRET), 'in no event');
  assert.ok(!JSON.stringify(t.log.read()).includes(link[1]!), 'the token itself is in no event (only its hash)');
  const raw = join(t.stateDir, 'intake', 'raw');
  assert.ok(!existsSync(raw) || readdirSync(raw).every((f) => !readFileSync(join(raw, f), 'utf8').includes(SECRET)), 'not kept privately either');
  assert.deepEqual(of(t.log, 'discord.reply').map((p) => [p.by, p.outcome, p.excerpt]), [['example-owner', 'ambiguous', null], ['example-admin', 'comment', null], ['example-owner', 'link', null]]);

  // The link opens that ask on the dashboard for that owner's own sign-in, once.
  const dash = await startDashboard({ root: t.repo, cfg: t.cfg, eventsDb: t.eventsDb, stateDir: t.stateDir, user: 'example-owner', roleOf, slotsDir: t.slotsDir, instance: 'example' });
  try {
    const post = (who: string, token: string) => fetch(`${dash.url.split('/?')[0]}/api/asks/link`, { method: 'POST', headers: { authorization: `Bearer ${dash.token}`, 'content-type': 'application/json', ...asPerson(who) }, body: JSON.stringify({ token }) });
    const r = await post('example-owner', link[1]!);
    assert.deepEqual([r.status, await r.json()], [200, { ok: true, ask: ask.id }]);
    const again = await post('example-owner', link[1]!);
    assert.equal(again.status, 410, 'single use');
    assert.doesNotMatch(JSON.stringify(await again.json()), new RegExp(link[1]!), 'no error quotes the token');
  } finally {
    await dash.close();
  }
});

test('owners: a used, expired or someone else\'s DM link is refused', () => {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'links-')), 'events.db'));
  const ask = asks(log).create({ kind: 'root_step', instance: 'example', title: 'Raise the slots', detail: 'more agents', command: 'set-slots', args: ['3'] });
  const now = Date.parse('2026-10-01T10:00:00Z');
  const a = issueSetupLink(log, { ask: ask.id, login: 'example-owner', now });
  assert.deepEqual(useSetupLink(log, { token: a.token, login: 'example-owner', role: 'owner', now: now + 60_000 }), { ok: true, ask: ask.id });
  assert.equal((useSetupLink(log, { token: a.token, login: 'example-owner', role: 'owner', now: now + 61_000 }) as { status: number }).status, 410, 'used');
  const b = issueSetupLink(log, { ask: ask.id, login: 'example-owner', now });
  assert.equal((useSetupLink(log, { token: b.token, login: 'example-owner', role: 'owner', now: now + LINK_TTL_MS }) as { status: number }).status, 410, 'expired');
  const c = issueSetupLink(log, { ask: ask.id, login: 'example-owner', now });
  assert.equal((useSetupLink(log, { token: c.token, login: 'example-cofounder', role: 'owner', now }) as { status: number }).status, 403, "another person's session");
  assert.equal((useSetupLink(log, { token: c.token, login: 'example-owner', role: 'owner', now }) as { status: number }).status, 410, 'and a refused presentation uses it up');
  const d = issueSetupLink(log, { ask: ask.id, login: 'example-owner', now });
  assert.equal((useSetupLink(log, { token: d.token, login: 'example-owner', role: 'writer', now }) as { status: number }).status, 403, 'not an owner now');
  assert.equal((useSetupLink(log, { token: 'x'.repeat(43), login: 'example-owner', role: 'owner', now }) as { status: number }).status, 404, 'unknown');
});

test('owners: the DM is outbound only; an incoming DM (a reply to it) is dropped on receipt', async () => {
  const a = adapter([OWNER_ID]);
  assert.equal(await a.d.dm(OWNER_ID, 'hello'), true);
  const dmChannel = String(600001);
  // A DM has no server.
  a.say(OWNER_ID, dmChannel, 'link', null);
  a.say(OWNER_ID, dmChannel, 'thanks', null);
  assert.deepEqual(a.d.take(), [], 'nothing taken');
  assert.equal(a.d.droppedBy.place, 2, 'dropped as a message from no server');
});

// ---------------------------------------------------------------- 3. one token, several instances

test('one token, two instances: each identifies on its own and acts only in its own server; other servers are dropped on receipt', async () => {
  const machine = mkdtempSync(join(tmpdir(), 'machine-'));
  let clock = 1_000_000;
  const sleep = async (ms: number) => void (clock += ms);
  const gateOf = () => identifyGate({ dir: machine, token: 'one-token', owner: 'test', now: () => clock, sleep, limit: async () => ({ remaining: 900, reset_after: 0, max_concurrency: 1 }) });
  const make = (guild: string) => {
    const sock = new FakeSocket();
    const d = new DiscordIntake({ token: 'one-token', guild, channels: ['111111'], allowedSenders: [OWNER_ID], prefixes: ['bug:'], gate: gateOf(), connect: () => sock, setInterval: () => 1, clearInterval: () => {} });
    d.start();
    return { d, sock };
  };
  const a = make(GUILD_A);
  const b = make(GUILD_B);
  a.sock.frame({ op: 10, d: { heartbeat_interval: 41250 } });
  b.sock.frame({ op: 10, d: { heartbeat_interval: 41250 } });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([a.d.identifies, b.d.identifies], [1, 1], 'each instance identifies separately');
  // The gateway delivers every server's events to every session on the token.
  for (const s of [a.sock, b.sock]) {
    s.frame({ op: 0, s: 1, t: 'GUILD_CREATE', d: { id: GUILD_B, guild_id: GUILD_B, name: 'other' } });
    s.frame({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { id: 'a1', channel_id: '111111', guild_id: GUILD_A, content: 'bug: in A', author: { id: OWNER_ID } } });
    s.frame({ op: 0, s: 3, t: 'MESSAGE_CREATE', d: { id: 'b1', channel_id: '111111', guild_id: GUILD_B, content: 'bug: in B', author: { id: OWNER_ID } } });
    s.frame({ op: 0, s: 4, t: 'MESSAGE_CREATE', d: { id: 'b2', channel_id: '111111', guild_id: GUILD_B, content: 'bug: from a stranger in B', author: { id: '199999999999' } } });
  }
  assert.deepEqual(a.d.take().map((r) => r.text), ['in A']);
  assert.deepEqual(b.d.take().map((r) => r.text), ['in B']);
  // Another server's events are dropped on their server alone, before the sender is even looked at.
  assert.deepEqual([a.d.droppedBy.place, a.d.droppedBy.sender], [3, 0]);
  assert.deepEqual([b.d.droppedBy.place, b.d.droppedBy.sender], [1, 1]);
});

test('identify gate: identifies on one token are serialised machine-wide, at least 5 s apart; no session starts left, none', async () => {
  const machine = mkdtempSync(join(tmpdir(), 'machine-'));
  let clock = 1_000_000;
  const at: number[] = [];
  const sleep = async (ms: number) => {
    await new Promise((r) => setTimeout(r, 1));
    clock += ms;
  };
  // `limit` is asked inside the lock, right before the identify is let go: when each identify happens.
  const gate = (token: string, remaining = 900, rec: number[] = []) => identifyGate({ dir: machine, token, owner: 'test', now: () => clock, sleep, limit: async () => (rec.push(clock), { remaining, reset_after: 3_600_000, max_concurrency: 1 }) });
  const results = await Promise.all([1, 2, 3].map(() => gate('one-token', 900, at)()));
  assert.ok(results.every((r) => r.ok));
  at.sort((x, y) => x - y);
  assert.ok(at[1]! - at[0]! >= IDENTIFY_SPACING_MS && at[2]! - at[1]! >= IDENTIFY_SPACING_MS, `spaced: ${at.map((x) => x - at[0]!).join(', ')}`);
  assert.ok(!readFileSync(join(machine, 'discord-identify.json'), 'utf8').includes('one-token'), 'the state keys a hash, never the token');
  const t0 = clock;
  assert.ok((await gate('another-token')()).ok);
  assert.equal(clock, t0, 'another bot is not held back');
  const none = await gate('third-token', 0)();
  assert.deepEqual(none, { ok: false, retryInMs: 3_600_000, why: 'the daily session start limit is used up' });
});

// ---------------------------------------------------------------- start-up checks

const intakeYaml = (o: { guild: string; channels: string[]; owners?: string[] }) =>
  `version: 1\ndiscord:\n  enabled: true\n  guild: "${o.guild}"\n  channels: [${o.channels.map((c) => `"${c}"`).join(', ')}]\n  allowed_senders: ["${OWNER_ID}", "${TEAMMATE_ID}"]\n  people: { "${OWNER_ID}": example-owner, "${TEAMMATE_ID}": example-collaborator }\n  owners: [${(o.owners ?? [OWNER_ID]).map((c) => `"${c}"`).join(', ')}]\n`;

function instances(names: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'instances-'));
  const machine = mkdtempSync(join(tmpdir(), 'machine-'));
  const token = join(dir, 'token');
  writeFileSync(token, 'one-token\n', { mode: 0o400 });
  for (const [name, yaml] of Object.entries(names)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'intake.yaml'), yaml, { mode: 0o600 });
  }
  const seen = { connects: 0 };
  const wire = (name: string, log: (l: string) => void = () => {}) =>
    intakeForInstance({ home: join(dir, name), repo: 'example/shop', instance: name, tokenFile: token, githubToken: async () => 'unused', machineDir: machine, roleOf, discord: { connect: () => (seen.connects++, new FakeSocket()), setInterval: () => 1, clearInterval: () => {} }, log })!;
  return { dir, machine, wire, seen };
}

test('start-up: a guild+channel clash between two instances on the machine is refused; the same guild with different channels is fine', async () => {
  const m = instances({ shop: intakeYaml({ guild: GUILD_A, channels: ['111111'] }), docs: intakeYaml({ guild: GUILD_A, channels: ['222222'] }), copy: intakeYaml({ guild: GUILD_A, channels: ['111111'] }) });
  const said: string[] = [];
  const shop = m.wire('shop', (l) => said.push(l));
  assert.match((await shop.start())!, /instance "copy" \(its intake\.yaml\) also acts in server \d+, channel 111111/);
  assert.deepEqual(shop.sources, [], 'refused: no Discord source');
  assert.match(said.join('\n'), /discord not started: /);
  const docs = m.wire('docs');
  assert.equal(await docs.start(), null, 'same server, its own channels');
  assert.equal(m.seen.connects, 1);
  docs.stop();

  // Across coordinator users (whose homes are private to each other): a running bot's claim in the machine directory.
  const solo = instances({ shop: intakeYaml({ guild: GUILD_A, channels: ['111111'] }) });
  const cfg = IntakeConfig.parse({ version: 1, discord: { enabled: true, guild: GUILD_A, channels: ['333333'], asks_channel: '111111', dashboard_url: DASH } });
  const release = writeDiscordClaim({ instance: 'elsewhere', config: cfg, claimsDir: solo.machine });
  assert.ok(!readFileSync(join(solo.machine, 'discord-claim-elsewhere.json'), 'utf8').includes('111111'), 'a claim names no id');
  assert.match((await solo.wire('shop').start())!, /instance "elsewhere" \(its running bot\) also acts in server \d+, channel 111111/);
  release();
  assert.equal(await solo.wire('shop').start(), null, 'once that bot stops, it starts');
  writeDiscordClaim({ instance: 'elsewhere', config: cfg, claimsDir: solo.machine });
  assert.equal(discordClash({ instance: 'x', config: cfg, instancesDir: mkdtempSync(join(tmpdir(), 'none-')), claimsDir: solo.machine, alive: () => false }), null, "a dead process's claim is stale");
  const both = await Promise.all([claimDiscord({ instance: 'one', config: cfg, instancesDir: mkdtempSync(join(tmpdir(), 'none-')), claimsDir: mkdtempSync(join(tmpdir(), 'claims-')) })]);
  assert.ok('release' in both[0]!);
});

test("start-up: a discord.owners entry not mapped to a GitHub admin is refused with a clear message; an unmapped one is a config error", async () => {
  const m = instances({ shop: intakeYaml({ guild: GUILD_A, channels: ['111111'], owners: [OWNER_ID, TEAMMATE_ID] }) });
  const w = m.wire('shop');
  assert.match((await w.start())!, new RegExp(`discord.owners: ${TEAMMATE_ID} maps to @example-collaborator, who is a writer on example/shop, not an admin`));
  assert.deepEqual(w.sources, []);
  assert.equal(m.seen.connects, 0, 'never connected');
  const bad = IntakeConfig.safeParse({ version: 1, discord: { enabled: true, guild: GUILD_A, allowed_senders: [OWNER_ID], owners: [OWNER_ID] } });
  assert.ok(!bad.success);
  assert.match(bad.error.issues.map((i) => i.message).join(), /in discord.owners but not mapped to a GitHub login/);
});
