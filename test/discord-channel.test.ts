// The chat channel (src/coordinator/channel.ts): decisions and asks posted in Discord threads, answered by a reply
// there through the dashboard's own decide path. Discord itself is never called: a fake source, or the real
// adapter with a fake socket and fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { asks } from '../src/console/asks.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { askBack, parseChoice } from '../src/intake/channel.js';
import { DiscordIntake, type Socket } from '../src/intake/discord.js';
import { mayAnswerFromChat } from '../src/intake/people.js';
import { loadIntakeConfig } from '../src/intake/config.js';
import { IntakeConfig, type IncomingReport, type IntakeSource } from '../src/intake/report.js';
import { FakeRunner } from '../src/runner.js';
import { asPerson, repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Placeholder ids and logins only.
const OWNER_ID = '100000000001';
const COFOUNDER_ID = '100000000002';
const TEAMMATE_ID = '100000000003';
const UNMAPPED_ID = '100000000004';
const STRANGER_ID = '100000000005';
const ASKS_CHANNEL = '200000000001';
const DASH = 'https://dashboard.example.test';

const CONFIG = IntakeConfig.parse({
  version: 1,
  discord: {
    enabled: true,
    guild: '555555',
    channels: ['111111'],
    allowed_senders: [OWNER_ID, COFOUNDER_ID, TEAMMATE_ID, UNMAPPED_ID],
    people: { [OWNER_ID]: 'example-owner', [COFOUNDER_ID]: 'example-cofounder', [TEAMMATE_ID]: 'example-collaborator' },
    asks_channel: ASKS_CHANNEL,
    dashboard_url: DASH,
  },
});

class FakeSocketImpl implements Socket {
  sent: { op: number; d: unknown }[] = [];
  private fns: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void) {
    (this.fns[type] ??= []).push(fn);
  }
  frame(f: object) {
    for (const fn of this.fns.message ?? []) fn({ data: JSON.stringify(f) });
  }
}

/** Roles as the repo would give them: two admins, a writer, everyone else a viewer. */
const ROLES: Record<string, 'owner' | 'writer' | 'viewer'> = { 'example-owner': 'owner', 'example-cofounder': 'owner', 'example-collaborator': 'writer' };
const roleOf = async (login: string) => ROLES[login.toLowerCase()] ?? 'viewer';

/** A chat source that records every post and thread, and hands out one batch per pull. */
function fakeChat(batches: IncomingReport[][]) {
  const posts: { where: string; text: string }[] = [];
  const threads: { channel: string; text: string; name: string; id: string }[] = [];
  const watched = new Set<string>();
  const src: IntakeSource & { posts: typeof posts; threads: typeof threads; watched: Set<string>; batches: IncomingReport[][]; takes: number } = {
    name: 'discord',
    takes: 0,
    posts,
    threads,
    watched,
    batches,
    take: async () => (src.takes++, batches.shift() ?? []),
    reply: async (t, text) => (posts.push({ where: t.id, text }), true),
    openThread: async (channel, text, name) => {
      const id = String(900000 + threads.length);
      threads.push({ channel, text, name, id });
      watched.add(id);
      return id;
    },
    watch: (t) => void watched.add(t),
  };
  return src;
}

function setup(o: { source?: IntakeSource; config?: IntakeConfig | null } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'chat-channel-'));
  const repo = join(base, 'checkout');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const cfg = loadConfig(repo);
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const eventsDb = join(base, 'events.db');
  const log = new EventLog(eventsDb);
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  const chat = fakeChat([]);
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
    intake: { config: () => (o.config === undefined ? CONFIG : o.config), sources: [source], pullMs: 0, roleOf },
  });
  /** One intake pass, with these messages arriving first. */
  const pass = async (...msgs: IncomingReport[]) => {
    if ('batches' in source) (source as ReturnType<typeof fakeChat>).batches.push(msgs);
    await c.checkIntake();
  };
  return { base, repo, cfg, log, eventsDb, backlog, stateDir, slotsDir, c, chat, pass };
}

let seq = 0;
const reply = (from: string, thread: string, text: string): IncomingReport => ({
  source: 'discord',
  sourceId: `3000000000${++seq}`,
  sender: { source: 'discord', id: from },
  text,
  receivedAt: '2026-10-01T10:00:00.000Z',
  thread: { kind: 'thread', id: thread },
});

const ask = (log: EventLog, id: string, kind: 'plan' | 'question' | 'land', issue: number | null = null, options = kind === 'plan' ? ['approve', 'revise', 'reject'] : ['approve', 'reject']) =>
  log.append('decision.asked', { id, kind, issue, owner: 'example-owner', question: `Should we go ahead with ${id}?`, options, recommendation: options[0]!, receipts: [] }, 'coordinator');
const of = (log: EventLog, type: 'decision.answered' | 'discord.reply' | 'dashboard.audit' | 'discord.posted') => log.read(0, [type]).map((e) => e.payload as Record<string, unknown>);
const rawFiles = (stateDir: string) => (existsSync(join(stateDir, 'intake', 'raw')) ? readdirSync(join(stateDir, 'intake', 'raw')) : []);

test('channel: an open decision posts in its own thread, with its question and exact options', async () => {
  const t = setup();
  ask(t.log, 'd-q', 'question');
  await t.pass();
  assert.equal(t.chat.threads.length, 1);
  assert.equal(t.chat.threads[0]!.channel, ASKS_CHANNEL);
  assert.match(t.chat.threads[0]!.text, /Should we go ahead with d-q\?[\s\S]*Options: approve \/ reject/);
  await t.pass();
  assert.equal(t.chat.threads.length, 1, 'posted once, however many passes');
});

test('channel: a non-allowed sender is ignored, with nothing stored (the adapter drops it; the coordinator never stores it)', async () => {
  // The adapter: a message in one of its own threads, from someone not allowed, is dropped on their id alone.
  const sock = new FakeSocketImpl();
  const d = new DiscordIntake({ token: 'tok', guild: '555555', channels: ['111111'], allowedSenders: [OWNER_ID], prefixes: ['bug:'], connect: () => sock, setInterval: () => 1, clearInterval: () => {} });
  d.start();
  d.watch('900000');
  sock.frame({ op: 0, s: 1, t: 'MESSAGE_CREATE', d: { id: '41', channel_id: '900000', guild_id: '555555', content: 'approve', author: { id: STRANGER_ID } } });
  sock.frame({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { id: '42', channel_id: '900000', guild_id: '555555', content: 'approve', author: { id: OWNER_ID } } });
  assert.deepEqual(d.take().map((r) => [r.sender.id, r.thread]), [[OWNER_ID, { kind: 'thread', id: '900000' }]], "only the allowed sender's reply is taken, and in a thread it needs no prefix");
  assert.equal(d.droppedBy.sender, 1);

  // The coordinator: a stranger's reply that reached it anyway, and an allowed but unmapped sender's, store nothing.
  const t = setup();
  ask(t.log, 'd-q', 'question');
  await t.pass();
  const thread = t.chat.threads[0]!.id;
  const before = t.log.read().length;
  const postsBefore = t.chat.posts.length;
  await t.pass(reply(STRANGER_ID, thread, 'approve'), reply(UNMAPPED_ID, thread, 'approve'));
  assert.deepEqual(rawFiles(t.stateDir), [], 'no raw file');
  assert.deepEqual(of(t.log, 'decision.answered'), [], 'no answer');
  assert.deepEqual(of(t.log, 'discord.reply'), [], 'no record of what they said');
  assert.deepEqual(t.chat.posts.slice(postsBefore), [], 'no reply to them');
  assert.deepEqual(t.log.read().slice(before).map((e) => e.type).filter((x) => x !== 'coordinator.tick'), [], 'no event at all');
});

test("channel: a teammate (writer) can't answer an owner decision; their reply is kept as a comment", async () => {
  const t = setup();
  const issue = await t.backlog.createIssue('Plan the export', 'body', ['ready']);
  ask(t.log, 'd-plan', 'plan', issue);
  await t.pass();
  const thread = t.chat.threads[0]!.id;
  await t.pass(reply(TEAMMATE_ID, thread, 'approve, ship it'));
  assert.deepEqual(of(t.log, 'decision.answered'), [], 'not an answer');
  assert.deepEqual(of(t.log, 'discord.reply').map((p) => [p.by, p.outcome, p.excerpt]), [['example-collaborator', 'comment', 'approve, ship it']]);
  assert.match((await t.backlog.comments(issue)).at(-1)!.body, /@example-collaborator commented in chat on decision d-plan \(a comment, not an answer\)/);
  assert.match(t.chat.posts.at(-1)!.text, /Noted as a comment from @example-collaborator\. Only an admin can answer/);
  // The same writer answers a writer-level question.
  ask(t.log, 'd-q', 'question');
  await t.pass();
  await t.pass(reply(TEAMMATE_ID, t.chat.threads[1]!.id, 'reject'));
  assert.deepEqual(of(t.log, 'decision.answered').map((p) => [p.id, p.by, p.answer, p.role]), [['d-q', 'example-collaborator', 'reject', 'writer']]);
});

test('channel: a mapped admin cofounder answers an owner decision, audited as from discord', async () => {
  const t = setup();
  ask(t.log, 'd-plan', 'plan');
  await t.pass();
  await t.pass(reply(COFOUNDER_ID, t.chat.threads[0]!.id, 'Approve.'));
  assert.deepEqual(of(t.log, 'decision.answered'), [{ id: 'd-plan', by: 'example-cofounder', answer: 'approve', role: 'owner' }]);
  assert.deepEqual(of(t.log, 'dashboard.audit'), [{ login: 'example-cofounder', role: 'owner', via: 'discord', instance: 'example', action: 'decision.answered', detail: { id: 'd-plan', kind: 'plan', answer: 'approve' } }]);
  assert.match(t.chat.posts.at(-1)!.text, /Decided: approve, by @example-cofounder/);
});

test('channel: two admins answer the same decision: the first stands, the second is told who decided; nothing is overwritten', async () => {
  const t = setup();
  ask(t.log, 'd-plan', 'plan');
  ask(t.log, 'd-q', 'question');
  await t.pass();
  const [plan, q] = t.chat.threads.map((x) => x.id);
  await t.pass(reply(COFOUNDER_ID, plan!, 'approve'), reply(OWNER_ID, plan!, 'reject'));
  assert.deepEqual(of(t.log, 'decision.answered').map((p) => [p.by, p.answer]), [['example-cofounder', 'approve']]);
  assert.deepEqual(of(t.log, 'discord.reply').map((p) => [p.by, p.outcome]), [['example-cofounder', 'answered'], ['example-owner', 'already']]);
  assert.match(t.chat.posts.at(-1)!.text, /already decided by @example-cofounder \(approve\)/);

  // Answered on the dashboard first: the thread says who decided, and a later reply there is refused the same way.
  const d = await startDashboard({ root: t.repo, cfg: t.cfg, eventsDb: t.eventsDb, stateDir: t.stateDir, user: 'example-owner', roleOf, slotsDir: t.slotsDir, instance: 'example' });
  try {
    const h = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asPerson('example-collaborator') };
    const first = await fetch(`${d.url.split('/?')[0]}/api/decide`, { method: 'POST', headers: h, body: JSON.stringify({ id: 'd-q', answer: 'approve' }) });
    assert.equal(first.status, 200);
    const again = await fetch(`${d.url.split('/?')[0]}/api/decide`, { method: 'POST', headers: { ...h, ...asPerson('example-owner') }, body: JSON.stringify({ id: 'd-q', answer: 'reject' }) });
    assert.equal(again.status, 409);
    assert.match(((await again.json()) as { error: string }).error, /already answered by @example-collaborator \(approve\)/);
  } finally {
    await d.close();
  }
  await t.pass(reply(OWNER_ID, q!, 'reject'));
  assert.deepEqual(of(t.log, 'decision.answered').filter((p) => p.id === 'd-q').map((p) => [p.by, p.answer]), [['example-collaborator', 'approve']]);
  const inQ = t.chat.posts.filter((p) => p.where === q).map((p) => p.text);
  assert.ok(inQ.some((x) => /Decided: approve, by @example-collaborator/.test(x)), 'the thread says who decided');
  assert.ok(inQ.some((x) => /already decided by @example-collaborator \(approve\)/.test(x)), 'the late reply is refused, naming who decided');
});

test("channel: an ambiguous reply answers nothing; the bot asks back with the exact options", async () => {
  const t = setup();
  ask(t.log, 'd-plan', 'plan');
  await t.pass();
  const thread = t.chat.threads[0]!.id;
  await t.pass(reply(OWNER_ID, thread, 'approve or reject? not sure'), reply(OWNER_ID, thread, 'yes'), reply(OWNER_ID, thread, "I wouldn't approve this"));
  assert.deepEqual(of(t.log, 'decision.answered'), []);
  assert.deepEqual(of(t.log, 'discord.reply').map((p) => p.outcome), ['ambiguous', 'ambiguous', 'ambiguous']);
  assert.equal(t.chat.posts.at(-1)!.text, askBack(['approve', 'revise', 'reject']));
  assert.deepEqual(parseChoice('/wl revise', ['approve', 'revise']), { answer: 'revise' });
  assert.deepEqual(parseChoice('**Approve**, looks good', ['approve', 'reject']), { answer: 'approve' });
});

test('channel: on a held plan, "approve plan <n>" is approve when n is its issue, and answers nothing when it names another', () => {
  const opts = ['approve', 'revise', 'reject'];
  for (const text of ['approve plan 12', 'Approve plan #12.', '/wl approve plan 12 looks good']) assert.deepEqual(parseChoice(text, opts, { plan: 12 }), { answer: 'approve' }, text);
  assert.deepEqual(parseChoice('approve plan 13', opts, { plan: 12 }), { ambiguous: true, wrongNumber: 13 });
  assert.deepEqual(parseChoice('reject plan 12', opts, { plan: 12 }), { answer: 'reject' });
  assert.deepEqual(parseChoice('approve plan 12 or reject', opts, { plan: 12 }), { ambiguous: true });
});

test("channel: a high-risk merge approval can't come from Discord: a notice with links only, and no reply approves it", async () => {
  const t = setup();
  ask(t.log, 'd-land', 'land', 7);
  await t.pass();
  assert.equal(t.chat.threads.length, 0, 'no thread to answer in');
  const notice = t.chat.posts.find((p) => p.where === ASKS_CHANNEL)!.text;
  assert.match(notice, /high-risk merge on #7.*only on GitHub or the dashboard/);
  assert.match(notice, new RegExp(`${DASH}/land`));
  assert.doesNotMatch(notice, /Options|approve \//, 'no options to pick');
  // Even a thread that pointed at it (forged into the record) answers nothing, whoever replies.
  t.log.append('discord.posted', { key: 'decision:d-land', thread: '777777', ok: true }, 'coordinator');
  await t.pass(reply(OWNER_ID, '777777', 'approve'));
  assert.deepEqual(of(t.log, 'decision.answered'), []);
  assert.deepEqual(of(t.log, 'discord.reply').map((p) => p.outcome), ['refused']);
  assert.equal(mayAnswerFromChat('land', 'owner'), false);
});

test('channel: a thread answer equals a dashboard answer, in effect and in the audit (only `via` differs)', async () => {
  const viaDashboard = setup();
  ask(viaDashboard.log, 'd-q', 'question');
  const d = await startDashboard({ root: viaDashboard.repo, cfg: viaDashboard.cfg, eventsDb: viaDashboard.eventsDb, stateDir: viaDashboard.stateDir, user: 'example-owner', roleOf, slotsDir: viaDashboard.slotsDir, instance: 'example' });
  try {
    const r = await fetch(`${d.url.split('/?')[0]}/api/decide`, { method: 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asPerson('example-owner') }, body: JSON.stringify({ id: 'd-q', answer: 'reject' }) });
    assert.equal(r.status, 200);
  } finally {
    await d.close();
  }
  const viaThread = setup();
  ask(viaThread.log, 'd-q', 'question');
  await viaThread.pass();
  await viaThread.pass(reply(OWNER_ID, viaThread.chat.threads[0]!.id, 'reject'));
  assert.deepEqual(of(viaThread.log, 'decision.answered'), of(viaDashboard.log, 'decision.answered'));
  const strip = (xs: Record<string, unknown>[]) => xs.map(({ via: _v, ...rest }) => rest);
  assert.deepEqual(strip(of(viaThread.log, 'dashboard.audit')), strip(of(viaDashboard.log, 'dashboard.audit')));
  assert.deepEqual(of(viaThread.log, 'dashboard.audit').map((p) => p.via), ['discord']);
  assert.deepEqual(of(viaDashboard.log, 'dashboard.audit').map((p) => p.via), ['session']);
});

test('channel: a secret ask never posts its content, only a dashboard link (every request the adapter makes is checked)', async () => {
  // Made at run time, so no secret-looking literal sits in the repo.
  const SECRET = `planted${randomBytes(12).toString('hex')}`;
  const sent: string[] = [];
  const sock = new FakeSocketImpl();
  let msg = 500000;
  const net = (async (url: string, init: RequestInit) => {
    sent.push(`${url}\n${String(init.body ?? '')}\n${JSON.stringify(init.headers ?? {})}`);
    return { ok: true, json: async () => ({ id: String(++msg) }) };
  }) as unknown as typeof fetch;
  const d = new DiscordIntake({ token: 'tok', guild: '555555', channels: ['111111'], allowedSenders: [OWNER_ID], prefixes: ['bug:'], connect: () => sock, fetch: net, setInterval: () => 1, clearInterval: () => {} });
  d.start();
  const source: IntakeSource = { name: 'discord', take: async () => d.take(), reply: (t, text) => d.reply(t.id, text), openThread: (c, text, name, from) => d.openThread(c, text, name, from), watch: (t) => d.watch(t) };
  const t = setup({ source });
  asks(t.log).create({ kind: 'paste_secret', instance: 'example', title: `Paste ${SECRET}`, detail: `The value is ${SECRET}`, credential: 'intake-discord', where: `credentials.yaml ${SECRET}` });
  asks(t.log).create({ kind: 'question', instance: 'example', title: 'Turn nightly runs on?', detail: 'Nightly full runs.', options: ['yes', 'no'] });
  await t.pass();
  const all = [...sent, ...sock.sent.map((f) => JSON.stringify(f))].join('\n');
  assert.ok(sent.length >= 2, 'the adapter posted');
  assert.ok(!all.includes(SECRET), 'the planted secret is in no Discord payload');
  assert.doesNotMatch(all, /Paste|credentials\.yaml|intake-discord/, "nor the secret ask's title, place or credential name");
  assert.match(all, new RegExp(`A setup step needs you on the dashboard: ${DASH}/setup`));
  assert.match(all, /Turn nightly runs on\?/, 'a question ask posts as usual');
});

test('channel config: the mapping lives in intake.yaml, readable by its owner only; a mapped person must be allowed', { skip: typeof process.getuid !== 'function' && 'POSIX owners and modes' }, () => {
  const d = mkdtempSync(join(tmpdir(), 'chat-config-'));
  const p = join(d, 'intake.yaml');
  const yaml = (people: string) => `version: 1\ndiscord:\n  enabled: true\n  guild: "555555"\n  channels: ["111111"]\n  allowed_senders: ["${OWNER_ID}"]\n  people: { ${people} }\n  asks_channel: "${ASKS_CHANNEL}"\n  dashboard_url: ${DASH}\n`;
  writeFileSync(p, yaml(`"${OWNER_ID}": example-owner`), { mode: 0o600 });
  const ok = loadIntakeConfig(p) as { config: IntakeConfig };
  assert.deepEqual(ok.config.discord.people, { [OWNER_ID]: 'example-owner' });
  chmodSync(p, 0o640);
  assert.match((loadIntakeConfig(p) as { error: string }).error, /readable by its group or others/);
  chmodSync(p, 0o600);
  writeFileSync(p, yaml(`"${TEAMMATE_ID}": example-collaborator`));
  assert.match((loadIntakeConfig(p) as { error: string }).error, /mapped to a GitHub login but not in discord.allowed_senders/);
  writeFileSync(p, yaml(`"${OWNER_ID}": "not a login!"`));
  assert.match((loadIntakeConfig(p) as { error: string }).error, /a GitHub login/);
});

test('channel: per instance and off by default: without a Discord config or a mapping, an instance posts nothing and reads nothing', async () => {
  const none = setup({ config: null });
  const off = setup({ config: IntakeConfig.parse({ version: 1 }) });
  const unmapped = setup({ config: IntakeConfig.parse({ version: 1, discord: { enabled: true, guild: '555555', channels: ['111111'], allowed_senders: [OWNER_ID], asks_channel: ASKS_CHANNEL, dashboard_url: DASH } }) });
  for (const [name, t] of [['no intake.yaml', none], ['Discord not enabled', off], ['no mapping', unmapped]] as const) {
    ask(t.log, 'd-q', 'question');
    asks(t.log).create({ kind: 'question', instance: 'example', title: 'Turn nightly runs on?', detail: 'Nightly full runs.', options: ['yes', 'no'] });
    await t.pass(reply(OWNER_ID, '900000', 'approve'));
    assert.deepEqual([t.chat.threads.length, t.chat.posts.length], [0, 0], `${name}: nothing posted`);
    assert.deepEqual(of(t.log, 'decision.answered'), [], `${name}: nothing answered`);
    assert.deepEqual(of(t.log, 'discord.posted'), [], `${name}: no post recorded`);
    assert.deepEqual(rawFiles(t.stateDir), [], `${name}: nothing stored`);
  }
  assert.equal(none.chat.takes, 0, 'no intake config: the source is never read');
  assert.equal(off.chat.takes, 0, 'Discord off: the source is never read');
});

test("channel: an instance can't answer through another instance's thread or mapping", async () => {
  const a = setup();
  const b = setup();
  ask(a.log, 'd-q', 'question');
  ask(b.log, 'd-q', 'question');
  await a.pass();
  const threadOfA = a.chat.threads[0]!.id;
  // B posts its own thread for its own decision, with a different id from A's.
  b.chat.threads.push({ channel: ASKS_CHANNEL, text: '', name: '', id: 'placeholder' });
  await b.pass();
  assert.notEqual(b.chat.threads.at(-1)!.id, threadOfA);
  // A reply in A's thread that reached B answers nothing in B, and isn't taken as a report there either.
  await b.pass(reply(OWNER_ID, threadOfA, 'approve'));
  assert.deepEqual(of(b.log, 'decision.answered'), []);
  assert.deepEqual(of(b.log, 'discord.reply'), []);
  assert.equal(b.log.read(0, ['intake.received']).length, 0);
  assert.deepEqual(rawFiles(b.stateDir), []);
});

test("channel: the main watch's alert posts once in the asks channel, a notice with the commit's and the revert's links and no secret", async () => {
  const t = setup();
  const sha = 'a1b2c3d'.padEnd(40, '0');
  t.log.append('main_watch.unaccounted', { sha, url: `https://github.com/example-org/example-shop/commit/${sha}`, reason: `${sha.slice(0, 8)} was pushed to main directly: no merged PR has it (token ghp_${'x'.repeat(36)})`, number: null, revert: 'https://github.com/example-org/example-shop/pull/9' }, 'coordinator');
  await t.pass();
  await t.pass();
  const posts = t.chat.posts.filter((p) => p.where === ASKS_CHANNEL);
  assert.equal(posts.length, 1, 'posted once');
  assert.equal(t.chat.threads.length, 0, 'a notice, not a thread');
  assert.match(posts[0]!.text, new RegExp(`commit/${sha}`));
  assert.match(posts[0]!.text, /Revert PR, for a human to approve: https:\/\/github\.com\/example-org\/example-shop\/pull\/9/);
  assert.ok(posts[0]!.text.includes(`${DASH}/prs`));
  assert.doesNotMatch(posts[0]!.text, /ghp_x{36}/, 'redacted');
});
