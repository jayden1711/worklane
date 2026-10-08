import { z } from 'zod';
export declare const DoneWhen: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
    command: z.ZodString;
    timeout_s: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    test: z.ZodString;
    timeout_s: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    manual: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    repro: z.ZodBoolean;
}, z.core.$strict>]>>;
export declare const TaskFile: z.ZodObject<{
    id: z.ZodString;
    done_when: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        command: z.ZodString;
        timeout_s: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        test: z.ZodString;
        timeout_s: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        manual: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        repro: z.ZodBoolean;
    }, z.core.$strict>]>>;
}, z.core.$strict>;
export type TaskFile = z.infer<typeof TaskFile>;
export type CheckStatus = 'pass' | 'fail' | 'unavailable';
export interface CheckRun {
    check: string;
    status: CheckStatus;
    exitCode: number | null;
    durationMs: number;
    detail: string;
}
export type GateOutcome = 'pass' | 'block' | 'no_task';
export interface GateResult {
    outcome: GateOutcome;
    /** Why it blocked: failing checks, or why the gate couldn't run. */
    reason: string;
    unavailable: boolean;
    checks: CheckRun[];
    manual: string[];
}
export interface GateOptions {
    cwd: string;
    stateDir: string;
    taskFile?: string | undefined;
    timeoutS: number;
    lockWaitS: number;
    busyPatterns: string[];
    /** Template for running one test file, with {file}. */
    testCommand?: string | undefined;
}
export declare function runStopGate(opts: GateOptions): Promise<GateResult>;
