// WHY: wizard screen 2, Sign in to Claude (src/claude-signin.ts). Local mode relays `claude auth login` with nothing
// pasted and no token through the dashboard; a server's agents get a pasted setup token through the existing
// paste_secret ask. Each guard here has a test that fails without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { relayableSigninUrl, parseClaudeStatus, type ClaudeStatus, type SigninChild, type SigninDeps } from '../src/claude-signin.js';
import { asks } from '../src/console/asks.js';
import { startDashboard, type DashboardOptions } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { browserRelay } from '../src/os/index.js';
import type { SetupProbe, SetupView } from '../src/setup-steps.js';
import { asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'claude-signin-state-'));
const posix = process.platform !== 'win32';

const q = (redirect: string) =>
  `https://claude.com/cai/oauth/authorize?code=true&client_id=example-client&response_type=code&redirect_uri=${encodeURIComponent(redirect)}&scope=user%3Ainference&code_challenge=example-challenge&code_challenge_method=S256&state=example-state-0123`;
/** What claude auth login hands its browser opener: Anthropic's page, back to its own listener on localhost. */
const LOCAL_URL = q('http://localhost:54321/callback');
/** What it prints for a browser elsewhere: back to Anthropic's page, which shows a code to paste. */
const PASTE_URL = q('https://platform.claude.com/oauth/code/callback');

test('only a sign-in link that comes back to localhost is relayed: never the paste-a-code one, another host, or plain http', () => {
  assert.equal(relayableSigninUrl(`${LOCAL_URL}\n`), LOCAL_URL);
  assert.equal(relayableSigninUrl(LOCAL_URL.replace('claude.com/cai', 'claude.ai')), LOCAL_URL.replace('claude.com/cai', 'claude.ai'));
  assert.equal(relayableSigninUrl(PASTE_URL), null, 'its redirect is a page that shows a code to paste');
  assert.equal(relayableSigninUrl(LOCAL_URL.replace('https://claude.com', 'http://claude.com')), null);
  assert.equal(relayableSigninUrl(LOCAL_URL.replace('claude.com', 'claude.com.example.net')), null);
  assert.equal(relayableSigninUrl(LOCAL_URL.replace('https://claude.com', 'https://user@claude.com')), null);
  assert.equal(relayableSigninUrl(LOCAL_URL.replace('/oauth/authorize', '/somewhere')), null);
  assert.equal(relayableSigninUrl(q('http://localhost.example.net:1/callback')), null);
  assert.equal(relayableSigninUrl('javascript:alert(1)'), null);
  assert.equal(relayableSigninUrl(''), null);
});

test("claude auth status: signed in or not, how, and the cached account only when signed in; nothing else is kept", () => {
  assert.deepEqual(parseClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@example.com', orgName: 'x', configDirectory: '/h' })), { loggedIn: true, method: 'claude.ai', cachedAccount: 'a@example.com' });
  assert.deepEqual(parseClaudeStatus(JSON.stringify({ loggedIn: false, authMethod: 'none', email: 'stale@example.com' })), { loggedIn: false, method: 'none', cachedAccount: null });
  assert.equal(parseClaudeStatus('not json'), null);
  assert.equal(parseClaudeStatus('{}'), null);
});

test('the browser relay writes the URL it is given to its file, this user only, and opens nothing', { skip: !posix }, () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-signin-relay-it's-"));
  const out = join(dir, 'url');
  const relay = browserRelay(dir, out)!;
  assert.equal(statSync(relay).mode & 0o777, 0o700);
  execFileSync(relay, [`${LOCAL_URL}&x='y'`]);
  assert.equal(readFileSync(out, 'utf8'), `${LOCAL_URL}&x='y'\n`);
  assert.equal(statSync(out).mode & 0o077, 0, 'the URL file is this user only');
});

/** A stand-in claude: auth login hands `url` to $BROWSER (the real relay) and waits; auth status says `status`. */
function standIn(url: string) {
  const s = { status: { loggedIn: false, method: 'none', cachedAccount: null } as ClaudeStatus, killed: 0, started: 0, env: null as NodeJS.ProcessEnv | null, exit: [] as ((c: number | null) => void)[] };
  const deps: Partial<SigninDeps> = {
    login: (env) => {
      s.started++;
      s.env = env;
      s.exit = [];
      if (env.BROWSER) execFileSync(env.BROWSER, [url]);
      const child: SigninChild = {
        kill: () => {
          s.killed++;
          for (const f of s.exit) f(143);
        },
        onExit: (f) => s.exit.push(f),
      };
      return child;
    },
    status: async () => s.status,
    pollMs: 20,
  };
  return { s, deps };
}

function probeFor(s: { status: ClaudeStatus }): SetupProbe {
  return {
    which: (c) => `/stand-in/${c}`,
    run: (cmd, args, o = {}) => {
      if (cmd === 'claude') return { status: s.status.loggedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn: s.status.loggedIn, authMethod: s.status.method }), stderr: '' };
      const r = spawnSync(cmd, args, { encoding: 'utf8', ...(o.cwd ? { cwd: o.cwd } : {}) });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    serviceRunning: () => false,
    systemUnitActive: () => false,
    linger: () => null,
  };
}

async function dashboard(over: Partial<DashboardOptions>, s: { status: ClaudeStatus }) {
  const { dir } = exampleProject();
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  const eventsDb = join(stateDir, 'events.db');
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb, stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'claude-signin-slots-')), setupProbe: probeFor(s), ...over });
  const base = d.url.split('/?')[0]!;
  const call = async (path: string, user: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asPerson(user) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  const view = async (user = 'example-owner') => (await call('/api/first-run/claude-signin', user)).body as { mode: string; state: string; url: string | null; detail: string; status: ClaudeStatus | null; canAct: boolean };
  const until = async (pred: (v: Awaited<ReturnType<typeof view>>) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const v = await view();
      if (pred(v)) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`never: ${JSON.stringify(await view())}`);
  };
  const events = () => {
    const log = new EventLog(eventsDb);
    try {
      return log.read(0);
    } finally {
      log.close();
    }
  };
  const audit = () => events().filter((e) => e.type === 'dashboard.audit').map((e) => e.payload as unknown as { login: string; action: string; detail: Record<string, unknown> }).filter((a) => a.action.startsWith('first_run.claude_signin'));
  return { d, call, view, until, audit, events, eventsDb, name: loadConfig(dir).project.project.name };
}

test("local: an owner's confirmed Sign in runs claude auth login, relays the localhost link to the owners only, and ends when claude auth status says signed in; nothing pasted, the link in no event", { skip: !posix }, async () => {
  const { s, deps } = standIn(LOCAL_URL);
  const t = await dashboard({ claudeSignin: deps }, s);
  try {
    const first = (await t.call('/api/first-run?fresh=1', 'example-owner')).body as unknown as { setup: SetupView };
    const step = first.setup.groups.flatMap((g) => g.steps).find((x) => x.id === 'claude-login')!;
    assert.deepEqual([step.done, step.fix], [false, { kind: 'signin', label: 'Sign in' }]);
    assert.equal((await t.view()).state, 'idle');
    // Refused: unconfirmed, a writer, a viewer. Nothing started.
    assert.equal((await t.call('/api/first-run/claude-signin', 'example-owner', {})).status, 400);
    const writer = await t.call('/api/first-run/claude-signin', 'example-collaborator', { confirm: true });
    assert.equal(writer.status, 403);
    assert.match(String(writer.body.error), /only the instance's owners/);
    assert.equal((await t.call('/api/first-run/claude-signin', 'someone-else', { confirm: true })).status, 403);
    assert.equal(s.started, 0);

    const go = await t.call('/api/first-run/claude-signin', 'example-owner', { confirm: true });
    assert.equal(go.status, 200, go.text);
    assert.equal(s.started, 1);
    assert.equal(typeof s.env!.BROWSER, 'string', 'claude hands its URL to the relay, not a browser');
    assert.equal((await t.call('/api/first-run/claude-signin', 'example-owner', { confirm: true })).status, 409, 'one at a time');
    const waiting = await t.until((v) => !!v.url);
    assert.deepEqual([waiting.state, waiting.url], ['waiting', LOCAL_URL]);
    assert.equal((await t.view('example-collaborator')).url, null, "a writer sees the state, never the link");
    const relayDir = dirname(s.env!.BROWSER!);
    assert.equal(existsSync(join(relayDir, 'url')), false, 'the URL file is gone once read');

    s.status = { loggedIn: true, method: 'claude.ai', cachedAccount: 'someone@example.com' };
    const done = await t.until((v) => v.state === 'done');
    assert.equal(done.url, null);
    assert.deepEqual(done.status, s.status);
    assert.match(done.detail, /signed in \(claude\.ai\), per `claude auth status`/);
    assert.equal(s.killed, 1, 'claude auth login is stopped once signed in');
    assert.equal(existsSync(relayDir), false, 'its scratch directory is removed');
    const after = (await t.call('/api/first-run?fresh=1', 'example-owner')).body as unknown as { setup: SetupView };
    assert.equal(after.setup.groups.flatMap((g) => g.steps).find((x) => x.id === 'claude-login')!.done, true);

    assert.deepEqual(t.audit().map((a) => [a.login, a.action, a.detail.state ?? null]), [
      ['example-owner', 'first_run.claude_signin_refused', null],
      ['example-collaborator', 'first_run.claude_signin_refused', null],
      ['example-owner', 'first_run.claude_signin', 'waiting'],
      ['example-owner', 'first_run.claude_signin_refused', null],
      ['example-owner', 'first_run.claude_signin_ended', 'done'],
    ]);
    const all = JSON.stringify(t.events());
    assert.ok(!all.includes('example-state-0123') && !all.includes('oauth/authorize'), 'the link is in no event, the audit included');
  } finally {
    await t.d.close();
  }
});

test('local: the paste-a-code link is never relayed; a sign-in that ends, is cancelled or runs past its limit stops claude auth login', { skip: !posix }, async () => {
  const paste = standIn(PASTE_URL);
  const t = await dashboard({ claudeSignin: paste.deps }, paste.s);
  try {
    assert.equal((await t.call('/api/first-run/claude-signin', 'example-owner', { confirm: true })).status, 200);
    const v = await t.until((x) => /isn't one this page relays/.test(x.detail));
    assert.equal(v.url, null);
    // Cancelled by an owner.
    assert.equal((await t.call('/api/first-run/claude-signin/cancel', 'example-collaborator', {})).status, 403);
    assert.equal((await t.call('/api/first-run/claude-signin/cancel', 'example-owner', {})).status, 200);
    assert.equal((await t.view()).state, 'cancelled');
    assert.equal(paste.s.killed, 1);
    // claude auth login gave up on its own: failed, said so.
    assert.equal((await t.call('/api/first-run/claude-signin', 'example-owner', { confirm: true })).status, 200);
    for (const f of paste.s.exit) f(1);
    const failed = await t.until((x) => x.state === 'failed');
    assert.match(failed.detail, /claude auth login ended \(exit 1\)/);
  } finally {
    await t.d.close();
  }
  const slow = standIn(LOCAL_URL);
  const u = await dashboard({ claudeSignin: { ...slow.deps, timeoutMs: 50 } }, slow.s);
  try {
    assert.equal((await u.call('/api/first-run/claude-signin', 'example-owner', { confirm: true })).status, 200);
    const out = await u.until((x) => x.state === 'timed-out');
    assert.equal(out.url, null);
    assert.equal(slow.s.killed, 1);
  } finally {
    await u.d.close();
  }
});

test("server: the dashboard never runs claude auth login; the agents' token goes into add-project's open paste box, and a cached account is said to be cached", { skip: !posix }, async () => {
  const { s, deps } = standIn(LOCAL_URL);
  const accountDir = mkdtempSync(join(tmpdir(), 'claude-signin-account-'));
  const probe = { status: s.status };
  const name = 'example-shop';
  const t = await dashboard({ claudeSignin: deps, instance: name, claudeAccountDir: accountDir }, probe);
  try {
    const refused = await t.call('/api/first-run/claude-signin', 'example-owner', { confirm: true });
    assert.equal(refused.status, 409);
    assert.match(String(refused.body.error), /setup-token/);
    assert.equal(s.started, 0);
    const none = (await t.call('/api/first-run/claude-signin', 'example-owner')).body as { mode: string; ask: unknown; status: unknown; agentUser: string; command: string };
    assert.deepEqual([none.mode, none.ask, none.status, none.agentUser], ['server', null, null, `wl-${name}-agent`]);
    assert.match(none.command, new RegExp(`claude setup-token[\\s\\S]*scripts/setup/credentials\\.sh ${name} claude`));

    // add-project's claude-token step is waiting: its paste box, for the owners.
    const log = new EventLog(t.eventsDb);
    let id: string;
    try {
      asks(log).create({ kind: 'paste_secret', instance: 'another', title: 'not this one', detail: 'x', credential: 'claude-token', where: 'x' }, 'add-project');
      asks(log).create({ kind: 'paste_secret', instance: name, title: 'the intake token', detail: 'x', credential: 'intake-discord', where: 'x' }, 'add-project');
      id = asks(log).create({ kind: 'paste_secret', instance: name, title: `The Claude login for ${name}'s agents`, detail: 'Paste the token claude setup-token prints.', credential: 'claude-token', where: `wl-${name}-agent's Claude login` }, 'add-project').id;
    } finally {
      log.close();
    }
    const open = (await t.call('/api/first-run/claude-signin', 'example-owner')).body as { ask: { id: string; canAnswer: boolean } };
    assert.deepEqual([open.ask.id, open.ask.canAnswer], [id, true]);
    assert.equal(((await t.call('/api/first-run/claude-signin', 'example-collaborator')).body as { ask: { canAnswer: boolean } }).ask.canAnswer, false);

    writeFileSync(join(accountDir, 'status.json'), JSON.stringify({ at: '2026-10-13T00:00:00Z', users: [{ instance: name, kind: 'agent', user: `wl-${name}-agent`, stored: true, logged_in: true, auth_method: 'claude.ai', account: 'previous@example.com', installed_at: '2026-10-13T01:00:00Z' }] }));
    const st = (await t.call('/api/first-run/claude-signin', 'example-owner')).body as { status: { loggedIn: boolean; cachedAccount: string; installedAt: string } };
    assert.deepEqual([st.status.loggedIn, st.status.cachedAccount, st.status.installedAt], [true, 'previous@example.com', '2026-10-13T01:00:00Z']);
    assert.equal(((await t.call('/api/first-run?fresh=1', 'example-owner')).body as unknown as { setup: SetupView }).setup.groups.flatMap((g) => g.steps).find((x) => x.id === 'claude-token')!.fix.kind, 'signin');
  } finally {
    await t.d.close();
  }
});

test("server, the terminal's way: credentials.sh claude takes the setup token at a hidden prompt (stdin without a terminal), checks it and installs it as the agent's own login; no /login session; bootstrap says so", () => {
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'credentials.sh'), 'utf8');
  const at = sh.indexOf('\n  claude)');
  const block = sh.slice(at, sh.indexOf(';;', at));
  assert.match(block, /if \[ -t 0 \]; then\s+read -rsp "Paste the token from claude setup-token, then Enter \(it is not shown\): " token/);
  assert.match(block, /claude_token_ok "\$token" \|\| \{ token=""; echo "that is not a token from claude setup-token/);
  assert.match(block, /printf '%s' "\$token" \| install_claude_token "\$agent"\n\s+token=""\n\s+claude_login_ok "\$agent"/);
  assert.doesNotMatch(sh, /\/login/, 'no interactive Claude session to sign in through');
  const bs = readFileSync(join(repoRoot, 'scripts', 'bootstrap.sh'), 'utf8');
  assert.match(bs, /claude setup-token[^\n]*\n[^\n]*credentials\.sh \$NAME claude {3}\(paste the token it printed; it is not shown\)/);
});
