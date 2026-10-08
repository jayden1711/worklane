import type { GuardrailsConfig } from '../config/schema.js';
export type Decision = 'deny' | 'ask' | 'none';
export interface ToolCall {
    tool: string;
    input: Record<string, unknown>;
    cwd: string;
}
export interface EvalContext {
    projectRoot: string;
    /** Headless agent run (set by the coordinator) vs a human's interactive session. */
    agent: boolean;
    env: Record<string, string | undefined>;
    /** Fingerprint set name -> hashes. A missing set means "unknown", not "empty". */
    fingerprints: Record<string, Set<string> | undefined>;
    /** Home directory, for "~/" secret paths. */
    home?: string;
    /** Linked environment for a CLI in a directory, or null if unknown. */
    linkedEnvironment(resolver: string, cwd: string): string | null;
}
export interface Verdict {
    decision: Decision;
    rule?: string;
    reason?: string;
}
export declare function evaluate(call: ToolCall, cfg: GuardrailsConfig, ctx: EvalContext): Verdict;
