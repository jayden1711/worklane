#!/usr/bin/env node
// CI only (the "add-project (real systemd)" job in .github/workflows/ci-slow.yml): the machine owner's browser in the
// agents' App manifest flow, while scripts/setup/add-project.sh runs as root on the same host. It signs in to the real
// hub (through the fake GitHub's sign-in), opens the approve link the App step asks with, checks the manifest the page
// would post, has the fake GitHub make a one-time code (as GitHub does when the owner approves the App), and follows
// GitHub's redirect back to the hub. No real App is made. The code is written to <code file> (0600) for the job's
// leak check and never printed.
//
//   node manifest-browser.mjs <dist dir> <hub http base> <hub public origin> <fake GitHub> <owner login> <add-project jsonl> <code file>
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, hub, publicOrigin, gh, owner, jsonl, codeFile] = process.argv.slice(2);
if (!dist || !hub || !publicOrigin || !gh || !owner || !jsonl || !codeFile) {
  console.error('usage: manifest-browser.mjs <dist dir> <hub http base> <hub public origin> <fake GitHub> <owner login> <add-project jsonl> <code file>');
  process.exit(2);
}
const { AGENT_APP_PERMISSIONS, MANIFEST_CALLBACK_PATH } = await import(pathToFileURL(join(dist, 'src', 'setup', 'app-manifest.js')).href);
const { SESSION_COOKIE, STATE_COOKIE } = await import(pathToFileURL(join(dist, 'src', 'dashboard-auth.js')).href);
const { APP_SECRET, WEBHOOK_SECRET } = await import(pathToFileURL(join(dist, 'test', 'fake-github.js')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (r, name) => r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(';')[0];
const fake = (path, body) => fetch(`${gh}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
/** The browser on the hub's public origin, which tailscale serve would forward to the hub's port. */
const open = (link, cookie) => fetch(link.replace(publicOrigin, hub), { redirect: 'manual', headers: cookie ? { cookie } : {} });

/** Sign in to the hub as `login`, the way a browser does, with the fake GitHub vouching for the sign-in code. */
async function signIn(login) {
  const start = await fetch(`${hub}/auth/login`, { redirect: 'manual' });
  assert.equal(start.status, 302, `the hub's sign-in: ${start.status}`);
  const to = new URL(start.headers.get('location'));
  assert.equal(to.origin, new URL(gh).origin, "sign-in goes to the fake GitHub, as the hub's unit points it");
  const code = `signin-${randomBytes(8).toString('hex')}`;
  assert.equal((await fake('/_fake/signin-code', { code, login })).status, 201);
  const back = await fetch(`${hub}/auth/callback?code=${code}&state=${to.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: cookieOf(start, STATE_COOKIE) } });
  const session = cookieOf(back, SESSION_COOKIE);
  assert.ok(session, `signed in as ${login} (${back.status})`);
  return session;
}

/** The n-th approve link the App step asked with, once add-project.sh has printed it. */
async function ask(n) {
  for (let i = 0; i < 240; i++) {
    const lines = existsSync(jsonl) ? readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const asks = lines.filter((l) => l.step === 'app' && l.state === 'ask');
    if (asks.length >= n) return asks[n - 1].ask;
    const failed = lines.find((l) => l.state === 'failed');
    assert.ok(!failed, `add-project failed at ${failed?.step}: ${failed?.detail}`);
    await sleep(500);
  }
  throw new Error(`add-project never asked for GitHub click ${n}`);
}

const ownerSession = await signIn(owner);
const otherSession = await signIn('someone-else');
console.log(`signed in to the hub as @${owner} (a machine owner) and @someone-else (not one)`);

// 1. The approve link: a machine owner's only.
const create = await ask(1);
assert.equal(create.kind, 'approve_link');
assert.match(create.url, new RegExp(`^${publicOrigin}/setup/app-manifest/start/amf-[0-9a-f]{24}$`));
assert.equal((await open(create.url)).status, 401, 'signed out: refused');
assert.equal((await open(create.url, otherSession)).status, 403, 'not a machine owner: refused');
const page = await open(create.url, ownerSession);
const html = await page.text();
assert.equal(page.status, 200, html);
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const action = new URL(unesc(html.match(/action="([^"]+)"/)[1]));
const manifest = JSON.parse(unesc(html.match(/name="manifest" value="([^"]+)"/)[1]));
console.log(`the manifest for ${manifest.name}: ${JSON.stringify(manifest.default_permissions)}`);

// 2. What it would post to GitHub: exactly the agent App's permissions, private, no webhook, back to the hub.
assert.deepEqual(manifest.default_permissions, { ...AGENT_APP_PERMISSIONS });
assert.equal(manifest.public, false);
assert.equal(manifest.hook_attributes.active, false);
assert.deepEqual(manifest.default_events, []);
assert.equal(manifest.redirect_url, `${publicOrigin}${MANIFEST_CALLBACK_PATH}`);
assert.equal(`${action.origin}${action.pathname}`, `${gh}/settings/apps/new`);
const state = action.searchParams.get('state');
assert.ok(state && state.length >= 40, 'a long random state');

// 3. GitHub makes the App and sends the browser back with a one-time code (the fake, here: no real App).
const code = randomBytes(20).toString('hex');
writeFileSync(codeFile, `${code}\n`, { mode: 0o600 });
assert.equal((await fake('/_fake/manifest-code', { code, slug: manifest.name })).status, 201);
const callback = `${publicOrigin}${MANIFEST_CALLBACK_PATH}?code=${code}&state=${state}`;
assert.equal((await open(callback)).status, 401, 'signed out: refused, and nothing is used up');
const back = await open(callback, ownerSession);
const body = await back.text();
assert.equal(back.status, 200, body);
// The hub exchanged the code and holds the App for add-project's one collection: the page shows none of it.
for (const secret of [APP_SECRET, WEBHOOK_SECRET, code]) assert.ok(!body.includes(secret), 'nothing secret in the page');
const replay = await open(callback, ownerSession);
assert.equal(replay.status, 410, 'the state works once');
console.log(`the hub took GitHub's redirect from @${owner} once; a replay was refused`);

// 4. The install link: GitHub's install page for that App, with the repo picked for the project preselected.
const install = await ask(2);
assert.equal(install.kind, 'approve_link');
assert.equal(install.url, `${gh}/apps/${manifest.name}/installations/new/permissions?suggested_target_id=501&repository_ids[]=777`);
assert.match(install.detail, /Only select repositories/);
console.log(`the install link preselects the repo: ${install.url}`);
