import { buildModel, capped, modelRouting, routedModel } from '../model-routing.js';
import { providerOf } from '../providers.js';
/** A build's model (worker, investigator, conflict fix): by the issue's labels and how many attempts already failed. */
export function routeBuild(cfg, labels, attempt = 1) {
    return buildModel(modelRouting(cfg.agents), labels, attempt);
}
/** The model for a routed kind of run (planner, research, intake triage and replies, stage judge, eval answers). */
export function routeRun(cfg, kind) {
    return routedModel(modelRouting(cfg.agents), kind);
}
/** The model a run actually starts with: capped at the instance's model_cap, whatever chose it. */
export function cappedModel(model, settings) {
    return capped(model, settings?.model_cap);
}
/** The routing with every open-model setting dropped: what each kind of run uses when no provider takes it. */
function anthropicRouting(cfg) {
    const r = Object.fromEntries(Object.entries(cfg.agents.routing).filter(([, v]) => typeof v !== 'string' || !providerOf(v)));
    return modelRouting({ roles: cfg.agents.roles, routing: r });
}
/**
 * A build's model and its route: the high-risk route (labels, escalation) never goes to an open model, and an
 * open model's fallback is the build model it would otherwise be. `noOpenModel`: this attempt runs on Anthropic.
 */
export function buildRoute(cfg, labels, attempt = 1, noOpenModel = false) {
    const b = routeBuild(cfg, labels, attempt);
    const fallback = buildModel(anthropicRouting(cfg), labels, attempt).model;
    return { model: noOpenModel && providerOf(b.model) ? fallback : b.model, why: b.why, route: { kind: 'build', highRisk: b.why !== 'default', fallback } };
}
/** A routed kind's model and its route, with the Anthropic model it falls back to. */
export function runRoute(cfg, kind) {
    // The runner knows the reflection as an 'other' run: no open-model provider takes it (src/providers.ts).
    return { model: routeRun(cfg, kind), route: { kind: kind === 'reflection' ? 'other' : kind, fallback: routedModel(anthropicRouting(cfg), kind) } };
}
//# sourceMappingURL=model-routing.js.map