// GitHub Apps made through GitHub's manifest flow, so nobody copies an App id, a key or a client secret by hand:
// the agent App an instance's coordinator works as, and the dashboard's sign-in App. credentials.sh stays the
// manual fallback for both.
//
// Three parts, because three different users are involved:
// - The hub (dashboard-hub.ts, run as the viewer user) is where GitHub sends the browser back, since that is the
//   one address the owner's browser reaches. It keeps each pending flow in memory: a state token (single use,
//   10 minutes), the manifest, and who may finish it. Its start page posts the manifest to GitHub (GitHub's flow
//   takes a form POST, so no plain link can start it); its callback takes GitHub's one-time code, but only from a
//   signed-in machine owner, and exchanges it (POST /app-manifests/{code}/conversions). The App's key or client
//   secret is then held in memory until the flow's runner collects it, once, over the loopback break-glass port.
// - The runner (runAppManifest; `<cli> app-manifest`, as root, from the setup scripts) registers the flow with the
//   hub, waits, and writes what GitHub returned straight to its 0400 file for the one user it belongs to, at
//   credentials.sh's paths. For the agent App it then asks for the install on exactly the instance's repo, finds
//   the installation, runs the same check as credentials.sh (scripts/setup/app-permissions.mjs, as the coordinator
//   user) and refuses an installation that reaches any other repo; only then does it write credentials.yaml.
// - The setup console (startAppManifest): the same runner, with each GitHub click an approve_link ask.
//
// Key material never reaches a log, an event, an ask, a response other than the runner's single collection, or an
// error message: errors name the step and GitHub's status, never a body.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { BRAND } from '../brand.js';
import type { Asks } from '../console/asks.js';
import { CALLBACK_PATH } from '../dashboard-auth.js';
import { appJwt } from '../github-app.js';
import { asUser, currentUser, homeOf, installSecretFor, replaceFileAtomically } from '../os/index.js';

type Fetch = typeof fetch;
export type AppKind = 'agent' | 'signin';

/**
 * The agent App's permissions, exactly: what scripts/setup/app-permissions.mjs requires and expects, with checks
 * write. Never workflows, administration or actions write (that script refuses each).
 */
export const AGENT_APP_PERMISSIONS: Readonly<Record<string, 'read' | 'write'>> = Object.freeze({
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  checks: 'write',
  actions: 'read',
  metadata: 'read',
});

export const MANIFEST_START_PATH = '/setup/app-manifest/start';
export const MANIFEST_CALLBACK_PATH = '/setup/app-manifest/callback';
/** How long a flow's state token lives: from registering to GitHub's redirect back. */
export const MANIFEST_STATE_MS = 10 * 60_000;
/** An instance name, as add-project takes it. */
export const INSTANCE_NAME = /^[a-z][a-z0-9-]{0,20}$/;
const REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
/** GitHub's longest App name. */
const MAX_APP_NAME = 34;
/** The machine's user names, as scripts/setup/lib.sh makes them: wl-<name> (coordinator), wl-dash (the hub). */
export const coordinatorUser = (instance: string) => `wl-${instance}`;
export const VIEWER_USER = 'wl-dash';

const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } as const;
const defaultApi = () => (process.env[`${BRAND.envPrefix}_GITHUB_API`] ?? 'https://api.github.com').replace(/\/+$/, '');
const defaultWeb = () => (process.env[`${BRAND.envPrefix}_GITHUB_WEB`] ?? 'https://github.com').replace(/\/+$/, '');

export function validRepo(repo: unknown): repo is string {
  return typeof repo === 'string' && REPO.test(repo) && !repo.includes('..');
}

/** `<name>-<cli>` for the agent App, `<name>-<cli>-signin` for the sign-in App, within GitHub's 34 characters. */
export function appBaseName(instance: string, kind: AppKind): string {
  return `${instance}-${BRAND.cli}${kind === 'signin' ? '-signin' : ''}`.slice(0, MAX_APP_NAME).replace(/-+$/, '');
}

/**
 * The base name, or, when GitHub already has an App by that name, the base with a short random suffix. Only public
 * Apps are visible here; GitHub's own form still refuses a taken private name, and lets the owner edit it there.
 */
export async function availableAppName(base: string, o: { api?: string; fetch?: Fetch; suffix?: () => string } = {}): Promise<string> {
  const f = o.fetch ?? fetch;
  const api = (o.api ?? defaultApi()).replace(/\/+$/, '');
  const suffix = o.suffix ?? (() => randomBytes(2).toString('hex'));
  for (let i = 0; i < 5; i++) {
    const name = i === 0 ? base : `${base.slice(0, MAX_APP_NAME - 5).replace(/-+$/, '')}-${suffix()}`;
    const r = await f(`${api}/apps/${encodeURIComponent(name)}`, { headers: HEADERS });
    if (r.status !== 200) return name; // 404: free (anything else: let GitHub's form say)
  }
  throw new Error(`GitHub has Apps named ${base} and every suffix tried; pick another instance name`);
}

export interface AppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: false };
  redirect_url: string;
  callback_urls?: string[];
  public: false;
  default_permissions: Record<string, string>;
  default_events: [];
}

/**
 * The manifest: private, no webhook (inactive), no events. The agent App gets exactly AGENT_APP_PERMISSIONS; the
 * sign-in App none, and the hub's sign-in callback.
 */
export function appManifest(o: { kind: AppKind; name: string; repo: string; publicUrl: string }): AppManifest {
  const origin = new URL(o.publicUrl).origin;
  return {
    name: o.name,
    url: o.kind === 'agent' ? `https://github.com/${o.repo}` : origin,
    hook_attributes: { url: `${origin}/no-webhook`, active: false },
    redirect_url: `${origin}${MANIFEST_CALLBACK_PATH}`,
    ...(o.kind === 'signin' ? { callback_urls: [`${origin}${CALLBACK_PATH}`] } : {}),
    public: false,
    default_permissions: o.kind === 'agent' ? { ...AGENT_APP_PERMISSIONS } : {},
    default_events: [],
  };
}

/** Where the manifest is posted: the user's App settings, or the organization's. */
export function manifestTarget(owner: string, ownerType: 'User' | 'Organization', state: string, web = defaultWeb()): string {
  const base = ownerType === 'Organization' ? `${web}/organizations/${encodeURIComponent(owner)}/settings/apps/new` : `${web}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The page that posts the manifest to GitHub: one button, so nothing happens without the owner. */
export function manifestPage(m: AppManifest, target: string): string {
  const perms = Object.entries(m.default_permissions);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Create the GitHub App</title>
<body style="font:15px system-ui;max-width:640px;margin:48px auto;padding:0 16px">
<h1 style="font-size:20px">Create ${esc(m.name)} on GitHub</h1>
${perms.length ? `<p>${esc(BRAND.name)} needs a GitHub App with these permissions only:</p><ul>${perms.map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`).join('')}</ul><p>No webhook, no Workflows, no Administration, no Actions write.</p>` : `<p>The dashboard's sign-in App: no permissions and no webhook; it only names who signs in.</p>`}
<p>GitHub shows the App before creating it, then sends you back here.</p>
<form method="post" action="${esc(target)}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(m))}"><button type="submit" style="font:inherit;padding:8px 16px">Continue to GitHub</button></form>
</body>`;
}

/** GitHub's install page for the App, preselecting the one repo when its ids are known. */
export function installUrl(slug: string, ids: { ownerId: number; repoId: number | null } | null, web = defaultWeb()): string {
  const base = `${web}/apps/${encodeURIComponent(slug)}/installations/new`;
  if (!ids) return base;
  return `${base}/permissions?suggested_target_id=${ids.ownerId}${ids.repoId ? `&repository_ids[]=${ids.repoId}` : ''}`;
}

/** What GitHub's conversion returns that the runner needs. pem and clientSecret are secrets. */
export interface ConvertedApp {
  id: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  pem: string;
  owner: string;
  htmlUrl: string;
}

/** Exchange the manifest code (one use, an hour) for the App's credentials. Errors carry the status only. */
export async function convertManifest(code: string, o: { api?: string; fetch?: Fetch } = {}): Promise<ConvertedApp> {
  const api = (o.api ?? defaultApi()).replace(/\/+$/, '');
  const r = await (o.fetch ?? fetch)(`${api}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: HEADERS });
  if (r.status !== 201 && r.status !== 200) throw new Error(`GitHub ${r.status} converting the manifest code`);
  let j: { id?: unknown; slug?: unknown; client_id?: unknown; client_secret?: unknown; pem?: unknown; owner?: { login?: unknown }; html_url?: unknown };
  try {
    j = (await r.json()) as typeof j;
  } catch {
    throw new Error('GitHub returned an unreadable conversion');
  }
  if (typeof j.id !== 'number' || typeof j.slug !== 'string' || !/^[a-z0-9-]+$/.test(j.slug) || typeof j.pem !== 'string' || typeof j.client_id !== 'string' || typeof j.client_secret !== 'string') {
    throw new Error('GitHub returned no App id, slug, key or client secret for the manifest');
  }
  return { id: j.id, slug: j.slug, clientId: j.client_id, clientSecret: j.client_secret, pem: j.pem, owner: typeof j.owner?.login === 'string' ? j.owner.login : '', htmlUrl: typeof j.html_url === 'string' ? j.html_url : '' };
}

// ---------------------------------------------------------------------------------------------------------------
// The hub's half: pending flows, the start page, the callback, and the runner's collection.

export type FlowStatus = 'pending' | 'converting' | 'done' | 'delivered' | 'refused' | 'expired';

interface Flow {
  id: string;
  kind: AppKind;
  instance: string;
  repo: string;
  name: string;
  manifest: AppManifest;
  target: string;
  stateHash: string;
  expiresAt: number;
  status: FlowStatus;
  by: string | null;
  error: string | null;
  app: ConvertedApp | null;
  waiters: Set<() => void>;
}

/** What the runner collects: the App, once, when done; otherwise where the flow is. */
export type FlowView = { status: 'done'; by: string; app: ConvertedApp } | { status: Exclude<FlowStatus, 'done'>; error: string | null };

export interface Registered {
  id: string;
  name: string;
  /** The page to open (the approve link): it posts the manifest to GitHub. */
  startUrl: string;
  expiresAt: string;
}

export interface ManifestFlowsOptions {
  /** Whether a GitHub login is a machine owner (src/machine-owners.ts). */
  isMachineOwner: (login: string) => boolean;
  /** Whether the hub has sign-in: without it, only a sign-in App's flow can finish (on its state alone). */
  signIn: boolean;
  /** The hub's https origin as browsers reach it, when it knows it (sign-in set up). */
  publicUrl: string | null;
  api?: string;
  web?: string;
  fetch?: Fetch;
  now?: () => number;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class ManifestFlows {
  private readonly flows = new Map<string, Flow>();
  private readonly now: () => number;
  constructor(private readonly o: ManifestFlowsOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Register a flow for the runner (break-glass only): its manifest, a fresh state token, and the page to open. */
  async register(input: { kind?: unknown; instance?: unknown; repo?: unknown; publicUrl?: unknown }): Promise<Registered> {
    const kind = input.kind === 'signin' ? 'signin' : input.kind === 'agent' ? 'agent' : null;
    if (!kind) throw new FlowError('kind must be agent or signin');
    if (typeof input.instance !== 'string' || !INSTANCE_NAME.test(input.instance)) throw new FlowError(`instance must match ${INSTANCE_NAME}`);
    if (!validRepo(input.repo)) throw new FlowError('repo must be owner/name');
    const publicUrl = this.o.publicUrl ?? (typeof input.publicUrl === 'string' ? input.publicUrl : '');
    let origin: URL;
    try {
      origin = new URL(publicUrl);
    } catch {
      throw new FlowError("the hub's public URL is unknown: pass --public-url https://<machine>.<tailnet>.ts.net");
    }
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search) throw new FlowError("the public URL must be the hub's https origin");
    const api = this.o.api ?? defaultApi();
    const f = this.o.fetch ?? fetch;
    const owner = input.repo.split('/')[0]!;
    const u = await f(`${api}/users/${encodeURIComponent(owner)}`, { headers: HEADERS });
    const ownerType = u.ok && ((await u.json()) as { type?: string }).type === 'Organization' ? 'Organization' : 'User';
    const name = await availableAppName(appBaseName(input.instance, kind), { api, fetch: f });
    const state = randomBytes(32).toString('base64url');
    const id = `amf-${randomBytes(12).toString('hex')}`;
    const t = this.now();
    for (const [k, x] of this.flows) if (x.expiresAt + MANIFEST_STATE_MS < t) this.flows.delete(k);
    if (this.flows.size > 100) throw new FlowError('too many App setups pending on this hub');
    const manifest = appManifest({ kind, name, repo: input.repo, publicUrl: origin.origin });
    this.flows.set(id, { id, kind, instance: input.instance, repo: input.repo, name, manifest, target: manifestTarget(owner, ownerType, state, this.o.web ?? defaultWeb()), stateHash: sha(state), expiresAt: t + MANIFEST_STATE_MS, status: 'pending', by: null, error: null, app: null, waiters: new Set() });
    return { id, name, startUrl: `${origin.origin}${MANIFEST_START_PATH}/${id}`, expiresAt: new Date(t + MANIFEST_STATE_MS).toISOString() };
  }

  /** Whether `login` may open or finish this flow; null when they may, otherwise why not (and the status to answer with). */
  private refusal(f: Flow, login: string | null): { status: 401 | 403; why: string } | null {
    if (this.o.signIn) {
      if (!login) return { status: 401, why: 'sign in first (/auth/login): only a machine owner may set up a GitHub App here' };
      if (!this.o.isMachineOwner(login)) return { status: 403, why: `@${login} is not a machine owner of this machine; only a machine owner may set up a GitHub App here` };
      return null;
    }
    // No sign-in yet: the sign-in App itself, started by root on this machine, finishes on its state alone.
    return f.kind === 'signin' ? null : { status: 403, why: "sign-in isn't set up on this hub: an agent App needs a machine owner signed in; set up the sign-in App first" };
  }

  private expire(f: Flow): void {
    if (f.status === 'pending' && this.now() >= f.expiresAt) this.settle(f, 'expired', `the App setup expired (${MANIFEST_STATE_MS / 60_000} minutes); start it again`);
  }

  private settle(f: Flow, status: FlowStatus, error: string | null = null): void {
    f.status = status;
    f.error = error;
    for (const w of f.waiters) w();
    f.waiters.clear();
  }

  /** The start page for a flow (GET, the approve link). */
  page(id: string, login: string | null): { status: number; type: 'html' | 'text'; body: string; formAction?: string } {
    const f = this.flows.get(id);
    if (!f) return { status: 404, type: 'text', body: 'no such App setup on this hub (it may have expired); start it again' };
    this.expire(f);
    if (f.status !== 'pending') return { status: 410, type: 'text', body: `this App setup is ${f.status}; start it again` };
    const no = this.refusal(f, login);
    if (no) return { status: no.status, type: 'text', body: no.why };
    return { status: 200, type: 'html', body: manifestPage(f.manifest, f.target), formAction: new URL(f.target).origin };
  }

  /**
   * GitHub's redirect back: the state must name a pending flow (used up on the first try, even a refused one), not
   * yet expired, and the person must be a machine owner. Then the code is exchanged, and the App held for the runner.
   */
  async callback(state: string | null, code: string | null, login: string | null): Promise<{ status: number; body: string }> {
    if (!state) return { status: 400, body: 'GitHub sent no state; start the App setup again' };
    const h = sha(state);
    const f = [...this.flows.values()].find((x) => timingSafeEqual(Buffer.from(x.stateHash), Buffer.from(h)));
    if (!f) return { status: 400, body: 'this App setup did not start here, or has expired; start it again' };
    this.expire(f);
    if (f.status !== 'pending') return { status: 410, body: `this App setup is already ${f.status}: a state is used once; start it again` };
    const no = this.refusal(f, login);
    if (no) {
      // Not signed in: nothing is used up, so the owner can sign in and come back. Anyone else uses the state up.
      if (no.status === 403) this.settle(f, 'refused', no.why);
      return { status: no.status, body: no.why };
    }
    if (!code || !/^[A-Za-z0-9_-]{1,200}$/.test(code)) {
      this.settle(f, 'refused', 'GitHub sent no usable code');
      return { status: 400, body: 'GitHub sent no usable code; start the App setup again' };
    }
    f.status = 'converting';
    f.by = login ?? '';
    try {
      f.app = await convertManifest(code, { ...(this.o.api ? { api: this.o.api } : {}), ...(this.o.fetch ? { fetch: this.o.fetch } : {}) });
    } catch (e) {
      this.settle(f, 'refused', (e as Error).message);
      return { status: 502, body: `${(e as Error).message}; start the App setup again` };
    }
    this.settle(f, 'done');
    return { status: 200, body: `GitHub created the App ${f.app.slug}. You can close this tab: setup continues where it started${f.kind === 'agent' ? ', and asks you to install the App on ' + f.repo + ' next' : ''}.` };
  }

  /** The runner's view of a flow, waiting up to `ms` for a change. The App is handed over once, then forgotten. */
  async wait(id: string, ms: number): Promise<FlowView | null> {
    const f = this.flows.get(id);
    if (!f) return null;
    this.expire(f);
    if (f.status === 'pending' || f.status === 'converting') {
      await new Promise<void>((done) => {
        const until = Math.min(ms, Math.max(0, f.expiresAt - this.now()) + 50);
        const t = setTimeout(() => (f.waiters.delete(wake), done()), until);
        const wake = () => (clearTimeout(t), done());
        f.waiters.add(wake);
      });
      this.expire(f);
    }
    if (f.status === 'done' && f.app) {
      const app = f.app;
      f.app = null;
      f.status = 'delivered';
      return { status: 'done', by: f.by ?? '', app };
    }
    return { status: f.status as Exclude<FlowStatus, 'done'>, error: f.error };
  }
}

export class FlowError extends Error {}

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** The hub's public routes (the start page and GitHub's redirect back); false when the path isn't one. */
export async function handleManifestPublic(req: IncomingMessage, res: ServerResponse, url: URL, flows: ManifestFlows, login: string | null): Promise<boolean> {
  if (!url.pathname.startsWith('/setup/app-manifest/')) return false;
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end('GET only');
    return true;
  }
  const text = (status: number, body: string) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end(body);
  };
  const start = url.pathname.match(/^\/setup\/app-manifest\/start\/(amf-[0-9a-f]{24})$/);
  if (start) {
    const p = flows.page(start[1]!, login);
    if (p.type === 'text') return text(p.status, p.body), true;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${p.formAction}` });
    res.end(p.body);
    return true;
  }
  if (url.pathname === MANIFEST_CALLBACK_PATH) {
    const r = await flows.callback(url.searchParams.get('state'), url.searchParams.get('code'), login);
    return text(r.status, r.body), true;
  }
  text(404, 'not found');
  return true;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8_000) throw new FlowError('body too large');
    chunks.push(c as Buffer);
  }
  try {
    const v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    throw new FlowError('the body must be JSON');
  }
}

/**
 * The runner's routes, on the break-glass port only (after its token check):
 *   POST /api/setup/app-manifest          {kind, instance, repo, publicUrl?}: register a flow
 *   GET  /api/setup/app-manifest/<id>     ?wait=<ms>: where it is; the App, once, when done
 */
export async function handleManifestBreakGlass(req: IncomingMessage, res: ServerResponse, url: URL, flows: ManifestFlows): Promise<boolean> {
  if (url.pathname !== '/api/setup/app-manifest' && !url.pathname.startsWith('/api/setup/app-manifest/')) return false;
  try {
    if (url.pathname === '/api/setup/app-manifest' && req.method === 'POST') return sendJson(res, 201, await flows.register(await readJsonBody(req))), true;
    const m = url.pathname.match(/^\/api\/setup\/app-manifest\/(amf-[0-9a-f]{24})$/);
    if (m && req.method === 'GET') {
      const v = await flows.wait(m[1]!, Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), 30_000));
      return v ? sendJson(res, 200, v) : sendJson(res, 404, { error: 'no such App setup on this hub' }), true;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, e instanceof FlowError ? 400 : 500, { error: String((e as Error).message).slice(0, 300) });
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// The runner's half.

/** How the runner reaches the hub's pending flows. */
export interface HubLink {
  register(o: { kind: AppKind; instance: string; repo: string; publicUrl?: string }): Promise<Registered>;
  wait(id: string, ms: number): Promise<FlowView>;
}

/** The hub over its break-glass port (loopback, with the hub's token, which root can read). */
export function breakGlassHub(o: { base: string; token: string; fetch?: Fetch }): HubLink {
  const f = o.fetch ?? fetch;
  const base = o.base.replace(/\/+$/, '');
  const h = { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' };
  const body = async (r: Response, what: string) => {
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`the hub refused ${what} (${r.status}${typeof j.error === 'string' ? `: ${j.error}` : ''})`);
    return j;
  };
  return {
    async register(x) {
      return (await body(await f(`${base}/api/setup/app-manifest`, { method: 'POST', headers: h, body: JSON.stringify(x) }), 'the App setup')) as unknown as Registered;
    },
    async wait(id, ms) {
      return (await body(await f(`${base}/api/setup/app-manifest/${id}?wait=${ms}`, { headers: h }), 'reading the App setup')) as unknown as FlowView;
    },
  };
}

/** An approve link for the owner, as the console or the terminal shows it. */
export interface ApproveLink {
  title: string;
  detail: string;
  url: string;
}

export interface RunDeps {
  hub: HubLink;
  api?: string;
  web?: string;
  fetch?: Fetch;
  /** The users secrets go to; wl-<name> and wl-dash by default. */
  users?: { coordinator?: string; viewer?: string };
  homeOf?: (user: string) => string | null;
  installSecret?: (user: string, dir: string, name: string, value: string) => string;
  /** The same check as credentials.sh: app-permissions.mjs, as the coordinator user. */
  verify?: (o: { user: string; key: string; appId: number; installationId: number; repo: string }) => Promise<{ ok: boolean; output: string }>;
  /** Show an approve link; returns its ask id when it is an ask. */
  onAsk?: (a: ApproveLink) => string | undefined;
  /** The step behind an ask is done (by whom). */
  onDone?: (askId: string, by: string) => void;
  /** The step behind an ask failed or timed out. */
  onFail?: (askId: string, why: string) => void;
  log?: (line: string) => void;
  /** How long to wait for each GitHub click; 15 minutes by default. */
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
}

export type RunResult =
  | { ok: true; kind: AppKind; appId: number; slug: string; clientId: string; by: string; installationId?: number; keyPath?: string; credentials?: string | null; secretPath?: string }
  | { ok: false; step: string; error: string };

/** credentials.sh's paths, on top of a user's home. */
export const agentKeyDir = (home: string, instance: string) => join(home, '.config', `${instance}-app`);
export const signInDir = (home: string) => join(home, '.config', 'dashboard-signin');
export const credentialsFile = (home: string, instance: string) => join(home, '.local', 'state', BRAND.cli, 'instances', instance, 'credentials.yaml');
export const APP_PERMISSIONS_SCRIPT = fileURLToPath(new URL('../../../scripts/setup/app-permissions.mjs', import.meta.url));

/** Run app-permissions.mjs as `user` (sudo when that isn't this user), against the same API base. Its output names no secret. */
export function verifyWithScript(api = defaultApi(), script = APP_PERMISSIONS_SCRIPT): NonNullable<RunDeps['verify']> {
  return (o) =>
    new Promise((done) => {
      const env = { [`${BRAND.envPrefix}_GITHUB_API`]: api };
      const args = ['--input-type=module', '-', o.key, String(o.appId), String(o.installationId), o.repo];
      const [file, argv] = o.user === currentUser() ? [process.execPath, args] : asUser(o.user, process.execPath, args, env);
      const p = spawn(file, argv, { cwd: '/', env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      p.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')));
      p.on('error', (e) => done({ ok: false, output: e.message }));
      p.on('close', (code) => done({ ok: code === 0, output: out.trim() }));
      p.stdin.end(readFileSync(script));
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The whole manifest flow for one App, headless: register with the hub, show the approve link, collect the App,
 * store its secret for its one user, and, for the agent App, the install link, the installation, the check and
 * credentials.yaml. Stops at the first failure, naming the step.
 */
export async function runAppManifest(o: { instance: string; repo: string; kind: AppKind; publicUrl?: string }, d: RunDeps): Promise<RunResult> {
  const log = d.log ?? (() => {});
  const api = (d.api ?? defaultApi()).replace(/\/+$/, '');
  const web = (d.web ?? defaultWeb()).replace(/\/+$/, '');
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const timeout = d.timeoutMs ?? 15 * 60_000;
  const pollMs = d.pollMs ?? 5_000;
  const home = d.homeOf ?? homeOf;
  const install = d.installSecret ?? installSecretFor;
  const fail = (step: string, error: string, askId?: string): RunResult => {
    if (askId) d.onFail?.(askId, error);
    return { ok: false, step, error };
  };
  if (!INSTANCE_NAME.test(o.instance)) return fail('arguments', `the name must match ${INSTANCE_NAME}`);
  if (!validRepo(o.repo)) return fail('arguments', 'the repo must be owner/name');
  const user = o.kind === 'agent' ? (d.users?.coordinator ?? coordinatorUser(o.instance)) : (d.users?.viewer ?? VIEWER_USER);
  const userHome = home(user);
  if (!userHome) return fail('arguments', `no user ${user} on this machine (${o.kind === 'agent' ? 'run instance.sh first' : 'run dashboards.sh first'})`);

  // 1. The manifest, through the hub.
  let reg: Registered;
  try {
    reg = await d.hub.register({ kind: o.kind, instance: o.instance, repo: o.repo, ...(o.publicUrl ? { publicUrl: o.publicUrl } : {}) });
  } catch (e) {
    return fail('create the App', (e as Error).message);
  }
  const what = o.kind === 'agent' ? `the GitHub App ${o.instance}'s coordinator works as, for ${o.repo} only` : "the dashboard's sign-in App (no permissions)";
  const createAsk = d.onAsk?.({ title: `Create ${reg.name} on GitHub`, detail: `Open the link as a machine owner, signed in to the dashboard, and approve ${what} on GitHub. The link works once, until ${reg.expiresAt}.`, url: reg.startUrl });
  log(`open, as a machine owner signed in to the dashboard: ${reg.startUrl}  (until ${reg.expiresAt})`);
  let app: ConvertedApp | null = null;
  let by = '';
  const until = now() + timeout;
  while (!app) {
    let v: FlowView;
    try {
      v = await d.hub.wait(reg.id, Math.min(25_000, Math.max(0, until - now())));
    } catch (e) {
      return fail('create the App', (e as Error).message, createAsk);
    }
    if (v.status === 'done') {
      app = v.app;
      by = v.by;
    } else if (v.status === 'pending' || v.status === 'converting') {
      if (now() >= until) return fail('create the App', `nobody approved the App on GitHub within ${Math.round(timeout / 60_000)} minutes`, createAsk);
    } else return fail('create the App', v.error ?? `the App setup is ${v.status}`, createAsk);
  }
  if (createAsk) d.onDone?.(createAsk, by);
  log(`GitHub created App ${app.slug} (id ${app.id})${by ? `, approved by @${by}` : ''}`);

  // 2. Its secret, for its one user only.
  if (o.kind === 'signin') {
    const dir = signInDir(userHome);
    let secretPath: string;
    try {
      secretPath = install(user, dir, 'client-secret', app.clientSecret);
      if (!existsSync(join(dir, 'session-secret'))) {
        install(user, dir, 'session-secret', randomBytes(32).toString('hex'));
        log(`generated ${join(dir, 'session-secret')}`);
      }
    } catch (e) {
      return fail('store the client secret', String((e as Error).message).split('\n')[0]!);
    }
    log(`installed ${secretPath} (0400, ${user} only); the App's key is not kept: sign-in never uses it`);
    log(`then: dashboards.sh --client-id ${app.clientId} --public-url ${new URL(reg.startUrl).origin} <name>...`);
    return { ok: true, kind: 'signin', appId: app.id, slug: app.slug, clientId: app.clientId, by, secretPath };
  }
  let keyPath: string;
  try {
    keyPath = install(user, agentKeyDir(userHome, o.instance), 'private-key.pem', app.pem);
  } catch (e) {
    return fail('store the App key', String((e as Error).message).split('\n')[0]!);
  }
  log(`installed the App's private key for ${user} only (${keyPath}, 0400)`);

  // 3. The install, on exactly the instance's repo.
  const [owner] = o.repo.split('/') as [string, string];
  let ids: { ownerId: number; repoId: number | null } | null = null;
  try {
    const u = await f(`${api}/users/${encodeURIComponent(owner)}`, { headers: HEADERS });
    const r = await f(`${api}/repos/${o.repo}`, { headers: HEADERS });
    const ownerId = u.ok ? ((await u.json()) as { id?: unknown }).id : null;
    const repoId = r.ok ? ((await r.json()) as { id?: unknown }).id : null;
    if (typeof ownerId === 'number') ids = { ownerId, repoId: typeof repoId === 'number' ? repoId : null };
  } catch {
    // the plain install page works too
  }
  const link = installUrl(app.slug, ids, web);
  const installAsk = d.onAsk?.({ title: `Install ${app.slug} on ${o.repo} only`, detail: `On GitHub, choose "Only select repositories" and pick ${o.repo}, nothing else. An installation that reaches any other repo is refused.`, url: link });
  log(`install it on ${o.repo} only ("Only select repositories"): ${link}`);
  let installationId: number | null = null;
  const installUntil = now() + timeout;
  while (installationId === null) {
    try {
      const r = await f(`${api}/repos/${o.repo}/installation`, { headers: { ...HEADERS, authorization: `Bearer ${appJwt(app.id, app.pem, now())}` } });
      if (r.ok) {
        const id = ((await r.json()) as { id?: unknown }).id;
        if (typeof id === 'number') installationId = id;
      } else if (r.status !== 404) return fail('install the App', `GitHub ${r.status} finding the App's installation on ${o.repo}`, installAsk);
    } catch (e) {
      return fail('install the App', `couldn't reach GitHub: ${(e as Error).message}`, installAsk);
    }
    if (installationId === null) {
      if (now() >= installUntil) return fail('install the App', `the App wasn't installed on ${o.repo} within ${Math.round(timeout / 60_000)} minutes`, installAsk);
      await sleep(pollMs);
    }
  }
  log(`found installation ${installationId}`);

  // 4. The same check as credentials.sh, as the coordinator user.
  const v = await (d.verify ?? verifyWithScript(api))({ user, key: keyPath, appId: app.id, installationId, repo: o.repo });
  for (const line of v.output.split('\n').filter(Boolean)) log(`  ${line}`);
  if (!v.ok) return fail('verify', `${v.output.split('\n').filter((l) => l.startsWith('FAILED')).join('; ') || 'the check failed'}; nothing was written to credentials.yaml. Fix the installation on GitHub, then: credentials.sh ${o.instance} github-app ${app.id} ${installationId} ${keyPath} ${o.repo}`, installAsk);
  if (installAsk) d.onDone?.(installAsk, by);

  // 5. credentials.yaml, as credentials.sh writes it, keeping its other settings.
  const creds = credentialsFile(userHome, o.instance);
  const github = { kind: 'app', app_id: app.id, installation_id: installationId, key_path: keyPath };
  if (existsSync(creds)) {
    try {
      const doc = parseDocument(readFileSync(creds, 'utf8'));
      if (doc.errors.length) throw new Error(`${creds} isn't valid YAML`);
      if (!doc.has('version')) doc.set('version', 1);
      doc.set('github', github);
      replaceFileAtomically(creds, String(doc), 0o600);
    } catch (e) {
      return fail('write credentials.yaml', String((e as Error).message).split('\n')[0]!);
    }
    log(`wrote ${creds} (github: the App)`);
  } else log(`no instance home yet (run instance.sh first); then set in credentials.yaml: github: { kind: app, app_id: ${app.id}, installation_id: ${installationId}, key_path: ${keyPath} }`);
  return { ok: true, kind: 'agent', appId: app.id, slug: app.slug, clientId: app.clientId, by, installationId, keyPath, credentials: existsSync(creds) ? creds : null };
}

/**
 * The same flow from the setup console: each GitHub click is an approve_link ask in `asks`, answered (approved, by
 * the machine owner who did it) once GitHub confirms it, or withdrawn when the step fails. Returns the first ask's id
 * as soon as it exists, and the whole run.
 */
export async function startAppManifest(o: { instance: string; repo: string; kind: AppKind; publicUrl: string }, d: RunDeps & { asks: Asks }): Promise<{ askId: string; done: Promise<RunResult> }> {
  let first!: (id: string) => void;
  let none!: (e: Error) => void;
  const firstAsk = new Promise<string>((res, rej) => ((first = res), (none = rej)));
  const done = runAppManifest(o, {
    ...d,
    onAsk: (a) => {
      const id = d.asks.create({ kind: 'approve_link', instance: o.instance, ...a }, 'setup').id;
      first(id);
      return id;
    },
    onDone: (id, by) => {
      try {
        d.asks.answer(id, { by: by || 'setup', role: 'owner', answer: 'approved' });
      } catch {
        // already answered or withdrawn in the console
      }
    },
    onFail: (id, why) => {
      try {
        d.asks.cancel(id, 'setup', why);
      } catch {
        // already answered or withdrawn
      }
    },
  });
  void done.then((r) => none(new Error(r.ok ? 'the App setup asked nothing' : `${r.step}: ${r.error}`)));
  return { askId: await firstAsk, done };
}
