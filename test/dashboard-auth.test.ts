// Per-person sign-in on the dashboard hub, end to end against a fake GitHub
// (the OAuth code exchange, /user, the token revoke, and the repo permission
// API): roles from repo permission, the 5-minute role cache, per-instance
// visibility, CSRF, sessions, cookies, the audit, the break-glass and the
// loopback-only listeners. No real network.
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
  ROLE_CACHE_MS,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  Sessions,
  STATE_COOKIE,
} from '../src/dashboard-auth.js';
import { EventLog } from '../src/events/log.js';
import { BRAND } from '../src/brand.js';
import { fullRunLock, tryAgentSlot } from '../src/slots.js';
import { tryTestSlot } from '../src/testrun/slots.js';
import { exampleProject, marksOf, seedInstanceItems, type InstanceMarks } from './helpers.js';

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
async function setup(o: { machine?: boolean } = {}) {
  const gh = await fakeGitHub();
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
    const d = await startDashboard({ root, cfg, eventsDb: db, stateDir: dir, user: 'example-owner', roleOf, instance: name, slotsDir: shared ?? join(dir, 'slots'), actor: m.actor, pollMs: 50 });
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
  const h = await startHub({ instances, stateDir: hubState, webDir: web, now, signIn: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, sessionSecret: 's'.repeat(48), publicUrl: PUBLIC, web: gh.url, api: gh.url } });
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
    const hub = (await (await fetch(`${s.glass}/api/hub?t=${s.h.token}`)).json()) as { instances: { name: string; role: string }[] };
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

test('the session the setup console reads (SessionOf): login, the role from the repo, the sign-in time, and the CSRF check', async () => {
  const s = await setup();
  try {
    s.gh.perms.set('example/a:ada', 'admin');
    const signedInAt = s.clock.t;
    const p = await s.signIn('ada');
    const req = (headers: Record<string, string>, method = 'POST') => ({ headers, method }) as unknown as import('node:http').IncomingMessage;
    assert.equal(s.h.session(req({}), 'a'), null, 'no cookie: no session');
    // Before the hub has asked the instance, no role: refused (fail closed).
    assert.equal(s.h.session(req({ cookie: p.cookie, 'x-csrf-token': p.csrf }), 'a')!.role, null);
    await p.get('/api/hub');
    s.clock.t += 60_000;
    assert.deepEqual(s.h.session(req({ cookie: p.cookie, 'x-csrf-token': p.csrf }), 'a'), { login: 'ada', role: 'owner', authenticatedAt: signedInAt, csrfOk: true });
    assert.equal(s.h.session(req({ cookie: p.cookie }), 'a')!.csrfOk, false, 'no CSRF token');
    assert.equal(s.h.session(req({ cookie: p.cookie, 'x-csrf-token': 'x'.repeat(43) }), 'a')!.csrfOk, false, 'a wrong one');
    assert.equal(s.h.session(req({ cookie: p.cookie, 'x-csrf-token': p.csrf, origin: 'https://evil.example' }), 'a')!.csrfOk, false, 'from another site');
    assert.equal(s.h.session(req({ cookie: p.cookie, 'x-csrf-token': p.csrf }), 'b')!.role, null, 'no role on b');
    assert.equal(s.h.session(req({ cookie: p.cookie, 'x-csrf-token': p.csrf }), 'nope')!.role, null, 'not an instance of this hub');
    // The hub's copy of the role lasts no longer than the role cache: removed from the repo, refused within 5 minutes.
    s.gh.perms.delete('example/a:ada');
    s.clock.t += ROLE_CACHE_MS;
    assert.equal(s.h.session(req({ cookie: p.cookie, 'x-csrf-token': p.csrf }), 'a')!.role, null);
    // The instance's own server sees the same person, role and sign-in time through the hub (dashboardSession).
    s.gh.perms.set('example/a:ada', 'admin');
    s.clock.t += ROLE_CACHE_MS;
    assert.equal(await status(p.get('/api/i/a/state')), 200);
    const r = (await (await p.get('/api/i/a/role')).json()) as { login: string; role: string; authenticatedAt: number };
    assert.deepEqual([r.login, r.role, r.authenticatedAt], ['ada', 'owner', signedInAt]);
    const glass = (await (await fetch(`${s.glass}/api/i/a/role`, { headers: { authorization: `Bearer ${s.h.token}` } })).json()) as { role: string; authenticatedAt: unknown };
    assert.deepEqual([glass.role, glass.authenticatedAt], ['owner', null], 'the break-glass never counts as a fresh sign-in');
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
