// Hotspots: files that two tasks running at once would both change and then
// conflict on (lockfiles, registries, shared test helpers). Before a task
// starts, the coordinator estimates the files it will touch from the issue
// alone (no agent run, no checkout scan beyond a file list), and never runs
// two tasks at once that touch the same hotspot. The second one waits; other
// ready work takes the free slot meanwhile. Everything else runs in parallel.
import { globToRegExp } from './guardrails/glob.js';
/** Used when a repo lists none: lockfiles, registries and changelogs, shared test helpers. */
export const DEFAULT_HOTSPOTS = [
    // lockfiles
    '**/package-lock.json',
    '**/npm-shrinkwrap.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/poetry.lock',
    '**/Pipfile.lock',
    '**/uv.lock',
    '**/Cargo.lock',
    '**/go.sum',
    '**/Gemfile.lock',
    '**/composer.lock',
    // registries: one shared list every addition edits
    '**/registry.*',
    '**/*-registry.*',
    '**/*_registry.*',
    'CHANGELOG.md',
    // shared test helpers
    '**/conftest.py',
    '**/test/helpers.*',
    '**/tests/helpers.*',
    '**/test-utils.*',
    '**/test_utils.*',
    '**/testutils.*',
    '**/setupTests.*',
];
/** Lockfile globs: a task that adds or upgrades a dependency touches them even if the issue never names them. */
const LOCKFILES = DEFAULT_HOTSPOTS.slice(0, 11);
const DEPENDENCY_WORK = /\b(add|adds|adding|install|bump|bumps|upgrade|upgrades|update|updates|pin|unpin|remove|drop)\b[^.\n]{0,60}\b(dependenc(y|ies)|package|packages|library|libraries|crate|gem|module)\b|\b(npm|pnpm|yarn) (install|add|i)\b|\bpip install\b|\bpoetry add\b|\bcargo add\b|\bgo get\b/i;
const matchers = new Map();
const re = (g) => {
    let r = matchers.get(g);
    if (!r)
        matchers.set(g, (r = globToRegExp(g)));
    return r;
};
/** The hotspots among `files`, by the repo's globs (or the defaults). */
export function hotspotsIn(files, globs = DEFAULT_HOTSPOTS) {
    return [...new Set(files.filter((f) => globs.some((g) => re(g).test(f))))].sort();
}
/**
 * The repo files an issue is likely to touch, from its own text: paths it names (in backticks or bare,
 * matched against the repo's file list, by full path or by unique file name), plus the repo's lockfiles
 * when the issue is about dependencies. A cheap guess, never an agent run; an empty answer means "unknown".
 */
export function estimateFiles(text, repo, globs = DEFAULT_HOTSPOTS) {
    const ix = Array.isArray(repo) ? fileIndex(repo, globs) : repo;
    const out = new Set();
    // Path-like tokens: anything with a dot-extension or a slash, in or out of backticks.
    for (const m of text.matchAll(/[A-Za-z0-9_.@\-/]*[A-Za-z0-9_\-]\.[A-Za-z0-9]{1,8}\b|[A-Za-z0-9_.@\-]+\/[A-Za-z0-9_.@\-/]+/g)) {
        const tok = m[0].replace(/^\.\//, '').replace(/[.,:;)]+$/, '');
        if (ix.known.has(tok))
            out.add(tok);
        else if (!tok.includes('/') && ix.byName.get(tok)?.length === 1)
            out.add(ix.byName.get(tok)[0]);
        // A directory named: the hotspots under it (only those matter here).
        else if (tok.includes('/'))
            for (const f of ix.hot)
                if (f.startsWith(`${tok.replace(/\/$/, '')}/`))
                    out.add(f);
    }
    if (DEPENDENCY_WORK.test(text))
        for (const f of ix.lockfiles)
            out.add(f);
    return [...out].sort();
}
export function fileIndex(repoFiles, globs = DEFAULT_HOTSPOTS) {
    const byName = new Map();
    for (const f of repoFiles) {
        const name = f.slice(f.lastIndexOf('/') + 1);
        const list = byName.get(name);
        if (list)
            list.push(f);
        else
            byName.set(name, [f]);
    }
    return { known: new Set(repoFiles), byName, hot: hotspotsIn(repoFiles, globs), lockfiles: hotspotsIn(repoFiles, LOCKFILES) };
}
/**
 * Which ready tasks to start now, in order, given what's running and how many slots are free: a task whose
 * hotspots overlap a running (or just-picked) task's is held, with who holds it and why, and the next ready
 * task that doesn't overlap takes the slot, so no slot sits idle while other work could run.
 */
export function pickDispatch(ready, running, freeSlots) {
    const busy = [...running];
    const start = [];
    const held = [];
    for (const c of ready) {
        if (start.length >= freeSlots)
            break;
        const clash = busy.find((r) => r.hotspots.some((h) => c.hotspots.includes(h)));
        if (clash) {
            held.push({ issue: c.issue, by: clash.issue, files: c.hotspots.filter((h) => clash.hotspots.includes(h)) });
            continue;
        }
        start.push(c.issue);
        busy.push(c);
    }
    return { start, held };
}
/** The line shown for a held task (dashboard, event). */
export function holdReason(h) {
    return `waits for #${h.by}: both change ${h.files.slice(0, 3).join(', ')}${h.files.length > 3 ? ` and ${h.files.length - 3} more` : ''}`;
}
//# sourceMappingURL=hotspots.js.map