import type { Config } from '../config/load.js';
import type { InstanceSettings } from '../instance.js';
import { type RoutedRun } from '../model-routing.js';
import type { RunRequest } from '../runner.js';
/** A build's model (worker, investigator, conflict fix): by the issue's labels and how many attempts already failed. */
export declare function routeBuild(cfg: Config, labels: string[], attempt?: number): {
    model: string;
    why: 'high-risk' | 'escalated' | 'default';
};
/** The model for a routed kind of run (planner, research, intake triage and replies, stage judge, eval answers). */
export declare function routeRun(cfg: Config, kind: RoutedRun): string;
/** The model a run actually starts with: capped at the instance's model_cap, whatever chose it. */
export declare function cappedModel(model: string, settings: InstanceSettings | undefined): string;
/**
 * A build's model and its route: the high-risk route (labels, escalation) never goes to an open model, and an
 * open model's fallback is the build model it would otherwise be. `noOpenModel`: this attempt runs on Anthropic.
 */
export declare function buildRoute(cfg: Config, labels: string[], attempt?: number, noOpenModel?: boolean): {
    model: string;
    why: 'high-risk' | 'escalated' | 'default';
    route: NonNullable<RunRequest['route']>;
};
/** A routed kind's model and its route, with the Anthropic model it falls back to. */
export declare function runRoute(cfg: Config, kind: RoutedRun): {
    model: string;
    route: NonNullable<RunRequest['route']>;
};
