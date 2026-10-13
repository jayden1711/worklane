// Model routing, decided in code: which model each kind of run uses. Haiku for the intake replier and the decision
// thread summary (held-out 20/20 on haiku and on sonnet at 3 samples); Sonnet for
// L1/L2 builds, planning, research, eval answering and the stage-label judge; Opus for L3 and high-risk builds,
// and for a build that already failed twice on its usual model. Intake triage stays on the model it had (the
// researcher's, else the workers'): its held-out score dropped on haiku. The stage-label judge stays on sonnet:
// on haiku it missed a case of its eval in two samples of three. Decision-thread questions and picks stay on sonnet:
// on haiku their held-out score dropped (21/22 on sonnet to 19/22, 3 samples). The evaluator's model is
// tiered separately (src/eval-routing.ts). The repo's agents.yaml `model_routing` overrides any of these; the
// instance's `model_cap` (policy.yaml settings) caps every run's model at a tier (in the coordinator's runner,
// so no run escapes it), never raises one.
import type { AgentsConfig } from './config/schema.js';
import { OPTIMIZE_LABEL } from './optimize.js';

export const MODEL_TIERS = ['haiku', 'sonnet', 'opus'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Kinds of run routed here (not the evaluator, which eval_routing tiers). */
export type RoutedRun = 'planner' | 'research' | 'intake_triage' | 'intake_replier' | 'intake_summary' | 'intake_thread' | 'stage_judge' | 'eval_answer';

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
}

export const DEFAULT_HIGH_RISK_LABELS = ['size:L', 'money-path', 'review:L3', 'high-risk'];

/**
 * The routing for a config: the repo's model_routing over the defaults. A repo that names its workers' model or
 * hard_issues_model and no model_routing.build keeps those for builds.
 */
export function modelRouting(agents: Pick<AgentsConfig, 'roles' | 'model_routing'>): ModelRouting {
  const r = agents.model_routing ?? {};
  const workers = agents.roles.workers;
  return {
    build: r.build ?? workers?.model ?? 'sonnet',
    build_high_risk: r.build_high_risk ?? workers?.hard_issues_model ?? 'opus',
    high_risk_labels: r.high_risk_labels ?? DEFAULT_HIGH_RISK_LABELS,
    escalate_after: r.escalate_after ?? 2,
    planner: r.planner ?? 'sonnet',
    research: r.research ?? agents.roles.researcher?.model ?? 'sonnet',
    // Stays on its current model: on haiku its held-out score dropped (20/20 to 19/20; model routing PR).
    intake_triage: r.intake_triage ?? agents.roles.researcher?.model ?? workers?.model ?? 'sonnet',
    intake_replier: r.intake_replier ?? 'haiku',
    intake_summary: r.intake_summary ?? 'haiku',
    // Stays on sonnet: on haiku its held-out score dropped (21/22 to 19/22).
    intake_thread: r.intake_thread ?? 'sonnet',
    stage_judge: r.stage_judge ?? 'sonnet',
    eval_answer: r.eval_answer ?? 'sonnet',
  };
}

/** A model's tier from its alias or full id; null for a model this doesn't know (treated as the top tier when capping). */
export function tierOf(model: string): ModelTier | null {
  const words = model.toLowerCase().split(/[^a-z0-9]+/);
  return MODEL_TIERS.find((t) => words.includes(t)) ?? null;
}

/** The model, capped at `cap`: a model above it (or of an unknown tier) becomes the cap's alias. */
export function capped(model: string, cap?: ModelTier): string {
  if (!cap) return model;
  const t = tierOf(model);
  return t !== null && MODEL_TIERS.indexOf(t) <= MODEL_TIERS.indexOf(cap) ? model : cap;
}

/** The model for a routed run. */
export function routedModel(r: ModelRouting, kind: RoutedRun): string {
  return r[kind];
}

/**
 * A build's model: the high-risk model for an issue labelled high-risk (L3, money path, size L), or from the
 * attempt after `escalate_after` failed ones; else the usual build model. `why` says which applied.
 */
export function buildModel(r: ModelRouting, labels: string[], attempt = 1): { model: string; why: 'high-risk' | 'escalated' | 'default' } {
  // An optimization task (src/optimize.ts) always runs on the strongest model: the high-risk build model.
  const risky = labels.some((l) => r.high_risk_labels.includes(l)) || labels.includes(OPTIMIZE_LABEL);
  const escalated = r.escalate_after > 0 && attempt > r.escalate_after;
  const why = risky ? 'high-risk' : escalated ? 'escalated' : 'default';
  return { model: why === 'default' ? r.build : r.build_high_risk, why };
}
