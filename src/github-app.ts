// GitHub App authentication for an instance's coordinator. The App's
// private key stays in the coordinator user's home (0400); from it the
// coordinator signs a short-lived JWT and exchanges it for an installation
// token limited to the instance's repos. Tokens last an hour, are cached in
// the instance's private state, and never reach agents.
import { createSign } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Fetch = typeof fetch;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** An App JWT (RS256), valid for 9 minutes, backdated a minute for clock skew. */
export function appJwt(appId: number, privateKeyPem: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 600, iss: String(appId) }));
  const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64url(sig)}`;
}

export interface AppCredentials {
  appId: number;
  installationId: number;
  keyPath: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

/** Mint an installation token limited to `repos` (owner/name; all must share the installation's owner). */
export async function mintInstallationToken(c: AppCredentials, repos: string[], fetchImpl: Fetch = fetch, api = 'https://api.github.com', now = Date.now()): Promise<InstallationToken> {
  const jwt = appJwt(c.appId, readFileSync(c.keyPath, 'utf8'), now);
  const res = await fetchImpl(`${api}/app/installations/${c.installationId}/access_tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    body: JSON.stringify({ repositories: repos.map((r) => r.split('/')[1]) }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} minting an installation token for App ${c.appId}`);
  const j = (await res.json()) as { token: string; expires_at: string };
  return { token: j.token, expiresAt: j.expires_at };
}

/**
 * A token source for one instance: reuses the cached token while it has more
 * than 10 minutes left, otherwise mints and caches a new one (0600, in the
 * instance's state, which only the coordinator user can read).
 */
export function installationTokens(c: AppCredentials, repos: string[], stateDir: string, fetchImpl: Fetch = fetch, api = 'https://api.github.com') {
  const cache = join(stateDir, 'github-app-token.json');
  return async (now = Date.now()): Promise<string> => {
    try {
      const t = JSON.parse(readFileSync(cache, 'utf8')) as InstallationToken;
      if (Date.parse(t.expiresAt) - now > 10 * 60_000) return t.token;
    } catch {
      // no usable cached token
    }
    const t = await mintInstallationToken(c, repos, fetchImpl, api, now);
    const tmp = `${cache}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
    renameSync(tmp, cache);
    return t.token;
  };
}
