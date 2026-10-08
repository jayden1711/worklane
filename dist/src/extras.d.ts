import type { Backlog } from './backlog/types.js';
import type { Config } from './config/load.js';
import type { EventLog } from './events/log.js';
import type { EventPayload, StoredEvent } from './events/types.js';
import type { Level } from './review.js';
import type { AgentRunner } from './runner.js';
export type ExtraRoleName = 'security' | 'red_attributor' | 'ci_repair' | 'qa_playtester' | 'monitor' | 'release_prep';
/** What the coordinator lends a role: never a token, never a writable checkout. */
export interface ExtraCtx {
    cfg: Config;
    log: EventLog;
    backlog: Backlog;
    runner: AgentRunner;
    repo: string;
    stateDir: string;
    branch: string;
    remote: string;
    emit<T extends Parameters<EventLog['append']>[0]>(type: T, payload: EventPayload<T>): StoredEvent;
    git(cwd: string, ...args: string[]): string;
    sh(command: string, cwd: string): Promise<{
        code: number | null;
        tail: string;
    }>;
    /** Why no agent may start now (budget, load, disk), or null. */
    hold(): string | null;
    budgetLeft(): number;
    now(): Date;
}
export declare function enabled(cfg: Config, role: ExtraRoleName): {
    enabled: boolean;
    model: string;
    count?: number | undefined;
    max?: number | undefined;
    hard_issues_model?: string | undefined;
    max_per_day?: number | undefined;
    max_fixes_per_pr?: number | undefined;
    applies_to?: string[] | undefined;
    budget_usd?: number | undefined;
    every_minutes?: number | undefined;
    tools?: string[] | undefined;
} | null;
export interface SecurityFinding {
    severity: 'low' | 'medium' | 'high' | 'critical';
    file: string;
    issue: string;
    evidence: string;
}
/**
 * Review a change in the categories the role applies to (default: money
 * paths). Returns the review level the result requires: block -> L3,
 * concerns -> L2. A reviewer that moved HEAD or left changes counts as a
 * block: a read-only role that writes is not trusted.
 */
export declare function securityReview(ctx: ExtraCtx, t: {
    issue: number;
    path: string;
    base: string;
    head: string;
    categories: string[];
}): Promise<{
    requested: Level | null;
    receipts: string[];
}>;
/** Once a day, when changes landed since the last tag: release notes as a PR. Never tags or deploys. */
declare function releasePrep(ctx: ExtraCtx, pr: (branch: string, file: string, content: string, title: string, body: string) => Promise<string>): Promise<void>;
/** One pass over the enabled scheduled roles (security runs inside each task's pipeline instead). */
export declare function runExtras(ctx: ExtraCtx, pr: Parameters<typeof releasePrep>[1]): Promise<void>;
export {};
