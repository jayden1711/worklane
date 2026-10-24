// The first-run page's Slack and Linear steps (src/intake/source-setup.ts), beside Discord's: looking changes nothing;
// owners only act (a writer reads, a viewer is refused, every refusal audited); each secret through the paste box to a
// 0400 file and credentials.yaml, shape-checked; what the secret sees from the child process only (the dashboard never
// opens a secret file); intake.yaml written only as the exact diff an owner confirmed, only the step's own keys, ids
// only from the view; who may send never written here. Plus the view commands: the secret scrubbed from everything
// they print, and their requests only to Slack's and Linear's own bases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadConfig } from '../src/config/load.js';
import { secretsDir } from '../src/console/secrets.js';
import { startDashboard } from '../src/dashboard.js';
import { discordListingStandIn, type RunCli } from '../src/intake/discord-setup.js';
import { EventLog } from '../src/events/log.js';
import { INTAKE_FILE } from '../src/intake/config.js';
import { LINEAR_API } from '../src/intake/linear.js';
import { SLACK_API } from '../src/intake/slack.js';
import { credStates, intakeSourcesSummary, planSourceIntake, slackManifest, SLACK_SCOPES, type SourceView } from '../src/intake/source-setup.js';
import { tokenState } from '../src/intake/discord-setup.js';
import { sourceViewCommand } from '../src/intake/source-view.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

const posix = process.platform !== 'win32';
// Token-shaped placeholders, joined at run time so no secret scanner takes the source for a real token.
const APP_TOKEN = ['xapp', '1', 'A0000000001', '0000000000000', 'placeholderappleveltokenvalue'].join('-');
const BOT_TOKEN = ['xoxb', '0000000000', '0000000000000', 'placeholderbottokenvalue'].join('-');
const LINEAR_KEY = 'lin_api_PLACEHOLDERKEY0000000000000000000000';
const TEAM = 'T0000000001';
const [IDEAS, OTHER] = ['C0000000001', 'C0000000002'];
const LTEAM = '00000000-0000-4000-8000-000000000001';
const LLABEL = '00000000-0000-4000-8000-000000000002';

const SLACK_VIEW = { team: { id: TEAM, name: 'Example' }, bot: { user: 'U00000000B0' }, channels: [{ id: IDEAS, name: 'ideas', member: true }, { id: OTHER, name: 'random', member: false }], members: [{ id: 'U0000000011', name: 'Ada' }] };
const LINEAR_VIEW = { organization: { name: 'Example' }, viewer: { id: '00000000-0000-4000-8000-000000000010', name: 'Intake bot' }, teams: [{ id: LTEAM, name: 'Engineering', key: 'ENG', labels: [{ id: LLABEL, name: 'intake' }], members: [{ id: '00000000-0000-4000-8000-000000000011', name: 'Ada' }] }], labels: [] };

function instance() {
  const dir = mkdtempSync(join(tmpdir(), 'ssetup-'));
  const home = join(dir, 'shop');
  mkdirSync(home);
  writeFileSync(join(home, 'instance.yaml'), 'version: 1\nname: shop\nrepos: [{ path: ./repo, repo: example/shop }]\n');
  writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 20 }\nagents: { max_workers: 2 }\nland_mode: pr\nauto_merge: false\n');
  writeFileSync(join(home, 'credentials.yaml'), 'version: 1\ngithub: { kind: gh-config-dir, path: /nonexistent }\n', { mode: 0o600 });
  return { dir, home, intake: join(home, INTAKE_FILE), credentials: join(home, 'credentials.yaml') };
}

test('the Slack manifest asks for exactly Socket Mode, the app_mention event and the four bot scopes; nothing else', () => {
  const m = slackManifest('Example intake') as { oauth_config: { scopes: { bot: string[]; user?: unknown } }; settings: Record<string, unknown> };
  assert.deepEqual(m.oauth_config.scopes, { bot: ['app_mentions:read', 'chat:write', 'users:read', 'channels:read'] });
  assert.deepEqual(m.settings, { event_subscriptions: { bot_events: ['app_mention'] }, interactivity: { is_enabled: false }, org_deploy_enabled: false, socket_mode_enabled: true, token_rotation_enabled: false });
  assert.deepEqual(SLACK_SCOPES.map((s) => s.scope), m.oauth_config.scopes.bot);
});

test('planSourceIntake: only the step\'s keys, ids only from the view, the workspace the token belongs to; who may send kept by hand', { skip: !posix && 'POSIX modes' }, () => {
  const i = instance();
  writeFileSync(i.intake, `version: 1\n# who may send: by hand\nslack:\n  allowed_senders: ["U0000000011"]\n`, { mode: 0o600 });
  const view: SourceView = { kind: 'slack', ...SLACK_VIEW };
  const plan = planSourceIntake({ kind: 'slack', path: i.intake, values: { 'slack.enabled': true, 'slack.team': TEAM, 'slack.channels': [IDEAS] }, view });
  assert.match(plan.diff, /# who may send: by hand/);
  assert.deepEqual(parse(plan.text), { version: 1, slack: { allowed_senders: ['U0000000011'], enabled: true, team: TEAM, channels: [IDEAS] } });
  assert.throws(() => planSourceIntake({ kind: 'slack', path: i.intake, values: { 'slack.allowed_senders': ['U0000000099'] }, view }), /not set here: slack\.allowed_senders/);
  assert.throws(() => planSourceIntake({ kind: 'slack', path: i.intake, values: { 'slack.channels': ['C0000000777'] }, view }), /C0000000777 is not in what the Slack app can see/);
  assert.throws(() => planSourceIntake({ kind: 'slack', path: i.intake, values: { 'slack.team': 'T0000000999' }, view }), /T0000000999 is not in what the Slack app can see/);
  const lview: SourceView = { kind: 'linear', ...LINEAR_VIEW };
  assert.throws(() => planSourceIntake({ kind: 'linear', path: i.intake, values: { 'linear.label': '00000000-0000-4000-8000-000000000777' }, view: lview }), /is not in what the Linear key can see/);
  assert.throws(() => planSourceIntake({ kind: 'linear', path: i.intake, values: { 'linear.enabled': true }, view: lview }), /linear\.team and linear\.label are required/);
});

test('the view commands: the secret is scrubbed from everything printed, and requests go only to Slack\'s and Linear\'s own bases', { skip: !posix && 'POSIX modes' }, async () => {
  const i = instance();
  const bot = join(i.home, 'slack-bot-token');
  const key = join(i.home, 'linear-api-key');
  writeFileSync(bot, `${BOT_TOKEN}\n`, { mode: 0o400 });
  writeFileSync(key, `${LINEAR_KEY}\n`, { mode: 0o400 });
  writeFileSync(i.credentials, `version: 1\ngithub: { kind: gh-config-dir, path: /nonexistent }\nintake: { slack_bot_token: ${JSON.stringify(bot)}, linear_api_key: ${JSON.stringify(key)} }\n`, { mode: 0o600 });
  const urls: string[] = [];
  const slackFetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const m = String(url).slice(SLACK_API.length + 1);
    // A server that echoes the token back in a name: it must not leave the command.
    const a = m === 'auth.test' ? { ok: true, team_id: TEAM, team: `Example ${BOT_TOKEN}`, user_id: 'U00000000B0' } : m === 'conversations.list' ? { ok: true, channels: [{ id: IDEAS, name: 'ideas', is_member: true }] } : { ok: true, members: [{ id: 'U0000000011', profile: { display_name: 'Ada' } }, { id: 'U0000000012', is_bot: true }] };
    return new Response(JSON.stringify(a));
  }) as typeof fetch;
  const out: string[] = [];
  const err: string[] = [];
  assert.equal(await sourceViewCommand({ kind: 'slack', instance: 'shop', dir: i.dir, json: true, fetch: slackFetch, out: (l) => out.push(l), err: (l) => err.push(l) }), 0, err.join('\n'));
  const v = JSON.parse(out[0]!) as typeof SLACK_VIEW;
  assert.equal(v.team.name, 'Example [key]');
  assert.deepEqual(v.members, [{ id: 'U0000000011', name: 'Ada' }], 'no bots');
  assert.ok(urls.every((u) => u.startsWith(`${SLACK_API}/`)), urls.join(', '));
  const lfetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ errors: [{ message: `bad key ${LINEAR_KEY}` }] }), { status: 401 });
  }) as typeof fetch;
  assert.equal(await sourceViewCommand({ kind: 'linear', instance: 'shop', dir: i.dir, fetch: lfetch, out: (l) => out.push(l), err: (l) => err.push(l) }), 1);
  assert.ok(urls.at(-1) === LINEAR_API);
  assert.ok(!err.join('\n').includes(LINEAR_KEY) && !out.join('\n').includes(BOT_TOKEN), 'no secret printed');
});

test("the dashboard's Slack and Linear steps: looking changes nothing; owners only, audited; secrets to 0400 files; intake.yaml only as the confirmed diff", { skip: !posix && 'POSIX modes' }, async () => {
  const i = instance();
  const { dir: root } = exampleProject();
  const state = mkdtempSync(join(tmpdir(), 'ssetup-state-'));
  const eventsDb = join(state, 'events.db');
  const secretsHome = join(state, 'home');
  const runs: string[][] = [];
  const cli: RunCli = async (args) => {
    runs.push(args);
    assert.deepEqual(args.slice(1), ['view', '--instance', 'shop', '--json']);
    return { status: 0, stdout: `${JSON.stringify(args[0] === 'slack' ? SLACK_VIEW : LINEAR_VIEW)}\n`, stderr: '' };
  };
  const dash = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: join(state, 'state'), user: 'example-owner', roleOf: exampleRoles, instance: 'shop', policyFile: join(i.home, 'policy.yaml'), slotsDir: join(state, 'slots'), secretsHome, webDir: join(state, 'web'), discordListing: discordListingStandIn(cli) });
  const base = dash.url.split('/?')[0]!;
  const bodies: string[] = [];
  const call = async (path: string, login: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${dash.token}`, 'content-type': 'application/json', ...asPerson(login) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    bodies.push(text);
    return { status: r.status, json: JSON.parse(text) as Record<string, unknown> };
  };
  const [owner, writer, viewer] = ['example-owner', 'example-collaborator', 'someone-else'];
  try {
    const before = readFileSync(i.credentials, 'utf8');
    // Looking: an owner and a writer read the step (the writer may not act); a viewer is refused.
    const v0 = await call('/api/first-run/slack', owner);
    assert.equal(v0.status, 200);
    assert.deepEqual([v0.json.kind, v0.json.canAct, (v0.json.creds as unknown[]).length], ['slack', true, 2]);
    assert.equal((await call('/api/first-run/slack', writer)).json.canAct, false);
    assert.equal((await call('/api/first-run/linear', viewer)).status, 403);
    // A writer (and a viewer) can't open a paste box, load the view or change intake.yaml.
    for (const who of [writer, viewer]) {
      assert.equal((await call('/api/first-run/slack/token-ask', who, { confirm: true, credential: 'intake-slack-bot' })).status, 403);
      assert.equal((await call('/api/first-run/linear/view', who)).status, 403);
      assert.equal((await call('/api/first-run/linear/intake', who, { values: { 'linear.enabled': true } })).status, 403);
    }
    // No secrets yet: no view (the child is never run); the paste box only when confirmed and named.
    assert.equal((await call('/api/first-run/slack/view', owner)).status, 409);
    assert.equal(runs.length, 0);
    assert.equal((await call('/api/first-run/slack/token-ask', owner, { credential: 'intake-slack-bot' })).status, 400);
    assert.equal((await call('/api/first-run/slack/token-ask', owner, { confirm: true, credential: 'intake-linear' })).status, 400, "another source's secret");
    assert.equal(readFileSync(i.credentials, 'utf8'), before);
    assert.equal(existsSync(i.intake), false);

    // The secrets: a paste box each, shape-checked, to a 0400 file, credentials.yaml pointed at it.
    const paste = async (kind: string, credential: string, value: string) => {
      const a = await call(`/api/first-run/${kind}/token-ask`, owner, { confirm: true, credential });
      assert.equal(a.status, 200, JSON.stringify(a.json));
      return call(`/api/asks/${(a.json.ask as { id: string }).id}/secret`, owner, { value });
    };
    const wrong = await paste('slack', 'intake-slack-bot', APP_TOKEN);
    assert.deepEqual([wrong.status, wrong.json.error], [400, "that doesn't look like a Slack bot token (xoxb-...); nothing stored"]);
    assert.equal((await paste('slack', 'intake-slack-bot', BOT_TOKEN)).status, 200);
    assert.equal((await paste('slack', 'intake-slack-app', APP_TOKEN)).status, 200);
    assert.equal((await paste('linear', 'intake-linear', LINEAR_KEY)).status, 200);
    const files = ['intake-slack-app', 'intake-slack-bot', 'intake-linear'].map((f) => join(secretsDir('shop', secretsHome), f));
    for (const f of files) assert.equal(statSync(f).mode & 0o777, 0o400);
    assert.deepEqual(parse(readFileSync(i.credentials, 'utf8')).intake, { slack_bot_token: files[1], slack_app_token: files[0], linear_api_key: files[2] });

    // The view, from the child process only; then a reviewed change, written only as confirmed.
    assert.equal((await call('/api/first-run/slack/view', owner)).status, 200);
    assert.deepEqual(runs.map((r) => r[0]), ['slack']);
    const values = { 'slack.enabled': true, 'slack.team': TEAM, 'slack.channels': [IDEAS] };
    const review = await call('/api/first-run/slack/intake', owner, { values });
    assert.equal(review.status, 200, JSON.stringify(review.json));
    assert.deepEqual(review.json.warnings, ['slack is on but slack.allowed_senders is empty: no Slack message will be accepted']);
    assert.equal(existsSync(i.intake), false, 'a review writes nothing');
    assert.equal((await call('/api/first-run/slack/intake', owner, { values, confirm: true, expect: 'f'.repeat(64) })).status, 409, 'a stale or other hash writes nothing');
    assert.equal((await call('/api/first-run/slack/intake', owner, { values: { ...values, 'slack.allowed_senders': ['U0000000099'] } })).status, 400, 'who may send is never set here');
    assert.equal(existsSync(i.intake), false);
    const done = await call('/api/first-run/slack/intake', owner, { values, confirm: true, expect: review.json.hash });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.deepEqual(parse(readFileSync(i.intake, 'utf8')), { version: 1, slack: { enabled: true, team: TEAM, channels: [IDEAS] } });
    assert.equal(statSync(i.intake).mode & 0o777, 0o600);

    // The Intake page's strip: states and counts, never an id or a secret; the setup link for owners only.
    const page = await call('/api/intake', owner);
    assert.deepEqual(page.json.sources, intakeSourcesSummary(i.home));
    assert.deepEqual((page.json.sources as { name: string; state: string }[]).map((s) => [s.name, s.state]), [['discord', 'none'], ['slack', 'on'], ['linear', 'off']]);
    assert.equal(page.json.canSetUpSources, true);
    assert.equal((await call('/api/intake', writer)).json.canSetUpSources, false);

    // Audited; and no secret in any event or response.
    const log = new EventLog(eventsDb);
    const events = log.read(0);
    log.close();
    const audit = events.filter((e) => e.type === 'dashboard.audit').map((e) => (e.payload as { action: string }).action);
    for (const a of ['first_run.slack_token_ask', 'first_run.linear_token_ask', 'first_run.slack_intake', 'first_run.slack_refused', 'first_run.linear_refused']) assert.ok(audit.includes(a), `${a} in ${audit.join(', ')}`);
    for (const secret of [APP_TOKEN, BOT_TOKEN, LINEAR_KEY]) {
      assert.ok(!JSON.stringify(events).includes(secret), 'not in any event');
      assert.ok(!bodies.join('\n').includes(secret), 'not in any response');
    }
  } finally {
    await dash.close();
  }
});

test("#882: credentials.yaml unreadable or invalid is named by its name in the Slack and Linear steps and the Discord step, never its path", () => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-name-'));
  const file = join(dir, 'credentials.yaml');
  const errors = () => [...credStates(file, 'slack').map((c) => c.error), tokenState(file).error];
  const missing = errors();
  writeFileSync(file, 'version: 1\ngithub: 3\n', { mode: 0o600 });
  const invalid = errors();
  for (const e of missing) assert.equal(e, "can't read credentials.yaml (ENOENT)");
  for (const e of invalid) assert.match(e ?? '', /^credentials\.yaml is invalid: /);
  for (const e of [...missing, ...invalid]) assert.ok(!e!.includes(dir), `${dir} in ${e}`);
});
