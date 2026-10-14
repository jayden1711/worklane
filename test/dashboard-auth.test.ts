// Per-person sign-in on the dashboard hub, end to end against a fake GitHub
// (the OAuth code exchange, /user, the token revoke, and the repo permission
// API): roles from repo permission, the 5-minute role cache, per-instance
// visibility, CSRF, sessions, cookies, the audit, the break-glass and the
// loopback-only listeners. No real network.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { startHub, type HubInstance } from '../src/dashboard-hub.js';
import {
  assertLoopbackHost,
  breakGlassAllowed,
  cachedRoles,
  mayAnswerKind,
  repoPermission,
  roleFromPermission,
  DEVICE_VIEWS,
  ROLE_CACHE_MS,
  SESSION_COOKIE,
  TERMINAL_PROTOCOL,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  Sessions,
  STATE_COOKIE,
} from '../src/dashboard-auth.js';
import { WebSocket } from 'ws';
import { EventLog } from '../src/events/log.js';
import { asks } from '../src/console/asks.js';
import { CONSOLE_SHELL, type AuditEntry, type SpawnPty } from '../src/console/terminal.js';

/**
 * Open the owner terminal through the hub as a browser does: a real WebSocket upgrade from the hub's public origin
 * (the Host is the public one, as Tailscale serve forwards it), offering `protocols`. What came back: refused and
 * why, the HTTP status of a refused upgrade, or the subprotocol the hub answered with.
 */
function openTerminalWs(base: string, protocols: string[], headers: Record<string, string>, origin = PUBLIC) {
  return new Promise<{ refused?: string; error?: string; protocol?: string }>((done) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/terminal?instance=a`, protocols, { origin, headers: { host: new URL(PUBLIC).host, ...headers } });
    ws.on('message', (m) => {
      const msg = JSON.parse(String(m)) as { type: string; why?: string };
      if (msg.type === 'refused') done({ refused: msg.why! });
    });
    ws.on('unexpected-response', (_req, res) => done({ error: String(res.statusCode) }));
    ws.on('error', (e) => done({ error: e.message }));
    ws.on('open', () =>
      setTimeout(() => {
        const protocol = ws.protocol;
        ws.close();
        done({ protocol });
      }, 150),
    );
  });
}
import { MACHINE_EVENTS, machineRequests } from '../src/machine-requests.js';
import { BRAND } from '../src/brand.js';
import { fullRunLock, tryAgentSlot } from '../src/slots.js';
import { tryTestSlot } from '../src/testrun/slots.js';
import { exampleProject, machineOwnersFile, repoRoot, marksOf, seedInstanceItems, type InstanceMarks } from './helpers.js';

const CLIENT_ID = 'Iv1.testclient01';
const CLIENT_SECRET = 'client-secret-for-tests';
const INSTANCE_TOKEN = 'ghs_instance_token';
const PUBLIC = 'https://hub.example.test';

/** A fake GitHub: codes become user tokens, user tokens name a login, and each repo's collaborators have a permission. */
async function fakeGitHub() {
  const codes = new Map<string, string>();
  const perms = new Map<string, string>(); // `${repo}:${login}` -> permission
  const seen = { permission: 0, revoked: [] as string[], userTokenOnPermission: 0 };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status: number, j: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(j));
      };
      const url = new URL(req.url ?? '/', 'http://x');
      const auth = req.headers.authorization ?? '';
      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        const b = JSON.parse(body) as { client_id: string; client_secret: string; code: string; redirect_uri: string };
        if (b.client_id !== CLIENT_ID || b.client_secret !== CLIENT_SECRET) return send(200, { error: 'incorrect_client_credentials' });
        if (b.redirect_uri !== `${PUBLIC}/auth/callback`) return send(200, { error: 'redirect_uri_mismatch' });
        const login = codes.get(b.code);
        codes.delete(b.code);
        return login ? send(200, { access_token: `ghu_${login}`, token_type: 'bearer' }) : send(200, { error: 'bad_verification_code' });
      }
      if (req.method === 'GET' && url.pathname === '/user') {
        const m = auth.match(/^Bearer ghu_(.+)$/);
        return m ? send(200, { login: m[1] }) : send(401, { message: 'Bad credentials' });
      }
      const rv = url.pathname.match(/^\/applications\/([^/]+)\/token$/);
      if (req.method === 'DELETE' && rv) {
        seen.revoked.push((JSON.parse(body) as { access_token: string }).access_token);
        res.writeHead(204);
        return res.end();
      }
      const p = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/);
      if (req.method === 'GET' && p) {
        seen.permission++;
        if (auth.startsWith('Bearer ghu_')) seen.userTokenOnPermission++;
        if (auth !== `Bearer ${INSTANCE_TOKEN}`) return send(401, { message: 'Bad credentials' });
        const perm = perms.get(`${p[1]}:${decodeURIComponent(p[2]!).toLowerCase()}`);
        return perm ? send(200, { permission: perm, role_name: perm, user: { login: p[2] } }) : send(404, { message: 'Not Found' });
      }
      send(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  return { url, codes, perms, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const seenIssue = (issue: number, title: string) => ({ issue, title, labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' });
const ask = (id: string, kind: 'question' | 'plan' | 'land') => ({ id, kind, issue: 1, owner: 'example-owner', question: `${kind}?`, options: ['approve', 'reject'], recommendation: 'approve', receipts: [] });

/** Each instance's items when the set-up seeds them (src/dashboard.ts ownHolders tells holders apart by project and actor). */
const MARKS: Record<'a' | 'b', InstanceMarks> = {
  a: { project: 'alpha-proj', actor: 'wl-alpha@host', issue: 8101, pr: 8170, run: 'tr-alpha-1', title: 'Alpha-only' },
  b: { project: 'beta-proj', actor: 'wl-beta@host', issue: 9201, pr: 9270, run: 'tr-beta-1', title: 'Beta-only' },
};

/**
 * The whole set-up: a fake GitHub, two instances (each its own server, repo and log), the hub with sign-in, a mockable clock.
 * `machine`: as on a real machine, both instances share one slots dir, and each is seeded with items on every page
 * (MARKS), its coordinator holding an agent slot and a test slot there (b also the full-run lock).
 */
async function setup(o: { machine?: boolean; machineOwners?: string[]; devices?: { allow: string[]; whois: (ip: string) => string }; terminal?: { consoleUser: string; hubUser: string; spawnPty: SpawnPty; exec: () => string; audit: { record: (e: AuditEntry) => void } }; claudeAccountDir?: string; secretsHome?: string } = {}) {
  const gh = await fakeGitHub();
  const ownersFile = o.machineOwners ? machineOwnersFile(...o.machineOwners) : undefined;
  const clock = { t: Date.parse('2026-10-12T12:00:00Z') };
  const now = () => clock.t;
  const shared = o.machine ? mkdtempSync(join(tmpdir(), 'auth-slots-')) : null;
  const instance = async (name: 'a' | 'b') => {
    const dir = mkdtempSync(join(tmpdir(), `auth-${name}-`));
    const { dir: root } = exampleProject();
    const db = join(dir, 'events.db');
    const log = new EventLog(db);
    const cfg = loadConfig(root);
    const m = MARKS[name];
    if (o.machine) {
      cfg.project.project.name = m.project;
      seedInstanceItems(log, m);
      tryAgentSlot(`${BRAND.cli} ${m.project} #${m.issue}`, shared!);
      tryTestSlot(`${m.actor} test run ${m.run}`, shared!);
      if (name === 'b') await fullRunLock(`${BRAND.cli} ${m.project} land gate full`, 1000, shared!);
    }
    log.append('issue.seen', seenIssue(1, `In ${name}`), 'c');
    log.append('decision.asked', ask(`${name}-q`, 'question'), 'c');
    log.append('decision.asked', ask(`${name}-p`, 'plan'), 'c');
    log.append('decision.asked', ask(`${name}-l`, 'land'), 'c');
    const roleOf = cachedRoles(repoPermission({ repo: `example/${name}`, token: async () => INSTANCE_TOKEN, api: gh.url }), now);
    const d = await startDashboard({ root, cfg, eventsDb: db, stateDir: dir, user: 'example-owner', roleOf, instance: name, slotsDir: shared ?? join(dir, 'slots'), actor: m.actor, pollMs: 50, ...(ownersFile ? { machineOwnersFile: ownersFile } : {}), ...(o.claudeAccountDir ? { claudeAccountDir: o.claudeAccountDir } : {}), ...(o.secretsHome ? { secretsHome: o.secretsHome } : {}) });
    return { d, log, dir, port: Number(new URL(d.url).port) };
  };
  const a = await instance('a');
  const b = await instance('b');
  const web = mkdtempSync(join(tmpdir(), 'auth-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>hub</title>');
  const instances: HubInstance[] = [
    { name: 'a', port: a.port, tokenFile: join(a.dir, 'dashboard-token') },
    { name: 'b', port: b.port, tokenFile: join(b.dir, 'dashboard-token') },
  ];
  const hubState = mkdtempSync(join(tmpdir(), 'auth-hub-'));
  const h = await startHub({ instances, stateDir: hubState, webDir: web, now, signIn: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, sessionSecret: 's'.repeat(48), publicUrl: PUBLIC, web: gh.url, api: gh.url }, ...(o.devices ? { terminal: { devices: o.devices.allow, whois: o.devices.whois, peerUid: () => 0, ...(o.terminal ?? {}) } } : {}) });
  const base = h.url.replace(/\/$/, '');
  const glass = h.breakGlassUrl.split('/?')[0]!;

  /** Sign in as `login` through the whole round trip; the person's session, with helpers that carry its cookie. */
  const signIn = async (login: string) => {
    const start = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const to = new URL(start.headers.get('location')!);
    assert.equal(`${to.origin}${to.pathname}`, `${gh.url}/login/oauth/authorize`);
    assert.equal(to.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(to.searchParams.get('redirect_uri'), `${PUBLIC}/auth/callback`);
    const state = to.searchParams.get('state')!;
    const stateSet = start.headers.getSetCookie().find((c) => c.startsWith(`${STATE_COOKIE}=`))!;
    gh.codes.set(`code-${login}`, login);
    const back = await fetch(`${base}/auth/callback?code=code-${login}&state=${state}`, { redirect: 'manual', headers: { cookie: stateSet.split(';')[0]! } });
    assert.equal(back.status, 302, `signed in as ${login}`);
    const set = back.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    const cookie = set.split(';')[0]!;
    const me = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as { login: string; csrf: string };
    const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { cookie, ...headers } });
    const post = (path: string, body: unknown, o: { csrf?: string | null; headers?: Record<string, string> } = {}) =>
      fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { cookie, 'content-type': 'application/json', ...(o.csrf === null ? {} : { 'x-csrf-token': o.csrf ?? me.csrf }), ...(o.headers ?? {}) } });
    return { cookie, setCookie: set, csrf: me.csrf, me, get, post };
  };
  const close = async () => {
    await h.close();
    await a.d.close();
    await b.d.close();
    await gh.close();
  };
  return { gh, clock, a, b, h, base, glass, hubState, signIn, close };
}

const status = async (r: Promise<Response>) => (await r).status;

test('each role\'s allowed and refused actions follow the person\'s permission on the instance\'s repo (owner, writer, viewer, none)', async () => {
  const s = await setup();
  try {
    s.gh.perms.set('example/a:ada', 'admin');
    s.gh.perms.set('example/a:wes', 'write');
    s.gh.perms.set('example/a:mai', 'maintain');
    s.gh.perms.set('example/a:vic', 'read');
    s.gh.perms.set('example/a:tri', 'triage');
    const owner = await s.signIn('ada');
    const writer = await s.signIn('wes');
    const maintainer = await s.signIn('mai');
    const viewer = await s.signIn('vic');
    const triager = await s.signIn('tri');
    const nobody = await s.signIn('nob');
    const roleOf = async (p: Awaited<ReturnType<typeof s.signIn>>) => ((await (await p.get('/api/i/a/state')).json()) as { role: string; user: string; via: string }).role;
    assert.equal(await roleOf(owner), 'owner', 'admin: owner');
    assert.equal(await roleOf(writer), 'writer', 'write: writer');
    assert.equal(await roleOf(maintainer), 'writer', 'maintain: writer');
    assert.equal(await roleOf(viewer), 'viewer', 'read: viewer');
    assert.equal(await roleOf(triager), 'viewer', 'triage: viewer');
    assert.equal(await status(nobody.get('/api/i/a/state')), 403, 'none: refused');
    const st = (await (await owner.get('/api/i/a/state')).json()) as { user: string; via: string; canWrite: boolean; canReadAudit: boolean };
    assert.deepEqual([st.user, st.via, st.canWrite, st.canReadAudit], ['ada', 'session', true, true]);

    // Reads gated to owners and writers.
    for (const path of ['/api/i/a/runs?issue=1', '/api/i/a/throughput', '/api/i/a/waiting', '/api/i/a/intake', '/api/i/a/report']) {
      assert.notEqual(await status(owner.get(path)), 403, `owner reads ${path}`);
      assert.notEqual(await status(writer.get(path)), 403, `writer reads ${path}`);
      assert.equal(await status(viewer.get(path)), 403, `viewer is refused ${path}`);
      assert.equal(await status(nobody.get(path)), 403, `no role: refused ${path}`);
    }
    // The audit log: owners only.
    assert.equal(await status(owner.get('/api/i/a/audit')), 200);
    assert.equal(await status(writer.get('/api/i/a/audit')), 403);
    assert.equal(await status(viewer.get('/api/i/a/audit')), 403);

    // Writes. A viewer is read-only, whatever the route.
    assert.equal(await status(viewer.post('/api/i/a/decide', { id: 'a-q', answer: 'approve' })), 403, 'a viewer answers nothing');
    assert.equal(await status(viewer.post('/api/i/a/chat', { question: 'hi' })), 403, 'a viewer has no chat');
    assert.equal(await status(nobody.post('/api/i/a/decide', { id: 'a-q', answer: 'approve' })), 403);
    // Owner-only decisions: held plans and high-risk merges.
    assert.equal(await status(writer.post('/api/i/a/decide', { id: 'a-p', answer: 'approve' })), 403, 'a writer may not answer a held plan');
    assert.equal(await status(writer.post('/api/i/a/decide', { id: 'a-l', answer: 'approve' })), 403, 'a writer may not approve a high-risk merge');
    assert.equal(await status(writer.post('/api/i/a/decide', { id: 'a-q', answer: 'approve' })), 200, 'a writer answers an ordinary decision');
    assert.equal(await status(owner.post('/api/i/a/decide', { id: 'a-p', answer: 'approve' })), 200, 'the owner answers a held plan');
    assert.equal(await status(owner.post('/api/i/a/decide', { id: 'a-l', answer: 'approve' })), 200, 'the owner approves a high-risk merge');
    const answered = s.a.log.read(0, ['decision.answered']).map((e) => e.payload as { id: string; by: string; role?: string });
    assert.deepEqual(answered.map((x) => [x.id, x.by, x.role]), [['a-q', 'wes', 'writer'], ['a-p', 'ada', 'owner'], ['a-l', 'ada', 'owner']]);
    // Owner-only settings and console.
    assert.equal(await status(writer.post('/api/i/a/machine', { what: 'nothing' })), 403, 'machine settings: owners only');
    assert.equal(await status(owner.post('/api/i/a/machine', { what: 'nothing' })), 400, 'the owner gets past the role check');
    assert.equal(await status(writer.post('/api/i/a/runs/r1/stop', {})), 403, 'the console: owners only');
    assert.equal(await status(owner.post('/api/i/a/runs/r1/stop', {})), 404, "the owner gets past the role check (the run isn't live)");
    // The pure rule the server applies.
    assert.equal(mayAnswerKind('question', 'writer'), true);
    assert.equal(mayAnswerKind('intake', 'writer'), true);
    assert.equal(mayAnswerKind('plan', 'writer'), false);
    assert.equal(mayAnswerKind('land', 'viewer'), false);
    assert.equal(mayAnswerKind('question', null), false);
  } finally {
    await s.close();
  }
});

test('the role comes from the repo, never from the client: a login or role header the browser sends is ignored', async () => {
  const s = await setup();
  try {
    s.gh.perms.set('example/a:ada', 'admin');
    s.gh.perms.set('example/a:vic', 'read');
    const viewer = await s.signIn('vic');
    const st = (await (await viewer.get('/api/i/a/state', { 'x-dashboard-login': 'ada', 'x-dashboard-role': 'owner' })).json()) as { user: string; role: string };
    assert.deepEqual([st.user, st.role], ['vic', 'viewer']);
    assert.equal(await status(viewer.post('/api/i/a/decide', { id: 'a-q', answer: 'approve' }, { headers: { 'x-dashboard-login': 'ada' } })), 403);
    assert.equal(s.gh.seen.userTokenOnPermission, 0, "the person's own token is never used for the permission");
    assert.deepEqual(s.gh.seen.revoked, ['ghu_vic'], "the person's token is revoked once their login is known");
  } finally {
    await s.close();
  }
});

test('someone removed from the repo keeps access only until the 5-minute cache runs out (mocked clock)', async () => {
  const s = await setup();
  try {
    s.gh.perms.set('example/a:wes', 'write');
    const p = await s.signIn('wes');
    assert.equal(await status(p.get('/api/i/a/state')), 200);
    const asked = s.gh.seen.permission;
    s.gh.perms.delete('example/a:wes');
    s.clock.t += ROLE_CACHE_MS - 1000;
    assert.equal(await status(p.get('/api/i/a/state')), 200, 'still cached at 4:59');
    assert.equal(s.gh.seen.permission, asked, 'from the cache: GitHub not asked again');
    s.clock.t += 2000;
    assert.equal(await status(p.get('/api/i/a/state')), 403, 'refused once the cache expires');
    assert.equal(((await (await p.get('/api/hub')).json()) as { instances: unknown[] }).instances.length, 0, 'and the hub no longer lists it');
    // A failed lookup refuses (fail closed).
    const failing = cachedRoles(async () => {
      throw new Error('GitHub 502');
    });
    assert.equal(await failing('wes'), null);
    assert.equal(roleFromPermission('admin'), 'owner');
    assert.equal(roleFromPermission('maintain'), 'writer');
    assert.equal(roleFromPermission('write'), 'writer');
    assert.equal(roleFromPermission('triage'), 'viewer');
    assert.equal(roleFromPermission('read'), 'viewer');
    assert.equal(roleFromPermission('none'), null);
    assert.equal(roleFromPermission(undefined), null);
  } finally {
    await s.close();
  }
});

test('a person sees only the instances they have a role on; any other instance is refused, even with a valid session', async () => {
  const s = await setup();
  try {
    s.gh.perms.set('example/a:vic', 'read');
    const p = await s.signIn('vic');
    const hub = (await (await p.get('/api/hub')).json()) as { instances: { name: string; role: string }[] };
    assert.deepEqual(hub.instances.map((i) => [i.name, i.role]), [['a', 'viewer']], 'only a is listed');
    assert.equal(await status(p.get('/api/i/a/state')), 200);
    assert.equal(await status(p.get('/api/i/b/state')), 403, 'b: no role there');
    assert.equal(await status(p.get('/api/i/b/events')), 403, 'b: any direct API call');
    assert.equal(await status(p.post('/api/i/b/decide', { id: 'b-q', answer: 'approve' })), 403);
    assert.equal(await status(p.get('/api/i/nope/state')), 403, 'an instance not in this hub: refused as well');
    assert.equal(s.b.log.read(0, ['decision.answered']).length, 0);
  } finally {
    await s.close();
  }
});

test("a signed-in person's list keeps an instance that stopped answering (as down) while the hub's copy of their role there is fresh; never one they have no role on", async () => {
  const s = await setup();
  let aOpen = true;
  try {
    s.gh.perms.set('example/a:vic', 'read');
    s.gh.perms.set('example/b:wes', 'write');
    const vic = await s.signIn('vic');
    const wes = await s.signIn('wes');
    const list = async (p: { get: (path: string) => Promise<Response> }) => ((await (await p.get('/api/hub')).json()) as { instances: { name: string; up: boolean; role: string | null }[] }).instances.map((i) => [i.name, i.up, i.role]);
    assert.deepEqual(await list(vic), [['a', true, 'viewer']]);
    assert.deepEqual(await list(wes), [['b', true, 'writer']]);
    // a stops answering (an update's restart): vic still sees it, marked down, rather than losing it from the sidebar.
    await s.a.d.close();
    aOpen = false;
    assert.deepEqual(await list(vic), [['a', false, 'viewer']], 'a: listed as down, from the role the hub learned while it answered');
    assert.equal(await status(vic.get('/api/i/a/state')), 502, "and nothing of it is read: it isn't answering");
    // Someone with no role on a never gets it, down or not; nor does someone the hub never learned a role for.
    assert.deepEqual(await list(wes), [['b', true, 'writer']], 'wes: no role on a, so a is not listed');
    s.gh.perms.set('example/a:ivy', 'admin');
    const ivy = await s.signIn('ivy');
    assert.deepEqual(await list(ivy), [], 'ivy: a is down, and the hub has no fresh copy of her role there');
    // Past the role cache, the hub's copy is stale: the down instance is no longer listed (as before).
    s.clock.t += ROLE_CACHE_MS + 1000;
    assert.deepEqual(await list(vic), []);
  } finally {
    await s.h.close();
    if (aOpen) await s.a.d.close();
    await s.b.d.close();
    await s.gh.close();
  }
});

/** An SSE response read in the background: all that came in so far, whether it ended, and a wait for some text. */
function streamOf(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const st = { got: '', ended: false };
  void (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        st.got += dec.decode(r.value);
      }
    } catch {
      // cancelled
    }
    st.ended = true;
  })();
  /** Wait until `until` matches what came in after `from` (or the stream ends, or `ms` pass); what came in after `from`. */
  const wait = async (until: RegExp, ms: number, from = 0) => {
    const deadline = Date.now() + ms;
    while (!until.test(st.got.slice(from)) && !st.ended && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    return st.got.slice(from);
  };
  return { st, wait, cancel: () => reader.cancel().catch(() => undefined) };
}

test("someone with a role on one instance and none on the other never receives the other's items: from any endpoint, the hub's views, the slots both share, or the stream", async () => {
  const s = await setup({ machine: true });
  const leak = marksOf(MARKS.b);
  const mine = marksOf(MARKS.a);
  try {
    for (const [login, perm] of [['wes', 'write'], ['vic', 'read'], ['ola', 'admin']] as const) {
      s.gh.perms.set(`example/a:${login}`, perm);
      const p = await s.signIn(login);
      const hub = (await (await p.get('/api/hub')).json()) as { instances: { name: string }[] };
      assert.deepEqual(hub.instances.map((i) => i.name), ['a'], `${login}: the hub lists a only`);
      const paths = ['/api/hub', '/api/me'];
      for (const inst of ['a', 'b']) {
        for (const path of ['state', 'board', 'test-runs', 'events', 'prs', 'waiting', 'live', 'runs', `runs?issue=${MARKS.b.issue}`, `checks?issue=${MARKS.b.issue}`, 'health', 'machine', 'report', 'throughput', 'intake', 'settings', 'instance-settings', 'audit', 'logs', 'views', 'asks', `runs/${MARKS.b.run}`]) paths.push(`/api/i/${inst}/${path}`);
      }
      let sawMine = false;
      for (const path of paths) {
        const r = await p.get(path);
        const body = await r.text();
        assert.doesNotMatch(body, leak, `${login} (${perm} on a, none on b): ${path} (${r.status}) carries b's items`);
        if (path.startsWith('/api/i/b/')) assert.equal(r.status, 403, `${login}: ${path} is refused`);
        if (mine.test(body)) sawMine = true;
      }
      assert.ok(sawMine, `${login}: a's own items are there (the check isn't vacuous)`);
      // a's own slot holders keep their names for its owners and writers; b's are counted, never named.
      const state = (await (await p.get('/api/i/a/state')).json()) as { slots: { running: number; agents?: { owner: string }[]; fullRun?: { owner: string } | null } };
      assert.equal(state.slots.running, 2, `${login}: both instances' agents count against the machine's slots`);
      if (perm !== 'read') {
        assert.deepEqual(state.slots.agents!.map((a) => a.owner).sort(), [`${BRAND.cli} ${MARKS.a.project} #${MARKS.a.issue}`, 'another instance or job on this machine'].sort());
        assert.equal(state.slots.fullRun!.owner, 'another instance or job on this machine');
        const runs = (await (await p.get('/api/i/a/test-runs')).json()) as { inUse: number; slots: { owner: string }[] };
        assert.equal(runs.inUse, 2);
        assert.deepEqual(runs.slots.map((x) => x.owner).sort(), [`${MARKS.a.actor} test run ${MARKS.a.run}`, 'another instance or job on this machine'].sort());
      }
    }

    // The live stream: a's changes reach the person; b's stream is refused, and b's events never reach them.
    const p = await s.signIn('wes');
    assert.equal((await p.get('/api/i/b/stream')).status, 403, "b's stream: refused");
    const res = await p.get('/api/i/a/stream');
    assert.equal(res.status, 200);
    const stream = streamOf(res);
    await stream.wait(/event: hello/, 2000);
    s.b.log.append('issue.seen', { issue: MARKS.b.issue + 50, title: `${MARKS.b.title} late`, labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' }, MARKS.b.actor);
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch(stream.st.got, /event: change/, "b's event: nothing on a's stream");
    s.a.log.append('issue.seen', { issue: MARKS.a.issue + 50, title: `${MARKS.a.title} late`, labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' }, MARKS.a.actor);
    const got = await stream.wait(/event: change/, 5000);
    assert.match(got, /event: change/, "a's change arrives");
    assert.doesNotMatch(got, leak, "nothing of b's on a's stream");
    const after = (await (await p.get('/api/i/a/state')).json()) as { tasks: { title: string }[] };
    assert.ok(!after.tasks.some((t) => leak.test(t.title)), "b's event, pushed after sign-in, isn't in a's state either");

    // Removed from a's repo while the stream is open: once the role cache says so, the stream ends; nothing more of a reaches them.
    s.gh.perms.delete('example/a:wes');
    s.clock.t += ROLE_CACHE_MS + 1000;
    const from = stream.st.got.length;
    s.a.log.append('issue.seen', { issue: MARKS.a.issue + 60, title: `${MARKS.a.title} after removal`, labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' }, MARKS.a.actor);
    const rest = await stream.wait(/event: change/, 3000, from);
    assert.doesNotMatch(rest, /event: change/, 'no change after their role is gone');
    assert.ok(stream.st.ended, 'the stream ends');
    await stream.cancel();
  } finally {
    await s.close();
  }
});

test('CSRF: a write without a valid token, with another session\'s token, or from another site is refused', async () => {
  const s = await setup();
  try {
    s.gh.perms.set('example/a:wes', 'write');
    s.gh.perms.set('example/a:ada', 'admin');
    const w = await s.signIn('wes');
    const o = await s.signIn('ada');
    assert.notEqual(w.csrf, o.csrf);
    assert.equal(await status(w.post('/api/i/a/decide', { id: 'a-q', answer: 'approve' }, { csrf: null })), 403, 'no token');
    assert.equal(await status(w.post('/api/i/a/decide', { id: 'a-q', answer: 'approve' }, { csrf: 'x'.repeat(43) })), 403, 'a made-up token');
    assert.equal(await status(w.post('/api/i/a/decide', { id: 'a-q', answer: 'approve' }, { csrf: o.csrf })), 403, "another session's token");
    assert.equal(await status(w.post('/api/i/a/decide', { id: 'a-q', answer: 'approve' }, { headers: { origin: 'https://evil.example' } })), 403, 'from another site');
    assert.equal(await status(w.post('/auth/logout', {}, { csrf: null })), 403, 'sign-out needs it too');
    assert.equal(s.a.log.read(0, ['decision.answered']).length, 0, 'nothing written');
    assert.equal(await status(w.post('/api/i/a/decide', { id: 'a-q', answer: 'approve' }, { headers: { origin: PUBLIC } })), 200, 'its own token, from the hub: accepted');
    const put = await fetch(`${s.base}/api/i/a/views`, { method: 'PUT', body: '[]', headers: { cookie: w.cookie, 'content-type': 'application/json' } });
    assert.equal(put.status, 403, 'PUT without a token');
  } finally {
    await s.close();
  }
});

test('the break-glass token: refused on the proxied port, through a proxy, or from another address; accepted on the real loopback path', async () => {
  const s = await setup();
  try {
    // The hub's port is the one tailscale serve forwards: every request on it arrives from 127.0.0.1. The token is never accepted there.
    assert.equal(await status(fetch(`${s.base}/api/hub`, { headers: { authorization: `Bearer ${s.h.token}` } })), 401);
    assert.equal(await status(fetch(`${s.base}/api/i/a/state?t=${s.h.token}`)), 401);
    assert.equal(await status(fetch(`${s.base}/api/i/a/state`, { headers: { authorization: `Bearer ${s.h.token}`, 'tailscale-user-login': 'someone@example.com', 'x-forwarded-for': '203.0.113.7' } })), 401, 'as tailscale serve would forward it');
    // The break-glass port: refused with a proxy's headers, whatever the token.
    for (const h of [{ 'x-forwarded-for': '203.0.113.7' }, { 'tailscale-user-login': 'someone@example.com' }, { 'x-forwarded-proto': 'https' }, { forwarded: 'for=203.0.113.7' }]) {
      assert.equal(await status(fetch(`${s.glass}/api/i/a/state`, { headers: { authorization: `Bearer ${s.h.token}`, ...h } })), 403, `refused with ${Object.keys(h)[0]}`);
    }
    assert.equal(await status(fetch(`${s.glass}/api/i/a/state`, { headers: { authorization: 'Bearer wrong' } })), 401, 'a wrong token');
    // From another address (the listeners are loopback-only, so this is the rule they apply).
    assert.equal(breakGlassAllowed({ headers: {}, socket: { remoteAddress: '203.0.113.7' } }), false);
    assert.equal(breakGlassAllowed({ headers: {}, socket: { remoteAddress: '198.51.100.20' } }), false);
    assert.equal(breakGlassAllowed({ headers: {}, socket: { remoteAddress: undefined } }), false);
    assert.equal(breakGlassAllowed({ headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '127.0.0.1' } }), false);
    assert.equal(breakGlassAllowed({ headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
    assert.equal(breakGlassAllowed({ headers: {}, socket: { remoteAddress: '::1' } }), true);
    // The real loopback path: the owner.
    const st = (await (await fetch(`${s.glass}/api/i/a/state`, { headers: { authorization: `Bearer ${s.h.token}` } })).json()) as { role: string; via: string; user: string };
    assert.deepEqual([st.role, st.via, st.user], ['owner', 'break-glass', 'example-owner']);
    const hub = (await (await fetch(`${s.glass}/api/hub`, { headers: { authorization: `Bearer ${s.h.token}` } })).json()) as { instances: { name: string; role: string }[] };
    assert.deepEqual(hub.instances.map((i) => [i.name, i.role]), [['a', 'owner'], ['b', 'owner']]);
    // An instance's own server applies the same rule to its token used without a person named.
    const inst = `http://127.0.0.1:${s.a.port}`;
    assert.equal(await status(fetch(`${inst}/api/state`, { headers: { authorization: `Bearer ${s.a.d.token}`, 'x-forwarded-for': '203.0.113.7' } })), 403);
    assert.equal(await status(fetch(`${inst}/api/state`, { headers: { authorization: `Bearer ${s.a.d.token}` } })), 200);
  } finally {
    await s.close();
  }
});

test('sessions expire at 12 h idle and 7 days total, and sign-out ends one server-side', async () => {
  const clock = { t: 1_000_000 };
  const dir = mkdtempSync(join(tmpdir(), 'auth-sessions-'));
  const store = new Sessions({ secret: 'k'.repeat(40), file: join(dir, 'sessions.json'), now: () => clock.t });
  const idle = store.create('ada');
  clock.t += SESSION_IDLE_MS - 1000;
  assert.equal(store.get(idle.id)?.login, 'ada', 'just under 12 h idle');
  clock.t += SESSION_IDLE_MS - 1000;
  assert.equal(store.get(idle.id)?.login, 'ada', 'the idle clock restarted at the last request');
  clock.t += SESSION_IDLE_MS;
  assert.equal(store.get(idle.id), null, '12 h idle: gone');
  const busy = store.create('ada');
  const start = clock.t;
  while (clock.t + 6 * 3_600_000 < start + SESSION_MAX_MS) {
    clock.t += 6 * 3_600_000;
    assert.ok(store.get(busy.id), 'used every 6 h, it lasts');
  }
  clock.t = start + SESSION_MAX_MS;
  assert.equal(store.get(busy.id), null, '7 days after sign-in: gone, however busy');
  const kept = store.create('ada');
  const file = readFileSync(join(dir, 'sessions.json'), 'utf8');
  assert.ok(!file.includes(kept.id), 'the store holds no session id');
  assert.ok(!file.includes(kept.csrf), 'nor a CSRF token');
  assert.ok(new Sessions({ secret: 'k'.repeat(40), file: join(dir, 'sessions.json'), now: () => clock.t }).get(kept.id), 'a restarted hub keeps live sessions');
  assert.equal(new Sessions({ secret: 'j'.repeat(40), file: join(dir, 'sessions.json'), now: () => clock.t }).get(kept.id), null, 'under another secret, none');
  assert.throws(() => new Sessions({ secret: 'short' }), /at least 32/);

  // Through the hub: the mocked clock, and a sign-out the browser can't undo by keeping the cookie.
  const s = await setup();
  try {
    s.gh.perms.set('example/a:wes', 'write');
    const p = await s.signIn('wes');
    assert.equal(await status(p.get('/api/me')), 200);
    s.clock.t += SESSION_IDLE_MS + 1000;
    assert.equal(await status(p.get('/api/hub')), 401, 'idle 12 h: signed out');
    assert.equal(((await (await p.get('/api/me')).json()) as { login: string | null }).login, null, 'nobody signed in');
    const q = await s.signIn('wes');
    const out = await q.post('/auth/logout', {});
    assert.equal(out.status, 200);
    assert.match(out.headers.getSetCookie().join('\n'), new RegExp(`^${SESSION_COOKIE}=; .*Max-Age=0`, 'm'), 'the cookie is cleared');
    assert.equal(await status(q.get('/api/hub')), 401, 'the old cookie, replayed: refused');
    assert.equal(((await (await q.get('/api/me')).json()) as { login: string | null }).login, null);
    assert.equal(await status(q.get('/api/i/a/state')), 401);
  } finally {
    await s.close();
  }
});

test('the session cookie is HttpOnly, Secure and SameSite=Strict; the sign-in round trip is single-use and bound to the browser', async () => {
  const s = await setup();
  try {
    s.gh.perms.set('example/a:wes', 'write');
    const p = await s.signIn('wes');
    const attrs = p.setCookie.split(';').map((x) => x.trim());
    assert.ok(attrs[0]!.startsWith('__Host-'), 'a __Host- cookie: this origin only, no Domain');
    for (const a of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(attrs.includes(a), `has ${a}`);
    assert.ok(!attrs.some((a) => /^domain=/i.test(a)), 'no Domain');
    assert.match(p.setCookie, /Max-Age=604800/, 'at most 7 days');
    assert.ok(p.cookie.split('=')[1]!.length >= 43, 'at least 256 bits, base64url');
    // A callback whose state didn't start here, or comes back without the browser's cookie, or twice, is refused.
    const start = await fetch(`${s.base}/auth/login`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    assert.match(start.headers.getSetCookie().join(''), /HttpOnly; Secure; SameSite=Lax/, 'the state cookie must come back on GitHub\'s redirect: Lax');
    s.gh.codes.set('c1', 'wes');
    assert.equal(await status(fetch(`${s.base}/auth/callback?code=c1&state=${state}`, { redirect: 'manual' })), 400, 'no state cookie');
    assert.equal(await status(fetch(`${s.base}/auth/callback?code=c1&state=${state}`, { redirect: 'manual', headers: { cookie: `${STATE_COOKIE}=${state}` } })), 400, 'used up');
    assert.equal(await status(fetch(`${s.base}/auth/callback?code=c1&state=made-up`, { redirect: 'manual', headers: { cookie: `${STATE_COOKIE}=made-up` } })), 400, 'never issued');
  } finally {
    await s.close();
  }
});

test('every write is audited with login, role, instance and action; owners read the audit', async () => {
  const s = await setup();
  try {
    s.gh.perms.set('example/a:wes', 'write');
    s.gh.perms.set('example/a:ada', 'admin');
    const w = await s.signIn('wes');
    const o = await s.signIn('ada');
    assert.equal(await status(w.post('/api/i/a/decide', { id: 'a-q', answer: 'approve' })), 200);
    assert.equal(await status(w.post('/api/i/a/chat', { question: 'What is blocked?', key: 'audit-key-1' })), 200);
    const put = await fetch(`${s.base}/api/i/a/views`, { method: 'PUT', body: '[]', headers: { cookie: o.cookie, 'content-type': 'application/json', 'x-csrf-token': o.csrf } });
    assert.equal(put.status, 200);
    assert.equal(await status(fetch(`${s.glass}/api/i/a/decide`, { method: 'POST', body: JSON.stringify({ id: 'a-p', answer: 'approve' }), headers: { authorization: `Bearer ${s.h.token}`, 'content-type': 'application/json' } })), 200);
    const rows = s.a.log.read(0, ['dashboard.audit']).map((e) => e.payload as { login: string; role: string; via: string; instance: string; action: string; detail: Record<string, unknown> });
    assert.deepEqual(
      rows.map((r) => [r.login, r.role, r.via, r.instance, r.action]),
      [
        ['wes', 'writer', 'session', 'a', 'decision.answered'],
        ['wes', 'writer', 'session', 'a', 'chat.asked'],
        ['ada', 'owner', 'session', 'a', 'views.saved'],
        ['example-owner', 'owner', 'break-glass', 'a', 'decision.answered'],
      ],
    );
    assert.deepEqual(rows[0]!.detail, { id: 'a-q', kind: 'question', answer: 'approve' });
    assert.equal(s.b.log.read(0, ['dashboard.audit']).length, 0, "b's log is untouched");
    const audit = (await (await o.get('/api/i/a/audit')).json()) as { entries: { login: string; action: string }[] };
    assert.deepEqual(audit.entries.map((e) => e.action), ['decision.answered', 'views.saved', 'chat.asked', 'decision.answered'], 'newest first');
    // A refused write records nothing.
    assert.equal(await status(w.post('/api/i/a/decide', { id: 'a-p', answer: 'approve' })), 403);
    assert.equal(s.a.log.read(0, ['dashboard.audit']).length, 4);
  } finally {
    await s.close();
  }
});

test('the session the setup console reads (SessionOf): login, the role from the repo, and the CSRF check', async () => {
  const s = await setup();
  try {
    s.gh.perms.set('example/a:ada', 'admin');
    const p = await s.signIn('ada');
    const req = (headers: Record<string, string>, method = 'POST') => ({ headers, method }) as unknown as import('node:http').IncomingMessage;
    assert.equal(s.h.session(req({}), 'a'), null, 'no cookie: no session');
    // Before the hub has asked the instance, no role: refused (fail closed).
    assert.equal(s.h.session(req({ cookie: p.cookie, 'x-csrf-token': p.csrf }), 'a')!.role, null);
    await p.get('/api/hub');
    s.clock.t += 60_000;
    assert.deepEqual(s.h.session(req({ cookie: p.cookie, 'x-csrf-token': p.csrf }), 'a'), { login: 'ada', role: 'owner', csrfOk: true });
    assert.equal(s.h.session(req({ cookie: p.cookie }), 'a')!.csrfOk, false, 'no CSRF token');
    assert.equal(s.h.session(req({ cookie: p.cookie, 'x-csrf-token': 'x'.repeat(43) }), 'a')!.csrfOk, false, 'a wrong one');
    assert.equal(s.h.session(req({ cookie: p.cookie, 'x-csrf-token': p.csrf, origin: 'https://evil.example' }), 'a')!.csrfOk, false, 'from another site');
    assert.equal(s.h.session(req({ cookie: p.cookie, 'x-csrf-token': p.csrf }), 'b')!.role, null, 'no role on b');
    assert.equal(s.h.session(req({ cookie: p.cookie, 'x-csrf-token': p.csrf }), 'nope')!.role, null, 'not an instance of this hub');
    // The hub's copy of the role lasts no longer than the role cache: removed from the repo, refused within 5 minutes.
    s.gh.perms.delete('example/a:ada');
    s.clock.t += ROLE_CACHE_MS;
    assert.equal(s.h.session(req({ cookie: p.cookie, 'x-csrf-token': p.csrf }), 'a')!.role, null);
    // The instance's own server sees the same person and role through the hub (dashboardSession).
    s.gh.perms.set('example/a:ada', 'admin');
    s.clock.t += ROLE_CACHE_MS;
    assert.equal(await status(p.get('/api/i/a/state')), 200);
    const r = (await (await p.get('/api/i/a/role')).json()) as Record<string, unknown>;
    assert.deepEqual(r, { login: 'ada', role: 'owner', via: 'session' }, 'no sign-in time: nothing reads it');
    const glass = (await (await fetch(`${s.glass}/api/i/a/role`, { headers: { authorization: `Bearer ${s.h.token}` } })).json()) as { role: string; via: string };
    assert.deepEqual([glass.role, glass.via], ['owner', 'break-glass']);
  } finally {
    await s.close();
  }
});

test('the servers refuse to listen anywhere but loopback', async () => {
  for (const host of ['0.0.0.0', '::', '203.0.113.103', '198.51.100.5']) {
    assert.throws(() => assertLoopbackHost(host), /loopback only/);
    await assert.rejects(startHub({ instances: [], stateDir: mkdtempSync(join(tmpdir(), 'auth-bind-')), host }), /loopback only/, `the hub refuses ${host}`);
    const { dir: root } = exampleProject();
    const dir = mkdtempSync(join(tmpdir(), 'auth-bind-'));
    await assert.rejects(startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', host }), /loopback only/, `an instance's dashboard refuses ${host}`);
  }
  const h = await startHub({ instances: [], stateDir: mkdtempSync(join(tmpdir(), 'auth-bind-')) });
  try {
    for (const srv of [h.server, h.breakGlass]) {
      const a = srv.address();
      assert.equal(typeof a === 'object' && a ? a.address : '', '127.0.0.1');
    }
    // Without sign-in set up, the hub's port refuses every API call; the break-glass is the only way in.
    assert.equal(await status(fetch(`${h.url}api/hub`)), 401);
    assert.equal((await fetch(`${h.url}auth/login`, { redirect: 'manual' })).status, 503);
  } finally {
    await h.close();
  }
});

test('a request through the hub carries the person to the instance only in a header the hub sets itself', async () => {
  // A raw request with a cookie-less, CSRF-less body never reaches the instance (checked above); this checks the
  // instance's own refusal of an unknown login header value.
  const s = await setup();
  try {
    const raw = (headers: Record<string, string>) =>
      new Promise<number>((done, fail) => {
        const r = request({ host: '127.0.0.1', port: s.a.port, path: '/api/state', headers: { authorization: `Bearer ${s.a.d.token}`, ...headers } }, (res) => {
          res.resume();
          done(res.statusCode ?? 0);
        });
        r.on('error', fail);
        r.end();
      });
    assert.equal(await raw({ 'x-dashboard-login': 'not a login!' }), 400);
    assert.equal(await raw({ 'x-dashboard-login': 'stranger' }), 403, 'no permission on the repo: refused');
  } finally {
    await s.close();
  }
});

test('a machine change through the hub: only a machine owner, signed in, from an allowed console device; the hub alone says which device', async () => {
  // Fake tailnet fixtures, built here so no address or node name is spelled out (the push gate's rules).
  const net = ['tail1234', 'ts', 'net'].join('.');
  const ip = (n: number) => [100, 101, 102, 100 + n].join('.');
  const nodes: Record<string, unknown> = { [ip(3)]: { Node: { Name: `laptop.${net}.`, Tags: [] } }, [ip(5)]: { Node: { Name: `someone-else.${net}.`, Tags: ['tag:guest'] } } };
  const whois = (a: string) => {
    if (!nodes[a]) throw new Error('no such peer');
    return JSON.stringify(nodes[a]);
  };
  // Two machine owners; ivy owns instance a (admin on its repo) and nothing more.
  const s = await setup({ machineOwners: ['ada', 'olu'], devices: { allow: ['laptop'], whois } });
  try {
    s.clock.t = Date.now();
    for (const l of ['ada', 'olu', 'ivy']) s.gh.perms.set(`example/a:${l}`, 'admin');
    const [ada, olu, ivy] = [await s.signIn('ada'), await s.signIn('olu'), await s.signIn('ivy')];
    const laptop = { 'x-forwarded-for': ip(3) };
    const stranger = { 'x-forwarded-for': ip(5) };
    const change = async (p: typeof ada, what: string, value: unknown, headers: Record<string, string>) => {
      const r = await p.post('/api/i/a/machine', { what, value }, { headers });
      return { status: r.status, body: (await r.json()) as { error?: string } };
    };
    for (const [what, value] of [['slots', 4], ['updates', true]] as const) {
      const ok = await change(ada, what, value, laptop);
      assert.equal(ok.status, 200, `${what}: a machine owner on an allowed device: ${JSON.stringify(ok.body)}`);
      assert.equal((await change(olu, what, value, laptop)).status, 200, `${what}: the second machine owner too`);
      const instanceOnly = await change(ivy, what, value, laptop);
      assert.equal(instanceOnly.status, 403, `${what}: an instance-only owner`);
      assert.match(instanceOnly.body.error!, /machine owners: @ada, @olu\); @ivy isn't one/);
      const elsewhere = await change(ada, what, value, stranger);
      assert.equal(elsewhere.status, 403, `${what}: a device not on the console's list`);
      assert.match(elsewhere.body.error!, /allowed devices/);
      // A browser's own copy of the hub's device header never reaches the instance.
      assert.equal((await change(ada, what, value, { ...stranger, 'x-dashboard-console-device': '1' })).status, 403, `${what}: a forged device header`);
    }
    // ivy reads the settings read-only, with who may change them.
    const seen = (await (await ivy.get('/api/i/a/machine')).json()) as { canChange: boolean; machineOwner: boolean; machineOwners: string[] };
    assert.deepEqual([seen.canChange, seen.machineOwner, seen.machineOwners], [false, false, ['ada', 'olu']]);
    assert.equal(((await (await ada.get('/api/i/a/machine')).json()) as { canChange: boolean }).canChange, true);
    // Add project says before the form is filled whether a submit would pass: the hub tells it the device on a read too.
    const adding = async (p: typeof ada, headers: Record<string, string>) => (await (await p.get('/api/i/a/add-project', headers)).json()) as { allowed: boolean; why: string | null };
    assert.equal((await adding(ada, laptop)).allowed, true, 'a machine owner on an allowed device');
    assert.match((await adding(ada, stranger)).why ?? '', /allowed devices/, 'a device off the list');
    assert.match((await adding(ivy, laptop)).why ?? '', /@ivy isn't one/, 'an instance-only owner');

    // The break-glass needs none of it.
    const glass = await fetch(`${s.glass}/api/i/a/machine`, { method: 'POST', headers: { authorization: `Bearer ${s.h.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ what: 'slots', value: 5 }) });
    assert.equal(glass.status, 200, await glass.clone().text());
    const requests = machineRequests(s.a.log.read(0, [...MACHINE_EVENTS]));
    assert.deepEqual(requests.map((r) => [r.by, r.args.join(' '), r.breakGlass]), [['ada', 'set-slots 4', false], ['olu', 'set-slots 4', false], ['ada', 'set-updates on', false], ['olu', 'set-updates on', false], ['example-owner', 'set-slots 5', true]], 'only the allowed ones were recorded');
  } finally {
    await s.close();
  }
});

test('no fresh sign-in: a session signed in days ago (still within 12 h idle / 7 days) does every formerly fresh-gated action; role, device, CSRF, expiry and the audit still hold', { skip: process.platform === 'win32' }, async () => {
  // Fake tailnet fixtures, built here so no address or node name is spelled out (the push gate's rules).
  const net = ['tail1234', 'ts', 'net'].join('.');
  const ip = (n: number) => [100, 101, 102, 100 + n].join('.');
  const nodes: Record<string, unknown> = { [ip(3)]: { Node: { Name: `laptop.${net}.`, Tags: [] } }, [ip(5)]: { Node: { Name: `someone-else.${net}.`, Tags: [] } } };
  const whois = (a: string) => {
    if (!nodes[a]) throw new Error('no such peer');
    return JSON.stringify(nodes[a]);
  };
  // A Claude account switch waiting for its token from instance a's dashboard (claude-account.sh's progress file).
  const accountDir = mkdtempSync(join(tmpdir(), 'auth-account-'));
  const at = new Date().toISOString();
  writeFileSync(join(accountDir, 'switch.jsonl'), [{ step: 'switch', state: 'started', detail: '1 instance(s): a; the token from the dashboard of a' }, { step: 'pause', state: 'done', instance: 'a', detail: 'starts no more runs' }, { step: 'token', state: 'ask', detail: "paste the token in a's dashboard" }].map((l) => JSON.stringify({ at, ...l })).join('\n') + '\n');
  const termAudit: AuditEntry[] = [];
  const spawned: string[][] = [];
  const spawnPty: SpawnPty = (o) => {
    spawned.push(o.argv);
    return { write: () => {}, onData: () => {}, onExit: () => {}, kill: () => {} };
  };
  const s = await setup({
    machineOwners: ['ada'],
    devices: { allow: ['laptop'], whois },
    terminal: { consoleUser: 'adminx', hubUser: 'wl-dash', spawnPty, exec: () => 'password-required\n', audit: { record: (e) => void termAudit.push(e) } },
    claudeAccountDir: accountDir,
    secretsHome: mkdtempSync(join(tmpdir(), 'auth-secrets-')),
  });
  try {
    for (const l of ['ada', 'ivy']) s.gh.perms.set(`example/a:${l}`, 'admin');
    s.gh.perms.set('example/a:wes', 'write');
    const signedIn = s.clock.t;
    const [ada, ivy, wes] = [await s.signIn('ada'), await s.signIn('ivy'), await s.signIn('wes')];
    const idle = await s.signIn('ada');
    // Days of use, never more than 12 h apart: the sessions stay valid, the sign-in is long past.
    while (s.clock.t + 6 * 3_600_000 < signedIn + SESSION_MAX_MS - 3_600_000) {
      s.clock.t += 6 * 3_600_000;
      for (const p of [ada, ivy, wes]) assert.equal(await status(p.get('/api/hub')), 200);
    }
    assert.ok(s.clock.t - signedIn > 6 * 24 * 3_600_000, 'signed in more than 6 days ago');
    assert.equal(await status(idle.get('/api/hub')), 401, 'a session idle over 12 h has expired: refused');

    const laptop = { 'x-forwarded-for': ip(3) };
    const stranger = { 'x-forwarded-for': ip(5) };
    const post = async (p: typeof ada, path: string, body: unknown, headers = laptop, csrf?: null) => {
      const r = await p.post(`/api/i/a/${path}`, body, { headers, ...(csrf === null ? { csrf: null } : {}) });
      return { status: r.status, body: (await r.json()) as { error?: string } };
    };
    const step = asks(s.a.log).create({ instance: 'a', kind: 'root_step', title: 'Four slots', detail: 'x', command: 'set-slots', args: ['4'] });
    const actions: [string, string, unknown][] = [
      ['machine settings', 'machine', { what: 'slots', value: 4 }],
      ['add project', 'machine/add-project', { name: 'gamma', repo: 'example/gamma' }],
      ['Claude account status', 'machine/claude-account', { action: 'status' }],
      ['Claude account token paste', 'claude-account/token', { value: `sk-ant-oat01-${'Q'.repeat(40)}` }],
      ['root step run', `asks/${step.id}/run`, {}],
    ];
    for (const [what, path, body] of actions) {
      // Refused first, so nothing is recorded yet: no CSRF token, a device off the list, someone who isn't a machine owner, a writer.
      const noCsrf = await post(ada, path, body, laptop, null);
      assert.equal(noCsrf.status, 403, `${what}: no CSRF token`);
      assert.match(noCsrf.body.error ?? '', /CSRF/i, `${what}: no CSRF token`);
      const elsewhere = await post(ada, path, body, stranger);
      assert.equal(elsewhere.status, 403, `${what}: a device off the list: ${JSON.stringify(elsewhere.body)}`);
      assert.match(elsewhere.body.error ?? '', /allowed devices/, `${what}: a device off the list`);
      const instanceOnly = await post(ivy, path, body);
      assert.equal(instanceOnly.status, 403, `${what}: an instance owner who isn't a machine owner`);
      assert.equal((await post(wes, path, body)).status, 403, `${what}: a writer`);
      // The machine owner, signed in days ago, on an allowed device: allowed.
      const ok = await post(ada, path, body);
      assert.equal(ok.status, 200, `${what}: a stale but valid session: ${JSON.stringify(ok.body)}`);
    }
    // Every one of them is on record: the audit, and the root step's machine request names who asked.
    const audited = s.a.log.read(0, ['dashboard.audit']).map((e) => e.payload as { login: string; via: string; action: string });
    for (const action of ['machine.changed', 'machine.add_project', 'machine.claude_account', 'claude_account.token']) {
      assert.ok(audited.some((a) => a.login === 'ada' && a.via === 'session' && a.action === action), `${action} audited: ${audited.map((a) => a.action).join(', ')}`);
    }
    assert.ok(audited.some((a) => a.login === 'ivy' && a.action === 'machine.add_project_refused'), 'a refused add-project is audited too');
    const requests = machineRequests(s.a.log.read(0, [...MACHINE_EVENTS]));
    assert.deepEqual(requests.map((r) => [r.by, r.args.join(' '), r.via]), [['ada', 'set-slots 4', 'settings'], ['ada', 'add-project gamma example/gamma', 'add-project'], ['ada', 'claude-account status', 'claude-account'], ['ada', 'set-slots 4', 'ask']]);

    // The owner terminal: the same session opens it from the laptop, and nothing else does.
    const term = (p: typeof ada | null, o: { headers?: Record<string, string>; csrf?: boolean } = {}) => openTerminalWs(s.base, p && o.csrf !== false ? [TERMINAL_PROTOCOL, `csrf.${p.csrf}`] : [TERMINAL_PROTOCOL], { ...laptop, ...(o.headers ?? {}), ...(p ? { cookie: p.cookie } : {}) });
    // The hub's copy of each role is fresh (/api/hub, within the 5-minute role cache).
    for (const p of [ada, ivy, wes]) await p.get('/api/hub');
    assert.deepEqual(await term(ada), { protocol: TERMINAL_PROTOCOL }, 'a stale but valid session: the terminal opens');
    assert.deepEqual(spawned, [['sudo', '-n', '-u', 'adminx', CONSOLE_SHELL, 'shell']]);
    assert.match((await term(wes)).refused ?? '', /owner's alone/, 'a writer');
    assert.match((await term(ada, { headers: stranger })).refused ?? '', /device|tailnet|allowed|console_devices/i, 'a device off the list');
    assert.match((await term(ada, { csrf: false })).refused ?? '', /CSRF/, 'no CSRF token');
    assert.equal(spawned.length, 1, 'only the one terminal started');
    assert.ok(termAudit.some((e) => e.kind === 'opened' && e.login === 'ada'), 'the terminal is audited');
    assert.ok(termAudit.filter((e) => e.kind === 'refused').length >= 3, 'its refusals too');

    // Seven days after the sign-in the session ends, however active: everything is refused.
    s.clock.t = signedIn + SESSION_MAX_MS;
    assert.equal(await status(ada.get('/api/hub')), 401, 'past 7 days: expired');
    const expired = await ada.post('/api/i/a/machine', { what: 'slots', value: 5 }, { headers: laptop });
    assert.equal(expired.status, 401, 'an expired session changes nothing');
    assert.match((await term(ada)).refused ?? '', /not signed in/, 'nor opens the terminal');
    assert.equal(machineRequests(s.a.log.read(0, [...MACHINE_EVENTS])).length, 4, 'nothing more recorded');
  } finally {
    await s.close();
  }
});

/** Fake tailnet fixtures, built here so no address or node name is spelled out (the push gate's rules). */
function tailnet() {
  const net = ['tail1234', 'ts', 'net'].join('.');
  const ip = (n: number) => [100, 101, 102, 100 + n].join('.');
  const nodes: Record<string, unknown> = { [ip(3)]: { Node: { Name: `laptop.${net}.`, Tags: [] } }, [ip(5)]: { Node: { Name: `someone-else.${net}.`, Tags: [] } } };
  const whois = (a: string) => {
    if (!nodes[a]) throw new Error('no such peer');
    return JSON.stringify(nodes[a]);
  };
  return { whois, laptop: { 'x-forwarded-for': ip(3) }, stranger: { 'x-forwarded-for': ip(5) } };
}

test("the terminal's upgrade through the hub takes the session's CSRF token as a subprotocol (a browser can't set the header), answers with the terminal's protocol alone, and refuses and audits anything else", { skip: process.platform === 'win32' }, async () => {
  const { whois, laptop } = tailnet();
  const termAudit: AuditEntry[] = [];
  const spawned: string[][] = [];
  const spawnPty: SpawnPty = (o) => {
    spawned.push(o.argv);
    return { write: () => {}, onData: () => {}, onExit: () => {}, kill: () => {} };
  };
  const s = await setup({ machineOwners: ['ada'], devices: { allow: ['laptop'], whois }, terminal: { consoleUser: 'adminx', hubUser: 'wl-dash', spawnPty, exec: () => 'password-required\n', audit: { record: (e) => void termAudit.push(e) } } });
  try {
    s.gh.perms.set('example/a:ada', 'admin');
    s.gh.perms.set('example/a:olu', 'admin');
    const ada = await s.signIn('ada');
    const olu = await s.signIn('olu');
    for (const p of [ada, olu]) await p.get('/api/hub');
    const open = (protocols: string[], o: { origin?: string; cookie?: string } = {}) => openTerminalWs(s.base, protocols, { ...laptop, cookie: o.cookie ?? ada.cookie }, o.origin);
    const refusals = () => termAudit.filter((e) => e.kind === 'refused').length;

    const cases: [string, Promise<{ refused?: string; error?: string; protocol?: string }>, RegExp][] = [
      ['no token', open([TERMINAL_PROTOCOL]), /CSRF/],
      ['a wrong token', open([TERMINAL_PROTOCOL, `csrf.${'x'.repeat(ada.csrf.length)}`]), /CSRF/],
      ["another session's token", open([TERMINAL_PROTOCOL, `csrf.${olu.csrf}`]), /CSRF/],
      ['the token in the header only (what a browser cannot send)', openTerminalWs(s.base, [TERMINAL_PROTOCOL], { ...laptop, cookie: ada.cookie, 'x-csrf-token': ada.csrf }), /CSRF/],
    ];
    for (const [what, r, re] of cases) {
      const before = refusals();
      const got = await r;
      assert.match(got.refused ?? '', re, `${what}: ${JSON.stringify(got)}`);
      assert.equal(refusals(), before + 1, `${what}: audited`);
    }
    const before = refusals();
    const cross = await open([TERMINAL_PROTOCOL, `csrf.${ada.csrf}`], { origin: 'https://evil.example' });
    assert.equal(cross.error, '403', 'another Origin: the upgrade itself is refused');
    assert.equal(refusals(), before + 1, 'another Origin: audited');
    assert.equal(spawned.length, 0, 'none of them started anything');

    // A valid session with its own token opens it, and the answer names the terminal's protocol, never the token.
    const ok = await open([TERMINAL_PROTOCOL, `csrf.${ada.csrf}`]);
    assert.deepEqual(ok, { protocol: TERMINAL_PROTOCOL });
    assert.equal(spawned.length, 1);
    assert.ok(termAudit.some((e) => e.kind === 'opened' && e.login === 'ada'));
    assert.ok(!JSON.stringify(termAudit).includes(ada.csrf), 'the token is in no audit entry');
    // The page offers exactly these subprotocols (web/src/api.ts terminalProtocols).
    const web = readFileSync(join(repoRoot, 'web', 'src', 'api.ts'), 'utf8');
    assert.ok(web.includes(`'${TERMINAL_PROTOCOL}'`) && web.includes('`csrf.${csrf}`'), 'the page sends the protocol and the token the hub reads');
  } finally {
    await s.close();
  }
});

test('the views that say whether a machine change would pass get the device from the hub on a read too: the Machine page, Add project, the Claude account and Tailscale setup', async () => {
  const { whois, laptop, stranger } = tailnet();
  const accountDir = mkdtempSync(join(tmpdir(), 'auth-account-'));
  const s = await setup({ machineOwners: ['ada'], devices: { allow: ['laptop'], whois }, claudeAccountDir: accountDir });
  try {
    s.gh.perms.set('example/a:ada', 'admin');
    const ada = await s.signIn('ada');
    const view = async (path: string, headers: Record<string, string>) => (await (await ada.get(`/api/i/a/${path}`, headers)).json()) as Record<string, unknown>;
    // Every path in the shared list is one the instance serves, and each says the device when the hub does.
    assert.deepEqual(Object.values(DEVICE_VIEWS).sort(), ['add-project', 'claude-account', 'machine', 'tailscale']);
    assert.deepEqual([(await view(DEVICE_VIEWS.tailscale, laptop)).allowed, (await view(DEVICE_VIEWS.tailscale, laptop)).why], [true, null], 'Tailscale setup from an allowed device: a step may be asked for');
    assert.match(String((await view(DEVICE_VIEWS.tailscale, stranger)).why), /allowed devices/);
    const fromLaptop = { machine: await view(DEVICE_VIEWS.machine, laptop), add: await view(DEVICE_VIEWS.addProject, laptop), account: await view(DEVICE_VIEWS.claudeAccount, laptop) };
    assert.deepEqual([fromLaptop.machine.canChange, fromLaptop.machine.deviceReady], [true, true], 'the Machine page from an allowed device: changes may be made');
    assert.deepEqual([fromLaptop.add.allowed, fromLaptop.add.why], [true, null]);
    assert.deepEqual([fromLaptop.account.allowed, fromLaptop.account.why], [true, null], "the Claude account card doesn't say the device is wrong");
    const elsewhere = { machine: await view(DEVICE_VIEWS.machine, stranger), add: await view(DEVICE_VIEWS.addProject, stranger), account: await view(DEVICE_VIEWS.claudeAccount, stranger) };
    assert.equal(elsewhere.machine.deviceReady, false, 'the Machine page from a device off the list says so');
    assert.match(String(elsewhere.add.why), /allowed devices/);
    assert.match(String(elsewhere.account.why), /allowed devices/);
    // The browser's own copy of the device header counts for nothing on a read either.
    assert.equal((await view(DEVICE_VIEWS.machine, { ...stranger, 'x-dashboard-console-device': '1' })).deviceReady, false);

    // And the real change agrees with the view: accepted from the laptop, refused from elsewhere.
    const ok = await ada.post('/api/i/a/machine', { what: 'slots', value: 4 }, { headers: laptop });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(((await ok.json()) as { machine: { deviceReady: boolean } }).machine.deviceReady, true);
    const no = await ada.post('/api/i/a/machine', { what: 'slots', value: 5 }, { headers: stranger });
    assert.equal(no.status, 403);
    assert.match(((await no.json()) as { error: string }).error, /allowed devices/);
    assert.deepEqual(machineRequests(s.a.log.read(0, [...MACHINE_EVENTS])).map((r) => r.args.join(' ')), ['set-slots 4']);
  } finally {
    await s.close();
  }
});
