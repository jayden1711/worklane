// The GitHub App for a project, made through GitHub's manifest flow: the owner opens a page that posts the
// manifest to GitHub, approves it there, and GitHub sends the browser back here with a one-time code, which
// is exchanged for the App's id, slug and private key. The page and the callback are served on loopback only,
// by a server that lives for this one exchange (GitHub's flow needs a form POST, so no plain link can start it).
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BRAND } from '../brand.js';

/**
 * Exactly the permissions scripts/setup/app-permissions.mjs checks for: REQUIRED and EXPECTED, nothing more.
 * Never workflows, administration or actions: write (REFUSED there). A test checks this against that script.
 */
export const APP_PERMISSIONS = {
  metadata: 'read',
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  checks: 'read',
  actions: 'read',
} as const;

export interface AppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: false };
  redirect_url: string;
  public: false;
  default_permissions: typeof APP_PERMISSIONS;
  default_events: [];
}

/** An App name GitHub accepts (at most 34 characters), from the project's repo or, shared, its owner. */
export function appName(repo: string, shared: boolean): string {
  const [owner, name] = repo.split('/') as [string, string];
  const base = `${BRAND.cli}-${(shared ? owner : name).toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
  return base.slice(0, 34).replace(/-+$/, '');
}

/** The manifest: private, no webhook (its URL is required but inactive), no events, the permissions above. */
export function appManifest(o: { repo: string; shared: boolean; redirectUrl: string }): AppManifest {
  return {
    name: appName(o.repo, o.shared),
    url: `https://github.com/${o.shared ? o.repo.split('/')[0] : o.repo}`,
    hook_attributes: { url: 'https://example.invalid/no-webhook', active: false },
    redirect_url: o.redirectUrl,
    public: false,
    default_permissions: APP_PERMISSIONS,
    default_events: [],
  };
}

/** Where the manifest is posted: the user's or the organization's App settings. */
export function manifestTarget(owner: string, ownerType: 'User' | 'Organization', state: string, web = 'https://github.com'): string {
  const base = ownerType === 'Organization' ? `${web}/organizations/${encodeURIComponent(owner)}/settings/apps/new` : `${web}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The page that posts the manifest to GitHub (one button, so nothing happens without the owner). */
export function manifestPage(manifest: AppManifest, target: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Create the GitHub App</title>
<body style="font:15px system-ui;max-width:640px;margin:48px auto;padding:0 16px">
<h1 style="font-size:20px">Create ${esc(manifest.name)} on GitHub</h1>
<p>${esc(BRAND.name)} needs a GitHub App for this project, with these permissions only:</p>
<ul>${Object.entries(manifest.default_permissions).map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`).join('')}</ul>
<p>No webhook, no Workflows, no Administration. GitHub shows the App before creating it; afterwards it sends you back here.</p>
<form method="post" action="${esc(target)}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"><button type="submit" style="font:inherit;padding:8px 16px">Continue to GitHub</button></form>
</body>`;
}

export interface ManifestServer {
  /** The page to open (loopback). */
  url: string;
  /** Where GitHub sends the browser back. */
  redirectUrl: string;
  /** The code GitHub sent back, once it has. */
  code: Promise<string>;
  close(): Promise<void>;
}

/**
 * Serve the manifest page and its callback on 127.0.0.1, for one exchange. The paths carry a random secret, and
 * the callback must carry the state the page posted, so another local page can't feed it a code.
 */
export async function startManifestServer(o: { repo: string; shared: boolean; owner: string; ownerType: 'User' | 'Organization'; port?: number; web?: string }): Promise<ManifestServer> {
  const secret = randomBytes(16).toString('hex');
  const state = randomBytes(16).toString('hex');
  let resolve!: (c: string) => void;
  const code = new Promise<string>((r) => (resolve = r));
  let page = '';
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && u.pathname === `/manifest/${secret}`) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; form-action https://github.com; style-src 'unsafe-inline'" });
      return res.end(page);
    }
    if (req.method === 'GET' && u.pathname === `/callback/${secret}`) {
      const c = u.searchParams.get('code') ?? '';
      if (u.searchParams.get('state') !== state || !/^[A-Za-z0-9_-]{1,100}$/.test(c)) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        return res.end('this is not the reply to the App this setup asked for');
      }
      resolve(c);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><p style="font:15px system-ui;margin:48px">GitHub created the App. You can close this tab; setup continues.</p>');
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const redirectUrl = `http://127.0.0.1:${port}/callback/${secret}`;
  page = manifestPage(appManifest({ repo: o.repo, shared: o.shared, redirectUrl }), manifestTarget(o.owner, o.ownerType, state, o.web));
  return { url: `http://127.0.0.1:${port}/manifest/${secret}`, redirectUrl, code, close: () => new Promise((r) => server.close(() => r())) };
}

/** GitHub's install page for the App, preselecting the one repo when its ids are known. */
export function installUrl(slug: string, ids?: { ownerId: number; repoId: number }, web = 'https://github.com'): string {
  const base = `${web}/apps/${encodeURIComponent(slug)}/installations/new`;
  return ids ? `${base}/permissions?suggested_target_id=${ids.ownerId}&repository_ids[]=${ids.repoId}` : base;
}
