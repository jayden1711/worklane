// tests.yaml `test_run:`: how the coordinator runs a project's CI on the machine (docs/test-runs.md).
//
// Each tier is one command run in the run's own clean workspace, as the sandboxed test user. A fast tier runs on
// every PR; a full tier runs once per batch (PR mode), sharded across the machine's test-run slots when it says it
// can be. A tier that needs a database gets the run's own Postgres in DATABASE_URL. Caches are keyed by the hash
// of the files that pin what they hold (a lockfile), so a changed lockfile starts a new cache, never a stale one.
// Each tier posts one GitHub check; `checks` maps a tier to its check name.
import { z } from 'zod';
import { projectEnvProblem } from '../project-env.js';
import { selectMode } from './select.js';
import { NPM_CACHE_ENV } from './fetch.js';
import { SETUP_TIER } from './network.js';
const tierName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'lowercase letters, digits, _ or - (at most 40)');
const relPath = z
    .string()
    .min(1)
    .refine((p) => !p.startsWith('/') && !p.split(/[\\/]/).includes('..') && !/^[A-Za-z]:/.test(p), 'a path inside the repo (relative, no ..)');
/** The placeholders a tier command may use; anything else in braces is left as written. */
export const TIER_PLACEHOLDERS = ['{changed_files}', '{tests}', '{shard_index}', '{shard_total}', '{shard}', '{total}'];
/** Whether a command passes its shard's place: {shard_index} and {shard_total}, or the short {shard} and {total}. */
export function passesShard(command) {
    return (command.includes('{shard_index}') && command.includes('{shard_total}')) || (command.includes('{shard}') && command.includes('{total}'));
}
export const TestRunTier = z
    .strictObject({
    name: tierName,
    /**
     * Run under bash with pipefail in the run's workspace. `{changed_files}` is a file listing the change's paths,
     * one per line (for the project's own changed-plan command); `{tests}` (select: imports) the test files the
     * change can affect, shell-quoted, or nothing for the whole suite; `{shard_index}` (1-based) and `{shard_total}`,
     * or `{shard}` and `{total}`, are this shard's place in a sharded full run.
     */
    command: z.string().min(1),
    /** fast: every PR (and each PR's new head). full: once per batch of approved PRs. */
    kind: z.enum(['fast', 'full']),
    /** Gets the run's own Postgres (test_run.database) in DATABASE_URL. */
    database: z.boolean().default(false),
    /** A full tier that splits across shards with {shard_index}/{shard_total}; any other tier runs in the first shard only. */
    shardable: z.boolean().default(false),
    /**
     * Needs the directories tests.yaml checkout.sparse_exclude leaves out: a run with this tier checks the whole tree
     * out (every tier of that run shares its workspace).
     */
    full_checkout: z.boolean().default(false),
    /**
     * Asks for the GPU (docs/test-runs.md "GPU"). Only asks: the sandbox helper grants it only when root's own
     * /etc/<cli>/testrun-gpu.json lists this instance, and then for at most that file's max_minutes. Without it the
     * tier runs as any other, and its record and check say why.
     */
    gpu: z.boolean().default(false),
    /**
     * Asks for the network (docs/test-runs.md "Network"). Only asks: a run's commands have none (their own loopback
     * only) unless root's own /etc/<cli>/testrun-network.json lists this tier for this instance. Nothing in the repo
     * grants it. Without the grant the tier runs with no network, and its record and check say why.
     */
    network: z.boolean().default(false),
    timeout_s: z.number().int().min(30).max(6 * 3600).default(1800),
})
    .refine((t) => !t.shardable || t.kind === 'full', { message: 'only a full tier can be sharded', path: ['shardable'] })
    .refine((t) => !t.shardable || passesShard(t.command), {
    message: 'a shardable tier passes {shard_index} and {shard_total} (or {shard} and {total}) to its command',
    path: ['command'],
});
export const TestRunCache = z.strictObject({
    name: tierName,
    /** The variable the cache's directory is given in (e.g. npm_config_cache, PLAYWRIGHT_BROWSERS_PATH). */
    env: z.string().superRefine((k, ctx) => {
        const why = projectEnvProblem(k);
        if (why)
            ctx.addIssue({ code: 'custom', message: why });
    }),
    /** Files whose contents key the cache (the lockfile): any change to them starts a new one. */
    key: z.array(relPath).min(1),
});
/** A Postgres image pinned to its digest: a tag alone could change under the run. */
export const PINNED_IMAGE = /^[a-z0-9][a-z0-9./_-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;
/**
 * A directory every run of the instance shares and no wipe removes, given in `env`: e.g. a registry of test ports
 * that concurrent runs coordinate through. Never a cache of anything a run trusts: any run can write it.
 */
export const TestRunShared = z.strictObject({
    name: tierName,
    env: z.string().superRefine((k, ctx) => {
        const why = projectEnvProblem(k);
        if (why)
            ctx.addIssue({ code: 'custom', message: why });
    }),
});
/** test_run.database.max_connections: its bounds (the sandbox helper checks the same) and default. */
export const MAX_CONNECTIONS = { min: 20, max: 2000, default: 200 };
export const TestRunDatabase = z.strictObject({
    image: z.string().regex(PINNED_IMAGE, 'an image pinned to its digest: <name>[:<tag>]@sha256:<64 hex>'),
    /** The database the run's DATABASE_URL names. */
    name: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'a lowercase database name').default('test'),
    ready_timeout_s: z.number().int().min(5).max(600).default(60),
    /**
     * Postgres's max_connections. Size it as the run's parallel lanes x (each lane's pool + its ORM's own
     * connections) + headroom (psql, migrations, superuser slots): 22 lanes x (8 + 2) + 20 = 240. The image's 100
     * runs out ("sorry, too many clients already") well before that.
     */
    max_connections: z.number().int().min(MAX_CONNECTIONS.min).max(MAX_CONNECTIONS.max).default(MAX_CONNECTIONS.default),
});
export const TestRunConfig = z
    .strictObject({
    /**
     * Which tests a PR's fast run selects (src/testrun/select.ts): `repo`, the repo's own planner given
     * {changed_files} (the default when a tier passes it); `imports`, the engine's import graph, for a JS/TS repo,
     * in {tests}; `off`, none (the default otherwise). A full run always runs everything.
     */
    select: z.enum(['imports', 'repo', 'off']).optional(),
    /**
     * Run in the workspace before the tiers, with the caches set, and with no network (e.g. `npm ci --offline`, after
     * `fetch`); a failure fails every tier.
     */
    setup: z.array(z.string().min(1)).default([]),
    /**
     * Downloads before the setup steps, with network, running none of the repo's code (./fetch.ts): `npm` fills the
     * named cache (its env must be npm_config_cache) with what package-lock.json pins, so `npm ci --offline` installs.
     */
    fetch: z.array(z.strictObject({ npm: tierName })).max(4).default([]),
    /**
     * The setup steps ask for the network, as the tier "setup": granted only when root's own testrun-network.json
     * lists "setup" for this instance. For an install that can't be split into fetch and an offline step.
     */
    setup_network: z.boolean().default(false),
    tiers: z.array(TestRunTier).min(1),
    database: TestRunDatabase.optional(),
    caches: z.array(TestRunCache).default([]),
    shared: z.array(TestRunShared).default([]),
    /**
     * Tier name -> its GitHub check's name. A tier not named here posts `test-run/<tier>`. Several tiers of one kind
     * may share a check: it passes only when every one of them passed.
     */
    checks: z.record(tierName, z.string().min(1).max(100)).default({}),
    /** Variables for the run (never secrets: the same rules as tests.yaml env). */
    env: z
        .record(z.string(), z.string().regex(/^[^\0\n]*$/, 'one line'))
        .superRefine((env, ctx) => {
        for (const k of Object.keys(env)) {
            const why = k === 'DATABASE_URL' ? 'set by the run from its own database' : projectEnvProblem(k);
            if (why)
                ctx.addIssue({ code: 'custom', path: [k], message: why });
        }
    })
        .default({}),
})
    .superRefine((c, ctx) => {
    const names = new Set();
    c.tiers.forEach((t, i) => {
        if (t.name === SETUP_TIER)
            ctx.addIssue({ code: 'custom', path: ['tiers', i, 'name'], message: `"${SETUP_TIER}" is the setup steps' name for the network grant; call the tier something else` });
        if (names.has(t.name))
            ctx.addIssue({ code: 'custom', path: ['tiers', i, 'name'], message: `duplicate tier ${t.name}` });
        names.add(t.name);
        if (t.database && !c.database)
            ctx.addIssue({ code: 'custom', path: ['tiers', i, 'database'], message: 'needs test_run.database' });
    });
    for (const k of Object.keys(c.checks))
        if (!names.has(k))
            ctx.addIssue({ code: 'custom', path: ['checks', k], message: `no tier named ${k}` });
    // Each selection mode has the placeholder it fills, and only that one carries a selection.
    const mode = selectMode(c);
    c.tiers.forEach((t, i) => {
        if (t.command.includes('{tests}') && mode !== 'imports')
            ctx.addIssue({ code: 'custom', path: ['tiers', i, 'command'], message: `{tests} is filled only with select: imports (this config's is ${mode})` });
        if (t.command.includes('{changed_files}') && mode === 'off')
            ctx.addIssue({ code: 'custom', path: ['tiers', i, 'command'], message: 'select: off hands no tier the changed files: drop {changed_files}, or select: repo' });
    });
    if (mode === 'imports' && !c.tiers.some((t) => t.kind === 'fast' && t.command.includes('{tests}')))
        ctx.addIssue({ code: 'custom', path: ['select'], message: 'select: imports needs a fast tier that passes {tests} to its test runner' });
    // A check is a fast check or a full one, never both: a PR's fast check must not wait on its batch.
    const checkKind = new Map();
    for (const t of c.tiers) {
        const n = checkName(c, t.name);
        const k = checkKind.get(n);
        if (k && k !== t.kind)
            ctx.addIssue({ code: 'custom', path: ['checks'], message: `the check "${n}" has fast and full tiers` });
        checkKind.set(n, t.kind);
    }
    c.fetch.forEach((f, i) => {
        const cache = c.caches.find((x) => x.name === f.npm);
        if (!cache)
            ctx.addIssue({ code: 'custom', path: ['fetch', i, 'npm'], message: `no cache named ${f.npm} in test_run.caches` });
        else if (cache.env !== NPM_CACHE_ENV)
            ctx.addIssue({ code: 'custom', path: ['fetch', i, 'npm'], message: `the cache ${f.npm} is given in ${cache.env}; npm's fetch needs ${NPM_CACHE_ENV}, so the offline install reads it` });
    });
    const vars = new Set(Object.keys(c.env));
    for (const [list, what] of [[c.caches, 'caches'], [c.shared, 'shared']]) {
        const seen = new Set();
        list.forEach((x, i) => {
            if (seen.has(x.name))
                ctx.addIssue({ code: 'custom', path: [what, i, 'name'], message: `duplicate ${what} ${x.name}` });
            if (vars.has(x.env))
                ctx.addIssue({ code: 'custom', path: [what, i, 'env'], message: `${x.env} is set twice` });
            seen.add(x.name);
            vars.add(x.env);
        });
    }
});
/** A tier's GitHub check name: the mapping's, or `test-run/<tier>`. */
export function checkName(c, tier) {
    return c.checks[tier] ?? `test-run/${tier}`;
}
//# sourceMappingURL=config.js.map