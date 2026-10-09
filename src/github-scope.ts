// A coordinator's GitHub credential must reach its instance's repos and
// nothing else: a GitHub App installation or a fine-grained token limited
// to those repos. A personal login (gh auth login, OAuth) or a classic
// token reaches every repo its user can, so it is refused. The token
// itself is never printed or logged.

export type TokenKind = 'app-installation' | 'fine-grained' | 'personal' | 'unknown';

/** GitHub's token prefixes: ghs_ App installation, github_pat_ fine-grained, gho_/ghp_/ghu_ personal (OAuth, classic, App user). */
export function tokenKind(token: string): TokenKind {
  if (token.startsWith('ghs_')) return 'app-installation';
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (/^gh[opu]_/.test(token)) return 'personal';
  return 'unknown';
}

type Fetch = typeof fetch;

async function listRepos(token: string, path: string, pick: (j: unknown) => { full_name: string }[], fetchImpl: Fetch, api: string): Promise<string[]> {
  const out: string[] = [];
  let url: string | null = `${api}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  for (let page = 0; url && page < 20; page++) {
    const res: Response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
    if (!res.ok) throw new Error(`GitHub ${res.status} listing the token's repositories`);
    out.push(...pick(await res.json()).map((r) => r.full_name.toLowerCase()));
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
  }
  return out;
}

/**
 * Check that a token sees exactly the instance's repos: all of them, and no
 * others. Refusals name the problem and counts, never other repos' names.
 */
export async function checkRepoScope(token: string, allowed: string[], fetchImpl: Fetch = fetch, api = 'https://api.github.com'): Promise<{ ok: true; kind: TokenKind } | { ok: false; why: string }> {
  const kind = tokenKind(token);
  const want = new Set(allowed.map((r) => r.toLowerCase()));
  const advice = `use a fine-grained token limited to ${allowed.join(', ')}, or a GitHub App installed on only ${allowed.length > 1 ? 'those repos' : 'that repo'}`;
  if (kind === 'personal') return { ok: false, why: `this is a personal login or classic token, which reaches every repo its user can; ${advice}` };
  if (kind === 'unknown') return { ok: false, why: `unrecognized token type; ${advice}` };
  let seen: string[];
  try {
    seen =
      kind === 'app-installation'
        ? await listRepos(token, '/installation/repositories', (j) => (j as { repositories: { full_name: string }[] }).repositories, fetchImpl, api)
        : await listRepos(token, '/user/repos?affiliation=owner,collaborator,organization_member', (j) => j as { full_name: string }[], fetchImpl, api);
  } catch (e) {
    return { ok: false, why: `could not check what the token can reach (${(e as Error).message}); not starting` };
  }
  const extra = [...new Set(seen)].filter((r) => !want.has(r));
  const missing = [...want].filter((r) => !seen.includes(r));
  if (extra.length) return { ok: false, why: `the token can reach ${extra.length} repo(s) outside this instance; ${advice}` };
  if (missing.length) return { ok: false, why: `the token cannot reach ${missing.join(', ')}` };
  return { ok: true, kind };
}
