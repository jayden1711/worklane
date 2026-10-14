#!/usr/bin/env node
// Dev only: a seeded demo's dashboard behind the hub's GitHub sign-in, with a
// fake GitHub on loopback (authorize, code exchange, /user, token revoke, and
// the repo permission API), so control-dashboard.mjs --as <role> can sign in
// as an owner, a writer or a viewer in a real browser. No real network.
//
//   node scripts/dev/signin-fake.mjs <demo root> <owner|writer|viewer> <built engine> <hub state dir>
//
// Prints `hub <url>` (sign in at <url>/auth/login) and `instance <url> (... it is in <key file>)`, then serves until killed.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, role, engine, hubState] = process.argv.slice(2);
const LOGINS = { owner: 'example-owner', writer: 'example-collaborator', viewer: 'someone-else' };
const PERMS = { 'example-owner': 'admin', 'example-collaborator': 'write', 'someone-else': 'read' };
const login = LOGINS[role];
if (!root || !login || !engine || !hubState) {
  console.error('usage: signin-fake.mjs <demo root> <owner|writer|viewer> <built engine> <hub state dir>');
  process.exit(2);
}
const load = (m) => import(pathToFileURL(join(engine, 'dist', 'src', m)).href);
const { dashboardSite, startDashboard } = await load('dashboard.js');
const { startHub } = await load('dashboard-hub.js');
const { cachedRoles, repoPermission } = await load('dashboard-auth.js');
const { freePort } = await load('browser/cdp.js');

const INSTALLATION = 'fake-installation-token';
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const gh = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const send = (status, j) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(j)));
    if (url.pathname === '/login/oauth/authorize') {
      // GitHub would ask the person to authorize; the fake says yes at once, as `login`.
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', `fake-${login}`);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      const code = JSON.parse(body).code;
      return send(200, code?.startsWith('fake-') ? { access_token: `ghu_${code.slice(5)}` } : { error: 'bad_verification_code' });
    }
    if (url.pathname === '/user') {
      const m = (req.headers.authorization ?? '').match(/^Bearer ghu_(.+)$/);
      return m ? send(200, { login: m[1] }) : send(401, { message: 'Bad credentials' });
    }
    if (req.method === 'DELETE' && /^\/applications\/[^/]+\/token$/.test(url.pathname)) return res.writeHead(204), res.end();
    const p = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/);
    if (p) {
      if (req.headers.authorization !== `Bearer ${INSTALLATION}`) return send(401, { message: 'Bad credentials' });
      const perm = PERMS[decodeURIComponent(p[1]).toLowerCase()];
      return perm ? send(200, { permission: perm }) : send(404, { message: 'Not Found' });
    }
    send(404, { message: 'Not Found' });
  });
});
const ghUrl = await listen(gh);

const site = dashboardSite(root);
const roleOf = cachedRoles(repoPermission({ repo: 'example-org/demo', token: async () => INSTALLATION, api: ghUrl }));
const d = await startDashboard({ root: site.root, cfg: site.cfg, eventsDb: site.eventsDb, stateDir: site.stateDir, logs: site.logs, policyFile: site.policyFile, backlog: site.backlog, user: 'example-owner', roleOf, instance: 'demo', port: 0 });
const hubPort = await freePort();
const publicUrl = `http://127.0.0.1:${hubPort}`;
const h = await startHub({
  instances: [{ name: 'demo', port: Number(new URL(d.url).port), tokenFile: join(site.stateDir, 'dashboard-token') }],
  stateDir: hubState,
  port: hubPort,
  signIn: { clientId: 'Iv1.devfakeclient', clientSecret: 'dev-fake-client-secret', sessionSecret: randomBytes(32).toString('hex'), publicUrl, web: ghUrl, api: ghUrl },
});
// The instance's URL carries no key; its file is named, as `dashboard` prints it.
process.stdout.write(`hub ${publicUrl}\ninstance ${d.url} (the page asks for the key once: it is in ${join(site.stateDir, 'dashboard-token')})\nas ${login} (${role})\n`);
const stop = async () => {
  await h.close();
  await d.close();
  gh.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
