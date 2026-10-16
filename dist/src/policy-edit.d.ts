import type { Config } from './config/load.js';
export declare const POLICY_KEYS: readonly ["budget.daily_usd", "agents.max_workers", "land_mode", "auto_merge", "main_watch", "automations.enabled"];
export type PolicyKey = (typeof POLICY_KEYS)[number];
export interface PolicyField {
    key: PolicyKey;
    value: number | boolean | string;
    kind: 'number' | 'boolean' | 'choice';
    min?: number;
    max?: number;
    step?: number;
    choices?: string[];
    why: string;
}
export interface PolicyFormView {
    fields: PolicyField[];
    /** INVARIANT: shown read-only; this form never writes them. */
    fixed: {
        key: string;
        value: unknown;
    }[];
    error: string | null;
}
export declare class PolicyEditError extends Error {
}
export declare function policyForm(path: string, limitsPath?: string): PolicyFormView;
export interface PolicyChange {
    key: PolicyKey;
    from: unknown;
    to: unknown;
}
/** The change these values make, or why it is refused; nothing is written. */
export declare function planPolicy(o: {
    path: string;
    cfg: Config;
    values: Record<string, unknown>;
    limitsPath?: string;
}): {
    changes: PolicyChange[];
    text: string;
};
/** Write a confirmed change: the plan again (the file may have changed since), atomically, 0600, and logged. */
export declare function applyPolicy(o: {
    path: string;
    cfg: Config;
    values: Record<string, unknown>;
    eventsDb: string;
    by: string;
    limitsPath?: string;
}): PolicyChange[];
