// The coordinator's browser checks (Track B), for verify(): which flows run (src/browser/gate.ts), each run and
// judged (src/browser/check.ts), recorded as checks with kind 'browser', and the PR's BROWSER CHECKS section.
//
// A flow the issue asks for is a check like any other: unavailable (no app, no browser) fails the attempt, as
// verify() fails anything that isn't a pass. A flow run only because the change touched ui_paths is held to its
// result too, except that with no browser on the machine it is listed and skipped: a project's UI changes don't
// all stop because one machine lacks Chrome, and the PR says so.
//
// Each flow is first run at the base commit the change is measured against (a worktree of its own, the app
// started there), so only console errors and failed requests the change adds count against it. A baseline that
// can't be had (the app won't start at base) is said in the evidence, and the flow is judged with none: every
// error counts, never a silent pass. Baselines are cached per (base, flow), so a retry doesn't rerun them.
import { join } from 'node:path';
import { findChrome } from '../browser/cdp.js';
import { runBrowserCheck } from '../browser/check.js';
import { browserEvidenceLines } from '../browser/evidence.js';
import { askedFlows, browserGate } from '../browser/gate.js';
import { runFlow } from '../browser/run.js';
import { BRAND } from '../brand.js';
import { createWorktreeAsync, removeWorktree } from '../worktrees.js';
/**
 * Baselines at `base`: the worktree is opened on the first flow not already cached, and removed by close().
 * `cache` outlives the call (the coordinator keeps it), so a retry of the same task reuses its baselines.
 */
export function baselineSource(o) {
    const run = o.run ?? runFlow;
    let tree = null;
    return {
        base: o.base,
        async run(flow) {
            const key = `${o.base}:${flow}`;
            const cached = o.cache.get(key);
            if (cached)
                return cached;
            tree ??= o.open().catch((e) => ({ error: `the base worktree couldn't be made: ${e.message.split('\n')[0]}` }));
            const t = await tree;
            let r;
            if ('error' in t)
                r = { unavailable: t.error };
            else {
                try {
                    const ev = await run({ app: o.app, flow, cwd: t.path, outDir: join(o.outDir, flow), chrome: o.chrome, ...(o.runAs ? { runAs: { user: o.runAs.user, home: o.runAs.home } } : {}) });
                    r = 'skipped' in ev ? { unavailable: ev.skipped } : { evidence: ev };
                }
                catch (e) {
                    const setup = t.setupErrors.length ? ` (its setup failed: ${t.setupErrors.join('; ').slice(0, 300)})` : '';
                    r = { unavailable: `the app couldn't be run at base${setup}: ${e.message.split('\n')[0].slice(0, 300)}` };
                }
            }
            o.cache.set(key, r);
            // A few tasks' worth: the oldest go first.
            while (o.cache.size > 50)
                o.cache.delete(o.cache.keys().next().value);
            return r;
        },
        async close() {
            if (!tree)
                return null;
            try {
                await tree;
                o.remove();
                return null;
            }
            catch (e) {
                return `the base worktree wasn't removed: ${e.message.split('\n')[0]}`;
            }
        },
    };
}
/** Baselines from a worktree of the project at `base` (named `name`, set up like any task's), always removed. */
export function worktreeBaseline(o) {
    return baselineSource({
        ...o,
        open: () => createWorktreeAsync(o.wt, o.name, `${BRAND.cli}/${o.name}`, o.base),
        remove: () => {
            if (!removeWorktree(o.wt, o.name))
                throw new Error(`${o.name} is still on disk`);
        },
    });
}
/** The change proposed at `head`: its base and files. None for a head no change was proposed at (the base itself). */
export function changeAt(events, head) {
    const p = events.filter((e) => e.type === 'change.proposed').map((e) => e.payload).filter((c) => c.head === head).at(-1);
    return p ? { base: p.base, files: p.files } : null;
}
export async function browserChecks(o) {
    const asked = askedFlows(o.doneWhen);
    const gate = browserGate({ app: o.app, changed: o.changed, asked });
    const run = o.run ?? runBrowserCheck;
    // No browser: no baseline either (the flows themselves are unavailable), and no base worktree made for nothing.
    const chrome = o.chrome === undefined ? findChrome(process.env.CHROME) : o.chrome;
    const source = o.app && chrome && gate.flows.length ? (o.baseline?.(chrome) ?? null) : null;
    const results = [];
    const notes = [];
    try {
        for (const flow of gate.flows) {
            const b = source && o.app?.flows[flow] ? await source.run(flow) : null;
            const before = b && 'evidence' in b ? b.evidence : null;
            const result = await run({
                item: { browser: flow },
                app: o.app,
                cwd: o.cwd,
                outDir: join(o.outDir, flow),
                baseline: before,
                chrome,
                ...(o.runAs ? { runAs: { user: o.runAs.user, home: o.runAs.home } } : {}),
            });
            if (b && 'unavailable' in b && result.evidence)
                result.tail += `\nnote: no baseline at base ${source.base.slice(0, 12)} (${b.unavailable}), so every error was counted as new`;
            results.push({ flow, result, before, ...(b && 'unavailable' in b ? { baselineUnavailable: b.unavailable } : {}) });
        }
    }
    finally {
        const note = await source?.close();
        if (note)
            notes.push(note);
    }
    const checks = results
        .filter(({ flow, result }) => asked.includes(flow) || result.status !== 'unavailable')
        .map(({ result: r }) => ({ check: r.check, status: r.status, kind: 'browser', exitCode: null, tail: r.tail, ...(r.evidence ? { duration_ms: r.evidence.durationMs } : {}) }));
    const lines = o.app || asked.length
        ? [...browserEvidenceLines({ gate, runs: results.map(({ result, before, baselineUnavailable }) => ({ result, before, ...(source ? { base: source.base } : {}), ...(baselineUnavailable && result.evidence ? { baselineUnavailable } : {}) })) }), ...notes.map((n) => `- note: ${n}`)]
        : [];
    return { gate, checks, lines };
}
//# sourceMappingURL=browser.js.map