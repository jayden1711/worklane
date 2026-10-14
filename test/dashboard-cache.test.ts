// What the dashboard keeps of each view (web/src/cache.ts), so a switch shows it at once: keyed by instance, so one
// instance's data is never read under another's (an answer that arrives after a switch included); emptied when the
// person, their role or their session changes and on sign-out; kept in memory only, never in the tab's storage; and
// only page views, never sign-in links or tokens. The page's own modules, bundled for Node as the render checks are,
// run against a stand-in tab on a hub page.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers.js';

const WEB_SRC = join(repoRoot, 'web', 'src');

interface Scope {
  current: string | null;
  all: boolean;
  instances: (string | null)[];
}
interface Web {
  peek<T>(url: string): { data: T; at: number } | undefined;
  keep(url: string, data: unknown): void;
  kept(url: string): boolean;
  keptCount(): number;
  forgetAll(): void;
  setCacheOff(v: boolean): void;
  coalesced<T>(url: string, run: () => Promise<T>, fresh?: boolean): Promise<T>;
  instanceApi<T>(name: string, path: string): Promise<T>;
  viewUrl(path: string, instance?: string | null): string;
  selectInstance(name: string): void;
  scopeNowOrNull(): Scope | null;
  instanceScope: Promise<Scope>;
  signOut(): Promise<void>;
}
let web: Web;

/** Every write to the tab's storage (session or local): only the instance choice may ever be written. */
const writes: { store: string; key: string; value: string }[] = [];
/** The stand-in server: answers by URL, each held until the test lets it go when `hold` names it. */
const answers = new Map<string, () => { status: number; body: unknown }>();
const held = new Map<string, () => void>();
const hold = new Set<string>();
const asked: string[] = [];

function storage(name: string, init: [string, string][] = []) {
  const m = new Map(init);
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes.push({ store: name, key: k, value: v });
      m.set(k, v);
    },
    removeItem: (k: string) => void m.delete(k),
  };
}

before(async () => {
  const g = globalThis as Record<string, unknown>;
  // A hub page (its marker), a tab that last showed alpha.
  g.window = { location: { href: 'http://127.0.0.1/', pathname: '/', hostname: '127.0.0.1', search: '', hash: '', reload: () => assert.fail('a switch never reloads the page'), assign: () => {} }, history: { replaceState: () => {} }, matchMedia: () => ({ matches: false }), setTimeout, clearTimeout };
  g.document = { querySelector: (s: string) => (s === 'meta[name="dashboard-hub"]' ? {} : null) };
  Object.defineProperty(g, 'sessionStorage', { value: storage('session', [['dash-instance', 'alpha']]), configurable: true, writable: true });
  Object.defineProperty(g, 'localStorage', { value: storage('local'), configurable: true, writable: true });
  answers.set('/api/me', () => ({ status: 200, body: { login: 'ada', csrf: 'c', breakGlass: false } }));
  answers.set('/api/hub', () => ({ status: 200, body: { instances: [{ name: 'alpha', up: true, error: null }, { name: 'beta', up: true, error: null }] } }));
  globalThis.fetch = (async (u: string | URL | Request) => {
    const url = String(u);
    asked.push(url);
    if (hold.has(url)) await new Promise<void>((r) => held.set(url, r));
    const a = answers.get(url)?.() ?? { status: 404, body: { error: 'no such view' } };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const { build } = await import('vite');
  const out = mkdtempSync(join(tmpdir(), 'web-cache-'));
  const entry = join(out, 'entry.ts');
  writeFileSync(entry, `export { peek, keep, kept, keptCount, forgetAll, setCacheOff, coalesced } from ${JSON.stringify(join(WEB_SRC, 'cache.ts'))};\nexport { instanceApi, viewUrl, selectInstance, scopeNowOrNull, instanceScope, signOut } from ${JSON.stringify(join(WEB_SRC, 'api.ts'))};\n`);
  await build({ configFile: false, root: join(repoRoot, 'web'), logLevel: 'silent', ssr: { noExternal: true }, build: { ssr: entry, outDir: join(out, 'dist'), emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'web.mjs' } } } });
  web = (await import(pathToFileURL(join(out, 'dist', 'web.mjs')).href)) as Web;
  await web.instanceScope;
});

const state = (instance: string, user = 'ada', role = 'owner') => ({ project: { name: instance }, user, role, lastId: 1 });

test('each view is kept under its instance: what one instance answered is never read under another', async () => {
  web.forgetAll();
  answers.set('/api/i/alpha/state', () => ({ status: 200, body: state('alpha') }));
  answers.set('/api/i/beta/state', () => ({ status: 200, body: state('beta') }));
  assert.equal(web.scopeNowOrNull()?.current, 'alpha');
  assert.equal(web.viewUrl('/api/state'), '/api/i/alpha/state');
  assert.equal(web.viewUrl('/api/board', 'beta'), '/api/i/beta/board');
  await web.instanceApi('alpha', '/api/state');
  assert.deepEqual(web.peek<{ project: { name: string } }>('/api/i/alpha/state')?.data.project, { name: 'alpha' });
  assert.equal(web.peek('/api/i/beta/state'), undefined, "alpha's answer is not beta's");
  assert.equal(web.peek('/api/state'), undefined, 'nor the bare path');
});

test("an instance switch doesn't reload, and an answer from the last instance that arrives after it stays that instance's", async () => {
  web.forgetAll();
  hold.add('/api/i/alpha/state');
  const late = web.instanceApi('alpha', '/api/state');
  await new Promise((r) => setTimeout(r, 10));
  const release = () => {
    held.get('/api/i/alpha/state')?.();
    hold.clear();
  };
  try {
    web.selectInstance('beta');
  assert.equal(web.scopeNowOrNull()?.current, 'beta', 'switched in place');
  assert.equal((await web.instanceScope).current, 'beta', 'whatever asks for the scope after the switch gets the new one');
    assert.equal(web.viewUrl('/api/state'), '/api/i/beta/state');
    release();
    await late;
    assert.equal(web.peek(web.viewUrl('/api/state')), undefined, "beta's view shows nothing of alpha's late answer");
    assert.ok(web.peek('/api/i/alpha/state'), "it is kept as alpha's");
  } finally {
    release();
    web.selectInstance('alpha');
  }
});

test('another role on an instance forgets what was read there under the old one; another person forgets everything', () => {
  web.forgetAll();
  web.keep('/api/i/alpha/state', state('alpha', 'ada', 'owner'));
  web.keep('/api/i/alpha/prs', { prs: ['owner-only detail'] });
  web.keep('/api/i/beta/state', state('beta', 'ada', 'owner'));
  web.keep('/api/i/beta/board', { cards: [] });
  // Ada is a viewer on alpha now: alpha's views read as owner go; beta's stay.
  web.keep('/api/i/alpha/state', state('alpha', 'ada', 'viewer'));
  assert.equal(web.peek('/api/i/alpha/prs'), undefined, 'read under the old role: gone');
  assert.equal(web.peek<{ role: string }>('/api/i/alpha/state')?.data.role, 'viewer');
  assert.ok(web.peek('/api/i/beta/board'), "another instance's stays");
  // Someone else on beta: nothing read for ada stays anywhere.
  web.keep('/api/i/beta/state', state('beta', 'bob', 'owner'));
  assert.equal(web.peek('/api/i/beta/board'), undefined);
  assert.equal(web.peek('/api/i/alpha/state'), undefined);
  assert.deepEqual(web.peek<{ user: string }>('/api/i/beta/state')?.data.user, 'bob');
});

test('a refused session (401) forgets everything; a role taken away (403 on its state) forgets that instance; sign-out forgets everything', async () => {
  web.forgetAll();
  web.keep('/api/i/alpha/state', state('alpha'));
  web.keep('/api/i/beta/state', state('beta'));
  web.keep('/api/i/beta/board', { cards: [] });
  answers.set('/api/i/beta/state', () => ({ status: 403, body: { error: 'no role on beta' } }));
  await assert.rejects(web.instanceApi('beta', '/api/state'));
  assert.equal(web.peek('/api/i/beta/board'), undefined, "beta's gone");
  assert.ok(web.peek('/api/i/alpha/state'), "alpha's stays");
  answers.set('/api/i/beta/state', () => ({ status: 401, body: { error: 'signed out' } }));
  await assert.rejects(web.instanceApi('beta', '/api/state'));
  assert.equal(web.keptCount(), 0, 'a 401: nothing kept');
  web.keep('/api/i/alpha/state', state('alpha'));
  answers.set('/auth/logout', () => ({ status: 200, body: {} }));
  await web.signOut();
  assert.equal(web.keptCount(), 0, 'signed out: nothing kept');
  answers.set('/api/i/beta/state', () => ({ status: 200, body: state('beta') }));
});

test('only page views are kept: never sign-in links, tokens, transcripts, setup asks or the audit log', () => {
  for (const url of ['/api/i/alpha/state', '/api/i/alpha/board', '/api/prs', '/api/i/beta/test-runs', '/api/i/beta/usage', '/api/i/a/health/incidents', '/api/i/a/events?after=3']) assert.ok(web.kept(url), url);
  for (const url of ['/api/me', '/api/hub', '/api/i/alpha/first-run/claude-signin', '/api/i/alpha/claude-account', '/api/i/alpha/claude-account/token', '/api/i/alpha/tailscale', '/api/i/alpha/runs/x/live', '/api/i/alpha/asks', '/api/i/alpha/audit', '/api/i/alpha/chat/1', '/api/i/alpha/machine', '/api/i/alpha/stateful']) assert.ok(!web.kept(url), url);
  web.forgetAll();
  web.keep('/api/i/alpha/claude-account/token', { token: 'secret' });
  assert.equal(web.keptCount(), 0);
});

test('nothing is ever written to the tab\'s storage but which instance it shows', async () => {
  web.forgetAll();
  answers.set('/api/i/alpha/board', () => ({ status: 200, body: { cards: [{ title: 'private title' }] } }));
  await web.instanceApi('alpha', '/api/state');
  await web.instanceApi('alpha', '/api/board');
  web.selectInstance('beta');
  web.selectInstance('alpha');
  assert.ok(writes.length > 0);
  for (const w of writes) {
    assert.equal(w.store, 'session', 'never localStorage');
    assert.ok(['dash-instance', 'dash-all-instances'].includes(w.key), w.key);
    assert.match(w.value, /^[a-z0-9-]+$|^1$/, 'an instance name, no data');
  }
  // And the module itself never names a storage write or IndexedDB.
  const src = readFileSync(join(WEB_SRC, 'cache.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /localStorage|indexedDB|setItem/);
});

test('one GET of a URL at a time: a second ask waits and asks again (its answer may predate the change); a prefetch takes the one in flight', { timeout: 5000 }, async () => {
  let n = 0;
  let release: () => void = () => {};
  const run = () => new Promise<number>((r) => (release = () => r(++n)));
  const a = web.coalesced('/x', run);
  const b = web.coalesced('/x', run);
  const c = web.coalesced('/x', run);
  const p = web.coalesced('/x', run, false);
  release();
  assert.equal(await a, 1);
  assert.equal(await p, 1, 'the prefetch took the answer in flight');
  await new Promise((r) => setTimeout(r, 0));
  release();
  assert.deepEqual([await b, await c], [2, 2], 'one more ask, shared');
});

test('turned off (the speed test\'s "without the cache"), nothing is kept or shown', () => {
  web.setCacheOff(true);
  web.keep('/api/i/alpha/state', state('alpha'));
  assert.equal(web.peek('/api/i/alpha/state'), undefined);
  web.setCacheOff(false);
});
