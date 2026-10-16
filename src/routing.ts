// INVARIANT (item 32): the one source of routing defaults; agents.yaml `routing` (and its aliases, merged in
// src/config/schema.ts) overrides them, and src/model-routing.ts and src/eval-routing.ts read through route().
import type { Level } from './review.js';

export const DEFAULT_HIGH_RISK_LABELS = ['size:L', 'money-path', 'review:L3', 'high-risk'];

export const ROUTING = {
  build: { default: 'sonnet' as string, task: 'L1/L2 builds (worker, investigator, conflict fix)' },
  build_high_risk: { default: 'opus' as string, task: 'L3 and high-risk builds, and a build past escalate_after failed attempts' },
  high_risk_labels: { default: DEFAULT_HIGH_RISK_LABELS as string[], task: 'issue labels that make a build high-risk' },
  escalate_after: { default: 2 as number, task: 'failed attempts before a build moves to build_high_risk (0: never)' },
  planner: { default: 'sonnet' as string, task: 'planning' },
  research: { default: 'sonnet' as string, task: 'research' },
  // WHY: on haiku its held-out score dropped (20/20 to 19/20; model routing PR).
  intake_triage: { default: 'sonnet' as string, task: 'intake triage' },
  intake_replier: { default: 'haiku' as string, task: 'intake replies' },
  intake_summary: { default: 'haiku' as string, task: "a decision thread's plain-language summary" },
  // WHY: on haiku its held-out score dropped (21/22 to 19/22).
  intake_thread: { default: 'sonnet' as string, task: 'questions and picks in a decision thread' },
  stage_judge: { default: 'sonnet' as string, task: 'the stage-label judge' },
  eval_answer: { default: 'sonnet' as string, task: 'eval answers' },
  // WHY: a few lines from a rejection and a diff: the cheap tier (#338).
  reflection: { default: 'haiku' as string, task: "the read-only reflection before a worker's retry" },
  // WHY: the dashboard chat's model until now was roles.chief_of_staff.model, else sonnet; that stays its fallback.
  chat: { default: 'sonnet' as string, task: "the dashboard chat's default model (the picker offers only models routing names)" },
  eval_cheap: { default: 'sonnet' as string, task: 'the evaluator, for changes at eval_cheap_levels' },
  eval_cheap_levels: { default: ['L0'] as Level[], task: 'review levels judged by eval_cheap (the rest: the evaluator role\'s model)' },
  eval_escalate: { default: true as boolean, task: 'a failed or uncertain eval_cheap verdict is judged once more by the evaluator role\'s model' },
};

export type RoutingKey = keyof typeof ROUTING;
export type Routing = { -readonly [K in RoutingKey]: (typeof ROUTING)[K]['default'] };
export const ROUTING_KEYS = Object.keys(ROUTING) as RoutingKey[];

export const ROUTING_ALIASES = {
  model_routing: Object.fromEntries(ROUTING_KEYS.filter((k) => !k.startsWith('eval_') || k === 'eval_answer').map((k) => [k, k])) as Record<string, RoutingKey>,
  eval_routing: { cheap_model: 'eval_cheap', cheap_levels: 'eval_cheap_levels', escalate: 'eval_escalate' } as Record<string, RoutingKey>,
};

interface RoutingSource {
  roles: { workers?: { model: string; hard_issues_model?: string | undefined; [k: string]: unknown } | undefined; researcher?: { model: string; [k: string]: unknown } | undefined; [k: string]: unknown };
  routing?: Partial<Routing>;
  routing_from?: Partial<Record<RoutingKey, string>>;
}

export interface RouteValue<K extends RoutingKey = RoutingKey> {
  key: K;
  value: Routing[K];
  /** INVARIANT: null means the default in code. */
  from: string | null;
}

export function route<K extends RoutingKey>(a: RoutingSource, key: K): RouteValue<K> {
  const set = a.routing?.[key];
  if (set !== undefined) return { key, value: set as Routing[K], from: a.routing_from?.[key] ?? `routing.${key}` };
  const w = a.roles.workers;
  const r = a.roles.researcher;
  // WHY: a repo that named its workers' or researcher's model before routing existed keeps it for these tasks.
  const fallbacks: Partial<Record<RoutingKey, [string | undefined, string][]>> = {
    build: [[w?.model, 'roles.workers.model']],
    build_high_risk: [[w?.hard_issues_model, 'roles.workers.hard_issues_model']],
    research: [[r?.model, 'roles.researcher.model']],
    intake_triage: [[r?.model, 'roles.researcher.model'], [w?.model, 'roles.workers.model']],
    chat: [[(a.roles.chief_of_staff as { model?: string } | undefined)?.model, 'roles.chief_of_staff.model']],
  };
  for (const [v, at] of fallbacks[key] ?? []) if (v !== undefined) return { key, value: v as Routing[K], from: at };
  return { key, value: ROUTING[key].default as Routing[K], from: null };
}

export function effectiveRouting(a: RoutingSource): RouteValue[] {
  return ROUTING_KEYS.map((k) => route(a, k));
}
