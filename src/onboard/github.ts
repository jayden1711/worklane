// GitHub, as onboarding uses it. Two identities, kept apart:
// - The project's App (its key, before it's handed to the coordinator): exchange the manifest code, find and
//   check the installation, and, with an installation token, create the labels and open the setup PR.
// - The owner's own gh login, for the one thing the App may never do: the main-branch ruleset (it needs
//   Administration, which the App is refused). Only after the owner approves it.
import { execFileSync } from 'node:child_process';
import { appJwt } from '../github-app.js';
import { GitHubBacklog } from '../backlog/github.js';

type Fetch = typeof fetch;

export interface AppCreated {
  id: number;
  slug: string;
  pem: string;
  owner: string;
  htmlUrl: string;
}

export interface MintedToken {
  token: string;
  permissions: Record<string, string>;
}

/** What onboarding asks of GitHub with the App's credentials (a fake in tests). */
export interface OnboardGitHub {
  ownerType(owner: string): Promise<'User' | 'Organization'>;
  convertManifest(code: string): Promise<AppCreated>;
  appSlug(appId: number, pem: string): Promise<string>;
  /** The App's installation on the repo, or null while it isn't installed there. */
  installationFor(appId: number, pem: string, repo: string): Promise<number | null>;
  /** An installation token; `onlyRepo`: limited to that repo. */
  mintToken(appId: number, pem: string, installationId: number, onlyRepo?: string): Promise<MintedToken>;
  reposOf(token: string): Promise<string[]>;
  defaultBranch(token: string, repo: string): Promise<string>;
  ensureLabels(token: string, repo: string, labels: { name: string; color: string; description: string }[]): Promise<string[]>;
  /** The open PR from head into base, if any. */
  findPr(token: string, repo: string, head: string): Promise<{ number: number; url: string } | null>;
  openPr(token: string, repo: string, o: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  /** The URL git pushes and fetches the repo at. */
  gitUrl(repo: string): string;
}

const H = (auth?: string) => ({ accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(auth ? { authorization: `Bearer ${auth}` } : {}) });

export function restGitHub(fetchImpl: Fetch = fetch, api = 'https://api.github.com', web = 'https://github.com'): OnboardGitHub {
  const req = async <T>(method: string, path: string, auth?: string, body?: unknown): Promise<{ status: number; json: T }> => {
    const res = await fetchImpl(`${api}${path}`, { method, headers: { ...H(auth), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json: json as T };
  };
  const must = <T>(r: { status: number; json: T }, what: string): T => {
    if (r.status >= 300) throw new Error(`GitHub ${r.status} ${what}: ${typeof r.json === 'object' && r.json && 'message' in r.json ? String((r.json as { message: unknown }).message) : ''}`.trim());
    return r.json;
  };
  return {
    async ownerType(owner) {
      const r = await req<{ type?: string }>('GET', `/users/${encodeURIComponent(owner)}`);
      return r.status < 300 && r.json?.type === 'Organization' ? 'Organization' : 'User';
    },
    async convertManifest(code) {
      const j = must(await req<{ id: number; slug: string; pem: string; owner?: { login?: string }; html_url: string }>('POST', `/app-manifests/${encodeURIComponent(code)}/conversions`), 'exchanging the manifest code');
      if (!Number.isInteger(j.id) || typeof j.slug !== 'string' || typeof j.pem !== 'string') throw new Error('GitHub returned no App id, slug or key for the manifest');
      return { id: j.id, slug: j.slug, pem: j.pem, owner: j.owner?.login ?? '', htmlUrl: j.html_url };
    },
    async appSlug(appId, pem) {
      return must(await req<{ slug: string }>('GET', '/app', appJwt(appId, pem)), `reading App ${appId} with its key`).slug;
    },
    async installationFor(appId, pem, repo) {
      const r = await req<{ id: number }>('GET', `/repos/${repo}/installation`, appJwt(appId, pem));
      if (r.status === 404) return null;
      return must(r, `finding the App's installation on ${repo}`).id;
    },
    async mintToken(appId, pem, installationId, onlyRepo) {
      const j = must(await req<{ token: string; permissions: Record<string, string> }>('POST', `/app/installations/${installationId}/access_tokens`, appJwt(appId, pem), onlyRepo ? { repositories: [onlyRepo.split('/')[1]] } : undefined), `minting a token for installation ${installationId}`);
      return { token: j.token, permissions: j.permissions ?? {} };
    },
    async reposOf(token) {
      return must(await req<{ repositories: { full_name: string }[] }>('GET', '/installation/repositories?per_page=100', token), 'listing what the installation reaches').repositories.map((r) => r.full_name);
    },
    async defaultBranch(token, repo) {
      return must(await req<{ default_branch: string }>('GET', `/repos/${repo}`, token), `reading ${repo}`).default_branch;
    },
    ensureLabels(token, repo, labels) {
      return new GitHubBacklog(repo, () => token, fetchImpl, api).ensureLabels(labels);
    },
    async findPr(token, repo, head) {
      const owner = repo.split('/')[0];
      const prs = must(await req<{ number: number; html_url: string }[]>('GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`, token), 'listing open PRs');
      return prs[0] ? { number: prs[0].number, url: prs[0].html_url } : null;
    },
    async openPr(token, repo, o) {
      const p = must(await req<{ number: number; html_url: string }>('POST', `/repos/${repo}/pulls`, token, o), 'opening the setup PR');
      return { number: p.number, url: p.html_url };
    },
    gitUrl: (repo) => `${web}/${repo}.git`,
  };
}

/** The ruleset proposed for the default branch: the detected checks required, and up to date before merging. */
export function proposedRuleset(checks: string[], name: string) {
  return {
    name,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: false, required_status_checks: checks.map((context) => ({ context })) } },
      { type: 'non_fast_forward' },
      { type: 'deletion' },
    ],
  };
}
export type Ruleset = ReturnType<typeof proposedRuleset>;

/** The owner's own GitHub login, for the ruleset and two read-only lookups (a fake in tests). */
export interface OwnerGitHub {
  login(): Promise<string | null>;
  /** The ids GitHub's install page takes to preselect the repo; null when the owner's login can't see them. */
  repoIds(repo: string): Promise<{ ownerId: number; repoId: number } | null>;
  /** Create the ruleset, or update the one of the same name: idempotent. */
  applyRuleset(repo: string, ruleset: Ruleset): Promise<{ id: number; created: boolean }>;
}

/** The owner's `gh` (their own login on this machine). Nothing here is ever given to an agent or the coordinator. */
export function ghOwner(run: (args: string[], input?: string) => string = (args, input) => execFileSync('gh', args, { encoding: 'utf8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) })): OwnerGitHub {
  return {
    async login() {
      try {
        return run(['api', 'user', '--jq', '.login']).trim() || null;
      } catch {
        return null;
      }
    },
    async repoIds(repo) {
      try {
        const j = JSON.parse(run(['api', `repos/${repo}`])) as { id: number; owner: { id: number } };
        return { ownerId: j.owner.id, repoId: j.id };
      } catch {
        return null;
      }
    },
    async applyRuleset(repo, ruleset) {
      const existing = (JSON.parse(run(['api', `repos/${repo}/rulesets`])) as { id: number; name: string }[]).find((r) => r.name === ruleset.name);
      const out = JSON.parse(run(['api', '--method', existing ? 'PUT' : 'POST', existing ? `repos/${repo}/rulesets/${existing.id}` : `repos/${repo}/rulesets`, '--input', '-'], JSON.stringify(ruleset))) as { id: number };
      return { id: out.id, created: !existing };
    },
  };
}
