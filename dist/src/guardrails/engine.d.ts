import type { GuardrailsConfig } from '../config/schema.js';
/**
 * Harness config no agent writes, whatever a project's guardrails list (there's no opt-out): the config folder, and
 * everything under .claude/ (settings, skills, commands, agents, hooks), which Claude Code itself reads.
 */
export declare const BUILTIN_PROTECTED: string[];
/**
 * Under the config folder, the only paths agents may write: the agents' own role prompts and skills (a correction
 * lands there). A change to them is always high-risk and never auto-merges (review.ts AGENT_INSTRUCTIONS).
 */
export declare const AGENT_EDITABLE: string[];
/** WHY: item 33; an AGENTS.md line comes only from an owner promoting a learning (src/learnings.ts), never an agent. */
export declare const AGENTS_MD_PATHS: string[];
/**
 * May an agent not write this path (relative to the project root; a directory counts for what's under it)? The
 * built-in paths always apply, except the agents' own instructions. A project's own list can only add to them;
 * its catch-all for the config folder (the template's) is the built-in rule now, so it doesn't take the agents'
 * instructions away from them.
 */
export declare function isProtectedPath(rel: string, g: Pick<GuardrailsConfig, 'protected_paths'>): boolean;
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
/** Whether a host is on an allowlist: exact names, or `*.example.org` for it and its subdomains. */
export declare function hostAllowed(host: string, allow: string[]): boolean;
export declare function evaluate(call: ToolCall, cfg: GuardrailsConfig, ctx: EvalContext): Verdict;
