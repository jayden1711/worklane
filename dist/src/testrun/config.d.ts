import { z } from 'zod';
/** The placeholders a tier command may use; anything else in braces is left as written. */
export declare const TIER_PLACEHOLDERS: readonly ["{changed_files}", "{tests}", "{shard_index}", "{shard_total}", "{shard}", "{total}"];
/** Whether a command passes its shard's place: {shard_index} and {shard_total}, or the short {shard} and {total}. */
export declare function passesShard(command: string): boolean;
export declare const TestRunTier: z.ZodObject<{
    name: z.ZodString;
    command: z.ZodString;
    kind: z.ZodEnum<{
        full: "full";
        fast: "fast";
    }>;
    database: z.ZodDefault<z.ZodBoolean>;
    shardable: z.ZodDefault<z.ZodBoolean>;
    full_checkout: z.ZodDefault<z.ZodBoolean>;
    timeout_s: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type TestRunTier = z.infer<typeof TestRunTier>;
export declare const TestRunCache: z.ZodObject<{
    name: z.ZodString;
    env: z.ZodString;
    key: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type TestRunCache = z.infer<typeof TestRunCache>;
/** A Postgres image pinned to its digest: a tag alone could change under the run. */
export declare const PINNED_IMAGE: RegExp;
/**
 * A directory every run of the instance shares and no wipe removes, given in `env`: e.g. a registry of test ports
 * that concurrent runs coordinate through. Never a cache of anything a run trusts: any run can write it.
 */
export declare const TestRunShared: z.ZodObject<{
    name: z.ZodString;
    env: z.ZodString;
}, z.core.$strict>;
export type TestRunShared = z.infer<typeof TestRunShared>;
/** test_run.database.max_connections: its bounds (the sandbox helper checks the same) and default. */
export declare const MAX_CONNECTIONS: {
    readonly min: 20;
    readonly max: 2000;
    readonly default: 200;
};
export declare const TestRunDatabase: z.ZodObject<{
    image: z.ZodString;
    name: z.ZodDefault<z.ZodString>;
    ready_timeout_s: z.ZodDefault<z.ZodNumber>;
    max_connections: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export declare const TestRunConfig: z.ZodObject<{
    select: z.ZodOptional<z.ZodEnum<{
        imports: "imports";
        repo: "repo";
        off: "off";
    }>>;
    setup: z.ZodDefault<z.ZodArray<z.ZodString>>;
    tiers: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        command: z.ZodString;
        kind: z.ZodEnum<{
            full: "full";
            fast: "fast";
        }>;
        database: z.ZodDefault<z.ZodBoolean>;
        shardable: z.ZodDefault<z.ZodBoolean>;
        full_checkout: z.ZodDefault<z.ZodBoolean>;
        timeout_s: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    database: z.ZodOptional<z.ZodObject<{
        image: z.ZodString;
        name: z.ZodDefault<z.ZodString>;
        ready_timeout_s: z.ZodDefault<z.ZodNumber>;
        max_connections: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    caches: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        env: z.ZodString;
        key: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>>;
    shared: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        env: z.ZodString;
    }, z.core.$strict>>>;
    checks: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    env: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strict>;
export type TestRunConfig = z.infer<typeof TestRunConfig>;
/** A tier's GitHub check name: the mapping's, or `test-run/<tier>`. */
export declare function checkName(c: Pick<TestRunConfig, 'checks'>, tier: string): string;
