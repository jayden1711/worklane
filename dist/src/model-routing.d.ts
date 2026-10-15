import { route } from './routing.js';
export declare const MODEL_TIERS: readonly ["haiku", "sonnet", "opus"];
export type ModelTier = (typeof MODEL_TIERS)[number];
/** Kinds of run routed here (not the evaluator, which the eval_* keys of routing tier). */
export type RoutedRun = 'planner' | 'research' | 'intake_triage' | 'intake_replier' | 'intake_summary' | 'intake_thread' | 'stage_judge' | 'eval_answer' | 'reflection';
export interface ModelRouting {
    /** L1/L2 builds (worker, investigator, conflict fix). */
    build: string;
    /** L3 and high-risk builds: an issue with any of high_risk_labels, or one past escalate_after failed attempts. */
    build_high_risk: string;
    high_risk_labels: string[];
    /** Failed attempts on `build` before the next attempt runs on `build_high_risk`; 0: never escalate. */
    escalate_after: number;
    planner: string;
    research: string;
    intake_triage: string;
    intake_replier: string;
    /** A decision thread's plain-language summary (src/intake/explain.ts). */
    intake_summary: string;
    /** Questions and plain-language picks in a decision thread. */
    intake_thread: string;
    stage_judge: string;
    eval_answer: string;
    /** The short read-only reflection before a worker's retry: what failed, what to change. */
    reflection: string;
}
export { DEFAULT_HIGH_RISK_LABELS } from './routing.js';
export declare function modelRouting(agents: Parameters<typeof route>[0]): ModelRouting;
/** A model's tier from its alias or full id; null for a model this doesn't know (treated as the top tier when capping). */
export declare function tierOf(model: string): ModelTier | null;
/** The model, capped at `cap`: a model above it (or of an unknown tier) becomes the cap's alias. */
export declare function capped(model: string, cap?: ModelTier): string;
/** The model for a routed run. */
export declare function routedModel(r: ModelRouting, kind: RoutedRun): string;
/**
 * A build's model: the high-risk model for an issue labelled high-risk (L3, money path, size L), or from the
 * attempt after `escalate_after` failed ones; else the usual build model. `why` says which applied.
 */
export declare function buildModel(r: ModelRouting, labels: string[], attempt?: number): {
    model: string;
    why: 'high-risk' | 'escalated' | 'default';
};
