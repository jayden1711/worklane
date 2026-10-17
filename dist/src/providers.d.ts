import { type ModelTier, type RoutedRun } from './model-routing.js';
export type ProviderKind = 'local' | 'hosted' | 'cli';
export declare const CLI_AGENTS: readonly ["codex", "gemini"];
export type CliAgentName = (typeof CLI_AGENTS)[number];
export interface ProviderConfig {
    /** Anthropic-compatible endpoint: the runner sets ANTHROPIC_BASE_URL to it for the run. */
    base_url: string;
    /** The credential's name: its key file comes from the instance's credentials.yaml provider_keys, never the repo. */
    credential: string;
    /** The provider's own model id, passed to claude --model. */
    model: string;
    /** Hosted: its price tier (haiku, sonnet or opus by per-token price); the instance's model cap applies to it. */
    tier?: ModelTier | undefined;
    /** Estimated price per million tokens, in and out (hosted); local runs cost nothing. */
    usd_per_mtok_in?: number | undefined;
    usd_per_mtok_out?: number | undefined;
    /** Local: a GPU lock another workload holds while it runs (flock); while it's held, local runs fall back. */
    gpu_lock?: string | undefined;
    /** Local: the health check's latency cap; slower (or down) means fall back. */
    latency_ms?: number | undefined;
}
/** A model setting that names a provider: `local`, `hosted:<name>` or `cli:<agent>`; null for a plain (Anthropic) model. */
export declare function providerOf(model: string): {
    kind: ProviderKind;
    name: string;
} | null;
/** What each kind of provider may run (code, not config). Builds here are the L1/L2 build route only. */
export declare const PROVIDER_USES: Record<ProviderKind, readonly (RoutedRun | 'build' | 'cross_eval')[]>;
/** Why a provider may not run this, or null. Hosted never gets high-risk work (labels, escalation, L3). */
export declare function providerRefusal(kind: ProviderKind, use: {
    route: RoutedRun | 'build' | 'evaluator' | 'cross_eval' | 'other';
    highRisk?: boolean;
}): string | null;
/**
 * Why a hosted model may not run under the instance's model cap (or null): it declares no price tier, or its tier is
 * above the cap. Local models cost nothing and have no tier.
 */
export declare function tierRefusal(kind: ProviderKind, tier: ModelTier | undefined, cap: ModelTier | undefined): string | null;
/** The provider's host, for the network allowlist and the report. */
export declare function providerHost(p: Pick<ProviderConfig, 'base_url'>): string;
/** A local server is up when it answers quickly; anything else (an error, a timeout, too slow) is down. */
export declare function healthCheck(p: Pick<ProviderConfig, 'base_url' | 'latency_ms'>, fetchImpl?: typeof fetch, now?: () => number): Promise<{
    ok: true;
    ms: number;
} | {
    ok: false;
    why: string;
}>;
/** The eval gate's record: a role may run on a provider's model only once it passed its evals there. */
export declare const PROVIDER_GATE_FILE: string;
export interface GateEntry {
    /** Held-out score on the provider's model, and on the role's normal model, as rubric items met. */
    held_out: {
        passed: number;
        total: number;
    };
    baseline: {
        passed: number;
        total: number;
    };
    visible: {
        passed: number;
        total: number;
    };
    samples: number;
    at: string;
}
/** Whether `role` passed on `model` (the provider's id): held-out not below the baseline, at 3 samples or more. */
export declare function gatePasses(stateDir: string, role: string, model: string): {
    ok: true;
} | {
    ok: false;
    why: string;
};
/** A run's estimated cost on a provider: local is free; hosted, from the configured prices, else unknown (null). */
export declare function providerCost(kind: ProviderKind, p: Pick<ProviderConfig, 'usd_per_mtok_in' | 'usd_per_mtok_out'>, tokens: {
    in: number;
    out: number;
}): number | null;
