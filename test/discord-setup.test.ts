// The first-run page's Discord step (src/intake/discord-setup.ts), against a fake Discord REST API
// (scripts/ci/fake-discord.mjs): the invite link's permission integer; the bot's view through a child process, so the
// dashboard's own process never opens the token file; a pasted token to a 0400 file and credentials.yaml; the picks
// written to intake.yaml through its schema, only as the exact diff an owner confirmed; nothing changed when the
// step is only looked at; the token in no response, event or audit line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { secretsDir } from '../src/console/secrets.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { setDiscordToken } from '../src/instance.js';
import { INTAKE_FILE, loadIntakeConfig } from '../src/intake/config.js';
import { discordChannelsCommand, type ChannelRow } from '../src/intake/discord-channels.js';
import { applyIntake, botView, DiscordSetupError, discordSetupView, INVITE_PERMISSION_INTEGER, INVITE_PERMISSIONS, inviteUrl, lineDiff, planIntake, systemRunCli, tokenState, type RunCli } from '../src/intake/discord-setup.js';
import { asPerson, engineCli, exampleProject, exampleRoles, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
// Shaped like a bot token (credentials.sh's check), and not a real one.
const TOKEN = 'MTAwMDAwMDAwMDAwMDAwMDAx.fake02.placeholder-bot-token-value';

interface Fake {
  api: string;
  seen: { method: string; path: string; authorized: boolean; tokenInUrl: boolean }[];
  close(): Promise<void>;
}
const fake = (await import(pathToFileURL(join(repoRoot, 'scripts', 'ci', 'fake-discord.mjs')).href)) as {
  startFakeDiscord(o: { token: string; application?: unknown }): Promise<Fake>;
};

const ALPHA = '900000000000000001';
const ZETA = '900000000000000002';
const [GENERAL, ENGINE, NEWS, ASKS, SUPERFAN, CHAT, IDEAS] = ['100000000000000011', '100000000000000012', '100000000000000015', '100000000000000016', '100000000000000017', '100000000000000018', '100000000000000021'] as const;

/** An instance home (instance.yaml, policy.yaml, credentials.yaml) in an instances dir of its own. */
function instance(o: { token?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsetup-'));
  const home = join(dir, 'shop');
  mkdirSync(home);
  writeFileSync(join(home, 'instance.yaml'), 'version: 1\nname: shop\nrepos: [{ path: ./repo, repo: example/shop }]\n');
  writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 20 }\nagents: { max_workers: 2 }\nland_mode: pr\nauto_merge: false\n');
  const tokenFile = join(home, 'discord-token');
  if (o.token) writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o400 });
  writeFileSync(join(home, 'credentials.yaml'), `version: 1\n# the App\ngithub: { kind: gh-config-dir, path: /nonexistent }\n${o.token ? `intake: { discord_token: ${JSON.stringify(tokenFile)} }\n` : ''}`, { mode: 0o600 });
  return { dir, home, tokenFile, intake: join(home, INTAKE_FILE), credentials: join(home, 'credentials.yaml') };
}

/** The child process's stand-in: the same command, in this process, against the fake Discord. */
const cliAgainst = (api: string, dir: string): RunCli => async (args) => {
  assert.deepEqual(args, ['discord', 'channels', '--instance', 'shop', '--json']);
  const out: string[] = [];
  const err: string[] = [];
  const status = await discordChannelsCommand({ instance: 'shop', dir, api, json: true, out: (l) => out.push(l), err: (l) => err.push(l), sleep: async () => {} });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
};

const rows = async (api: string, dir: string): Promise<ChannelRow[]> => (await botView('shop', cliAgainst(api, dir))).channels;

/** Every file under a directory with its mode and content, to show nothing changed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = `${(statSync(p).mode & 0o777).toString(8)} ${readFileSync(p, 'utf8')}`;
    }
  };
  walk(dir);
  return out;
}

test("the invite link asks for exactly intake's four permissions, and the docs state the same integer", () => {
  // Discord's own bit positions (its permissions table): the integer is their sum and nothing more.
  const discord = { 'View Channels': 1n << 10n, 'Send Messages': 1n << 11n, 'Create Public Threads': 1n << 35n, 'Send Messages in Threads': 1n << 38n };
  assert.deepEqual(INVITE_PERMISSIONS.map((p) => p.name), Object.keys(discord));
  for (const p of INVITE_PERMISSIONS) assert.equal(1n << BigInt(p.bit), discord[p.name]);
  assert.equal(INVITE_PERMISSION_INTEGER, '309237648384');
  assert.equal(BigInt(INVITE_PERMISSION_INTEGER), Object.values(discord).reduce((a, b) => a + b, 0n));
  // Not Administrator (bit 3), Manage Channels (4), Manage Server (5), Mention Everyone (17) or Manage Messages (13).
  for (const bit of [3n, 4n, 5n, 13n, 17n]) assert.equal(BigInt(INVITE_PERMISSION_INTEGER) & (1n << bit), 0n);
  assert.equal(inviteUrl('700000000000000001'), 'https://discord.com/oauth2/authorize?client_id=700000000000000001&scope=bot&permissions=309237648384');
  assert.throws(() => inviteUrl('1&scope=admin'), DiscordSetupError);
  const docs = readFileSync(join(repoRoot, 'docs', 'intake.md'), 'utf8');
  assert.ok(docs.includes(`permissions=${INVITE_PERMISSION_INTEGER}`), 'docs/intake.md gives the link with the integer');
  for (const p of INVITE_PERMISSIONS) assert.ok(docs.includes(`**${p.name}**`), `docs/intake.md names ${p.name}`);
});

test('discord channels --json: the application and each channel with its server id; GET only; the token nowhere in the output', async () => {
  const d = await fake.startFakeDiscord({ token: TOKEN });
  const i = instance({ token: true });
  try {
    const r = await cliAgainst(d.api, i.dir)(['discord', 'channels', '--instance', 'shop', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout) as { application: unknown; channels: ChannelRow[] };
    assert.deepEqual(j.application, { id: '700000000000000001', name: 'Example Bot', message_content: true });
    assert.deepEqual(j.channels.map((c) => `${c.guild_id} ${c.guild} #${c.name} ${c.id}`), [
      `${ALPHA} Alpha Server #asks ${ASKS}`,
      `${ALPHA} Alpha Server #chat ${CHAT}`,
      `${ALPHA} Alpha Server #general ${GENERAL}`,
      `${ALPHA} Alpha Server #news ${NEWS}`,
      `${ALPHA} Alpha Server #superfan-engine ${ENGINE}`,
      `${ALPHA} Alpha Server #superfan-shop ${SUPERFAN}`,
      `${ZETA} Zeta Server #ideas ${IDEAS}`,
    ]);
    assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
    assert.ok(d.seen.length >= 4);
    for (const s of d.seen) assert.deepEqual({ method: s.method, authorized: s.authorized, tokenInUrl: s.tokenInUrl }, { method: 'GET', authorized: true, tokenInUrl: false });
  } finally {
    await d.close();
  }
  // A name Discord sends back with the token in it (an echo) never leaves with it.
  const echo = await fake.startFakeDiscord({ token: TOKEN, application: { id: '700000000000000001', name: `bot ${TOKEN}`, flags: 0 } });
  try {
    const r = await cliAgainst(echo.api, i.dir)(['discord', 'channels', '--instance', 'shop', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(TOKEN), 'scrubbed from the JSON line');
    assert.equal((JSON.parse(r.stdout) as { application: { name: string } }).application.name, 'bot [token]');
  } finally {
    await echo.close();
  }
  // The intent off, as Discord's flags say it.
  const off = await fake.startFakeDiscord({ token: TOKEN, application: { id: '700000000000000001', name: 'Example Bot', flags: 0 } });
  try {
    assert.equal((await botView('shop', cliAgainst(off.api, i.dir))).application.message_content, false);
  } finally {
    await off.close();
  }
});

test('the bot view through the real child process: a failure is the command\'s own line, and bad output is refused', async () => {
  const i = instance();
  // The engine's own CLI, as the dashboard runs it; this instance has no token, so nothing reaches Discord.
  const run = systemRunCli(engineCli, { ...process.env, [`${BRAND.envPrefix}_INSTANCES_DIR`]: i.dir });
  await assert.rejects(botView('shop', run), (e: unknown) => e instanceof DiscordSetupError && e.status === 502 && /instance shop has no bot token/.test(e.message));
  await assert.rejects(botView('shop', async () => ({ status: 0, stdout: '{"application":{"id":"x"},"channels":[]}', stderr: '' })), /could not be read/);
  await assert.rejects(botView('shop', async () => ({ status: 0, stdout: 'not json', stderr: '' })), /could not be read/);
});

test('setDiscordToken: credentials.yaml names the file, the rest kept, 0600; a token file others can read is refused', { skip: !posix && 'POSIX modes' }, () => {
  const i = instance();
  writeFileSync(i.tokenFile, TOKEN, { mode: 0o400 });
  setDiscordToken(i.credentials, i.tokenFile);
  const text = readFileSync(i.credentials, 'utf8');
  assert.deepEqual(parse(text), { version: 1, github: { kind: 'gh-config-dir', path: '/nonexistent' }, intake: { discord_token: i.tokenFile } });
  assert.match(text, /# the App/, 'a comment is kept');
  assert.equal(statSync(i.credentials).mode & 0o777, 0o600);
  assert.ok(!text.includes(TOKEN), 'the path only, never the token');
  // Refused, and the file left as it was: a relative path, a missing file, one its group can read, no credentials.yaml.
  const open = join(i.home, 'open-token');
  writeFileSync(open, TOKEN, { mode: 0o640 });
  fs.chmodSync(open, 0o640);
  assert.throws(() => setDiscordToken(i.credentials, open), /open to its group or others/);
  assert.throws(() => setDiscordToken(i.credentials, 'discord-token'), /absolute path/);
  assert.throws(() => setDiscordToken(i.credentials, join(i.home, 'none')), /no token file/);
  assert.throws(() => setDiscordToken(join(i.home, 'missing.yaml'), i.tokenFile), /GitHub credential comes first/);
  assert.equal(readFileSync(i.credentials, 'utf8'), text);
});

test('this process never opens the token file: the view, the plan and the write know its path only', async () => {
  const d = await fake.startFakeDiscord({ token: TOKEN });
  const i = instance({ token: true });
  // The bot's list, read once by the stand-in for the child process (which is what reads the token).
  const channels = await rows(d.api, i.dir);
  await d.close();
  const canned = JSON.stringify({ application: { id: '700000000000000001', name: 'Example Bot', message_content: true }, channels });
  const opened: string[] = [];
  const real = { readFileSync: fs.readFileSync, openSync: fs.openSync, open: fs.open, readFile: fs.readFile, createReadStream: fs.createReadStream, promisesReadFile: fs.promises.readFile, promisesOpen: fs.promises.open };
  const note = (p: unknown) => void opened.push(String(p));
  fs.readFileSync = ((p: fs.PathOrFileDescriptor, ...a: unknown[]) => (note(p), (real.readFileSync as (...x: unknown[]) => unknown)(p, ...a))) as typeof fs.readFileSync;
  fs.openSync = ((p: fs.PathLike, ...a: unknown[]) => (note(p), (real.openSync as (...x: unknown[]) => number)(p, ...a))) as typeof fs.openSync;
  fs.open = ((p: fs.PathLike, ...a: unknown[]) => (note(p), (real.open as (...x: unknown[]) => void)(p, ...a))) as typeof fs.open;
  fs.readFile = ((p: fs.PathOrFileDescriptor, ...a: unknown[]) => (note(p), (real.readFile as (...x: unknown[]) => void)(p, ...a))) as typeof fs.readFile;
  fs.createReadStream = ((p: fs.PathLike, ...a: unknown[]) => (note(p), (real.createReadStream as (...x: unknown[]) => fs.ReadStream)(p, ...a))) as typeof fs.createReadStream;
  fs.promises.readFile = ((p: fs.PathLike, ...a: unknown[]) => (note(p), (real.promisesReadFile as (...x: unknown[]) => Promise<Buffer>)(p, ...a))) as typeof fs.promises.readFile;
  fs.promises.open = ((p: fs.PathLike, ...a: unknown[]) => (note(p), (real.promisesOpen as (...x: unknown[]) => Promise<fs.promises.FileHandle>)(p, ...a))) as typeof fs.promises.open;
  syncBuiltinESMExports();
  try {
    const t = tokenState(i.credentials);
    assert.deepEqual(t, { configured: true, file: i.tokenFile, present: true, error: null });
    const v = discordSetupView({ instance: 'shop', home: i.home, asks: [], role: 'owner', engineRoot: '/opt/engine', user: 'wl-shop' });
    assert.equal(v.token.present, true);
    const b = await botView('shop', async () => ({ status: 0, stdout: canned, stderr: '' }));
    const values = { 'discord.enabled': true, 'discord.guild': ALPHA, 'discord.channels': [GENERAL] };
    const plan = planIntake({ path: i.intake, values, channels: b.channels });
    applyIntake({ path: i.intake, values, channels: b.channels, expect: plan.hash });
    setDiscordToken(i.credentials, i.tokenFile);
    assert.ok(opened.includes(i.credentials), 'the spy sees this module read credentials.yaml');
    assert.ok(!opened.some((p) => p === i.tokenFile), `the token file was opened: ${opened.filter((p) => p === i.tokenFile).join(', ')}`);
    assert.ok(!JSON.stringify([t, v, b, plan]).includes(TOKEN));
  } finally {
    Object.assign(fs, { readFileSync: real.readFileSync, openSync: real.openSync, open: real.open, readFile: real.readFile, createReadStream: real.createReadStream });
    fs.promises.readFile = real.promisesReadFile;
    fs.promises.open = real.promisesOpen;
    syncBuiltinESMExports();
  }
});

test('planIntake: only picks from the bot\'s list, in the chosen server, a superfan channel of its own, through the schema; the rest of the file kept', { skip: !posix && 'POSIX modes' }, async () => {
  const d = await fake.startFakeDiscord({ token: TOKEN });
  const i = instance({ token: true });
  const channels = await rows(d.api, i.dir);
  await d.close();
  const plan = (values: Record<string, unknown>) => planIntake({ path: i.intake, values, channels });
  // A new file: created from the picks, ids as strings, as a diff of added lines only.
  const first = plan({ 'discord.enabled': true, 'discord.guild': ALPHA, 'discord.channels': [GENERAL], 'superfan.channel': SUPERFAN, 'superfan.machine_channel': ENGINE });
  assert.equal(first.creates, true);
  assert.equal(existsSync(i.intake), false, 'a plan writes nothing');
  assert.deepEqual(parse(first.text), { version: 1, discord: { enabled: true, guild: ALPHA, channels: [GENERAL] }, superfan: { channel: SUPERFAN, machine_channel: ENGINE } });
  assert.match(first.diff, new RegExp(`^--- \\(no ${INTAKE_FILE} yet\\)\\n\\+\\+\\+ ${INTAKE_FILE}\\n\\+version: 1\\n\\+discord:`));
  assert.ok(first.diff.split('\n').slice(2).every((l) => l.startsWith('+')));
  assert.deepEqual(first.warnings, ['discord is on but discord.allowed_senders is empty: no Discord message will be accepted']);
  // The schema's rule, held whether or not the superfan is on: its channels are not ones the bot reads.
  for (const [key, where] of [['discord.channels', [SUPERFAN]], ['discord.chat_channels', [SUPERFAN]], ['discord.asks_channel', SUPERFAN]] as const) {
    assert.throws(() => plan({ 'discord.guild': ALPHA, 'discord.dashboard_url': 'https://hub.example.test', [key]: where, 'superfan.channel': SUPERFAN }), /superfan\.channel: #superfan-shop is a channel the bot reads .* a superfan needs a channel of its own/, key);
  }
  assert.throws(() => plan({ 'discord.guild': ALPHA, 'discord.channels': [ENGINE], 'superfan.machine_channel': ENGINE }), /superfan\.machine_channel: #superfan-engine is a channel the bot reads/);
  // Not from the list: a channel the bot can't see, a server it isn't in, a voice channel's id.
  assert.throws(() => plan({ 'discord.guild': ALPHA, 'discord.channels': ['100000000000000099'] }), /discord\.channels: 100000000000000099 is not a channel the bot can see/);
  assert.throws(() => plan({ 'discord.guild': '900000000000000009' }), /discord\.guild: 900000000000000009 is not a server the bot can see/);
  assert.throws(() => plan({ 'superfan.channel': '100000000000000013' }), /not a channel the bot can see/);
  // A channel the bot reads must be in the chosen server; a post-only one (ops, superfan) may be elsewhere.
  assert.throws(() => plan({ 'discord.guild': ALPHA, 'discord.channels': [IDEAS] }), /discord\.channels: #ideas is in Zeta Server, not the chosen server \(Alpha Server\)/);
  assert.throws(() => plan({ 'discord.channels': [GENERAL] }), /discord\.guild: pick the server first/);
  assert.doesNotThrow(() => plan({ 'discord.guild': ALPHA, 'superfan.channel': IDEAS }));
  // The schema's own rules come through: the asks channel needs the dashboard's address; a chat channel is not an ideas channel.
  assert.throws(() => plan({ 'discord.guild': ALPHA, 'discord.asks_channel': ASKS }), /discord\.dashboard_url: discord\.dashboard_url is required with discord\.asks_channel/);
  assert.throws(() => plan({ 'discord.guild': ALPHA, 'discord.channels': [GENERAL], 'discord.chat_channels': [GENERAL] }), /a chat channel must not also be an ideas channel/);
  assert.throws(() => plan({ 'discord.enabled': true }), /discord\.guild \(the server id\) is required when discord is enabled/);
  // Only this step's keys, and only well-formed values.
  assert.throws(() => plan({ 'discord.owners': ['100000000000000001'] }), /not set here: discord\.owners/);
  assert.throws(() => plan({ 'trusted.discord': [] }), /not set here/);
  assert.throws(() => plan({ 'discord.guild': 'Alpha Server' }), /discord\.guild: must be an id/);
  assert.throws(() => plan({ 'discord.channels': GENERAL }), /must be a list of channel ids/);
  assert.throws(() => plan({ 'discord.enabled': 'yes' }), /must be true or false/);
  assert.throws(() => plan({}), /nothing to change/);

  // An existing file: only the picked keys change; comments, who may send and every other line stay.
  const existing = `version: 1\n# who may send: kept by hand\ndiscord:\n  enabled: true\n  guild: "${ALPHA}"\n  channels:\n    - "${GENERAL}"\n  allowed_senders: [ "200000000000000001" ] # the owner\n  people: { "200000000000000001": example-owner }\nraw_retention_days: 30\n`;
  writeFileSync(i.intake, existing, { mode: 0o600 });
  const second = plan({ 'discord.channels': [GENERAL, NEWS], 'discord.chat_channels': [CHAT], 'superfan.enabled': true, 'superfan.channel': SUPERFAN });
  assert.equal(second.creates, false);
  assert.deepEqual(second.changes, [
    { key: 'discord.channels', from: [GENERAL], to: [GENERAL, NEWS] },
    { key: 'discord.chat_channels', from: [], to: [CHAT] },
    { key: 'superfan.enabled', from: false, to: true },
    { key: 'superfan.channel', from: null, to: SUPERFAN },
  ]);
  for (const kept of ['# who may send: kept by hand', 'allowed_senders: [ "200000000000000001" ] # the owner', 'people: { "200000000000000001": example-owner }', 'raw_retention_days: 30']) assert.ok(second.text.includes(kept), kept);
  assert.ok(second.diff.split('\n').some((l) => l.startsWith('+') && l.includes(NEWS)));
  assert.deepEqual(second.diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')), [], 'lines are only added');
  assert.ok(!second.diff.split('\n').some((l) => /^[-+]/.test(l) && /allowed_senders|people|raw_retention/.test(l)), 'the other lines are not touched');
  assert.equal(readFileSync(i.intake, 'utf8'), existing, 'a plan writes nothing');
  // Clearing a key removes it; an id already in the file that the bot no longer sees may stay.
  writeFileSync(i.intake, `version: 1\ndiscord:\n  guild: "${ALPHA}"\n  channels: ["100000000000000099"]\nsuperfan:\n  channel: "${SUPERFAN}"\n`, { mode: 0o600 });
  const third = plan({ 'discord.channels': ['100000000000000099', GENERAL], 'superfan.channel': null });
  assert.deepEqual(parse(third.text), { version: 1, discord: { guild: ALPHA, channels: ['100000000000000099', GENERAL] }, superfan: {} });
  // A file the service would refuse is never rewritten here.
  fs.chmodSync(i.intake, 0o644);
  assert.throws(() => plan({ 'discord.channels': [GENERAL] }), /readable by its group or others/);
});

test('applyIntake writes only the change that was shown: 0600, renamed into place; a stale review writes nothing', { skip: !posix && 'POSIX modes' }, async () => {
  const d = await fake.startFakeDiscord({ token: TOKEN });
  const i = instance({ token: true });
  const channels = await rows(d.api, i.dir);
  await d.close();
  const values = { 'discord.enabled': true, 'discord.guild': ALPHA, 'discord.channels': [GENERAL] };
  const plan = planIntake({ path: i.intake, values, channels });
  assert.throws(() => applyIntake({ path: i.intake, values, channels, expect: 'not-the-hash' }), (e: unknown) => e instanceof DiscordSetupError && e.status === 409);
  assert.throws(() => applyIntake({ path: i.intake, values: { ...values, 'discord.channels': [NEWS] }, channels, expect: plan.hash }), /changed since the change was shown: nothing written/);
  assert.equal(existsSync(i.intake), false);
  applyIntake({ path: i.intake, values, channels, expect: plan.hash });
  assert.equal(readFileSync(i.intake, 'utf8'), plan.text);
  assert.equal(statSync(i.intake).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(i.home).filter((f) => f.includes('.tmp')), [], 'no temp file left behind');
  const loaded = loadIntakeConfig(i.intake);
  assert.ok(loaded && !('error' in loaded) && loaded.config.discord.guild === ALPHA && loaded.config.discord.enabled);
  // The file changed after the review (someone edited it): the confirm is refused and the edit stands.
  const next = planIntake({ path: i.intake, values: { 'discord.channels': [GENERAL, NEWS] }, channels });
  const edited = `${plan.text}raw_retention_days: 7\n`;
  writeFileSync(i.intake, edited, { mode: 0o600 });
  assert.throws(() => applyIntake({ path: i.intake, values: { 'discord.channels': [GENERAL, NEWS] }, channels, expect: next.hash }), /nothing written/);
  assert.equal(readFileSync(i.intake, 'utf8'), edited);
});

test('lineDiff: a unified diff by line, with context and gaps', () => {
  assert.equal(lineDiff(null, 'a\nb\n', 'f'), '--- (no f yet)\n+++ f\n+a\n+b');
  assert.equal(lineDiff('a\nb\nc\n', 'a\nB\nc\n', 'f'), '--- f\n+++ f\n a\n-b\n+B\n c');
  const before = Array.from({ length: 12 }, (_, n) => `l${n}`).join('\n') + '\n';
  assert.equal(lineDiff(before, before.replace('l0\n', 'L0\n').replace('l11\n', 'L11\n'), 'f'), '--- f\n+++ f\n-l0\n+L0\n l1\n l2\n l3\n@@\n l8\n l9\n l10\n-l11\n+L11');
});

test('the dashboard\'s Discord step: looking changes nothing; owners only; the token to a 0400 file and credentials.yaml; intake.yaml only as the confirmed diff', { skip: !posix && 'POSIX modes' }, async () => {
  const d = await fake.startFakeDiscord({ token: TOKEN });
  const i = instance();
  const { dir: root } = exampleProject();
  const state = mkdtempSync(join(tmpdir(), 'dsetup-state-'));
  const eventsDb = join(state, 'events.db');
  const secretsHome = join(state, 'home');
  let listings = 0;
  const cli = cliAgainst(d.api, i.dir);
  const dash = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: join(state, 'state'), user: 'example-owner', roleOf: exampleRoles, instance: 'shop', policyFile: join(i.home, 'policy.yaml'), slotsDir: join(state, 'slots'), secretsHome, webDir: join(state, 'web'), discordCli: (args) => (listings++, cli(args)) });
  const base = dash.url.split('/?')[0]!;
  const bodies: string[] = [];
  const call = async (path: string, login: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${dash.token}`, 'content-type': 'application/json', ...asPerson(login) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    bodies.push(text);
    return { status: r.status, json: JSON.parse(text) as Record<string, unknown> };
  };
  const owner = 'example-owner';
  const writer = 'example-collaborator';
  try {
    // Skipped: reading the step (as an owner, a writer) and being refused write nothing, anywhere.
    const before = snapshot(i.home);
    const v0 = await call('/api/first-run/discord', owner);
    assert.equal(v0.status, 200);
    assert.deepEqual(v0.json.token, { configured: false, file: null, present: false, error: null });
    assert.equal((v0.json.invite as { integer: string }).integer, '309237648384');
    assert.equal((v0.json.intake as { exists: boolean }).exists, false);
    assert.deepEqual(v0.json.automation, {
      token: `sudo bash ${join(repoRoot, 'scripts', 'setup', 'credentials.sh')} shop intake-discord`,
      channels: `sudo -H -u ${(v0.json.automation as { channels: string }).channels.split(' ')[3]} ${BRAND.cli} discord channels --instance shop`,
      file: i.intake,
      keys: ['discord.enabled', 'discord.guild', 'discord.channels', 'discord.asks_channel', 'discord.ops_channel', 'discord.chat_channels', 'discord.dashboard_url', 'superfan.enabled', 'superfan.channel', 'superfan.machine_channel'],
      restart: `sudo systemctl restart ${BRAND.cli}-shop.service`,
    });
    assert.equal((await call('/api/first-run/discord', writer)).json.canAct, false);
    assert.equal((await call('/api/first-run/discord', 'someone-else')).status, 403);
    // Only the owners act: a writer can't open the paste box, list the bot's channels or change intake.yaml.
    assert.equal((await call('/api/first-run/discord/token-ask', writer, { confirm: true })).status, 403);
    assert.equal((await call('/api/first-run/discord/channels', writer)).status, 403);
    assert.equal((await call('/api/first-run/discord/intake', writer, { values: { 'discord.enabled': true } })).status, 403);
    // No token yet: nothing to list with, and Discord is never asked.
    assert.equal((await call('/api/first-run/discord/channels', owner)).status, 409);
    assert.equal(listings, 0);
    assert.equal((await call('/api/first-run/discord/token-ask', owner, {})).status, 400, 'the paste box opens only when confirmed');
    assert.deepEqual(snapshot(i.home), before, 'nothing in the instance home changed');
    assert.equal(existsSync(secretsDir('shop', secretsHome)), false);
    assert.equal(d.seen.length, 0);

    // The token: a paste box (one, reused), then the setup console's secret route.
    const asked = await call('/api/first-run/discord/token-ask', owner, { confirm: true });
    assert.equal(asked.status, 200);
    const ask = asked.json.ask as { id: string; kind: string; credential: string };
    assert.deepEqual([ask.kind, ask.credential, asked.json.created], ['paste_secret', 'intake-discord', true]);
    const again = await call('/api/first-run/discord/token-ask', owner, { confirm: true });
    assert.deepEqual([(again.json.ask as { id: string }).id, again.json.created], [ask.id, false]);
    assert.equal(((await call('/api/first-run/discord', owner)).json.ask as { id: string }).id, ask.id);
    // Not token-shaped: refused with a fixed text, nothing stored, the ask still open.
    const bad = await call(`/api/asks/${ask.id}/secret`, owner, { value: 'not a token: $(id) 12345' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, "that doesn't look like a Discord bot token (the Bot page's Reset Token gives one); nothing stored");
    assert.equal(existsSync(secretsDir('shop', secretsHome)), false);
    assert.equal((await call(`/api/asks/${ask.id}/secret`, writer, { value: TOKEN })).status, 403);
    const pasted = await call(`/api/asks/${ask.id}/secret`, owner, { value: TOKEN });
    assert.equal(pasted.status, 200, JSON.stringify(pasted.json));
    const file = join(secretsDir('shop', secretsHome), 'intake-discord');
    assert.equal(readFileSync(file, 'utf8'), TOKEN);
    assert.equal(statSync(file).mode & 0o777, 0o400);
    assert.equal(statSync(secretsDir('shop', secretsHome)).mode & 0o777, 0o700);
    assert.equal(statSync(file).uid, process.getuid!());
    assert.deepEqual(parse(readFileSync(i.credentials, 'utf8')), { version: 1, github: { kind: 'gh-config-dir', path: '/nonexistent' }, intake: { discord_token: file } });
    assert.equal(statSync(i.credentials).mode & 0o777, 0o600);
    assert.match(String((pasted.json.ask as { answer: { detail: string } }).answer.detail), /credentials\.yaml intake\.discord_token now names it$/);
    const v1 = await call('/api/first-run/discord', owner);
    assert.deepEqual(v1.json.token, { configured: true, file, present: true, error: null });
    assert.equal(v1.json.ask, null);

    // The bot's own view: its application, the invite link, its channels. One listing serves the calls that follow.
    const bot = await call('/api/first-run/discord/channels', owner);
    assert.equal(bot.status, 200, JSON.stringify(bot.json));
    assert.equal(bot.json.invite, 'https://discord.com/oauth2/authorize?client_id=700000000000000001&scope=bot&permissions=309237648384');
    assert.equal((bot.json.channels as unknown[]).length, 7);
    await call('/api/first-run/discord/channels', owner);
    assert.equal(listings, 1);
    assert.ok(d.seen.every((s) => s.method === 'GET' && s.authorized && !s.tokenInUrl));

    // intake.yaml: the review shows the diff and writes nothing; refusals write nothing.
    const values = { 'discord.enabled': true, 'discord.guild': ALPHA, 'discord.channels': [GENERAL], 'discord.asks_channel': ASKS, 'discord.dashboard_url': 'https://hub.example.test', 'superfan.channel': SUPERFAN };
    const review = await call('/api/first-run/discord/intake', owner, { values });
    assert.equal(review.status, 200, JSON.stringify(review.json));
    assert.deepEqual([review.json.confirmed, review.json.creates], [false, true]);
    assert.match(String(review.json.diff), new RegExp(`\\+  guild: "${ALPHA}"`));
    assert.equal(review.json.text, undefined);
    assert.equal(existsSync(i.intake), false);
    const clash = await call('/api/first-run/discord/intake', owner, { values: { ...values, 'superfan.channel': GENERAL } });
    assert.equal(clash.status, 400);
    assert.match(String(clash.json.error), /superfan\.channel: #general is a channel the bot reads/);
    assert.equal((await call('/api/first-run/discord/intake', owner, { values, confirm: true })).status, 400, 'a confirm names the change');
    assert.equal((await call('/api/first-run/discord/intake', owner, { values, confirm: true, expect: 'f'.repeat(64) })).status, 409);
    assert.equal((await call('/api/first-run/discord/intake', owner, { values: { ...values, 'discord.channels': [NEWS] }, confirm: true, expect: review.json.hash })).status, 409, 'other picks than the reviewed ones');
    assert.equal(existsSync(i.intake), false);
    // Confirmed: exactly that change, 0600, loading through the service's own check.
    const done = await call('/api/first-run/discord/intake', owner, { values, confirm: true, expect: review.json.hash });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(statSync(i.intake).mode & 0o777, 0o600);
    assert.deepEqual(parse(readFileSync(i.intake, 'utf8')), { version: 1, discord: { enabled: true, guild: ALPHA, channels: [GENERAL], asks_channel: ASKS, dashboard_url: 'https://hub.example.test' }, superfan: { channel: SUPERFAN } });
    const loaded = loadIntakeConfig(i.intake);
    assert.ok(loaded && !('error' in loaded));
    const v2 = await call('/api/first-run/discord', owner);
    assert.deepEqual((v2.json.intake as { values: Record<string, unknown> }).values['discord.channels'], [GENERAL]);
    assert.equal((await call('/api/first-run/discord/intake', owner, { values })).status, 400, 'nothing to change now');

    // Audited: the paste box, the write and each refusal; and the token is in no event, audit line or response.
    const log = new EventLog(eventsDb);
    const events = log.read(0);
    log.close();
    const audit = events.filter((e) => e.type === 'dashboard.audit').map((e) => (e.payload as { action: string }).action);
    assert.ok(audit.includes('first_run.discord_token_ask') && audit.includes('first_run.discord_intake') && audit.includes('first_run.discord_refused'), audit.join(', '));
    assert.equal(audit.filter((a) => a === 'first_run.discord_intake').length, 1);
    assert.ok(!JSON.stringify(events).includes(TOKEN), 'not in any event');
    assert.ok(!bodies.join('\n').includes(TOKEN), 'not in any response');
    assert.ok(!bodies.join('\n').includes('not a token: $(id)'), 'a refused paste is not echoed');
    for (const f of [eventsDb, `${eventsDb}-wal`]) if (existsSync(f)) assert.ok(!readFileSync(f).includes(TOKEN), `not in ${f}`);
  } finally {
    await dash.close();
    await d.close();
  }
});

test("a checkout's dashboard has no Discord step: it says why and refuses the rest", async () => {
  const { dir: root } = exampleProject();
  const state = mkdtempSync(join(tmpdir(), 'dsetup-local-'));
  const dash = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(state, 'events.db'), stateDir: join(state, 'state'), user: 'example-owner', slotsDir: join(state, 'slots'), webDir: join(state, 'web'), discordCli: async () => assert.fail('never run') });
  const base = dash.url.split('/?')[0]!;
  const h = { authorization: `Bearer ${dash.token}`, 'content-type': 'application/json' };
  try {
    const v = (await (await fetch(`${base}/api/first-run/discord`, { headers: h })).json()) as { available: boolean; why: string };
    assert.equal(v.available, false);
    assert.match(v.why, /server instance's/);
    assert.equal((await fetch(`${base}/api/first-run/discord/channels`, { headers: h })).status, 400);
    assert.equal((await fetch(`${base}/api/first-run/discord/intake`, { method: 'POST', headers: h, body: '{"values":{}}' })).status, 400);
  } finally {
    await dash.close();
  }
});
