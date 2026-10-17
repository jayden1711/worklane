// The Add project repo picker (wizard screen 5): the repos of a GitHub account that the agents' App can be installed
// on, for the setup console to list instead of a typed owner/repo. The App itself is made later, by add-project's
// manifest flow (src/setup/app-manifest.ts), and its install link preselects the repo picked here; the installation is
// then checked to reach that one repo only (scripts/setup/app-permissions.mjs).
//
// WHY no token: the dashboard holds no GitHub token that can list a person's repos. Sign-in revokes its token right
// after reading the login (src/dashboard-auth.ts), and an App's own token reaches only the repos it is installed on.
// So GitHub answers with public repos only, and the page says so: a private repo is typed as owner/name, and checked
// the same way. Asking for a broader token just to fill a list would be a worse trade.
import { GITHUB_API } from '../github-hosts.js';
/** A GitHub user or organization name. */
export const ACCOUNT = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;
const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
const defaultApi = () => GITHUB_API;
/** GitHub allows 60 unauthenticated requests an hour per address: a list is kept this long. */
export const REPO_LIST_TTL_MS = 5 * 60_000;
const PRIVATE_NOTE = "GitHub lists only public repos here (the dashboard keeps no GitHub token that could list private ones): type a private repo as owner/name; it's checked the same way.";
const cache = new Map();
/** Why the App couldn't do its work on a repo, or null when it can. */
function notInstallable(r) {
    if (r.disabled === true)
        return 'disabled on GitHub';
    if (r.archived === true)
        return 'archived: read-only, so the agents could never push to it';
    return null;
}
/**
 * The repos of `owner` (a user or an organization) to pick from, most recently pushed first, with the accounts to
 * switch to. `login` is the signed-in person, whose organizations are offered. Never throws: a GitHub error is the
 * view's `error`, and the page still takes a typed owner/name.
 */
export async function listInstallableRepos(o) {
    const api = (o.api ?? defaultApi()).replace(/\/+$/, '');
    const f = o.fetch ?? fetch;
    const now = (o.now ?? Date.now)();
    const owner = o.owner.trim();
    const login = o.login && ACCOUNT.test(o.login) ? o.login : null;
    const base = { owner, ownerType: null, accounts: login ? [login] : [], repos: [], note: PRIVATE_NOTE, error: null };
    // No account to start from (the break-glass has no GitHub login): the page asks for one.
    if (!owner)
        return base;
    if (!ACCOUNT.test(owner))
        return { ...base, error: 'not a GitHub account name' };
    const key = `${api}\n${owner.toLowerCase()}\n${login ?? ''}`;
    const hit = cache.get(key);
    if (hit && now - hit.at < REPO_LIST_TTL_MS)
        return hit.view;
    const get = async (path) => {
        const r = await f(`${api}${path}`, { headers: HEADERS });
        if (r.status === 404)
            return { status: 404, body: null };
        if (!r.ok)
            return { status: r.status, body: null };
        return { status: r.status, body: (await r.json().catch(() => null)) };
    };
    const failed = (status) => status === 403 || status === 429 ? "GitHub's limit for listing without a token is reached for now: type owner/name, or try again within the hour" : `GitHub answered ${status}: type owner/name`;
    let view;
    try {
        const accounts = new Set(base.accounts);
        if (login) {
            const orgs = await get(`/users/${encodeURIComponent(login)}/orgs?per_page=100`);
            if (Array.isArray(orgs.body))
                for (const x of orgs.body)
                    if (typeof x.login === 'string' && ACCOUNT.test(x.login))
                        accounts.add(x.login);
        }
        const u = await get(`/users/${encodeURIComponent(owner)}`);
        if (u.status === 404)
            return { ...base, accounts: [...accounts], error: `GitHub has no account ${owner}` };
        if (!u.body)
            return { ...base, accounts: [...accounts], error: failed(u.status) };
        const ownerType = u.body.type === 'Organization' ? 'Organization' : 'User';
        const path = ownerType === 'Organization' ? `/orgs/${encodeURIComponent(owner)}/repos?type=all&sort=pushed&per_page=100` : `/users/${encodeURIComponent(owner)}/repos?type=owner&sort=pushed&per_page=100`;
        const r = await get(path);
        if (!Array.isArray(r.body))
            return { ...base, ownerType, accounts: [...accounts], error: failed(r.status) };
        const repos = [];
        for (const x of r.body) {
            if (typeof x.full_name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(x.full_name))
                continue;
            const why = notInstallable(x);
            repos.push({ fullName: x.full_name, private: x.private === true, installable: !why, why, pushedAt: typeof x.pushed_at === 'string' ? x.pushed_at : null });
        }
        // Installable first, each part most recently pushed first (GitHub's order).
        repos.sort((a, b) => Number(b.installable) - Number(a.installable));
        accounts.add(owner);
        view = { owner, ownerType, accounts: [...accounts], repos, note: PRIVATE_NOTE, error: null };
    }
    catch (e) {
        return { ...base, error: `couldn't reach GitHub (${e.message.slice(0, 120)}): type owner/name` };
    }
    if (cache.size > 200)
        cache.clear();
    cache.set(key, { at: now, view });
    return view;
}
/** Forget the cached lists (tests). */
export function clearRepoListCache() {
    cache.clear();
}
//# sourceMappingURL=repo-picker.js.map