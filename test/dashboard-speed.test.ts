// The dashboard's speed fixes, each pinned: the log read once and then incrementally (and the same JSON as reading
// it whole), compression of the built UI and of the listed views only (BREACH), the year-long cache of the
// content-hashed assets, and the hub compressing what it forwards while a live stream passes through as it is.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { loadConfig } from '../src/config/load.js';
import { IMMUTABLE, startDashboard } from '../src/dashboard.js';
import { startHub } from '../src/dashboard-hub.js';
import { acceptedEncoding, COMPRESSIBLE_API, mayCompressApi } from '../src/dashboard-compress.js';
import { EventCache } from '../src/events/cache.js';
import { EventLog } from '../src/events/log.js';
import { prsView, checkResults } from '../src/projection.js';
import type { EventType, StoredEvent } from '../src/events/types.js';
import { boardView } from '../src/board.js';
import { trustView } from '../src/trust.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';
import { writeSyntheticLog } from './synthetic-events.js';

/** A raw GET (fetch would decompress, and hide the headers this is about). */
function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((done, fail) => {
    const req = request(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', fail);
    req.end();
  });
}
const decoded = (r: { headers: Record<string, string | string[] | undefined>; body: Buffer }) => {
  const enc = r.headers['content-encoding'];
  return (enc === 'br' ? brotliDecompressSync(r.body) : enc === 'gzip' ? gunzipSync(r.body) : r.body).toString('utf8');
};

/** A built UI as vite writes it: index.html, a content-hashed bundle under assets/, and a file outside it. */
function webDir() {
  const dir = mkdtempSync(join(tmpdir(), 'speed-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), `<!doctype html><title>ok</title>${'<!-- padding -->'.repeat(100)}`);
  const js = `export const big = ${JSON.stringify('the dashboard bundle '.repeat(4000))};\n`;
  writeFileSync(join(dir, 'assets', 'index-AbC123.js'), js);
  writeFileSync(join(dir, 'licenses.txt'), 'MIT\n'.repeat(1000));
  return { dir, js };
}

async function dashboard(db: string, web?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'speed-'));
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots'), pollMs: 50, machineStats: () => null, ...(web ? { webDir: web } : {}) });
  return { d, h: { authorization: `Bearer ${d.token}` } };
}

/** Every route that read the whole log per request, as a person in each role reads it. */
const VIEWS = ['state', 'board', 'test-runs', 'audit', 'report', 'events', 'events?after=1500', 'events?issue=3', 'runs/r1/research', 'prs', 'intake', 'throughput', 'constraints', 'trust', 'metrics', 'harness-evals', 'flaky', 'learnings', 'waiting', 'usage', 'health', 'add-project', 'machine', 'checks?issue=3', 'goal-graph?issue=3'];
const PEOPLE: Record<string, string>[] = [{}, asPerson('example-collaborator'), asPerson('someone-else')];

async function answers(base: string, h: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const p of PEOPLE) for (const v of VIEWS) out[`${JSON.stringify(p)} ${v}`] = decoded(await get(`${base}/api/${v}`, { ...h, ...p }));
  return out;
}

/** Copy another synthetic log's events into this one, through the engine's own log (each checked against its schema). */
function append(db: string, from: string, n: number) {
  const src = new DatabaseSync(from, { readOnly: true });
  const rows = src.prepare('SELECT type, actor, source, payload FROM events ORDER BY id LIMIT ?').all(n) as { type: EventType; actor: string; source: 'coordinator' | 'human' | 'agent'; payload: string }[];
  src.close();
  const log = new EventLog(db);
  for (const r of rows) log.append(r.type, JSON.parse(r.payload) as never, r.actor, r.source);
  log.db.close();
}

test('event cache: every view read incrementally answers the same JSON as one reading the whole log, and the views match the folds', async (t) => {
  // One instant for both servers: views say how long things have waited, and when they were made.
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-01T13:00:00Z') });
  t.after(() => mock.timers.reset());
  const dir = mkdtempSync(join(tmpdir(), 'speed-log-'));
  const db = join(dir, 'events.db');
  const more = join(dir, 'more.db');
  writeSyntheticLog(db, { count: 2000, seed: 7 });
  writeSyntheticLog(more, { count: 600, seed: 8 });
  const a = await dashboard(db);
  try {
    const base = a.d.url;
    const first = await answers(base, a.h);
    append(db, more, 600);
    // A has read the log, folded it, and now reads only what was appended; B reads it whole for the first time.
    const grown = await answers(base, a.h);
    const b = await dashboard(db);
    try {
      const whole = await answers(b.d.url, b.h);
      for (const k of Object.keys(whole)) assert.equal(grown[k], whole[k], `${k}: read incrementally differs from read whole`);
    } finally {
      await b.d.close();
    }
    assert.notEqual(grown[`{} prs`], first[`{} prs`], 'the appended events show');
    // The views are the folds of the log as it is, as they were before the cache.
    const all = new EventLog(db).read();
    const prs = JSON.parse(grown[`{} prs`]!) as { prs: unknown };
    assert.deepEqual(prs.prs, JSON.parse(JSON.stringify(prsView(all).prs)));
    assert.deepEqual(JSON.parse(grown[`{} checks?issue=3`]!), JSON.parse(JSON.stringify(checkResults(all, 3))));
  } finally {
    await a.d.close();
  }
});

test('event cache: an appended event is in the next answer; a log not changed is not read again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'speed-log-'));
  const db = join(dir, 'events.db');
  writeSyntheticLog(db, { count: 300, seed: 3 });
  const s = await dashboard(db);
  try {
    const state = async () => JSON.parse(decoded(await get(`${s.d.url}/api/state`, s.h))) as { tasks: { issue: number; title: string }[]; lastId?: number };
    const before = await state();
    const log = new EventLog(db);
    log.append('issue.seen', { issue: 9001, title: 'Appended just now', labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: 'opened by writer' }, 'c');
    log.db.close();
    const after = await state();
    assert.ok(!before.tasks.some((t) => t.issue === 9001));
    assert.equal(after.tasks.find((t) => t.issue === 9001)?.title, 'Appended just now', 'the appended event is in the very next answer');
    // Rewrite a row already read (only a test can: the log's triggers refuse it). Read again whole, the title would
    // change; read incrementally, what was read stands, as the append-only log promises.
    const raw = new DatabaseSync(db);
    raw.exec('DROP TRIGGER events_no_update');
    raw.prepare("UPDATE events SET payload = json_set(payload, '$.title', 'rewritten') WHERE type = 'issue.seen' AND json_extract(payload, '$.issue') = 9001").run();
    raw.close();
    const again = await state();
    assert.equal(again.tasks.find((t) => t.issue === 9001)?.title, 'Appended just now', 'the rows already read were not read again');
  } finally {
    await s.d.close();
  }
});

test('event cache: a different file at the path, or a migration, is read whole again; what it hands out is frozen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'speed-log-'));
  const db = join(dir, 'events.db');
  writeSyntheticLog(db, { count: 50, seed: 1 });
  const c = new EventCache(db);
  assert.equal(c.all().length, 50);
  assert.equal(c.fullReads, 1);
  assert.equal(c.all().length, 50);
  assert.equal(c.fullReads, 1, 'an unchanged log is not read again');
  assert.equal(c.after(45).length, 5);
  assert.deepEqual(c.after(45).map((e) => e.id), [46, 47, 48, 49, 50]);
  assert.throws(() => (c.all() as unknown as unknown[]).push({}), TypeError);
  assert.throws(() => {
    (c.all()[0]!.payload as Record<string, unknown>).instance = 'changed';
  }, TypeError);
  let calls = 0;
  const f = () => (calls++, { n: c.all().length });
  assert.equal(c.memo('n', f).n, 50);
  assert.equal(c.memo('n', f).n, 50);
  assert.equal(calls, 1, 'a fold of an unchanged log is kept');
  // Another log moved into its place (a restore): read whole, its own events.
  const other = join(dir, 'other.db');
  writeSyntheticLog(other, { count: 20, seed: 2 });
  renameSync(other, db);
  assert.equal(c.all().length, 20);
  assert.equal(c.fullReads, 2);
  assert.equal(c.memo('n', f).n, 20, 'and the folds of the old one are gone');
  // A migration (a new user_version) may rewrite rows: read whole again.
  const raw = new DatabaseSync(db);
  raw.exec(`PRAGMA user_version = ${Number((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) + 1}`);
  raw.close();
  assert.equal(c.all().length, 20);
  assert.equal(c.fullReads, 3);
});

test('static: the built UI is compressed (brotli, gzip) with Vary, the hashed assets cached a year, the page never', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'speed-log-'));
  const db = join(dir, 'events.db');
  new EventLog(db).db.close();
  const web = webDir();
  const s = await dashboard(db, web.dir);
  try {
    const js = `${s.d.url}/assets/index-AbC123.js`;
    for (const [accept, enc] of [['br, gzip', 'br'], ['gzip, deflate', 'gzip'], ['br;q=0, gzip', 'gzip']] as const) {
      const r = await get(js, { 'accept-encoding': accept });
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-encoding'], enc, accept);
      assert.equal(r.headers.vary, 'accept-encoding');
      assert.equal(r.headers['cache-control'], IMMUTABLE);
      assert.equal(IMMUTABLE, 'public, max-age=31536000, immutable');
      assert.ok(r.body.length < web.js.length / 5, `${enc}: ${r.body.length} bytes for ${web.js.length}`);
      assert.equal(decoded(r), web.js);
    }
    const plain = await get(js);
    assert.equal(plain.headers['content-encoding'], undefined, 'nothing accepted: sent as it is');
    assert.equal(plain.body.toString('utf8'), web.js);
    const page = await get(`${s.d.url}/`, { 'accept-encoding': 'gzip' });
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(decoded(page), /<title>ok/);
    const other = await get(`${s.d.url}/licenses.txt`, { 'accept-encoding': 'gzip' });
    assert.notEqual(other.headers['cache-control'], IMMUTABLE, 'only content-hashed files are kept a year');
    // A name under assets/ that isn't there falls back to the page: never cached.
    assert.equal((await get(`${s.d.url}/assets/index-missing.js`)).headers['cache-control'], 'no-store');
  } finally {
    await s.d.close();
  }
});

test('API: a listed view is compressed when asked, never stored; an unlisted one never compressed (BREACH)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'speed-log-'));
  const db = join(dir, 'events.db');
  writeSyntheticLog(db, { count: 400, seed: 5 });
  const s = await dashboard(db);
  try {
    const r = await get(`${s.d.url}/api/state`, { ...s.h, 'accept-encoding': 'br' });
    assert.equal(r.headers['content-encoding'], 'br');
    assert.equal(r.headers.vary, 'accept-encoding');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.ok(Array.isArray((JSON.parse(decoded(r)) as { tasks: unknown[] }).tasks));
    assert.equal((await get(`${s.d.url}/api/prs`, { ...s.h, 'accept-encoding': 'gzip' })).headers['content-encoding'], 'gzip');
    // Not listed: the setup console's views (sign-in links, device codes) and anything added later.
    for (const v of ['first-run/claude-signin', 'live', 'views']) {
      const u = await get(`${s.d.url}/api/${v}`, { ...s.h, 'accept-encoding': 'br, gzip' });
      assert.equal(u.headers['content-encoding'], undefined, v);
      assert.equal(u.headers['cache-control'], 'no-store', v);
    }
  } finally {
    await s.d.close();
  }
});

test('BREACH: no view that can carry a secret is ever listed for compression', () => {
  // Not views a page switch reads: each carries (or may carry) a token, key, CSRF value, one-time code or sign-in link
  // beside text others choose, or was never checked for it. Listing one needs that check first.
  for (const v of ['me', 'hub', 'first-run', 'first-run/claude-signin', 'first-run/gh-login', 'first-run/discord', 'first-run/discord/channels', 'claude-account', 'claude-account/token', 'tailscale', 'machine', 'add-project', 'add-project/repos', 'runs', 'live', 'chat', 'audit', 'views', 'role', 'stream', 'asks', 'instance-settings']) {
    assert.ok(!COMPRESSIBLE_API.has(v), `${v} must never be compressed`);
    assert.equal(mayCompressApi(`/api/${v}`), false, v);
  }
  assert.equal(mayCompressApi('/api/i/a/state'), false, "the hub's own answers aren't views");
  assert.equal(acceptedEncoding('gzip;q=0, br;q=0'), null);
  assert.equal(acceptedEncoding('identity'), null);
  assert.equal(acceptedEncoding('GZIP'), 'gzip');
});

test('hub: a forwarded view is compressed on the way out, /api/me never, and a live stream passes through as it is', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'speed-log-'));
  const db = join(dir, 'events.db');
  writeSyntheticLog(db, { count: 400, seed: 6 });
  const web = webDir();
  const i = await dashboard(db);
  const stateDir = mkdtempSync(join(tmpdir(), 'speed-hub-'));
  const h = await startHub({ instances: [{ name: 'a', port: Number(new URL(i.d.url).port), tokenFile: join(i.d.keyFile) }], stateDir, webDir: web.dir });
  try {
    const base = h.breakGlassUrl;
    const hh = { authorization: `Bearer ${h.token}` };
    const r = await get(`${base}/api/i/a/state`, { ...hh, 'accept-encoding': 'br, gzip' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'br');
    assert.equal(r.headers.vary, 'accept-encoding');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(decoded(r), decoded(await get(`${i.d.url}/api/state`, i.h)), 'the same JSON the instance gave');
    const me = await get(`${base}/api/me`, { ...hh, 'accept-encoding': 'br, gzip' });
    assert.equal(me.headers['content-encoding'], undefined, '/api/me carries the CSRF token: never compressed');
    const unlisted = await get(`${base}/api/i/a/live`, { ...hh, 'accept-encoding': 'br, gzip' });
    assert.equal(unlisted.headers['content-encoding'], undefined);
    // The bundle through the hub: compressed and kept a year, like the instance's own.
    const js = await get(`${base}/assets/index-AbC123.js`, { 'accept-encoding': 'br' });
    assert.equal(js.headers['content-encoding'], 'br');
    assert.equal(js.headers['cache-control'], IMMUTABLE);
    // The live stream: its first event arrives while the stream stays open (nothing buffers it), uncompressed.
    const first = await new Promise<{ type: string | undefined; enc: string | undefined; text: string }>((done, fail) => {
      const req = request(`${base}/api/i/a/stream`, { headers: { ...hh, 'accept-encoding': 'br, gzip' } }, (res) => {
        res.once('data', (c: Buffer) => {
          done({ type: res.headers['content-type'], enc: res.headers['content-encoding'], text: c.toString('utf8') });
          req.destroy();
        });
      });
      req.on('error', (e) => (e.message.includes('aborted') || e.message.includes('socket hang up') ? null : fail(e)));
      req.end();
    });
    assert.equal(first.type, 'text/event-stream');
    assert.equal(first.enc, undefined);
    assert.match(first.text, /event: hello/);
  } finally {
    await h.close();
    await i.d.close();
  }
});

test('the synthetic log is the same for the same seed, and each payload its schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'speed-log-'));
  const read = (seed: number, name: string) => {
    const f = join(dir, name);
    writeSyntheticLog(f, { count: 500, seed });
    const db = new DatabaseSync(f, { readOnly: true });
    const rows = db.prepare('SELECT ts, type, payload FROM events ORDER BY id').all();
    db.close();
    return JSON.stringify(rows);
  };
  assert.equal(read(4, 'a.db'), read(4, 'b.db'));
  assert.notEqual(read(4, 'c.db'), read(5, 'd.db'));
  assert.ok(readFileSync(join(dir, 'a.db')).length > 0);
});

/** The log as an array that counts each pass over it (an iteration, or a method that walks it). */
function counted(events: StoredEvent[]) {
  const walks = new Set<string | symbol>([Symbol.iterator, 'filter', 'map', 'forEach', 'reduce', 'some', 'every', 'find', 'findIndex', 'findLast', 'flatMap', 'slice', 'entries']);
  const n = { passes: 0 };
  const proxy = new Proxy([...events], {
    get(t, k, r) {
      if (walks.has(k)) n.passes++;
      return Reflect.get(t, k, r) as unknown;
    },
  });
  return { proxy, n };
}

test('the Board and the trust view pass over the log a fixed number of times, not once per card or per failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'speed-log-'));
  const now = new Date('2026-06-01T13:00:00Z');
  const passes = (count: number) => {
    const f = join(dir, `${count}.db`);
    writeSyntheticLog(f, { count, seed: 11 });
    const all = new EventLog(f).read();
    const b = counted(all);
    const board = boardView({ events: b.proxy, instance: 'x', role: 'owner', canReadDigest: true, live: [], slots: { cap: 2, running: 0 }, now });
    // The trust view copies the log first (the events up to now), so its passes show as times it parses one's time.
    const parse = Date.parse;
    let parsed = 0;
    Date.parse = (x: string) => (parsed++, parse(x));
    try {
      trustView(all, { agents: 2, now });
    } finally {
      Date.parse = parse;
    }
    const red = all.filter((e) => e.type === 'merge.main_result' && (e.payload as { outcome: string }).outcome === 'red').length;
    return { board: b.n.passes, cards: board.cards.length, trustPerEvent: parsed / all.length, red };
  };
  const small = passes(1500);
  const big = passes(6000);
  assert.ok(big.cards > small.cards + 10, `more cards on the bigger log (${small.cards}, ${big.cards})`);
  assert.ok(big.red > small.red, `more main-red failures on the bigger log (${small.red}, ${big.red})`);
  assert.equal(big.board, small.board, `the Board's passes over the log: ${small.board} for ${small.cards} cards, ${big.board} for ${big.cards}`);
  // Times parsed per event: the same whatever the failures (a pass per failure would add one per event each).
  assert.ok(big.trustPerEvent - small.trustPerEvent < 0.5, `the trust view parsed ${small.trustPerEvent.toFixed(2)} times per event with ${small.red} failures, ${big.trustPerEvent.toFixed(2)} with ${big.red}`);
});
