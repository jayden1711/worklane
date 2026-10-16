// A coordinator's GitHub credential must reach its instance's repos and
// nothing else: a GitHub App installation or a fine-grained token limited
// to those repos. A personal login (gh auth login, OAuth) or a classic
// token reaches every repo its user can, so it is refused. The token
// itself is never printed or logged.
/** GitHub's token prefixes: ghs_ App installation, github_pat_ fine-grained, gho_/ghp_/ghu_ personal (OAuth, classic, App user). */
export function tokenKind(token) {
    if (token.startsWith('ghs_'))
        return 'app-installation';
    if (token.startsWith('github_pat_'))
        return 'fine-grained';
    if (/^gh[opu]_/.test(token))
        return 'personal';
    return 'unknown';
}
/** GitHub sends a token's expiry with every response (`GitHub-Authentication-Token-Expiration`, e.g. "2026-11-07 00:00:00 UTC"). */
export function parseExpiry(header) {
    if (!header)
        return null;
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/.exec(header.trim());
    if (!m)
        return null;
    const tz = m[3] === 'UTC' ? 'Z' : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
    const t = Date.parse(`${m[1]}T${m[2]}${tz}`);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
}
async function listRepos(token, path, pick, fetchImpl, api, seenExpiry) {
    const out = [];
    let url = `${api}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    for (let page = 0; url && page < 20; page++) {
        const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
        if (!res.ok)
            throw new Error(`GitHub ${res.status} listing the token's repositories`);
        seenExpiry.at ??= parseExpiry(res.headers.get('github-authentication-token-expiration'));
        out.push(...pick(await res.json()).map((r) => r.full_name.toLowerCase()));
        url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
    }
    return out;
}
/**
 * Check that a token sees exactly the instance's repos: all of them, and no
 * others. Refusals name the problem and counts, never other repos' names.
 */
export async function checkRepoScope(token, allowed, fetchImpl = fetch, api = 'https://api.github.com') {
    const kind = tokenKind(token);
    const want = new Set(allowed.map((r) => r.toLowerCase()));
    const advice = `use a fine-grained token limited to ${allowed.join(', ')}, or a GitHub App installed on only ${allowed.length > 1 ? 'those repos' : 'that repo'}`;
    if (kind === 'personal')
        return { ok: false, why: `this is a personal login or classic token, which reaches every repo its user can; ${advice}` };
    if (kind === 'unknown')
        return { ok: false, why: `unrecognized token type; ${advice}` };
    let seen;
    const expiry = { at: null };
    try {
        seen =
            kind === 'app-installation'
                ? await listRepos(token, '/installation/repositories', (j) => j.repositories, fetchImpl, api, expiry)
                : await listRepos(token, '/user/repos?affiliation=owner,collaborator,organization_member', (j) => j, fetchImpl, api, expiry);
    }
    catch (e) {
        return { ok: false, why: `could not check what the token can reach (${e.message}); not starting` };
    }
    const extra = [...new Set(seen)].filter((r) => !want.has(r));
    const missing = [...want].filter((r) => !seen.includes(r));
    if (extra.length)
        return { ok: false, why: `the token can reach ${extra.length} repo(s) outside this instance; ${advice}` };
    if (missing.length)
        return { ok: false, why: `the token cannot reach ${missing.join(', ')}` };
    // A token whose user is an admin on the repo could bypass branch protection: a machine account with Write only.
    let login = null;
    if (kind === 'fine-grained') {
        try {
            const get = async (path) => {
                const res = await fetchImpl(`${api}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
                if (!res.ok)
                    throw new Error(`GitHub ${res.status} reading ${path.split('?')[0]}`);
                return (await res.json());
            };
            login = (await get('/user')).login;
            for (const repo of allowed) {
                const r = await get(`/repos/${repo}`);
                if (r.permissions?.admin)
                    return { ok: false, why: `the token's user (${login}) is an admin on ${repo}, and admins can bypass branch protection; use a dedicated machine account with Write access only` };
            }
        }
        catch (e) {
            return { ok: false, why: `could not check the token's user and permissions (${e.message}); not starting` };
        }
    }
    return { ok: true, kind, expiresAt: expiry.at, login };
}
/** Days until a token expires (rounded down), or null if it has no expiry. */
export const daysLeft = (expiresAt, now = new Date()) => (expiresAt ? Math.floor((Date.parse(expiresAt) - now.getTime()) / 86_400_000) : null);
//# sourceMappingURL=github-scope.js.map