import { z } from 'zod';
export declare const HarnessTask: z.ZodObject<{
    id: z.ZodString;
    repo: z.ZodString;
    base: z.ZodString;
    title: z.ZodString;
    body: z.ZodString;
    done_when: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        command: z.ZodString;
        timeout_s: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        test: z.ZodString;
        timeout_s: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        suite: z.ZodEnum<{
            full: "full";
            changed: "changed";
        }>;
        timeout_s: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        manual: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        repro: z.ZodBoolean;
    }, z.core.$strict>, z.ZodObject<{
        browser: z.ZodString;
    }, z.core.$strict>]>>;
    labels: z.ZodDefault<z.ZodArray<z.ZodString>>;
    outcome: z.ZodObject<{
        pr: z.ZodNumber;
        merge: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type HarnessTask = z.infer<typeof HarnessTask>;
export interface LoadedTask extends HarnessTask {
    /** From the held-out store: never named in a PR comment or a repository. */
    heldOut: boolean;
    file: string;
}
/** The public tasks the engine ships (package.json `files` includes templates/). */
export declare const PUBLIC_TASKS_DIR: string;
/** The held-out store's tasks: the coordinator's own state, owner-only. */
export declare const heldOutTasksDir: (stateDir: string, env?: NodeJS.ProcessEnv) => string;
/** The issue body an agent sees: the task's text and its done_when block. Never the outcome. */
export declare function issueBody(t: HarnessTask): string;
/**
 * A task file. A public one (`ownRepo` given) names no repository: it is always the engine's own, so a public task
 * from any other repository can't be written at all. Any other names its repository.
 */
export declare function parseTask(text: string, file: string, ownRepo?: string | null): HarnessTask;
/** Every task file (*.yaml) in a directory, sorted by id; a missing directory has none. Public: the engine's own tasks. */
export declare function readTasks(dir: string, heldOut: boolean, ownRepo?: string | null): LoadedTask[];
/**
 * The suite: the public tasks, then the held-out ones (when the store can be read). An id in both is refused, so a
 * private task can never be shadowed by, or mistaken for, a public one.
 */
export declare function loadSuite(o: {
    publicDirs: string[];
    heldOutDir?: string | null;
    projectDirs?: string[];
}): {
    tasks: LoadedTask[];
    notes: string[];
};
/** Write a task into the held-out store (owner-only), for a private repository's task. */
export declare function writeHeldOutTask(dir: string, t: HarnessTask): string;
/** The engine's own repository (owner/name), from its package.json: the only repository public tasks may come from. */
export declare function engineRepo(pkgJson?: string): string | null;
