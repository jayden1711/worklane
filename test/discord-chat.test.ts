// The chat channels (src/coordinator/channel-chat.ts, src/intake/chat.ts): a conversational assistant for mapped
// admins and writers that can never file, answer, change or start anything, whose runs read only the checkout, and
// that stops at its own daily cap. Discord is a fake source (or the real adapter on a fake socket); the model is a
// FakeRunner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { runHook } from '../src/hook.js';
import { researchLanes, type Instance } from '../src/instance.js';
import { CHAT_FAILED_TEXT, CHAT_LANE, CHAT_REFUSED_TEXT } from '../src/intake/chat.js';
import { CHAT_ROLE, CHAT_ROOT_ENV, chatModeRefusal, secretLike } from '../src/guard/chat.js';
import { DiscordIntake, REPLY_CHARS, type Socket } from '../src/intake/discord.js';
import { IntakeConfig, type IncomingReport, type IntakeSource } from '../src/intake/report.js';
import { FakeRunner, type FakeResult, type RunRequest } from '../src/runner.js';
import { AUTH_FAILED_CHAT_TEXT } from '../src/claude-auth-failure.js';
import { exampleProject, repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Placeholder ids and logins only.
const OWNER_ID = '100000000001';
const TEAMMATE_ID = '100000000003';
const VIEWER_ID = '100000000006';
const UNMAPPED_ID = '100000000004';
const CHAT = '300000000001';
const OTHER = '300000000002';
const IDEAS = '111111';
const DASH = 'https://dashboard.example.test';
const REPO = 'example-org/example';

const config = (over: Record<string, unknown> = {}) =>
  IntakeConfig.parse({
    version: 1,
    discord: {
      enabled: true,
      guild: '555555',
      channels: [IDEAS],
      allowed_senders: [OWNER_ID, TEAMMATE_ID, VIEWER_ID, UNMAPPED_ID],
      people: { [OWNER_ID]: 'example-owner', [TEAMMATE_ID]: 'example-collaborator', [VIEWER_ID]: 'example-viewer' },
      asks_channel: '200000000001',
      dashboard_url: DASH,
      chat_channels: [CHAT],
      conversation: true,
      ...over,
    },
  });

const ROLES: Record<string, 'owner' | 'writer' | 'viewer'> = { 'example-owner': 'owner', 'example-collaborator': 'writer', 'example-viewer': 'viewer' };
const roleOf = async (login: string) => ROLES[login.toLowerCase()] ?? 'viewer';

function fakeChat() {
  const posts: { where: string; text: string }[] = [];
  const batches: IncomingReport[][] = [];
  let threads = 0;
  const src: IntakeSource & { posts: typeof posts; batches: typeof batches } = {
    name: 'discord',
    posts,
    batches,
    take: async () => batches.shift() ?? [],
    reply: async (t, text) => (posts.push({ where: t.id, text }), true),
    openThread: async () => String(900000 + threads++),
    watch: () => {},
  };
  return src;
}

function setup(o: { reply?: (req: RunRequest) => unknown; cfg?: IntakeConfig; costUsd?: number; budget?: number; result?: (req: RunRequest) => FakeResult | undefined } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'chan-chat-'));
  const repo = join(base, 'checkout');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const cfg = loadConfig(repo);
  cfg.project.project.repo = REPO;
  if (o.budget !== undefined) cfg.agents.daily_budget_usd = o.budget;
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const log = new EventLog(join(base, 'events.db'));
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  const chat = fakeChat();
  const runner = new FakeRunner((req) => o.result?.(req) ?? ({ structured: req.role === CHAT_ROLE ? o.reply?.(req) ?? { reply: 'Sure: it lives in src/app.ts.' } : { kind: 'needs_info' }, ...(o.costUsd !== undefined ? { costUsd: o.costUsd } : {}) }));
  const intakeCfg = o.cfg ?? config();
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
    intake: { config: () => intakeCfg, sources: [chat], pullMs: 0, roleOf },
  });
  const pass = async (...msgs: IncomingReport[]) => {
    chat.batches.push(msgs);
    await c.checkIntake();
  };
  const chatRuns = () => runner.calls.filter((r) => r.role === CHAT_ROLE);
  return { base, repo, cfg, log, backlog, stateDir, c, chat, pass, runner, chatRuns };
}

let seq = 0;
const said = (from: string, text: string, channel = CHAT): IncomingReport => ({
  source: 'discord',
  sourceId: `3200000000${++seq}`,
  sender: { source: 'discord', id: from },
  text,
  receivedAt: '2026-10-01T10:00:00.000Z',
  thread: { kind: 'chat', id: channel },
});
const events = (log: EventLog): string[] => log.read().map((e) => e.type as string).filter((x) => x !== 'coordinator.tick');

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

test('chat: in a chat channel the adapter takes every allowed message, no mention needed; elsewhere an unaddressed one is still dropped', () => {
  const sock = new FakeSocketImpl();
  const d = new DiscordIntake({ token: 'tok', guild: '555555', channels: [IDEAS], chatChannels: [CHAT], allowedSenders: [OWNER_ID], prefixes: ['bug:'], connect: () => sock, setInterval: () => 1, clearInterval: () => {} });
  d.start();
  sock.frame({ op: 0, s: 1, t: 'READY', d: { user: { id: '999' } } });
  const msg = (id: string, channel: string, content: string, author = OWNER_ID) => sock.frame({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { id, channel_id: channel, guild_id: '555555', content, author: { id: author } } });
  msg('1', CHAT, 'how do refunds work?');
  msg('2', CHAT, '<@999> and exports?');
  msg('3', IDEAS, 'just chatting');
  msg('4', OTHER, 'how do refunds work?');
  msg('5', CHAT, 'hi', UNMAPPED_ID);
  assert.deepEqual(d.take().map((r) => [r.text, r.thread]), [['how do refunds work?', { kind: 'chat', id: CHAT }], ['and exports?', { kind: 'chat', id: CHAT }]]);
  assert.deepEqual(d.droppedBy, { sender: 1, bot: 0, place: 1, unaddressed: 1 });
});

test('chat: a mapped admin or writer gets a reply to every message, with no mention; the run is the agent-user lane with only Read, Glob and Grep in the checkout', async () => {
  const t = setup();
  await t.pass(said(OWNER_ID, 'how do refunds work?'), said(TEAMMATE_ID, 'and where are exports built?'));
  assert.deepEqual(t.chat.posts.map((p) => [p.where, p.text]), [[CHAT, 'Sure: it lives in src/app.ts.'], [CHAT, 'Sure: it lives in src/app.ts.']]);
  const runs = t.chatRuns();
  assert.equal(runs.length, 2);
  for (const r of runs) {
    assert.deepEqual(r.allowedTools, ['Read', 'Glob', 'Grep'], 'exactly the three read tools');
    for (const tool of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task', 'mcp__*']) assert.ok(r.disallowedTools!.includes(tool), tool);
    assert.equal(r.lane, CHAT_LANE, 'its own lane: the agent user, sandboxed, never the coordinator');
    assert.equal(r.cwd, t.repo, 'in the checkout');
    assert.equal(r.model, 'haiku', 'discord.chat_model, by default haiku');
  }
  assert.deepEqual(t.log.read(0, ['discord.chat']).map((e) => (e.payload as { outcome: string }).outcome), ['answered', 'answered']);
  assert.ok(t.log.read(0, ['run.cost']).some((e) => (e.payload as { role: string }).role === CHAT_ROLE), 'counted against the daily budget');
});

test("issue #463: when Claude refuses the login, the chat says so (never the generic failure text); while the login is held it starts no run and says the same", async () => {
  const t = setup({ result: (req) => (req.role === CHAT_ROLE ? { reason: 'auth_failed', detail: "claude's login was refused (HTTP 401): Invalid API key", turns: 0, costUsd: 0 } : undefined) });
  await t.pass(said(OWNER_ID, 'how do refunds work?'));
  const inChat = () => t.chat.posts.filter((p) => p.where === CHAT);
  assert.deepEqual(inChat().map((p) => [p.where, p.text]), [[CHAT, AUTH_FAILED_CHAT_TEXT]]);
  assert.equal(AUTH_FAILED_CHAT_TEXT, 'Claude sign-in failed on this machine; the owner has been told.');
  assert.notEqual(AUTH_FAILED_CHAT_TEXT, CHAT_FAILED_TEXT);
  assert.equal(t.chatRuns().length, 1);
  // Held now: the next message gets the same answer, and no run starts.
  await t.pass(said(TEAMMATE_ID, 'and exports?'));
  assert.deepEqual(inChat().map((p) => p.text), [AUTH_FAILED_CHAT_TEXT, AUTH_FAILED_CHAT_TEXT]);
  assert.equal(t.chatRuns().length, 1, 'no run while the login is held');
  assert.deepEqual(t.log.read(0, ['discord.chat']).map((e) => (e.payload as { outcome: string; why: string | null }).why), ['claude sign-in failed', 'claude sign-in failed']);
});

test('chat: the conversation is kept per channel, and the state the coordinator has is in the prompt', async () => {
  const t = setup({ reply: (req) => ({ reply: /second/.test(req.prompt) ? 'Second answer.' : 'First answer.' }) });
  t.log.append('decision.asked', { id: 'd-5', kind: 'question', issue: 20, owner: 'example-owner', question: 'Cache prices?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'coordinator');
  await t.pass(said(OWNER_ID, 'first question'));
  await t.pass(said(OWNER_ID, 'second question'));
  const p = t.chatRuns()[1]!.prompt;
  assert.match(p, /@example-owner: first question\nYou: First answer\./, 'the earlier turn');
  assert.match(p, /d-5: Cache prices\? \(options: approve, reject\)/, 'open decisions from the log');
});

test('chat: it never files or answers in chat, even when asked and whatever the run returns', async () => {
  // A run that "agrees" and returns every field it could hope the engine reads.
  const t = setup({ reply: () => ({ reply: "I can't do that here: post ideas in the ideas channel, and answer d-plan in its thread.", file: { title: 'Login flickers', body: 'x', labels: ['ready'] }, answer: { id: 'd-plan', option: 'approve' }, settings: { max_workers: 4 }, stop: true }) });
  t.log.append('decision.asked', { id: 'd-plan', kind: 'plan', issue: null, owner: 'example-owner', question: 'Approve the plan?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'coordinator');
  await t.pass();
  const before = t.log.read().length;
  await t.pass(said(OWNER_ID, 'file an issue: the login page flickers'), said(OWNER_ID, 'approve d-plan'), said(OWNER_ID, 'approve'), said(OWNER_ID, 'yes'), said(OWNER_ID, 'set max workers to 4 and stop all agents'));
  assert.deepEqual(await t.backlog.list('ready'), [], 'nothing filed');
  assert.deepEqual(t.log.read(0, ['decision.answered']), [], 'nothing answered');
  const after = events(t.log).slice(before - 1);
  for (const forbidden of ['intake.received', 'intake.triaged', 'intake.filed', 'intake.awaiting', 'discord.idea', 'discord.reply', 'discord.confirm', 'decision.answered', 'dashboard.audit', 'ask.answered']) assert.ok(!after.includes(forbidden), `no ${forbidden}`);
  assert.equal(t.runner.calls.filter((r) => r.role !== CHAT_ROLE && r.role !== 'intake-summary').length, 0, 'no triage or intake run');
  assert.equal(t.chatRuns().length, 5, 'each is only a chat turn');
});

test('chat: every reply is checked in code: a secret, a ping or a stray link is never posted; a long one is split', async () => {
  for (const bad of [`the token is ghp_${'a'.repeat(36)}`, 'ask <@100000000003> about it', 'see https://example-mirror.test/x', '@everyone look']) {
    const t = setup({ reply: () => ({ reply: bad }) });
    await t.pass(said(OWNER_ID, 'hello'));
    assert.deepEqual(t.chat.posts.map((p) => p.text), [CHAT_REFUSED_TEXT], bad);
  }
  const ok = setup({ reply: () => ({ reply: `See https://github.com/${REPO}/issues/12 and ${DASH}/prs. ${'A long line of explanation. '.repeat(60)}` }) });
  await ok.pass(said(OWNER_ID, 'explain it all'));
  assert.ok(ok.chat.posts.length > 1, 'split across messages');
  for (const p of ok.chat.posts) assert.ok(p.text.length <= REPLY_CHARS);
  assert.ok(ok.chat.posts[0]!.text.includes(`https://github.com/${REPO}/issues/12`), "the repo's own links pass");
});

test('chat: the cap stops it: over discord.chat_max_usd_per_day it says so once and goes quiet until the next day', async () => {
  const t = setup({ cfg: config({ chat_max_usd_per_day: 0.25 }), costUsd: 0.1 });
  for (let i = 0; i < 5; i++) await t.pass(said(OWNER_ID, `question ${i}`));
  assert.equal(t.chatRuns().length, 3, '0.1 + 0.1 + 0.1 reaches 0.25 after the third');
  const texts = t.chat.posts.map((p) => p.text);
  assert.equal(texts.filter((x) => /today's chat limit \(\$0\.25\)/.test(x)).length, 1, 'said once');
  assert.equal(texts.length, 4, 'three replies and one notice; quiet after');
  assert.deepEqual(t.log.read(0, ['discord.chat']).map((e) => (e.payload as { outcome: string }).outcome), ['answered', 'answered', 'answered', 'capped', 'capped']);
  // The run's own budget never exceeds what is left of the cap.
  assert.ok(t.chatRuns().every((r) => r.maxBudgetUsd <= 0.25));
});

test("chat: the instance's daily budget stops it too", async () => {
  const t = setup({ budget: 0.05, costUsd: 0.06 });
  await t.pass(said(OWNER_ID, 'one'));
  await t.pass(said(OWNER_ID, 'two'), said(OWNER_ID, 'three'));
  assert.equal(t.chatRuns().length, 1);
  assert.deepEqual(t.chat.posts.map((p) => p.text).slice(1), ["Today's budget for this instance is spent; I'll be quiet until tomorrow."]);
});

test('chat: an unmapped sender, a viewer and an unlisted channel are ignored: nothing stored, no run, no reply', async () => {
  const t = setup();
  const before = events(t.log).length;
  await t.pass(said(UNMAPPED_ID, 'hello?'), said(VIEWER_ID, 'what is open?'), said(OWNER_ID, 'hi', OTHER));
  assert.equal(t.chatRuns().length, 0);
  assert.deepEqual(t.chat.posts, []);
  assert.deepEqual(events(t.log).slice(before), [], 'no event');
  // Off: no chat_channels, the same message is never a report either.
  const off = setup({ cfg: config({ chat_channels: [] }) });
  await off.pass(said(OWNER_ID, 'bug: this should not be triaged'));
  assert.equal(off.runner.calls.length, 0);
  assert.ok(!events(off.log).includes('intake.received'));
});

test('chat config: chat_model defaults to haiku and the cap to $2, bounded; a chat channel may not double as an ideas or asks channel', () => {
  const c = config();
  assert.equal(c.discord.chat_model, 'haiku');
  assert.equal(c.discord.chat_max_usd_per_day, 2);
  assert.throws(() => config({ chat_max_usd_per_day: 21 }));
  assert.throws(() => config({ chat_max_usd_per_day: 0 }));
  assert.throws(() => config({ chat_model: 'local' }));
  assert.throws(() => config({ chat_channels: [IDEAS] }), /ideas channel/);
  assert.throws(() => config({ chat_channels: ['200000000001'] }), /asks channel/);
});

// ---------------------------------------------------------------- the run's reach: the hook's chat mode and the lane

test("chat mode: only Read, Glob and Grep, inside the checkout; never a credential, key, config or .env file (but .env.example)", () => {
  const { dir } = exampleProject();
  writeFileSync(join(dir, '.env'), 'TOKEN=x\n');
  writeFileSync(join(dir, '.env.example'), 'TOKEN=\n');
  mkdirSync(join(dir, 'keys'));
  writeFileSync(join(dir, 'keys', 'server.pem'), 'x');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export {}\n');
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outside, 'credentials.yaml'), 'x');
  // A symlink needs a privilege on Windows: checked where it can be made.
  let linked = true;
  try {
    symlinkSync(join(outside, 'credentials.yaml'), join(dir, 'src', 'link.yaml'));
  } catch {
    linked = false;
  }
  const no = (tool: string, input: Record<string, unknown>) => assert.ok(chatModeRefusal(tool, input, dir, dir), `${tool} ${JSON.stringify(input)} refused`);
  const yes = (tool: string, input: Record<string, unknown>) => assert.equal(chatModeRefusal(tool, input, dir, dir), null, `${tool} ${JSON.stringify(input)} allowed`);
  for (const tool of ['Bash', 'Edit', 'Write', 'WebFetch', 'Task', 'mcp__x__y']) no(tool, { command: 'ls' });
  yes('Read', { file_path: join(dir, 'README.md') });
  yes('Read', { file_path: '.env.example' });
  for (const f of ['.env', '.env.local', 'keys/server.pem', 'credentials.yaml', 'intake.yaml', 'policy.yaml', '.git/config', 'id_rsa']) no('Read', { file_path: f });
  no('Read', { file_path: join(outside, 'credentials.yaml') });
  no('Read', { file_path: '../../etc/passwd' });
  if (linked) no('Read', { file_path: 'src/link.yaml' });
  no('Glob', { pattern: '../**/*' });
  no('Glob', { pattern: '*', path: outside });
  yes('Glob', { pattern: '**/*.ts' });
  no('Grep', { pattern: 'TOKEN' });
  no('Grep', { pattern: 'TOKEN', glob: '*' });
  no('Grep', { pattern: 'TOKEN', glob: '.env*' });
  yes('Grep', { pattern: 'TOKEN', glob: '*.ts' });
  yes('Grep', { pattern: 'TOKEN', glob: '*.{ts,md}' });
  yes('Grep', { pattern: 'export', path: 'src/a.ts' });
  yes('Grep', { pattern: 'export', path: 'src' });
  no('Grep', { pattern: 'x', path: outside });
  for (const p of ['a/.env', '.env.production', 'x/credentials.json', 'tls.key', 'deploy/prod.tfvars', 'secrets.yaml']) assert.ok(secretLike(p), p);
  for (const p of ['.env.example', 'src/env.ts', 'README.md', 'docs/keys.md']) assert.ok(!secretLike(p), p);
});

test('chat mode in the hook: a chat run is refused everything without its root, and secret reads with it, before the project guardrails', async () => {
  const { dir, stateDir } = exampleProject();
  writeFileSync(join(dir, '.env.local'), 'TOKEN=x\n');
  const call = async (tool: string, input: Record<string, unknown>, root?: string) => {
    const out = await runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd: dir, tool_name: tool, tool_input: input }, { ...process.env, [`${BRAND.envPrefix}_AGENT`]: '1', [`${BRAND.envPrefix}_ROLE`]: CHAT_ROLE, [`${BRAND.envPrefix}_STATE_DIR`]: stateDir, ...(root ? { [CHAT_ROOT_ENV]: root } : {}) });
    return out.stdout ? (JSON.parse(out.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput : null;
  };
  assert.equal((await call('Read', { file_path: join(dir, 'README.md') }))?.permissionDecision, 'deny', 'no root: fail closed');
  assert.equal((await call('Read', { file_path: join(dir, 'README.md') }, dir))?.permissionDecision ?? 'allow', 'allow');
  for (const [tool, input] of [['Read', { file_path: join(dir, '.env.local') }], ['Bash', { command: 'cat .env.local' }], ['Write', { file_path: join(dir, 'x') }], ['Read', { file_path: '/etc/hosts' }]] as const) {
    const d = await call(tool, input, dir);
    assert.equal(d?.permissionDecision, 'deny', `${tool} ${JSON.stringify(input)}`);
  }
});

test("the chat lane: the instance's agent user, its home and credential stores denied, key files denied to Read, and the checkout pinned as the hook's root", () => {
  const root = mkdtempSync(join(tmpdir(), 'lanes-'));
  const i = {
    name: 'inst',
    home: join(root, 'home', 'state-home'),
    stateDir: join(root, 'home', 'state-home', 'state'),
    repo: { path: join(root, 'srv', 'inst', 'repo'), repo: REPO },
    runAs: { user: 'wl-inst-agent', home: join(root, 'home', 'agent') },
    evalAs: null,
    policy: { sandbox: true } as Instance['policy'],
    credentials: { version: 1, github: { kind: 'gh-config-dir', path: join(root, 'gh') } } as Instance['credentials'],
    config: {} as Instance['config'],
  } as Instance;
  const lane = researchLanes(i, { runAs: i.runAs! })[CHAT_LANE]!;
  assert.equal(lane.runAs?.user, 'wl-inst-agent');
  assert.equal(lane.ownHooks, undefined, "the instance's guardrail hooks run (with their chat mode)");
  assert.equal(lane.settings.env?.[CHAT_ROOT_ENV], i.repo.path);
  const deny = lane.settings.permissions.deny;
  const home = i.home.startsWith('/') ? i.home : `/${i.home}`;
  for (const tool of ['Read', 'Glob', 'Grep']) assert.ok(deny.includes(`${tool}(/${home}/**)`), `${tool} denied on the instance home`);
  for (const r of ['Read(**/.env)', 'Read(**/*.pem)', 'Read(**/credentials.yaml)', 'Read(**/intake.yaml)', 'Read(**/policy.yaml)']) assert.ok(deny.includes(r), r);
  assert.ok(!deny.some((d) => d.includes(i.repo.path)), 'the checkout itself is readable');
  assert.ok((lane.settings.sandbox as { filesystem: { denyRead: string[] } }).filesystem.denyRead.some((p) => p.endsWith('state-home')), 'sandboxed too');
});
