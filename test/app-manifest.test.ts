// GitHub Apps through the manifest flow, end to end against a fake GitHub: the hub's start page and callback
// (state single use, expiry, machine owners only), the conversion, the key stored 0400 for its one user and never
// logged, the install link, installation detection, the same check as credentials.sh (app-permissions.mjs, run for
// real), credentials.yaml, a refusal when the installation reaches another repo, and the sign-in App variant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { asks } from '../src/console/asks.js';
import { signInFromFiles, startHub } from '../src/dashboard-hub.js';
import { authorizeUrl, loginFromCode, SESSION_COOKIE, STATE_COOKIE } from '../src/dashboard-auth.js';
import { EventLog } from '../src/events/log.js';
import { currentUser } from '../src/os/index.js';
import { APP_SECRET, FAKE_PEM, fakeGitHub as fake, WEBHOOK_SECRET } from './fake-github.js';
import { loopbackGitHub, repoRoot } from './helpers.js';
import {
  AGENT_APP_PERMISSIONS,
  AGENT_SECRET_FILES,
  agentKeyDir,
  appManifest,
  availableAppName,
  breakGlassHub,
  credentialsFile,
  MANIFEST_CALLBACK_PATH,
  MANIFEST_STATE_MS,
  runAppManifest,
  signInDir,
  startAppManifest,
  verifyWithScript,
  type ApproveLink,
  type RunDeps,
} from '../src/setup/app-manifest.js';

const posix = process.platform !== 'win32';
const CLIENT_ID = 'Iv1.testclient01';
const CLIENT_SECRET = 'client-secret-for-tests';
const PUBLIC = 'https://hub.example.test';
const REPO = 'example/alpha';
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
FAKE_PEM.value = PEM;
/** The fake GitHub (test/fake-github.ts), the App installed on REPO alone once a test says so. */
const fakeGitHub = () => fake({ repo: REPO, permissions: { ...AGENT_APP_PERMISSIONS } });

async function setup(o: { signIn?: boolean } = {}) {
  const gh = await fakeGitHub();
  const clock = { t: Date.now() };
  const owners = new Set(['ada']);
  const web = mkdtempSync(join(tmpdir(), 'amf-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>hub</title>');
  const h = await startHub({
    instances: [],
    stateDir: mkdtempSync(join(tmpdir(), 'amf-hub-')),
    webDir: web,
    now: () => clock.t,
    signIn: o.signIn === false ? null : { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, sessionSecret: 's'.repeat(48), publicUrl: PUBLIC, web: gh.url, api: gh.url },
    appManifest: { isMachineOwner: (l) => owners.has(l.toLowerCase()), api: gh.url, web: gh.url },
  });
  const base = h.url.replace(/\/$/, '');
  const glass = h.breakGlassUrl.split('/?')[0]!;
  const signIn = async (login: string) => {
    const start = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    const st = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith(`${STATE_COOKIE}=`))!.split(';')[0]!;
    gh.signins.set(`c-${login}`, login);
    const back = await fetch(`${base}/auth/callback?code=c-${login}&state=${st}`, { redirect: 'manual', headers: { cookie: stateCookie } });
    return back.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0]!;
  };
  /** A browser on the hub's public URL: PUBLIC is where tailscale serve would forward it from. */
  const open = (link: string, cookie?: string) => fetch(link.replace(PUBLIC, base), { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const home = mkdtempSync(join(tmpdir(), 'amf-home-'));
  const asked: ApproveLink[] = [];
  const lines: string[] = [];
  const waitAsk = async (n: number) => {
    for (let i = 0; i < 400 && asked.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(asked.length >= n, `ask ${n} shown`);
    return asked[n - 1]!;
  };
  const deps = (more: Partial<RunDeps> = {}): RunDeps => ({
    hub: breakGlassHub({ base: glass, token: h.token }),
    api: gh.url,
    web: gh.url,
    users: { coordinator: currentUser(), viewer: currentUser() },
    homeOf: () => home,
    // The real script, as its own process: its GitHub host is a constant, so the child gets the loopback stand-in.
    verify: verifyWithScript({ node: { env: loopbackGitHub(gh.url) } }),
    onAsk: (a) => (asked.push(a), undefined),
    log: (l) => lines.push(l),
    pollMs: 20,
    timeoutMs: 20_000,
    ...more,
  });
  /** The manifest and GitHub target the start page posts, and the state in it. */
  const startPage = async (link: string, cookie: string | undefined) => {
    const r = await open(link, cookie);
    const html = await r.text();
    assert.equal(r.status, 200, html);
    const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const action = unesc(html.match(/action="([^"]+)"/)![1]!);
    const manifest = JSON.parse(unesc(html.match(/name="manifest" value="([^"]+)"/)![1]!)) as ReturnType<typeof appManifest>;
    return { manifest, action, state: new URL(action).searchParams.get('state')!, csp: r.headers.get('content-security-policy') ?? '' };
  };
  const close = async () => {
    await h.close();
    await gh.close();
  };
  return { gh, clock, owners, h, base, glass, signIn, open, home, asked, lines, waitAsk, deps, startPage, close };
}

/** Everything printed to the console while `f` runs. */
async function capture<T>(f: () => Promise<T>): Promise<{ out: string; value: T }> {
  const out: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a: unknown[]) => void out.push(a.map(String).join(' '));
  try {
    return { value: await f(), out: out.join('\n') };
  } finally {
    Object.assign(console, orig);
  }
}

test('the agent App: manifest, machine-owner callback, key 0400 for the coordinator, install link, installation, the real check, credentials.yaml', { skip: !posix }, async () => {
  const s = await setup();
  try {
    const creds = credentialsFile(s.home, 'alpha');
    mkdirSync(dirname(creds), { recursive: true });
    writeFileSync(creds, 'version: 1\nintake: { discord_token: /somewhere/discord-token }\n', { mode: 0o600 });
    const ada = await s.signIn('ada');
    const { out, value: r } = await capture(async () => {
      const run = runAppManifest({ instance: 'alpha', repo: REPO, kind: 'agent' }, s.deps());
      const create = await s.waitAsk(1);
      assert.match(create.url, new RegExp(`^${PUBLIC}/setup/app-manifest/start/amf-[0-9a-f]{24}$`));

      // The manifest: exactly the permissions, no webhook, private, back to the hub's callback.
      const p = await s.startPage(create.url, ada);
      assert.deepEqual(p.manifest.default_permissions, { contents: 'write', issues: 'write', pull_requests: 'write', checks: 'write', actions: 'read', metadata: 'read' });
      for (const never of ['workflows', 'administration']) assert.ok(!(never in p.manifest.default_permissions), `never ${never}`);
      assert.notEqual(p.manifest.default_permissions.actions, 'write');
      assert.deepEqual(p.manifest.hook_attributes.active, false);
      assert.equal(p.manifest.public, false);
      assert.deepEqual(p.manifest.default_events, []);
      assert.equal(p.manifest.name, `alpha-${BRAND.cli}`);
      assert.equal(p.manifest.redirect_url, `${PUBLIC}${MANIFEST_CALLBACK_PATH}`);
      assert.equal(p.action.split('?')[0], `${s.gh.url}/settings/apps/new`, "a user's repo: the user's App settings");
      assert.match(p.csp, new RegExp(`form-action ${s.gh.url}`));
      assert.ok(p.state.length >= 40, 'a long random state');

      // GitHub creates the App and sends the owner's browser back with a one-time code.
      s.gh.codes.set('mcode1', { slug: `alpha-${BRAND.cli}`, id: 91 });
      const back = await s.open(`${PUBLIC}${MANIFEST_CALLBACK_PATH}?code=mcode1&state=${p.state}`, ada);
      assert.equal(back.status, 200, await back.clone().text());
      assert.ok(!(await back.text()).includes(APP_SECRET));

      // A replayed state is refused, and GitHub is not asked again.
      const replay = await s.open(`${PUBLIC}${MANIFEST_CALLBACK_PATH}?code=mcode1&state=${p.state}`, ada);
      assert.equal(replay.status, 410);
      assert.match(await replay.text(), /used once/);
      assert.equal(s.gh.state.conversions, 1);

      // Then the install, on exactly the repo, preselected.
      const inst = await s.waitAsk(2);
      assert.equal(inst.url, `${s.gh.url}/apps/alpha-${BRAND.cli}/installations/new/permissions?suggested_target_id=501&repository_ids[]=777`);
      assert.match(inst.detail, /Only select repositories/);
      s.gh.state.installed = true;
      return run;
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.installationId, 4242);
    assert.equal(r.by, 'ada');

    // The key: for the coordinator user only, 0400 in a 0700 directory, at credentials.sh's path.
    const key = join(agentKeyDir(s.home, 'alpha'), 'private-key.pem');
    assert.equal(r.keyPath, key);
    assert.equal(key, join(s.home, '.config', 'alpha-app', 'private-key.pem'));
    assert.equal(readFileSync(key, 'utf8'), PEM);
    assert.equal(statSync(key).mode & 0o777, 0o400);
    assert.equal(statSync(dirname(key)).mode & 0o777, 0o700);
    assert.equal(statSync(key).uid, process.getuid!());

    // The App's client secret and webhook secret, as GitHub returned them: beside the key, the same way.
    for (const [file, value] of [[AGENT_SECRET_FILES.clientSecret, APP_SECRET], [AGENT_SECRET_FILES.webhookSecret, WEBHOOK_SECRET]] as const) {
      const f = join(dirname(key), file);
      assert.equal(readFileSync(f, 'utf8'), value, file);
      assert.equal(statSync(f).mode & 0o777, 0o400, `${file} 0400`);
      assert.equal(statSync(f).uid, process.getuid!(), `${file} the coordinator's`);
    }
    assert.deepEqual(readdirSync(dirname(key)).filter((f) => f.endsWith('.tmp')), [], 'no temp file left');

    // credentials.yaml: the App, with its other settings kept.
    const y = readFileSync(creds, 'utf8');
    assert.match(y, /github:\s*\n?\s*kind: app/);
    assert.match(y, /app_id: 91/);
    assert.match(y, /installation_id: 4242/);
    assert.ok(y.includes(`key_path: ${key}`));
    assert.match(y, /discord_token: \/somewhere\/discord-token/);
    assert.match(s.lines.join('\n'), /OK: the key works, the installation reaches only the instance repo/, 'the real app-permissions.mjs ran');

    // Never logged, never in an ask: no key material, no secret, and not the one-time conversion code either.
    const everything = [out, ...s.lines, ...s.asked.map((a) => `${a.title} ${a.detail} ${a.url}`), JSON.stringify(r)].join('\n');
    for (const secret of [PEM.split('\n')[1]!, APP_SECRET, WEBHOOK_SECRET, 'mcode1']) assert.ok(!everything.includes(secret), `no ${secret.slice(0, 6)}… in any output`);
  } finally {
    await s.close();
  }
});

test('an installation that reaches another repo is refused, and credentials.yaml is not written', { skip: !posix }, async () => {
  const s = await setup();
  try {
    const creds = credentialsFile(s.home, 'alpha');
    mkdirSync(dirname(creds), { recursive: true });
    writeFileSync(creds, 'version: 1\n', { mode: 0o600 });
    const ada = await s.signIn('ada');
    const run = runAppManifest({ instance: 'alpha', repo: REPO, kind: 'agent' }, s.deps());
    const p = await s.startPage((await s.waitAsk(1)).url, ada);
    s.gh.codes.set('mcode2', { slug: `alpha-${BRAND.cli}`, id: 91 });
    // An App without a webhook secret (GitHub may make none for an inactive webhook): nothing is stored for one.
    s.gh.state.webhookSecret = null;
    assert.equal((await s.open(`${PUBLIC}${MANIFEST_CALLBACK_PATH}?code=mcode2&state=${p.state}`, ada)).status, 200);
    await s.waitAsk(2);
    assert.deepEqual(readdirSync(agentKeyDir(s.home, 'alpha')).sort(), [AGENT_SECRET_FILES.clientSecret, AGENT_SECRET_FILES.key].sort(), 'the key and client secret, no webhook secret');
    s.gh.state.reaches = [REPO, 'example/other'];
    s.gh.state.installed = true;
    const r = await run;
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.step, 'verify');
    assert.match(!r.ok ? r.error : '', /must reach exactly example\/alpha/);
    assert.match(!r.ok ? r.error : '', /nothing was written to credentials\.yaml/);
    assert.equal(readFileSync(creds, 'utf8'), 'version: 1\n');
  } finally {
    await s.close();
  }
});

test('the callback is a machine owner\'s only: signed out it waits, anyone else uses the state up', { skip: !posix }, async () => {
  const s = await setup();
  try {
    const ada = await s.signIn('ada');
    const wes = await s.signIn('wes');
    // Signed out: refused, nothing used up; a non-owner can't even open the start page.
    const run1 = runAppManifest({ instance: 'alpha', repo: REPO, kind: 'agent' }, s.deps());
    const link1 = (await s.waitAsk(1)).url;
    assert.equal((await s.open(link1)).status, 401);
    assert.equal((await s.open(link1, wes)).status, 403);
    const p = await s.startPage(link1, ada);
    s.gh.codes.set('mcode3', { slug: `alpha-${BRAND.cli}`, id: 91 });
    const anon = await s.open(`${PUBLIC}${MANIFEST_CALLBACK_PATH}?code=mcode3&state=${p.state}`);
    assert.equal(anon.status, 401);
    assert.match(await anon.text(), /sign in first/);
    // A signed-in non-owner: refused, and the flow is over.
    const other = await s.open(`${PUBLIC}${MANIFEST_CALLBACK_PATH}?code=mcode3&state=${p.state}`, wes);
    assert.equal(other.status, 403);
    assert.match(await other.text(), /@wes is not a machine owner/);
    const r1 = await run1;
    assert.ok(!r1.ok && r1.step === 'create the App' && /not a machine owner/.test(r1.error), JSON.stringify(r1));
    assert.equal((await s.open(`${PUBLIC}${MANIFEST_CALLBACK_PATH}?code=mcode3&state=${p.state}`, ada)).status, 410, 'the state is used up');
    assert.equal(s.gh.state.conversions, 0, 'GitHub was never asked to convert');
    // An unknown state.
    assert.equal((await s.open(`${PUBLIC}${MANIFEST_CALLBACK_PATH}?code=x&state=made-up`, ada)).status, 400);
  } finally {
    await s.close();
  }
});

test('a state expires after 10 minutes: the callback is refused and the runner stops at that step', { skip: !posix }, async () => {
  const s = await setup();
  try {
    const ada = await s.signIn('ada');
    const run = runAppManifest({ instance: 'alpha', repo: REPO, kind: 'agent' }, s.deps());
    const p = await s.startPage((await s.waitAsk(1)).url, ada);
    s.clock.t += MANIFEST_STATE_MS + 1;
    s.gh.codes.set('mcode4', { slug: `alpha-${BRAND.cli}`, id: 91 });
    const late = await s.open(`${PUBLIC}${MANIFEST_CALLBACK_PATH}?code=mcode4&state=${p.state}`, ada);
    assert.equal(late.status, 410);
    assert.match(await late.text(), /expired/);
    const r = await run;
    assert.ok(!r.ok && r.step === 'create the App' && /expired/.test(r.error), JSON.stringify(r));
    assert.equal(s.gh.state.conversions, 0);
  } finally {
    await s.close();
  }
});

test('the sign-in App: no permissions, the hub\'s callback URL, its client secret 0400 for the viewer user, no key kept', { skip: !posix }, async () => {
  // Before sign-in exists, the hub knows no public URL and no one can sign in: the sign-in App finishes on its state alone.
  const s = await setup({ signIn: false });
  try {
    // An agent App can't be made on a hub without sign-in (no machine owner can be named).
    const agent = runAppManifest({ instance: 'alpha', repo: REPO, kind: 'agent', publicUrl: PUBLIC }, s.deps({ timeoutMs: 300 }));
    assert.equal((await s.open((await s.waitAsk(1)).url)).status, 403);
    assert.equal((await agent).ok, false);

    // The running hub's unit, with its Siri and hooks gateways and a device (this test's uid stands for root).
    const hubUnitFile = join(mkdtempSync(join(tmpdir(), 'amf-unit-')), `${BRAND.cli}-dashboard-hub.service`);
    writeFileSync(hubUnitFile, `[Service]\nExecStart=/usr/local/bin/${BRAND.cli} dashboard --hub alpha=/s --service --client-id Iv1.oldapp00001 --public-url ${PUBLIC} --signin-dir /x --siri-port 4397 --hooks-port 4396 --machine-devices box\n`, { mode: 0o644 });
    // A variable with pollMs: the same call compiles against an engine whose RunDeps has no hubUnit (the fail-without run).
    const more = { pollMs: 20, hubUnit: { hubUnitFile, rootUid: typeof process.getuid === 'function' ? process.getuid() : 0 } };
    const { out, value: r } = await capture(async () => {
      const run = runAppManifest({ instance: 'dash', repo: 'example-org/alpha', kind: 'signin', publicUrl: PUBLIC }, s.deps(more));
      const p = await s.startPage((await s.waitAsk(2)).url, undefined);
      assert.deepEqual(p.manifest.default_permissions, {});
      assert.deepEqual(p.manifest.callback_urls, [`${PUBLIC}/auth/callback`]);
      assert.equal(p.manifest.hook_attributes.active, false);
      assert.equal(p.manifest.name, `dash-${BRAND.cli}-signin`);
      assert.equal(p.action.split('?')[0], `${s.gh.url}/organizations/example-org/settings/apps/new`, "an org's repo: the org's App settings");
      s.gh.codes.set('scode', { slug: `dash-${BRAND.cli}-signin`, id: 92 });
      assert.equal((await s.open(`${PUBLIC}${MANIFEST_CALLBACK_PATH}?code=scode&state=${p.state}`)).status, 200);
      return run;
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.clientId, 'Iv1.madeapp00001');
    const dir = signInDir(s.home);
    assert.equal(r.secretPath, join(dir, 'client-secret'));
    assert.equal(readFileSync(join(dir, 'client-secret'), 'utf8'), APP_SECRET);
    assert.equal(statSync(join(dir, 'client-secret')).mode & 0o777, 0o400);
    assert.match(readFileSync(join(dir, 'session-secret'), 'utf8'), /^[0-9a-f]{64}$/);
    assert.deepEqual(readdirSync(dir).sort(), ['client-secret', 'session-secret'], 'the App key is not kept');
    // The rerun keeps the hub's gateways, devices and instances, with the new App's client id (#767).
    assert.ok(s.lines.includes(`then, as root: sudo bash /opt/${BRAND.cli}/current/scripts/setup/dashboards.sh --machine-devices 'box' --client-id 'Iv1.madeapp00001' --public-url '${PUBLIC}' --siri --hooks -- 'alpha'`), s.lines.join('\n'));
    for (const secret of [APP_SECRET, PEM.split('\n')[1]!]) assert.ok(![out, ...s.lines].join('\n').includes(secret));
  } finally {
    await s.close();
  }
});

test('from the setup console, each GitHub click is an approve_link ask, answered by the machine owner when GitHub confirms it', { skip: !posix }, async () => {
  const s = await setup({ signIn: false });
  try {
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'amf-log-')), 'events.db'));
    const a = asks(log);
    const { askId, done } = await startAppManifest({ instance: 'dash', repo: REPO, kind: 'signin', publicUrl: PUBLIC }, { ...s.deps(), asks: a });
    const ask = a.get(askId)!;
    assert.equal(ask.kind, 'approve_link');
    assert.equal(ask.status, 'open');
    assert.match(ask.kind === 'approve_link' ? ask.url : '', /\/setup\/app-manifest\/start\/amf-/);
    const p = await s.startPage(ask.kind === 'approve_link' ? ask.url : '', undefined);
    s.gh.codes.set('scode2', { slug: 'x', id: 93 });
    await s.open(`${PUBLIC}${MANIFEST_CALLBACK_PATH}?code=scode2&state=${p.state}`);
    assert.ok((await done).ok);
    assert.equal(a.get(askId)!.status, 'answered');
    assert.equal(a.get(askId)!.answer?.answer, 'approved');
    const events = JSON.stringify(log.read(0));
    assert.ok(!events.includes(APP_SECRET) && !events.includes(PEM.split('\n')[1]!), 'no key material in the event log');
    log.close();
  } finally {
    await s.close();
  }
});

test('the secrets go to wl-<name> (agent) and wl-dash (sign-in) unless told otherwise', async () => {
  const seen: string[] = [];
  const hub = { register: async () => assert.fail('not reached'), wait: async () => assert.fail('not reached') };
  for (const kind of ['agent', 'signin'] as const) {
    const r = await runAppManifest({ instance: 'alpha', repo: REPO, kind }, { hub, homeOf: (u) => (seen.push(u), null) });
    assert.equal(r.ok, false);
  }
  assert.deepEqual(seen, ['wl-alpha', 'wl-dash']);
  const bad = await runAppManifest({ instance: 'Alpha', repo: REPO, kind: 'agent' }, { hub });
  assert.ok(!bad.ok && bad.step === 'arguments');
  assert.ok(!(await runAppManifest({ instance: 'alpha', repo: 'not-a-repo', kind: 'agent' }, { hub })).ok);
});

test('a taken App name gets a short suffix', async () => {
  const taken = new Set(['alpha-x', 'alpha-x-0001']);
  let n = 0;
  const f = (async (u: string | URL) => new Response('{}', { status: taken.has(decodeURIComponent(String(u).split('/apps/')[1]!)) ? 200 : 404 })) as typeof fetch;
  assert.equal(await availableAppName('alpha-y', { api: 'http://gh', fetch: f }), 'alpha-y');
  assert.equal(await availableAppName('alpha-x', { api: 'http://gh', fetch: f, suffix: () => String(++n).padStart(4, '0') }), 'alpha-x-0002');
  assert.ok(appManifest({ kind: 'signin', name: 'n', repo: REPO, publicUrl: PUBLIC }).name.length <= 34);
});

// INVARIANT (owner's rule): GitHub's hosts for the hub's sign-in are constants. Sign-in sends the sign-in App's client
// secret and each person's sign-in code to them, so nothing may point them elsewhere: no environment variable, no
// request, no cookie, no signed-in person. (SignInConfig's `web`, `api` and `fetch` are for in-process tests only;
// signInFromFiles, the one way the hub's command makes its config, sets none of them.)
const SIGNIN_HOSTS = ['https://github.com', 'https://api.github.com'];
const HOST_VARIABLES = [`${BRAND.envPrefix}_GITHUB_API`, `${BRAND.envPrefix}_GITHUB_WEB`, 'GITHUB_API_URL', 'GITHUB_SERVER_URL', 'GH_HOST', 'GITHUB_HOST'];
const ELSEWHERE = 'https://elsewhere.example.test';
/** Run `f` with every variable that names a GitHub host anywhere in the engine or in gh pointing elsewhere. */
async function withHostsElsewhere<T>(f: () => Promise<T>): Promise<T> {
  const saved = HOST_VARIABLES.map((n) => process.env[n]);
  for (const n of HOST_VARIABLES) process.env[n] = ELSEWHERE;
  try {
    return await f();
  } finally {
    HOST_VARIABLES.forEach((n, i) => {
      if (saved[i] === undefined) delete process.env[n];
      else process.env[n] = saved[i];
    });
  }
}
const signInFiles = () => {
  const dir = mkdtempSync(join(tmpdir(), 'amf-signin-'));
  writeFileSync(join(dir, 'client-secret'), `${CLIENT_SECRET}\n`);
  writeFileSync(join(dir, 'session-secret'), `${'s'.repeat(48)}\n`);
  return dir;
};

test("sign-in's GitHub hosts are constants: no environment variable moves the redirect, the code exchange or the token's revocation", async () => {
  await withHostsElsewhere(async () => {
    const cfg = signInFromFiles({ clientId: CLIENT_ID, publicUrl: PUBLIC, dir: signInFiles() });
    assert.deepEqual(Object.keys(cfg).sort(), ['clientId', 'clientSecret', 'publicUrl', 'sessionSecret'], 'the config from files names no host and no fetch');
    assert.equal(new URL(authorizeUrl(cfg, 'state')).origin, 'https://github.com');
    // The exchange, with only fetch stood in (an in-process GitHub): every request goes to GitHub's own two hosts.
    const asked: { url: string; secret: boolean }[] = [];
    const github = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push({ url, secret: `${String(init?.body ?? '')} ${JSON.stringify(init?.headers ?? {})}`.includes(CLIENT_SECRET) || /Basic /.test(JSON.stringify(init?.headers ?? {})) });
      if (url.endsWith('/login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'ghu_ada' }), { status: 200 });
      if (url.endsWith('/user')) return new Response(JSON.stringify({ login: 'ada' }), { status: 200 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    assert.equal(await loginFromCode({ ...cfg, fetch: github }, 'the-code'), 'ada');
    assert.deepEqual(
      asked.map((a) => a.url),
      ['https://github.com/login/oauth/access_token', 'https://api.github.com/user', `https://api.github.com/applications/${CLIENT_ID}/token`],
    );
    for (const a of asked) assert.ok(SIGNIN_HOSTS.includes(new URL(a.url).origin), a.url);
    assert.ok(asked.some((a) => a.secret), 'the client secret did travel, and only there');
  });
});

test("the hub's sign-in goes to github.com whatever the environment, a request, a cookie or a signed-in person says", { skip: !posix }, async () => {
  const web = mkdtempSync(join(tmpdir(), 'amf-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>hub</title>');
  await withHostsElsewhere(async () => {
    // Started the way the hub's command starts it, with the environment pointing elsewhere before and after.
    const h = await startHub({ instances: [], stateDir: mkdtempSync(join(tmpdir(), 'amf-hub-')), webDir: web, signIn: signInFromFiles({ clientId: CLIENT_ID, publicUrl: PUBLIC, dir: signInFiles() }) });
    const base = h.url.replace(/\/$/, '');
    const E = ELSEWHERE;
    const [apiVar, webVar] = HOST_VARIABLES as [string, string, ...string[]];
    /** Everything a request can carry that names another host. */
    const tries: { q: string; headers: Record<string, string> }[] = [
      { q: '', headers: {} },
      { q: `?web=${E}&api=${E}&github_web=${E}&github_api=${E}&host=${E}`, headers: {} },
      { q: `?${apiVar}=${E}&${webVar}=${E}&redirect_uri=${E}/auth/callback&client_id=Iv1.someoneelse1`, headers: {} },
      { q: '', headers: { 'x-forwarded-host': 'elsewhere.example.test', 'x-forwarded-proto': 'https', origin: E, referer: `${E}/` } },
      { q: '', headers: { [apiVar.toLowerCase()]: E, [webVar.toLowerCase()]: E, 'x-github-api': E, 'x-github-web': E } },
      { q: '', headers: { cookie: `${apiVar}=${E}; ${webVar}=${E}; web=${E}; api=${E}` } },
    ];
    try {
      for (const t of tries) {
        const r = await fetch(`${base}/auth/login${t.q}`, { redirect: 'manual', headers: t.headers });
        assert.equal(r.status, 302);
        const to = new URL(r.headers.get('location')!);
        assert.equal(to.origin, 'https://github.com', JSON.stringify(t));
        assert.equal(to.pathname, '/login/oauth/authorize');
        assert.equal(to.searchParams.get('redirect_uri'), `${PUBLIC}/auth/callback`);
        assert.equal(to.searchParams.get('client_id'), CLIENT_ID);
      }
    } finally {
      await h.close();
    }
  });
  // A signed-in person is no different: on a hub whose GitHub is an in-process fake (a test's injection), a machine
  // owner's session moves nothing either.
  const s = await setup();
  try {
    const ada = await s.signIn('ada');
    for (const q of ['', `?web=${ELSEWHERE}&api=${ELSEWHERE}`]) {
      const r = await fetch(`${s.base}/auth/login${q}`, { redirect: 'manual', headers: { cookie: ada, 'x-github-web': ELSEWHERE } });
      assert.equal(new URL(r.headers.get('location')!).origin, new URL(s.gh.url).origin, 'where the hub was started with, not where the request says');
    }
  } finally {
    await s.close();
  }
});

// WHY: a static check on top of the behaviour: the sign-in path reads no environment at all, so a later change that
// adds a host override there has to delete this line to do it.
test('the sign-in code reads no environment variable', () => {
  for (const f of ['src/dashboard-auth.ts', 'src/dashboard-hub.ts']) assert.doesNotMatch(readFileSync(join(repoRoot, f), 'utf8'), /process\.env/, f);
});
