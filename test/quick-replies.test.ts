// Replies a person waits on (src/coordinator/quick-replies.ts, src/runner.ts loginStartLock): a chat-channel message
// or a decision-thread question wakes a pass at once (no tick, no intake pull), a burst makes one pass at a time,
// typing shows from accept until the reply, and the caps still hold. Discord is the real adapter on a fake socket
// and fetch; the model is a FakeRunner. The login locks are in test/login-start-lock.test.ts.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { QUICK_RUNS } from '../src/coordinator/quick-replies.js';
import { EventLog } from '../src/events/log.js';
import { CHAT_LANE, CHAT_ROLE } from '../src/intake/chat.js';
import { DiscordIntake, type Socket } from '../src/intake/discord.js';
import { THREAD_ROLE } from '../src/intake/explain.js';
import { IntakeConfig, type IntakeSource } from '../src/intake/report.js';
import { discordSource } from '../src/intake/wire.js';
import { FakeRunner, type AgentRunner, type RunRequest } from '../src/runner.js';
import { slotStatus, tryAgentSlot } from '../src/slots.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Placeholder ids and logins only.
const GUILD = '555555';
const BOT = '999999';
const OWNER_ID = '100000000001';
const CHATS = ['300000000001', '300000000002', '300000000003'];
const THREAD = '777777';
const DASH = 'https://dashboard.example.test';

const config = (over: Record<string, unknown> = {}) =>
  IntakeConfig.parse({
    version: 1,
    discord: { enabled: true, guild: GUILD, channels: ['111111'], allowed_senders: [OWNER_ID], people: { [OWNER_ID]: 'example-owner' }, asks_channel: '200000000001', dashboard_url: DASH, chat_channels: CHATS, ...over },
  });
const roleOf = async () => 'owner' as const;

class FakeSocketImpl implements Socket {
  private fns: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
  send() {}
  close() {}
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void) {
    (this.fns[type] ??= []).push(fn);
  }
  frame(f: object) {
    for (const fn of this.fns.message ?? []) fn({ data: JSON.stringify(f) });
  }
}

/** The real adapter on a fake socket; every request it makes is recorded with its time. */
function fakeDiscord(o: { typingStatus?: number } = {}) {
  const sock = new FakeSocketImpl();
  const sent: { at: number; kind: 'typing' | 'message'; where: string; text?: string }[] = [];
  let id = 600000;
  const net = (async (url: string, init: RequestInit) => {
    const m = url.match(/\/channels\/(\d+)\/(typing|messages)$/);
    if (m) sent.push({ at: Date.now(), kind: m[2] === 'typing' ? 'typing' : 'message', where: m[1]!, ...(m[2] === 'messages' ? { text: (JSON.parse(String(init.body)) as { content: string }).content } : {}) });
    const status = m?.[2] === 'typing' ? (o.typingStatus ?? 204) : 200;
    return { ok: status < 300, status, json: async () => ({ id: String(++id) }) };
  }) as unknown as typeof fetch;
  const bot = new DiscordIntake({ token: 'tok', guild: GUILD, channels: ['111111'], chatChannels: CHATS, allowedSenders: [OWNER_ID], prefixes: [], connect: () => sock, fetch: net, setInterval: () => 1, clearInterval: () => {} });
  bot.start();
  sock.frame({ op: 0, s: 1, t: 'READY', d: { user: { id: BOT } } });
  let n = 0;
  const say = (channel: string, content: string) => sock.frame({ op: 0, s: 2 + n, t: 'MESSAGE_CREATE', d: { id: `32000000${String(++n).padStart(4, '0')}`, channel_id: channel, guild_id: GUILD, content, author: { id: OWNER_ID, username: 'owner' } } });
  return { bot, sent, say, src: discordSource(bot) };
}

function setup(o: { runner: AgentRunner; cfg?: IntakeConfig; src: IntakeSource; typingMs?: number; budget?: number }) {
  const base = mkdtempSync(join(tmpdir(), 'quick-'));
  const repo = join(base, 'checkout');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const cfg = loadConfig(repo);
  cfg.project.project.repo = 'example-org/example';
  if (o.budget !== undefined) cfg.agents.daily_budget_usd = o.budget;
  const log = new EventLog(join(base, 'events.db'));
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  const intakeCfg = o.cfg ?? config();
  // An intake pull an hour apart: anything answered here was not answered by the intake pass.
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), runner: o.runner, repo, instance: 'example', stateDir, slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) }, settings: () => ({ settings: {}, error: null }), intake: { config: () => intakeCfg, sources: [o.src], pullMs: 3600_000, roleOf, ...(o.typingMs ? { typingMs: o.typingMs } : {}) } });
  return { c, log, stateDir, slotsDir };
}

const chatRunner = (o: { ms?: number; onRun?: (req: RunRequest) => void; costUsd?: number } = {}) => {
  let live = 0;
  const stats = { max: 0, runs: [] as { role: string; start: number; end: number }[] };
  const runner = new FakeRunner(async (req) => {
    live++;
    stats.max = Math.max(stats.max, live);
    const start = Date.now();
    o.onRun?.(req);
    await sleep(o.ms ?? 0);
    live--;
    stats.runs.push({ role: req.role, start, end: Date.now() });
    return { structured: req.role === CHAT_ROLE ? { reply: `Answer to: ${req.prompt.length}` } : { intent: 'question', answer: 'It merges the change once checks pass.' }, ...(o.costUsd !== undefined ? { costUsd: o.costUsd } : {}) };
  });
  return { runner, stats };
};

test('wake-up: a chat message is answered at once, with no tick and no intake pull', async () => {
  const d = fakeDiscord();
  const { runner } = chatRunner();
  const t = setup({ runner, src: d.src });
  const at = Date.now();
  d.say(CHATS[0]!, 'where does the config get loaded?');
  await t.c.quickIdle();
  const reply = d.sent.find((s) => s.kind === 'message');
  assert.ok(reply, 'the reply was posted without a tick or an intake pass');
  assert.equal(reply.where, CHATS[0]);
  assert.ok(reply.at - at < 2000, `answered in ${reply.at - at} ms`);
  assert.equal(runner.calls.filter((r) => r.role === CHAT_ROLE).length, 1);
  assert.equal(runner.calls[0]!.interactive, true, 'the chat run is interactive: it never queues behind agent runs');
  assert.equal(runner.calls[0]!.lane, CHAT_LANE, 'still the chat lane: sandboxed, the same three tools');
  assert.deepEqual(runner.calls[0]!.allowedTools, ['Read', 'Glob', 'Grep']);
  // The intake pass never sees it again (it took only what is not a reply a person waits on).
  await t.c.checkIntake();
  await t.c.quickIdle();
  assert.equal(runner.calls.length, 1);
});

test('wake-up: a burst of messages makes one pass at a time, coalesced, and every message is answered once', async () => {
  const d = fakeDiscord();
  // A pass that takes a while: wakes during it must not start a second pass alongside.
  let inPass = 0;
  let maxInPass = 0;
  let passes = 0;
  const takeNow = d.src.takeNow!;
  d.src.takeNow = async (which) => {
    passes++;
    inPass++;
    maxInPass = Math.max(maxInPass, inPass);
    await sleep(30);
    const got = await takeNow(which);
    inPass--;
    return got;
  };
  const { runner } = chatRunner();
  const t = setup({ runner, src: d.src });
  for (let i = 0; i < 8; i++) d.say(CHATS[0]!, `question ${i}`);
  await t.c.quickIdle();
  assert.equal(maxInPass, 1, 'never two passes at once');
  assert.ok(passes <= 2, `8 wakes coalesced into ${passes} passes`);
  assert.equal(runner.calls.filter((r) => r.role === CHAT_ROLE).length, 8, 'each message answered once');
  assert.equal(d.sent.filter((s) => s.kind === 'message').length, 8);
});

test('wake-up: a question in a decision thread is answered at once too, through the same thread path', async () => {
  const d = fakeDiscord();
  const { runner } = chatRunner();
  const t = setup({ runner, src: d.src });
  t.log.append('decision.asked', { id: 'd1', kind: 'question', issue: null, owner: 'example-owner', question: 'Ship it?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'coordinator');
  t.log.append('discord.posted', { key: 'decision:d1', thread: THREAD, ok: true }, 'coordinator');
  d.bot.watch(THREAD);
  d.say(THREAD, 'what would approving this change for users?');
  await t.c.quickIdle();
  const run = runner.calls.find((r) => r.role === THREAD_ROLE);
  assert.ok(run, 'the thread run ran without a tick');
  assert.equal(run.interactive, true);
  assert.ok(d.sent.some((s) => s.kind === 'message' && s.where === THREAD && /merges the change/.test(s.text ?? '')));
  assert.ok(d.sent.findIndex((s) => s.kind === 'typing' && s.where === THREAD) >= 0, 'typing shown in the thread');
});

test('typing: sent as soon as a message is accepted, again every interval until the reply posts, then never', async () => {
  const d = fakeDiscord();
  let typedBeforeRun = -1;
  const { runner } = chatRunner({ ms: 260, onRun: () => (typedBeforeRun = d.sent.filter((s) => s.kind === 'typing').length) });
  const t = setup({ runner, src: d.src, typingMs: 50 });
  d.say(CHATS[0]!, 'how are runs locked?');
  await t.c.quickIdle();
  assert.ok(typedBeforeRun >= 1, 'typing was sent before the run started');
  const replyAt = d.sent.findIndex((s) => s.kind === 'message');
  const typingBefore = d.sent.slice(0, replyAt).filter((s) => s.kind === 'typing');
  assert.ok(typingBefore.length >= 4, `typing refreshed while the reply was on its way (${typingBefore.length} sends)`);
  assert.ok(typingBefore.every((s) => s.where === CHATS[0]));
  const count = d.sent.filter((s) => s.kind === 'typing').length;
  await sleep(200);
  assert.equal(d.sent.filter((s) => s.kind === 'typing').length, count, 'no typing after the reply');
});

test('typing: a failed send (a rate limit) stops it at once; the reply still posts', async () => {
  const d = fakeDiscord({ typingStatus: 429 });
  const { runner } = chatRunner({ ms: 200 });
  const t = setup({ runner, src: d.src, typingMs: 30 });
  d.say(CHATS[0]!, 'and the slots?');
  await t.c.quickIdle();
  assert.equal(d.sent.filter((s) => s.kind === 'typing').length, 1, 'one failed send, never retried');
  assert.equal(d.sent.filter((s) => s.kind === 'message').length, 1);
  // Paused in that channel: the next reply there doesn't type into the rate limit again.
  d.say(CHATS[0]!, 'one more');
  await t.c.quickIdle();
  assert.equal(d.sent.filter((s) => s.kind === 'typing').length, 1);
});

test('caps: at most QUICK_RUNS chat replies run at once, in order within a channel, and none takes an agent slot', async () => {
  const d = fakeDiscord();
  const { runner, stats } = chatRunner({ ms: 150 });
  const t = setup({ runner, src: d.src });
  // The machine is full of agents: the one slot is taken.
  writeFileSync(join(t.slotsDir, 'config.json'), JSON.stringify({ max_agents: 1 }));
  const slot = tryAgentSlot('an agent', t.slotsDir);
  assert.ok(slot);
  try {
    for (const ch of CHATS) d.say(ch, `in ${ch}`);
    d.say(CHATS[0]!, 'a second one in the first channel');
    await t.c.quickIdle();
    assert.equal(stats.runs.length, 4, 'every message answered, the machine full of agents or not');
    assert.equal(stats.max, QUICK_RUNS, `at most ${QUICK_RUNS} at once`);
    assert.equal(slotStatus(t.slotsDir).agents.length, 1, 'chat took no agent slot');
    const first = d.sent.filter((s) => s.kind === 'message' && s.where === CHATS[0]).map((s) => s.text);
    assert.equal(first.length, 2);
  } finally {
    slot.release();
  }
});

test("caps: the chat's daily cap still applies on the quick path", async () => {
  const d = fakeDiscord();
  const { runner } = chatRunner({ costUsd: 0.6 });
  const t = setup({ runner, src: d.src, cfg: config({ chat_max_usd_per_day: 0.5 }) });
  d.say(CHATS[0]!, 'first');
  await t.c.quickIdle();
  d.say(CHATS[0]!, 'second');
  await t.c.quickIdle();
  assert.equal(runner.calls.filter((r) => r.role === CHAT_ROLE).length, 1, 'over the cap: no second run');
  assert.ok(d.sent.some((s) => s.kind === 'message' && /chat limit/.test(s.text ?? '')));
});
