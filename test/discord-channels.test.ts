// `discord channels` (src/intake/discord-channels.ts) against a fake Discord REST server on 127.0.0.1: one line per
// text or announcement channel, sorted; GET requests only; the token never in stdout, stderr, a URL or an error,
// even when the server echoes it back; 401, 429 and a missing token each say what's wrong.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discordChannelsCommand, listDiscordChannels } from '../src/intake/discord-channels.js';
import { API } from '../src/intake/discord.js';

const TOKEN = 'MTAwMDAwMDAwMDAwMDAwMDAx.fake01.placeholder-bot-token-value';

type Mode = 'ok' | 'unauthorized' | 'echo' | 'rate-once' | 'rate-long';
interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
}

async function fakeDiscord(mode: Mode) {
  const seen: Seen[] = [];
  let limited = false;
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
    if (mode === 'unauthorized') return json(res, 401, { message: '401: Unauthorized', code: 0 });
    // WHY: a server (or proxy) that echoes the request back is how a token would leak through an error message.
    if (mode === 'echo') return json(res, 500, { message: `internal error for ${req.headers.authorization}` });
    if (mode === 'rate-long') return json(res, 429, { message: 'You are being rate limited.', retry_after: 120 }, { 'retry-after': '120' });
    if (mode === 'rate-once' && !limited) {
      limited = true;
      return json(res, 429, { message: 'You are being rate limited.', retry_after: 0.01 }, { 'retry-after': '0.01' });
    }
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/users/@me/guilds') return json(res, 200, [{ id: '900000000000000002', name: 'Zeta Server' }, { id: '900000000000000001', name: 'Alpha Server' }]);
    if (url.pathname === '/guilds/900000000000000001/channels')
      return json(res, 200, [
        { id: '100000000000000012', name: 'superfan-engine', type: 0 },
        { id: '100000000000000011', name: 'general', type: 0 },
        { id: '100000000000000013', name: 'Voice', type: 2 },
        { id: '100000000000000014', name: 'Info', type: 4 },
        { id: '100000000000000015', name: 'news', type: 5 },
      ]);
    if (url.pathname === '/guilds/900000000000000002/channels') return json(res, 200, [{ id: '100000000000000021', name: 'ideas', type: 0 }, { id: '100000000000000022', name: 'a-forum', type: 15 }]);
    return json(res, 404, { message: 'Unknown' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { api, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** An instances dir with one instance, its credentials.yaml naming a token file (or none). */
function instances(o: { token?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dch-'));
  const home = join(dir, 'shop');
  mkdirSync(home);
  writeFileSync(join(home, 'instance.yaml'), 'version: 1\nname: shop\nrepos: [{ path: ./repo, repo: example/shop }]\n');
  const tokenFile = join(home, 'discord-token');
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  writeFileSync(join(home, 'credentials.yaml'), `version: 1\ngithub: { kind: gh-config-dir, path: /nonexistent }\n${o.token === false ? '' : `intake: { discord_token: ${JSON.stringify(tokenFile)} }\n`}`);
  return dir;
}

/**
 * Run the command with its default stdout/stderr (console.log and console.error, as the CLI runs it), capturing
 * them and every other console call meanwhile. WHY console, not process.stdout: the test runner reports through
 * the process's own stdout.
 */
/** A fetch that sends what the listing asks of Discord's REST base to the fake server instead (the base itself is a constant). */
const toFake = (api: string): typeof fetch => ((url: string | URL | Request, init?: RequestInit) => {
  assert.ok(String(url).startsWith(`${API}/`), `the listing asked ${String(url)}`);
  return fetch(`${api}${String(url).slice(API.length)}`, init);
}) as typeof fetch;

async function run(o: { api: string; instance?: string; dir: string; fetch?: typeof fetch }) {
  const out: string[] = [];
  const err: string[] = [];
  const stray: string[] = [];
  const keys = ['log', 'error', 'warn', 'info', 'debug'] as const;
  const saved = keys.map((k) => console[k]);
  const text = (a: unknown[]) => a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' ');
  console.log = (...a: unknown[]) => void out.push(text(a));
  console.error = (...a: unknown[]) => void err.push(text(a));
  console.warn = console.info = console.debug = (...a: unknown[]) => void stray.push(text(a));
  let code: number;
  try {
    const { api, ...rest } = o;
    code = await discordChannelsCommand({ ...rest, fetch: o.fetch ?? toFake(api), sleep: async () => {} });
  } finally {
    keys.forEach((k, i) => (console[k] = saved[i]!));
  }
  return { code, out, err, stray };
}

test('discord channels: one sorted line per text and announcement channel, and nothing else', async () => {
  const d = await fakeDiscord('ok');
  try {
    const r = await run({ api: d.api, dir: instances() });
    assert.equal(r.code, 0);
    assert.deepEqual(r.out, [
      'Alpha Server / #general 100000000000000011',
      'Alpha Server / #news 100000000000000015',
      'Alpha Server / #superfan-engine 100000000000000012',
      'Zeta Server / #ideas 100000000000000021',
    ]);
    assert.deepEqual(r.err, []);
    assert.deepEqual(r.stray, []);
    // The token travels in the Authorization header only, never in a URL.
    for (const s of d.seen) {
      assert.equal(s.auth, `Bot ${TOKEN}`);
      assert.ok(!s.url.includes(TOKEN));
    }
  } finally {
    await d.close();
  }
});

test('discord channels: only GET requests are made, whatever Discord answers', async () => {
  const methods = new Set<string>();
  for (const mode of ['ok', 'unauthorized', 'echo', 'rate-once', 'rate-long'] as const) {
    const d = await fakeDiscord(mode);
    try {
      await run({ api: d.api, dir: instances(), instance: 'shop' });
      assert.ok(d.seen.length > 0, `${mode}: it called the fake server`);
      for (const s of d.seen) methods.add(s.method);
    } finally {
      await d.close();
    }
  }
  assert.deepEqual([...methods], ['GET']);
});

test('discord channels: the token is never in stdout, stderr or a thrown error, even when Discord echoes it', async () => {
  const leaks = (texts: string[]) => texts.filter((t) => t.includes(TOKEN) || t.includes(TOKEN.split('.')[2]!));
  for (const mode of ['echo', 'unauthorized', 'rate-long'] as const) {
    const d = await fakeDiscord(mode);
    try {
      const r = await run({ api: d.api, dir: instances() });
      assert.equal(r.code, 1, `${mode}: fails`);
      assert.equal(r.err.length, 1, `${mode}: one line on stderr`);
      assert.deepEqual(leaks([...r.out, ...r.err, ...r.stray]), [], `${mode}: no token in any output`);
      const thrown = await listDiscordChannels({ token: TOKEN, fetch: toFake(d.api), sleep: async () => {} }).then(
        () => null,
        (e: Error) => e,
      );
      assert.ok(thrown, `${mode}: the listing throws`);
      assert.deepEqual(leaks([thrown.message, thrown.stack ?? '', String(thrown)]), [], `${mode}: no token in the error`);
    } finally {
      await d.close();
    }
  }
  // A transport error that carries the token (a misbehaving fetch, a proxy) is scrubbed too.
  const failing = (async () => {
    throw new Error(`socket closed while sending Bot ${TOKEN}`);
  }) as unknown as typeof fetch;
  const r = await run({ api: 'http://127.0.0.1:9', dir: instances(), fetch: failing });
  assert.equal(r.code, 1);
  assert.deepEqual(leaks([...r.out, ...r.err, ...r.stray]), []);
  assert.match(r.err[0]!, /could not reach Discord/);
});

test('discord channels: a 401, a long rate limit and no token each say what is wrong; a short rate limit is waited out', async () => {
  const unauthorized = await fakeDiscord('unauthorized');
  try {
    const r = await run({ api: unauthorized.api, dir: instances() });
    assert.match(r.err[0]!, /refused the bot token \(401/);
  } finally {
    await unauthorized.close();
  }
  const long = await fakeDiscord('rate-long');
  try {
    const r = await run({ api: long.api, dir: instances() });
    assert.match(r.err[0]!, /rate-limited .*try again in 120s/);
    assert.equal(long.seen.length, 1, 'a retry-after past the cap is not waited out');
  } finally {
    await long.close();
  }
  const once = await fakeDiscord('rate-once');
  try {
    const r = await run({ api: once.api, dir: instances() });
    assert.equal(r.code, 0);
    assert.equal(r.out.length, 4);
    assert.equal(once.seen[0]!.url, once.seen[1]!.url, 'the rate-limited request is retried');
  } finally {
    await once.close();
  }
  const none = await fakeDiscord('ok');
  try {
    const r = await run({ api: none.api, dir: instances({ token: false }) });
    assert.equal(r.code, 1);
    assert.match(r.err[0]!, /has no bot token/);
    assert.equal(none.seen.length, 0, 'no token: nothing is sent');
    const missing = await run({ api: none.api, dir: instances(), instance: 'other' });
    assert.equal(missing.code, 1);
    assert.match(missing.err[0]!, /instance other/);
  } finally {
    await none.close();
  }
});
