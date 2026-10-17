// WHY: nothing updates on its own; the owner is told when there is something newer to review. Once a day, at most, the
// instance's dashboard asks each approved plugin's GitHub repository for its newest commit (on that plugin's path) and
// npm for each pinned server's latest version, read-only and unauthenticated (public sources). An update is offered
// as "Fetch the update": a new preview, reviewed and approved like the first one. It never installs anything.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GITHUB_API } from '../github-hosts.js';
import { treeFiles } from './tree.js';
import { previewDir, storeDir } from './approval.js';
import { diffSnapshots } from '../mcp/snapshot.js';
export const UPDATES_FILE = 'plugin-updates.json';
export const UPDATE_EVERY_MS = 24 * 3_600_000;
const NPM_REGISTRY = 'https://registry.npmjs.org';
const defaultFetch = async (url) => {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'plugin-update-check' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok)
        throw new Error(`${url}: ${r.status}`);
    return r.json();
};
/** owner/repo of a github.com git URL, or null (other hosts are checked by hand). */
export const githubRepoOfUrl = (url) => url.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/)?.[1] ?? null;
/** What is newer than each approved entry's pin. Errors for one entry skip it, never the others. */
export async function checkUpdates(entries, fetchJson = defaultFetch) {
    const out = [];
    for (const e of entries) {
        try {
            if (e.record.kind === 'plugin') {
                const r = e.record;
                const repo = githubRepoOfUrl(r.source.url);
                if (!repo)
                    continue;
                const commits = (await fetchJson(`${GITHUB_API}/repos/${repo}/commits?per_page=1${r.source.path ? `&path=${encodeURIComponent(r.source.path)}` : ''}`));
                const sha = commits?.[0]?.sha;
                if (typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) && sha !== r.source.sha)
                    out.push({ id: r.id, kind: 'plugin', from: r.source.sha, to: sha, fetch: { kind: 'plugin', id: r.id, url: r.source.url, sha, ...(r.source.path ? { path: r.source.path } : {}) } });
            }
            else {
                const r = e.record;
                if (r.runtime.type !== 'npm')
                    continue;
                const doc = (await fetchJson(`${NPM_REGISTRY}/${r.runtime.package.replace('/', '%2f')}`));
                const latest = doc?.['dist-tags']?.latest;
                if (typeof latest === 'string' && /^\d+\.\d+\.\d+$/.test(latest) && latest !== r.runtime.version)
                    out.push({ id: r.id, kind: 'npm', from: r.runtime.version, to: latest, fetch: { kind: 'npm', id: r.id, package: r.runtime.package, version: latest } });
            }
        }
        catch {
            // unreachable or rate-limited: asked again next time
        }
    }
    return out;
}
/**
 * The cached updates, refreshed in the background when older than a day. Returns what is cached now (the page shows
 * it; the next load shows the refreshed list).
 */
export function cachedUpdates(stateDir, entries, o = {}) {
    const file = join(stateDir, UPDATES_FILE);
    let cached = { at: null, updates: [] };
    try {
        if (existsSync(file))
            cached = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        // re-checked below
    }
    const now = o.now ?? Date.now();
    if (!cached.at || now - Date.parse(cached.at) > UPDATE_EVERY_MS) {
        void checkUpdates(entries, o.fetchJson).then((updates) => {
            try {
                mkdirSync(dirname(file), { recursive: true });
                writeFileSync(file, JSON.stringify({ at: new Date(now).toISOString(), updates }) + '\n', { mode: 0o600 });
            }
            catch {
                // not cached: asked again next time
            }
        });
    }
    // Only what is still newer than the approved pin (an update approved since is no longer offered).
    const pins = new Map(entries.map((e) => [e.record.id, e.record.kind === 'plugin' ? e.record.source.sha : e.record.runtime.type === 'npm' ? e.record.runtime.version : '']));
    return { at: cached.at, updates: cached.updates.filter((u) => pins.get(u.id) === u.from) };
}
/** How a preview differs from the approved entry with its id: files for a plugin, tools for an MCP server. */
export function previewDiff(instance, p, approved) {
    if (!approved)
        return null;
    if (p.kind === 'plugin' && approved.record.kind === 'plugin') {
        // Both approved copies as they run (after the transform): the store's and the preview's.
        let old;
        let now;
        try {
            old = new Map(treeFiles(storeDir(instance, approved.record.id, approved.record.tree)).map((f) => [f.path, f.sha256]));
            now = new Map(treeFiles(join(previewDir(instance, p.id), 'tree')).map((f) => [f.path, f.sha256]));
        }
        catch {
            return null;
        }
        return {
            added: [...now.keys()].filter((k) => !old.has(k)).sort(),
            removed: [...old.keys()].filter((k) => !now.has(k)).sort(),
            changed: [...now.keys()].filter((k) => old.has(k) && old.get(k) !== now.get(k)).sort(),
        };
    }
    if (p.kind === 'mcp' && approved.record.kind === 'mcp') {
        const a = approved.record.snapshot;
        return { added: [], removed: [], changed: [], tools: a && p.snapshot ? diffSnapshots(a, p.snapshot) : undefined };
    }
    return null;
}
//# sourceMappingURL=updates.js.map