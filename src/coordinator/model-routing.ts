// Model routing, wired: the model each coordinator run uses, from the repo's agents.yaml model_routing over the
// defaults (src/model-routing.ts), and the instance's model_cap applied to every run the coordinator starts.
import type { Config } from '../config/load.js';
import type { InstanceSettings } from '../instance.js';
import { buildModel, capped, modelRouting, routedModel, type RoutedRun } from '../model-routing.js';

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
