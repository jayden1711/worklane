// docs/previews.md, "Screenshots".
// WHY: GitHub has no API for a comment's own attachments; a draft release's assets are outside git (no tag, no commit).
export const PREVIEW_RELEASE_TAG = 'pr-previews';
export function githubPreviews(repo, token, f = fetch, api = 'https://api.github.com', uploads = 'https://uploads.github.com') {
    const headers = async (extra = {}) => ({ authorization: `Bearer ${await token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...extra });
    const req = async (method, url, body) => {
        const res = await f(url, { method, headers: await headers(body === undefined ? {} : { 'content-type': 'application/json' }), ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
        if (!res.ok)
            throw new Error(`GitHub answered ${res.status} to ${method} ${new URL(url).pathname}`);
        return (res.status === 204 ? null : await res.json());
    };
    let release = null;
    const releaseId = async () => {
        if (release !== null)
            return release;
        const list = await req('GET', `${api}/repos/${repo}/releases?per_page=100`);
        const found = list.find((r) => r.draft && r.tag_name === PREVIEW_RELEASE_TAG);
        release = found
            ? found.id
            : (await req('POST', `${api}/repos/${repo}/releases`, { tag_name: PREVIEW_RELEASE_TAG, name: 'PR preview screenshots', body: 'Screenshots of PR previews, deleted with each preview. A draft: never published, no tag.', draft: true })).id;
        return release;
    };
    return {
        openPrs: async () => {
            try {
                const out = [];
                for (let page = 1; page <= 5; page++) {
                    const list = await req('GET', `${api}/repos/${repo}/pulls?state=open&per_page=100&page=${page}`);
                    for (const p of list)
                        out.push({ number: p.number, head: p.head.sha, sameRepo: (p.head.repo?.full_name ?? '').toLowerCase() === repo.toLowerCase() });
                    if (list.length < 100)
                        break;
                }
                return out;
            }
            catch {
                return null;
            }
        },
        comment: async (pr, id, body) => {
            if (id !== null)
                return (await req('PATCH', `${api}/repos/${repo}/issues/comments/${id}`, { body })).id;
            return (await req('POST', `${api}/repos/${repo}/issues/${pr}/comments`, { body })).id;
        },
        attach: async (name, png) => {
            const id = await releaseId();
            const res = await f(`${uploads}/repos/${repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', headers: await headers({ 'content-type': 'image/png' }), body: new Uint8Array(png), signal: AbortSignal.timeout(60_000) });
            if (!res.ok)
                throw new Error(`GitHub answered ${res.status} to the screenshot upload`);
            return String((await res.json()).browser_download_url);
        },
        detach: async (prefix) => {
            const id = await releaseId();
            // WHY: listed in full before any delete, so a deletion never shifts a page under the listing.
            const mine = [];
            for (let page = 1; page <= 10; page++) {
                const list = await req('GET', `${api}/repos/${repo}/releases/${id}/assets?per_page=100&page=${page}`);
                for (const a of list)
                    if (a.name.startsWith(prefix))
                        mine.push(a.id);
                if (list.length < 100)
                    break;
            }
            for (const a of mine)
                await req('DELETE', `${api}/repos/${repo}/releases/assets/${a}`);
        },
    };
}
//# sourceMappingURL=github.js.map