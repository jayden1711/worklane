// Model routing, wired: the model each coordinator run uses, from the repo's agents.yaml model_routing over the
// defaults (src/model-routing.ts), and the instance's model_cap applied to every run the coordinator starts.
import type { Config } from '../config/load.js';
import type { InstanceSettings } from '../instance.js';
import { buildModel, capped, modelRouting, routedModel, type RoutedRun } from '../model-routing.js';
import { providerOf } from '../providers.js';
import type { RunRequest } from '../runner.js';

/** A build's model (worker, investigator, conflict fix): by the issue's labels and how many attempts already failed. */
export function routeBuild(cfg: Config, labels: string[], attempt = 1): { model: string; why: 'high-risk' | 'escalated' | 'default' } {
  return buildModel(modelRouting(cfg.agents), labels, attempt);
}

/** The model for a routed kind of run (planner, research, intake triage and replies, stage judge, eval answers). */
export function routeRun(cfg: Config, kind: RoutedRun): string {
  return routedModel(modelRouting(cfg.agents), kind);
}

/** The model a run actually starts with: capped at the instance's model_cap, whatever chose it. */
export function cappedModel(model: string, settings: InstanceSettings | undefined): string {
  return capped(model, settings?.model_cap);
}

/** The routing with every open-model setting dropped: what each kind of run uses when no provider takes it. */
function anthropicRouting(cfg: Config) {
  const r = Object.fromEntries(Object.entries(cfg.agents.model_routing ?? {}).filter(([, v]) => typeof v !== 'string' || !providerOf(v)));
  return modelRouting({ roles: cfg.agents.roles, model_routing: r });
}

/**
 * A build's model and its route: the high-risk route (labels, escalation) never goes to an open model, and an
 * open model's fallback is the build model it would otherwise be. `noOpenModel`: this attempt runs on Anthropic.
 */
export function buildRoute(cfg: Config, labels: string[], attempt = 1, noOpenModel = false): { model: string; why: 'high-risk' | 'escalated' | 'default'; route: NonNullable<RunRequest['route']> } {
  const b = routeBuild(cfg, labels, attempt);
  const fallback = buildModel(anthropicRouting(cfg), labels, attempt).model;
  return { model: noOpenModel && providerOf(b.model) ? fallback : b.model, why: b.why, route: { kind: 'build', highRisk: b.why !== 'default', fallback } };
}

/** A routed kind's model and its route, with the Anthropic model it falls back to. */
export function runRoute(cfg: Config, kind: RoutedRun): { model: string; route: NonNullable<RunRequest['route']> } {
  // The runner knows the reflection as an 'other' run: no open-model provider takes it (src/providers.ts).
  return { model: routeRun(cfg, kind), route: { kind: kind === 'reflection' ? 'other' : kind, fallback: routedModel(anthropicRouting(cfg), kind) } };
}
