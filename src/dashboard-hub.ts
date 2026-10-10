// One dashboard over several instances on this machine. Each instance runs
// its own dashboard server, as its own coordinator user: the only process
// that reads its log and records answers in it. The hub, run as a separate
// viewer user, holds no log of its own and opens none: it reads each
// instance's dashboard token (granted read-only by the machine setup) and
// forwards the UI's API calls, answers included, to the selected instance's
// own server, which applies its own checks. So no instance, and not the hub,
// can write another instance's log.
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { DEFAULT_WEB_DIR, dashboardToken, json, serveStatic, tokenGiven } from './dashboard.js';

export interface HubInstance {
  name: string;
  /** The instance's own dashboard server, on loopback. */
  port: number;
  /** The instance's dashboard-token file. */
  tokenFile: string;
}

export interface HubOptions {
  instances: HubInstance[];
  /** The hub's own state (its token), in the viewer user's home. */
  stateDir: string;
  port?: number;
  webDir?: string;
}

/** The hub's port: next to the instances' range (4400-4899). */
export const HUB_PORT = 4399;
const NAME = /^[a-z][a-z0-9-]{0,40}$/;

/** `a=/state/a,b=/state/b`: each instance's name and state dir (its token file is there). */
export function parseHubArg(arg: string, port: (name: string) => number): HubInstance[] {
  const out: HubInstance[] = [];
  for (const part of arg.split(',').filter(Boolean)) {
    const i = part.indexOf('=');
    const name = part.slice(0, i);
    const dir = part.slice(i + 1);
    if (i < 1 || !NAME.test(name) || !dir) throw new Error(`--hub takes name=<state dir>[,name=<state dir>...]; got "${part}"`);
    if (out.some((x) => x.name === name)) throw new Error(`--hub names ${name} twice`);
    out.push({ name, port: port(name), tokenFile: `${dir.replace(/[\\/]+$/, '')}/dashboard-token` });
  }
  if (!out.length) throw new Error('--hub needs at least one instance');
  return out;
}

const readToken = (i: HubInstance): string | null => {
  try {
    return readFileSync(i.tokenFile, 'utf8').trim() || null;
  } catch {
    return null;
  }
};

/** Forward one API call to an instance's own server with its token; the instance's token never reaches the browser. */
function forward(i: HubInstance, req: IncomingMessage, res: ServerResponse, path: string, search: URLSearchParams): void {
  const token = readToken(i);
  if (!token) return json(res, 502, { error: `can't read instance ${i.name}'s dashboard token (${i.tokenFile}): is its dashboard running, and the hub allowed to read it?` });
  search.delete('t');
  const qs = search.toString();
  const up = request(
    { host: '127.0.0.1', port: i.port, path: `${path}${qs ? `?${qs}` : ''}`, method: req.method, headers: { authorization: `Bearer ${token}`, 'content-type': req.headers['content-type'] ?? 'application/json', ...(req.headers['last-event-id'] ? { 'last-event-id': req.headers['last-event-id'] } : {}) } },
    (r) => {
      const h: Record<string, string> = { 'cache-control': 'no-store' };
      if (r.headers['content-type']) h['content-type'] = r.headers['content-type'];
      res.writeHead(r.statusCode ?? 502, h);
      r.pipe(res);
    },
  );
  up.on('error', (e) => {
    if (!res.headersSent) json(res, 502, { error: `instance ${i.name}'s dashboard isn't answering on 127.0.0.1:${i.port} (${e.message})` });
    else res.end();
  });
  res.on('close', () => up.destroy());
  req.pipe(up);
}

/** Whether an instance's own server answers, as the hub sees it. */
function probe(i: HubInstance): Promise<{ up: boolean; error: string | null }> {
  const token = readToken(i);
  if (!token) return Promise.resolve({ up: false, error: "can't read its dashboard token" });
  return new Promise((done) => {
    const r = request({ host: '127.0.0.1', port: i.port, path: '/api/settings', headers: { authorization: `Bearer ${token}` }, timeout: 3000 }, (res) => {
      res.resume();
      done({ up: res.statusCode === 200, error: res.statusCode === 200 ? null : `answered ${res.statusCode}` });
    });
    r.on('timeout', () => r.destroy(new Error('timed out')));
    r.on('error', (e) => done({ up: false, error: e.message }));
    r.end();
  });
}

export function startHub(opts: HubOptions): Promise<{ server: Server; url: string; token: string; close: () => Promise<void> }> {
  const token = dashboardToken(opts.stateDir);
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const byName = new Map(opts.instances.map((i) => [i.name, i]));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!tokenGiven(req, url, token)) return json(res, 401, { error: 'missing or wrong token; open the URL the hub setup printed' });
        if (url.pathname === '/api/hub' && req.method === 'GET') {
          const instances = await Promise.all(opts.instances.map(async (i) => ({ name: i.name, ...(await probe(i)) })));
          return json(res, 200, { instances });
        }
        // /api/i/<instance>/<path> is that instance's /api/<path>.
        const m = url.pathname.match(/^\/api\/i\/([^/]+)\/(.+)$/);
        if (m) {
          const inst = byName.get(m[1]!);
          if (!inst) return json(res, 404, { error: `no instance ${m[1]} in this hub` });
          return forward(inst, req, res, `/api/${m[2]!}`, url.searchParams);
        }
        return json(res, 404, { error: 'not found: the hub serves /api/hub and /api/i/<instance>/...' });
      }
      serveStatic(webDir, url, res, { hub: true });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });
  return new Promise((resolveStart) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveStart({
        server,
        url: `http://127.0.0.1:${port}/?t=${token}`,
        token,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
