// People's GitHub pictures come from the dashboard's own origin (#462, the owner's option B): the hub, or an
// instance's own dashboard, fetches a picture from GitHub's hosts, keeps it a day in its state dir and serves it,
// signed-in only, for known people only; the page's CSP allows no outside host. Here GitHub is a stand-in fetch in
// code: no test makes a live call (a test process's default fetch refuses, checked below).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AVATAR_MAX_BYTES, AVATAR_SIZES, AVATAR_TTL_MS, avatarSize, Avatars, fetchAvatar } from '../src/avatars.js';
import { loadConfig } from '../src/config/load.js';
import { PAGE_CSP, startDashboard } from '../src/dashboard.js';
import { SESSION_COOKIE, STATE_COOKIE } from '../src/dashboard-auth.js';
import { startHub } from '../src/dashboard-hub.js';
import { EventLog } from '../src/events/log.js';
import { findChrome, until, type Cdp } from '../src/browser/cdp.js';
import { launchTestChrome, oneChromeAtATime, REAL_CHROME_TIMEOUT, realChromeTests, webUiSkip } from './browser-helpers.js';
import { asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

/** A 1 x 1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/** GitHub as a stand-in: github.com/<login>.png redirects to the avatars host, which answers `picture`. Every URL asked is kept. */
function standIn(picture: (login: string) => { type: string; body: Buffer; length?: number } | null = () => ({ type: 'image/png', body: PNG })) {
  const asked: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url.toString());
    const own = url.pathname.match(/^\/([A-Za-z0-9-]+)\.png$/);
    if (url.origin === 'https://github.com' && own) return new Response(null, { status: 302, headers: { location: `https://avatars.githubusercontent.com/u/${own[1]}?size=${url.searchParams.get('size')}&v=4` } });
    const u = url.pathname.match(/^\/u\/([A-Za-z0-9-]+)$/);
    if (url.origin === 'https://avatars.githubusercontent.com' && u) {
      const p = picture(u[1]!);
      if (!p) return new Response('Not Found', { status: 404 });
      return new Response(new Uint8Array(p.body), { status: 200, headers: { 'content-type': p.type, ...(p.length !== undefined ? { 'content-length': String(p.length) } : {}) } });
    }
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
  return { f, asked };
}

test('only a GitHub login at one of the fixed sizes is ever fetched: nothing else reaches the fetch', async () => {
  assert.deepEqual(AVATAR_SIZES, [40, 80, 160]);
  for (const s of ['40', '80', '160']) assert.equal(avatarSize(s), Number(s));
  for (const s of [null, '', '41', '4000', '40.0', '-40', '1e2', ' 40', '40px']) assert.equal(avatarSize(s), null, String(s));
  const g = standIn();
  for (const login of ['', '-lead', 'a'.repeat(40), 'a/b', 'a.b', '..', 'a b', 'evil.example.com', 'x%2F..']) assert.equal(await fetchAvatar(login, 40, { fetch: g.f }), null, login);
  assert.equal(await fetchAvatar('example-owner', 41, { fetch: g.f }), null);
  assert.deepEqual(g.asked, [], 'nothing asked for a bad login or size');
  assert.deepEqual(await fetchAvatar('example-owner', 40, { fetch: g.f }), { type: 'image/png', body: PNG });
  assert.deepEqual(g.asked, ['https://github.com/example-owner.png?size=40', 'https://avatars.githubusercontent.com/u/example-owner?size=40&v=4']);
});

test("a picture comes only from GitHub's hosts, over https, as a PNG, JPEG, GIF or WebP that is one, never SVG, and bounded", async () => {
  const redirect = (location: string) => {
    const asked: string[] = [];
    const f = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return asked.length === 1 ? new Response(null, { status: 302, headers: { location } }) : new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
    return { f, asked };
  };
  for (const to of ['https://evil.example.com/x.png', 'http://avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com.example.com/u/1', 'https://127.0.0.1/x.png']) {
    const r = redirect(to);
    assert.equal(await fetchAvatar('example-owner', 40, { fetch: r.f }), null, to);
    assert.equal(r.asked.length, 1, `${to} is never asked`);
  }
  const of = async (type: string, body: Buffer, length?: number) => fetchAvatar('example-owner', 40, { fetch: standIn(() => ({ type, body, ...(length !== undefined ? { length } : {}) })).f });
  assert.equal(await of('image/svg+xml', SVG), null, 'never SVG');
  assert.equal(await of('text/html', PNG), null);
  assert.equal(await of('image/png', SVG), null, 'a type its bytes are not');
  assert.equal(await of('image/jpeg', PNG), null);
  assert.equal(await of('image/png', Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES)])), null, 'too large, as read');
  assert.equal(await of('image/png', PNG, AVATAR_MAX_BYTES + 1), null, 'too large, as declared');
  assert.ok(await of('image/png; charset=binary', PNG));
  assert.ok(await of('image/gif', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')));
  assert.ok(await of('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])));
  assert.ok(await of('image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])));
  // Redirects end: a loop between GitHub's own hosts gives up.
  const loop = (async () => new Response(null, { status: 302, headers: { location: 'https://github.com/example-owner.png?size=40' } })) as typeof fetch;
  assert.equal(await fetchAvatar('example-owner', 40, { fetch: loop }), null);
});

test('a fetch that never answers gives up at its timeout', async () => {
  const hang = ((_u: string, init?: RequestInit) => new Promise<Response>((_ok, fail) => init?.signal?.addEventListener('abort', () => fail(new Error('aborted'))))) as typeof fetch;
  const t0 = Date.now();
  assert.equal(await fetchAvatar('example-owner', 40, { fetch: hang, timeoutMs: 200 }), null);
  assert.ok(Date.now() - t0 < 5_000);
});

test('in a test process the default fetch never reaches outside: no live call from a test (#462)', async () => {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (u: string | URL | Request) => {
    asked.push(String(u));
    return new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  try {
    assert.equal(await fetchAvatar('example-owner', 40), null);
    const a = new Avatars(mkdtempSync(join(tmpdir(), 'avatars-')));
    assert.equal(await a.picture('example-owner', 40), null);
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(asked, []);
});

/** A response as the route writes it, for Avatars.serve without a server. */
function capture(ifNoneMatch?: string) {
  const out: { status: number; headers: Record<string, string>; body: Buffer } = { status: 0, headers: {}, body: Buffer.alloc(0) };
  let finish: (o: typeof out) => void = () => {};
  const done = new Promise<typeof out>((ok) => (finish = ok));
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status;
      out.headers = headers;
      return res;
    },
    end(b?: Buffer | string) {
      out.body = b === undefined ? Buffer.alloc(0) : Buffer.from(b);
      finish(out);
    },
  };
  return { req: { headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {} } as never, res: res as never, done };
}

test('kept on disk for a day, served with cache-control and an ETag (304 when the browser has it); the stale one when GitHub fails', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'avatars-')), 'avatars');
  const clock = { t: 1_000_000 };
  let down = false;
  const g = standIn(() => (down ? null : { type: 'image/png', body: PNG }));
  const a = new Avatars(dir, { fetch: g.f, now: () => clock.t });
  const serve = async (login: string, size: string, inm?: string) => {
    const c = capture(inm);
    await a.serve(c.req, c.res, login, size, () => true);
    return c.done;
  };
  const first = await serve('Example-Owner', '40');
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'image/png');
  assert.deepEqual(first.body, PNG);
  assert.equal(first.headers['cache-control'], `private, max-age=${AVATAR_TTL_MS / 1000}`);
  assert.equal(first.headers['x-content-type-options'], 'nosniff');
  assert.match(first.headers.etag!, /^"[0-9a-f]{32}"$/);
  assert.deepEqual(readdirSync(dir), ['example-owner-40.json'], 'kept in the state dir, by lowercased login and size');
  assert.equal(g.asked.length, 2);
  // Within the day: from disk (a fresh Avatars too), never asked again; the browser's copy is a 304.
  clock.t += AVATAR_TTL_MS - 1000;
  const again = new Avatars(dir, { fetch: g.f, now: () => clock.t });
  const c = capture(first.headers.etag);
  await again.serve(c.req, c.res, 'example-owner', '40', () => true);
  const r304 = await c.done;
  assert.equal(r304.status, 304);
  assert.equal(r304.headers['cache-control'], 'private, max-age=1');
  assert.equal(g.asked.length, 2);
  // A day on: asked again; GitHub down, so the kept picture is served, and the miss isn't asked again for an hour.
  clock.t += 2000;
  down = true;
  assert.equal((await serve('example-owner', '40')).status, 200);
  assert.equal(g.asked.length, 4);
  assert.equal((await serve('example-owner', '40')).status, 200);
  assert.equal(g.asked.length, 4, 'a miss is not asked again at once');
  // Never kept: a 404, so the page shows initials.
  assert.equal((await serve('example-collaborator', '40')).status, 404);
  // Refused before anything is fetched: a bad login or size, someone not known.
  const before = g.asked.length;
  assert.equal((await serve('a/b', '40')).status, 400);
  assert.equal((await serve('example-owner', '41')).status, 400);
  const c2 = capture();
  await a.serve(c2.req, c2.res, 'stranger', '40', () => false);
  assert.equal((await c2.done).status, 404);
  assert.equal(g.asked.length, before);
  // A kept file that isn't a picture of its type is never served.
  writeFileSync(join(dir, 'example-owner-80.json'), JSON.stringify({ type: 'image/png', etag: '"x"', at: clock.t, body: SVG.toString('base64') }));
  down = true;
  assert.equal((await serve('example-owner', '80')).status, 404);
});

/** An instance's own dashboard, its log naming example-owner (a decision) and example-collaborator (a task's owner). */
async function instance(avatars: typeof fetch, builtUi = false) {
  const dir = mkdtempSync(join(tmpdir(), 'avatar-inst-'));
  const { dir: root } = exampleProject();
  const db = join(dir, 'events.db');
  const log = new EventLog(db);
  log.append('issue.seen', { issue: 1, title: 'One', labels: ['ready'], author: 'example-owner', owner: 'example-collaborator', actionable: true, why: '' }, 'c');
  log.append('decision.asked', { id: 'd-1', kind: 'question', issue: 1, owner: 'example-owner', question: 'Approve?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'c');
  log.close();
  const web = mkdtempSync(join(tmpdir(), 'avatar-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><title>d</title></head><body></body></html>');
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots'), ...(builtUi ? {} : { webDir: web }), pollMs: 50, avatars: { fetch: avatars } });
  return { d, dir, web };
}

test("an instance's own dashboard serves people's pictures itself: with its key, for people it knows; its page's CSP names no outside host", async () => {
  const g = standIn();
  const { d, dir } = await instance(g.f);
  try {
    const base = d.url.replace(/\/$/, '');
    const key = { authorization: `Bearer ${d.token}` };
    assert.equal((await fetch(`${base}/api/avatar/example-owner?size=40`)).status, 401, 'never without the key');
    assert.deepEqual(g.asked, []);
    for (const login of ['example-owner', 'example-collaborator']) {
      const r = await fetch(`${base}/api/avatar/${login}?size=80`, { headers: key });
      assert.equal(r.status, 200, login);
      assert.equal(r.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
    }
    assert.ok(existsSync(join(dir, 'avatars', 'example-owner-80.json')), "kept in the instance's state dir");
    const asked = g.asked.length;
    assert.equal((await fetch(`${base}/api/avatar/stranger?size=80`, { headers: key })).status, 404, 'not a person it knows');
    assert.equal((await fetch(`${base}/api/avatar/example-owner?size=999`, { headers: key })).status, 400);
    assert.equal((await fetch(`${base}/api/avatar/a%2Fb?size=40`, { headers: key })).status, 400);
    assert.equal(g.asked.length, asked, 'none of those fetched');
    // A person the hub names may see the picture of whoever this instance knows, themselves included.
    assert.equal((await fetch(`${base}/api/avatar/stranger?size=40`, { headers: { ...key, ...asPerson('stranger') } })).status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/people/example-collaborator`, { headers: key })).json(), { known: true });
    assert.deepEqual(await (await fetch(`${base}/api/people/someone-else`, { headers: key })).json(), { known: false });
    // The page: same-origin only, pictures included.
    for (const p of ['/', '/decisions']) {
      const page = await fetch(`${base}${p}`);
      assert.equal(page.headers.get('content-security-policy'), PAGE_CSP, p);
    }
    assertSelfOnly(PAGE_CSP);
  } finally {
    await d.close();
  }
});

/** Every CSP directive names this origin (or blob:/data: made by the page) and nothing else: no outside host. */
function assertSelfOnly(csp: string) {
  const directives = new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]));
  assert.deepEqual(directives.get('default-src'), ["'self'"]);
  assert.deepEqual(directives.get('img-src'), ["'self'", 'blob:']);
  for (const [k, v] of directives) for (const s of v) assert.ok(["'self'", "'none'", "'unsafe-inline'", 'blob:'].includes(s), `${k}: ${s} is not this origin`);
  assert.doesNotMatch(csp, /github|https?:|\*/);
}

test('the hub serves pictures itself, signed-in only and for people the instance knows, kept in its own state dir', async () => {
  const instGh = standIn();
  const hubGh = standIn();
  const { d } = await instance(instGh.f);
  const hubState = mkdtempSync(join(tmpdir(), 'avatar-hub-'));
  const web = mkdtempSync(join(tmpdir(), 'avatar-hub-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><title>hub</title></head><body></body></html>');
  // Sign-in through a stand-in GitHub, in code: a code is the login.
  const signInFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname === '/login/oauth/access_token') return Response.json({ access_token: `ghu_${(JSON.parse(String(init?.body)) as { code: string }).code}` });
    if (u.pathname === '/user') return Response.json({ login: String(new Headers(init?.headers).get('authorization')).replace('Bearer ghu_', '') });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const h = await startHub({
    instances: [{ name: 'a', port: Number(new URL(d.url).port), tokenFile: d.keyFile }],
    stateDir: hubState,
    webDir: web,
    signIn: { clientId: 'Iv1.testclient01', clientSecret: 'secret', sessionSecret: 's'.repeat(48), publicUrl: 'https://hub.example.test', fetch: signInFetch },
    appManifest: { isMachineOwner: () => false },
    avatars: { fetch: hubGh.f },
  });
  try {
    const base = h.url.replace(/\/$/, '');
    const signIn = async (login: string) => {
      const start = await fetch(`${base}/auth/login`, { redirect: 'manual' });
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith(`${STATE_COOKIE}=`))!.split(';')[0]!;
      const back = await fetch(`${base}/auth/callback?code=${login}&state=${state}`, { redirect: 'manual', headers: { cookie: stateCookie } });
      return back.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0]!;
    };
    const pic = `${base}/api/i/a/avatar/example-collaborator?size=40`;
    assert.equal((await fetch(pic)).status, 401, 'signed-in only');
    assert.deepEqual(hubGh.asked, []);
    const cookie = await signIn('example-owner');
    const r = await fetch(pic, { headers: { cookie } });
    assert.equal(r.status, 200);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
    assert.match(r.headers.get('cache-control')!, /^private, max-age=\d+$/);
    assert.ok(r.headers.get('etag'));
    assert.equal((await fetch(pic, { headers: { cookie, 'if-none-match': r.headers.get('etag')! } })).status, 304);
    assert.deepEqual(readdirSync(join(hubState, 'avatars')), ['example-collaborator-40.json'], "kept in the hub's state dir");
    assert.deepEqual(instGh.asked, [], 'the hub fetched it, not the instance');
    const asked = hubGh.asked.length;
    assert.equal((await fetch(`${base}/api/i/a/avatar/stranger?size=40`, { headers: { cookie } })).status, 404, 'not a person the instance knows: never fetched');
    assert.equal((await fetch(`${base}/api/i/zz/avatar/example-owner?size=40`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/i/a/avatar/example-owner?size=33`, { headers: { cookie } })).status, 400);
    assert.equal(hubGh.asked.length, asked);
    // The signed-in person's own picture, whoever they are.
    const own = await signIn('stranger');
    assert.equal((await fetch(`${base}/api/i/a/avatar/stranger?size=40`, { headers: { cookie: own } })).status, 200);
    // The break-glass: the hub's key, on this machine; the same rules.
    const glass = h.breakGlassUrl.split('/?')[0]!;
    const key = { authorization: `Bearer ${h.token}` };
    assert.equal((await fetch(`${glass}/api/i/a/avatar/example-owner?size=80`)).status, 401);
    assert.equal((await fetch(`${glass}/api/i/a/avatar/example-owner?size=80`, { headers: key })).status, 200);
    assert.equal((await fetch(`${glass}/api/i/a/avatar/nobody-known?size=80`, { headers: key })).status, 404);
    // The hub's page: the same CSP.
    assert.equal((await fetch(`${base}/`)).headers.get('content-security-policy'), PAGE_CSP);
  } finally {
    await h.close();
    await d.close();
  }
});

test("the page's sizes are the server's, and PersonAvatar asks this origin, never GitHub", () => {
  const api = readFileSync(join(repoRoot, 'web', 'src', 'api.ts'), 'utf8');
  assert.ok(api.includes(`export const AVATAR_SIZES = ${JSON.stringify([...AVATAR_SIZES]).replace(/,/g, ', ')};`), 'web/src/api.ts has the same sizes');
  const ui = readFileSync(join(repoRoot, 'web', 'src', 'components', 'ui.tsx'), 'utf8');
  assert.doesNotMatch(ui, /github\.com|githubusercontent/);
  assert.match(ui, /avatarSrc\(login, size\)/);
  for (const f of readdirSync(join(repoRoot, 'web', 'src'), { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(f)) continue;
    const src = readFileSync(join(repoRoot, 'web', 'src', f), 'utf8');
    assert.doesNotMatch(src, /src=\{?[`'"]https?:/, `${f}: a picture from another host`);
  }
});

realChromeTests();
const chrome = findChrome(process.env.CHROME);

async function js<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

test(
  "in a real Chrome under the page's CSP: a person's picture comes from the dashboard's own origin, no page breaks the CSP, nothing outside is asked",
  { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) },
  async (ctx) => {
    await oneChromeAtATime(ctx);
    const g = standIn();
    const { d } = await instance(g.f, true);
    const b = await launchTestChrome(chrome!, { width: 1280, height: 900 });
    try {
      const cdp = b.cdp;
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      // Every CSP violation on every page, from its first script on.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try { sessionStorage.setItem('dash-token', ${JSON.stringify(d.token)}); } catch {} window.__csp = []; addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.effectiveDirective + ' ' + e.blockedURI), true);`,
      });
      const pictures: string[] = [];
      cdp.on('Network.requestWillBeSent', (p) => {
        const url = String((p.request as { url?: unknown } | undefined)?.url ?? '');
        if (url.includes('/avatar/')) pictures.push(new URL(url).pathname + new URL(url).search);
      });
      const base = d.url.replace(/\/$/, '');
      for (const page of ['decisions', 'issues', 'issues/1', 'inbox', '', 'activity', 'settings']) {
        await cdp.send('Page.navigate', { url: `${base}/${page}` });
        await until(`the ${page || 'board'} page`, () => js<boolean>(cdp, `!!document.querySelector('[data-testid^="page-"]:not([data-testid="page-title"])')`), 20_000);
        if (page === 'decisions') {
          const img = `document.querySelector('[data-avatar="example-owner"] img')`;
          await until('example-owner\'s picture, drawn', () => js<boolean>(cdp, `!!${img} && ${img}.complete && ${img}.naturalWidth > 0`), 20_000);
          assert.match(await js<string>(cdp, `${img}.src`), /^blob:/, 'shown from what the page read from its own server');
        }
        assert.deepEqual(await js<string[]>(cdp, 'window.__csp'), [], `${page || 'board'}: nothing the CSP refused`);
      }
      assert.ok(pictures.includes('/api/avatar/example-owner?size=40'), `asked of this origin: ${pictures.join(', ')}`);
      assert.ok(g.asked.every((u) => u.startsWith('https://github.com/') || u.startsWith('https://avatars.githubusercontent.com/')), 'the server asked the stand-in GitHub');
    } finally {
      await b.close();
      await d.close();
    }
  },
);
