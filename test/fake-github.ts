// A fake GitHub, for the manifest flow's tests (test/app-manifest.test.ts) and for add-project end to end on a real
// host (scripts/ci/fake-github.mjs, in CI): sign-in, users, App names, manifest conversions (each code once), the
// App's installation and its token, the installation's repositories, and, with a git root, the repo itself over
// git's smart HTTP (git http-backend), which takes only the installation token, as GitHub takes it from the App's
// credential helper. Each git request's user is recorded, so a test can tell the clone went through the helper.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

export const FAKE_APP_ID = 91;
export const FAKE_INSTALLATION_ID = 4242;
export const FAKE_INSTALLATION_TOKEN = 'ghs_inst';

export interface FakeGitHubOptions {
  /** The one repo the App is installed on (owner/name). */
  repo: string;
  /** The installation's permissions, as its token reports them. */
  permissions: Record<string, string>;
  /** Installed already (as after the owner's install click). */
  installed?: boolean;
  /** A directory of bare repos (<owner>/<name>.git) served over git's smart HTTP. */
  gitRoot?: string;
  /** Answer any other GET with an empty list (200 []), as a running coordinator's calls need; otherwise 404. */
  lenient?: boolean;
  port?: number;
  /** Each request, as `<method> <path>` (and the git user), for a log. */
  log?: (line: string) => void;
}

export async function fakeGitHub(o: FakeGitHubOptions) {
  const codes = new Map<string, { slug: string; id: number }>(); // manifest codes
  const signins = new Map<string, string>(); // oauth codes -> login
  const takenNames = new Set<string>();
  const state = { installed: o.installed ?? false, reaches: [o.repo], permissions: { ...o.permissions }, conversions: 0, gitUsers: [] as string[], tokens: 0 };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const auth = req.headers.authorization ?? '';
    o.log?.(`${req.method} ${url.pathname}`);
    if (o.gitRoot && /\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(url.pathname)) return git(req, res, url, auth);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status: number, j: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(j));
      };
      const jwtIss = () => {
        const m = auth.match(/^Bearer [^.]+\.([^.]+)\./);
        return m ? String((JSON.parse(Buffer.from(m[1]!, 'base64url').toString()) as { iss: unknown }).iss) : null;
      };
      let m: RegExpMatchArray | null;
      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        const b = JSON.parse(body) as { code: string };
        const login = signins.get(b.code);
        signins.delete(b.code);
        return login ? send(200, { access_token: `ghu_${login}` }) : send(200, { error: 'bad_verification_code' });
      }
      if (req.method === 'GET' && url.pathname === '/user') return send(200, { login: auth.replace(/^Bearer ghu_/, '') });
      if (req.method === 'DELETE' && /^\/applications\/[^/]+\/token$/.test(url.pathname)) return res.writeHead(204).end();
      if (req.method === 'GET' && (m = url.pathname.match(/^\/users\/([^/]+)$/))) return send(200, { login: m[1], id: 501, type: m[1] === 'example-org' ? 'Organization' : 'User' });
      if (req.method === 'GET' && (m = url.pathname.match(/^\/apps\/([^/]+)$/))) return takenNames.has(m[1]!) ? send(200, { slug: m[1] }) : send(404, { message: 'Not Found' });
      if (req.method === 'POST' && (m = url.pathname.match(/^\/app-manifests\/([^/]+)\/conversions$/))) {
        const c = codes.get(m[1]!);
        codes.delete(m[1]!);
        if (!c) return send(404, { message: 'Not Found' });
        state.conversions++;
        return send(201, { id: c.id, slug: c.slug, client_id: 'Iv1.madeapp00001', client_secret: APP_SECRET, webhook_secret: null, pem: FAKE_PEM.value, owner: { login: 'example' }, html_url: `https://github.com/apps/${c.slug}` });
      }
      if (req.method === 'GET' && url.pathname === `/repos/${o.repo}`) return send(200, { id: 777, full_name: o.repo, default_branch: 'main', private: true });
      if (req.method === 'GET' && url.pathname === `/repos/${o.repo}/installation`) {
        if (jwtIss() !== String(FAKE_APP_ID)) return send(401, { message: 'Bad credentials' });
        return state.installed ? send(200, { id: FAKE_INSTALLATION_ID, app_id: FAKE_APP_ID }) : send(404, { message: 'Not Found' });
      }
      if (req.method === 'GET' && url.pathname === '/app') return jwtIss() === String(FAKE_APP_ID) ? send(200, { id: FAKE_APP_ID, slug: 'alpha-app' }) : send(401, {});
      if (req.method === 'POST' && url.pathname === `/app/installations/${FAKE_INSTALLATION_ID}/access_tokens`) {
        if (jwtIss() !== String(FAKE_APP_ID)) return send(401, { message: 'Bad credentials' });
        state.tokens++;
        return send(201, { token: FAKE_INSTALLATION_TOKEN, expires_at: '2099-01-01T00:00:00Z', permissions: state.permissions });
      }
      if (req.method === 'GET' && url.pathname === '/installation/repositories') {
        return auth === `Bearer ${FAKE_INSTALLATION_TOKEN}` || auth === `token ${FAKE_INSTALLATION_TOKEN}` ? send(200, { total_count: state.reaches.length, repositories: state.reaches.map((full_name) => ({ full_name })) }) : send(401, {});
      }
      if (o.lenient && req.method === 'GET') return send(200, []);
      send(404, { message: 'Not Found' });
    });
  });

  /** git's smart HTTP for <gitRoot>/<owner>/<name>.git: the installation token only, as x-access-token. */
  function git(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, auth: string) {
    const basic = /^Basic (.+)$/.exec(auth);
    const [user, pass] = basic ? Buffer.from(basic[1]!, 'base64').toString().split(':') : [];
    if (pass !== FAKE_INSTALLATION_TOKEN) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"' });
      return res.end();
    }
    state.gitUsers.push(user ?? '');
    o.log?.(`git as ${user ?? ''}: ${req.method} ${url.pathname}`);
    const cgi = spawn('git', ['http-backend'], {
      env: { ...process.env, GIT_PROJECT_ROOT: o.gitRoot!, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.replace(/^\?/, ''), REQUEST_METHOD: req.method ?? 'GET', CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: user ?? '', REMOTE_ADDR: '127.0.0.1' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let headDone = false;
    cgi.stdout.on('data', (c: Buffer) => {
      if (headDone) return void res.write(c);
      head = Buffer.concat([head, c]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      headDone = true;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString().split('\r\n')) {
        const i = line.indexOf(':');
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
    });
    cgi.on('close', () => res.end());
  }

  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', () => r()));
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  return { url, codes, signins, takenNames, state, gitPath: (repo: string) => join(o.gitRoot ?? '', `${repo}.git`), close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** The App's client secret the conversion returns. */
export const APP_SECRET = 'appclientsecret0123456789abcdefABCDEF';
/** The App's private key the conversion returns: set it before a conversion (a test makes one). */
export const FAKE_PEM = { value: '' };
