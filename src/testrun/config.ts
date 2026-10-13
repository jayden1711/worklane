// tests.yaml `test_run:`: how the coordinator runs a project's CI on the machine (docs/test-runs.md).
//
// Each tier is one command run in the run's own clean workspace, as the sandboxed test user. A fast tier runs on
// every PR; a full tier runs once per batch (PR mode), sharded across the machine's test-run slots when it says it
// can be. A tier that needs a database gets the run's own Postgres in DATABASE_URL. Caches are keyed by the hash
// of the files that pin what they hold (a lockfile), so a changed lockfile starts a new cache, never a stale one.
// Each tier posts one GitHub check; `checks` maps a tier to its check name.
import { z } from 'zod';
import { projectEnvProblem } from '../project-env.js';

const tierName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'lowercase letters, digits, _ or - (at most 40)');
const relPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split(/[\\/]/).includes('..') && !/^[A-Za-z]:/.test(p), 'a path inside the repo (relative, no ..)');

/** The placeholders a tier command may use; anything else in braces is left as written. */
export const TIER_PLACEHOLDERS = ['{changed_files}', '{shard_index}', '{shard_total}', '{shard}', '{total}'] as const;

/** Whether a command passes its shard's place: {shard_index} and {shard_total}, or the short {shard} and {total}. */
export function passesShard(command: string): boolean {
  return (command.includes('{shard_index}') && command.includes('{shard_total}')) || (command.includes('{shard}') && command.includes('{total}'));
}

export const TestRunTier = z
  .strictObject({
    name: tierName,
    /**
     * Run under bash with pipefail in the run's workspace. `{changed_files}` is a file listing the change's paths,
     * one per line (for the project's own changed-plan command); `{shard_index}` (1-based) and `{shard_total}`, or
     * `{shard}` and `{total}`, are this shard's place in a sharded full run.
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
    timeout_s: z.number().int().min(30).max(6 * 3600).default(1800),
  })
  .refine((t) => !t.shardable || t.kind === 'full', { message: 'only a full tier can be sharded', path: ['shardable'] })
  .refine((t) => !t.shardable || passesShard(t.command), {
    message: 'a shardable tier passes {shard_index} and {shard_total} (or {shard} and {total}) to its command',
    path: ['command'],
  });
export type TestRunTier = z.infer<typeof TestRunTier>;

export const TestRunCache = z.strictObject({
  name: tierName,
  /** The variable the cache's directory is given in (e.g. npm_config_cache, PLAYWRIGHT_BROWSERS_PATH). */
  env: z.string().superRefine((k, ctx) => {
    const why = projectEnvProblem(k);
    if (why) ctx.addIssue({ code: 'custom', message: why });
  }),
  /** Files whose contents key the cache (the lockfile): any change to them starts a new one. */
  key: z.array(relPath).min(1),
});
export type TestRunCache = z.infer<typeof TestRunCache>;

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
    if (why) ctx.addIssue({ code: 'custom', message: why });
  }),
});
export type TestRunShared = z.infer<typeof TestRunShared>;

/** test_run.database.max_connections: its bounds (the sandbox helper checks the same) and default. */
export const MAX_CONNECTIONS = { min: 20, max: 2000, default: 200 } as const;

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
    /** Run in the workspace before the tiers (e.g. `npm ci`), with the caches set; a failure fails every tier. */
    setup: z.array(z.string().min(1)).default([]),
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
          if (why) ctx.addIssue({ code: 'custom', path: [k], message: why });
        }
      })
      .default({}),
  })
  .superRefine((c, ctx) => {
    const names = new Set<string>();
    c.tiers.forEach((t, i) => {
      if (names.has(t.name)) ctx.addIssue({ code: 'custom', path: ['tiers', i, 'name'], message: `duplicate tier ${t.name}` });
      names.add(t.name);
      if (t.database && !c.database) ctx.addIssue({ code: 'custom', path: ['tiers', i, 'database'], message: 'needs test_run.database' });
    });
    for (const k of Object.keys(c.checks)) if (!names.has(k)) ctx.addIssue({ code: 'custom', path: ['checks', k], message: `no tier named ${k}` });
    // A check is a fast check or a full one, never both: a PR's fast check must not wait on its batch.
    const checkKind = new Map<string, string>();
    for (const t of c.tiers) {
      const n = checkName(c, t.name);
      const k = checkKind.get(n);
      if (k && k !== t.kind) ctx.addIssue({ code: 'custom', path: ['checks'], message: `the check "${n}" has fast and full tiers` });
      checkKind.set(n, t.kind);
    }
    const vars = new Set(Object.keys(c.env));
    for (const [list, what] of [[c.caches, 'caches'], [c.shared, 'shared']] as const) {
      const seen = new Set<string>();
      list.forEach((x, i) => {
        if (seen.has(x.name)) ctx.addIssue({ code: 'custom', path: [what, i, 'name'], message: `duplicate ${what} ${x.name}` });
        if (vars.has(x.env)) ctx.addIssue({ code: 'custom', path: [what, i, 'env'], message: `${x.env} is set twice` });
        seen.add(x.name);
        vars.add(x.env);
      });
    }
  });
export type TestRunConfig = z.infer<typeof TestRunConfig>;

/** A tier's GitHub check name: the mapping's, or `test-run/<tier>`. */
export function checkName(c: Pick<TestRunConfig, 'checks'>, tier: string): string {
  return c.checks[tier] ?? `test-run/${tier}`;
}
