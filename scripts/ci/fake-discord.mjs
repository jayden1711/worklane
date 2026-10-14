// A stand-in for Discord's REST API, for tests and CI only: what `discord channels` asks of it
// (src/intake/discord-channels.ts), and nothing else. GET /applications/@me, /users/@me/guilds and
// /guilds/<id>/channels answer for one bot token; any other token gets 401, and any other method 405.
//
//   import { startFakeDiscord } from './fake-discord.mjs'        (the tests)
//   node scripts/ci/fake-discord.mjs <port> <token-file> [<log>]  (CI: the token is read from a file, never an argument)
//
// The log (and `seen`) holds each request's method and path and whether it carried the right token: never the token.
import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FAKE_APPLICATION = { id: '700000000000000001', name: 'Example Bot', flags: 1 << 19 };
export const FAKE_GUILDS = [
  { id: '900000000000000002', name: 'Zeta Server' },
  { id: '900000000000000001', name: 'Alpha Server' },
];
export const FAKE_CHANNELS = {
  '900000000000000001': [
    { id: '100000000000000012', name: 'superfan-engine', type: 0 },
    { id: '100000000000000011', name: 'general', type: 0 },
    { id: '100000000000000013', name: 'Voice', type: 2 },
    { id: '100000000000000014', name: 'Info', type: 4 },
    { id: '100000000000000015', name: 'news', type: 5 },
    { id: '100000000000000016', name: 'asks', type: 0 },
    { id: '100000000000000017', name: 'superfan-shop', type: 0 },
    { id: '100000000000000018', name: 'chat', type: 0 },
  ],
  '900000000000000002': [
    { id: '100000000000000021', name: 'ideas', type: 0 },
    { id: '100000000000000022', name: 'a-forum', type: 15 },
  ],
};

/** Start it on 127.0.0.1. `application`: what /applications/@me answers (its flags hold the message-content intent). */
export async function startFakeDiscord({ token, port = 0, log = null, application = FAKE_APPLICATION }) {
  const seen = [];
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const authorized = req.headers.authorization === `Bot ${token}`;
    const entry = { method: req.method ?? '', path: url.pathname, authorized, tokenInUrl: (req.url ?? '').includes(token) };
    seen.push(entry);
    if (log) appendFileSync(log, `${entry.method} ${entry.path} ${authorized ? 'authorized' : 'unauthorized'}\n`);
    if (req.method !== 'GET') return json(res, 405, { message: '405: Method Not Allowed' });
    if (!authorized) return json(res, 401, { message: '401: Unauthorized', code: 0 });
    if (url.pathname === '/applications/@me') return json(res, 200, application);
    if (url.pathname === '/users/@me/guilds') return json(res, 200, FAKE_GUILDS);
    const m = /^\/guilds\/(\d+)\/channels$/.exec(url.pathname);
    if (m && FAKE_CHANNELS[m[1]]) return json(res, 200, FAKE_CHANNELS[m[1]]);
    return json(res, 404, { message: 'Unknown' });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { api: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [port, tokenFile, log] = process.argv.slice(2);
  if (!port || !tokenFile) {
    console.error('usage: fake-discord.mjs <port> <token-file> [<log>]');
    process.exit(2);
  }
  const f = await startFakeDiscord({ token: readFileSync(tokenFile, 'utf8').trim(), port: Number(port), log: log ?? null });
  console.log(`fake Discord on ${f.api}`);
}
