// Open-model providers, wired: a run whose model names a provider (`local`, `hosted:<name>`) goes to it only when
// every check passes, in this order, and otherwise runs on its route's fallback (the role's normal model), with a
// provider.fallback event saying why. The checks: this instance opted in; the provider is configured and its key
// installed; code allows it this work (src/providers.ts); the role passed its evals on the provider's model; and,
// for the local model, the GPU lock is free and the server is up and fast enough. Nothing waits on a provider.
import type { Config } from '../config/load.js';
import type { InstanceSettings } from '../instance.js';
import { flockHeld } from '../os/index.js';
import { gatePasses, healthCheck, providerOf, providerRefusal, type ProviderConfig } from '../providers.js';
import type { RunRequest } from '../runner.js';
import type { ReviewConfig } from '../config/schema.js';
import { computeLevel, type ChangeFile } from '../review.js';
import { instructionTargets } from '../skilleval.js';

export interface ProviderDeps {
  cfg: Config;
  settings: InstanceSettings;
  stateDir: string;
  providerKeys?: Record<string, string>;
  fetch?: typeof fetch;
  lockHeld?: (path: string) => boolean | null;
}

/** The run as it will start: on its provider, or on its fallback, with why it fell back (null when it didn't). */
export async function resolveProvider(req: RunRequest, d: ProviderDeps): Promise<{ req: RunRequest; fellBack: { provider: string; reason: string } | null }> {
  const named = providerOf(req.model);
  if (!named) return { req, fellBack: null };
  const label = named.kind === 'local' ? 'local' : `hosted:${named.name}`;
  const fallback = req.route?.fallback ?? 'sonnet';
  const back = (reason: string) => ({ req: { ...req, model: fallback }, fellBack: { provider: label, reason } });
  if (!req.route) return back('the run has no route, so it may not go to an open model');
  const opted = named.kind === 'local' ? d.settings.providers?.local === true : (d.settings.providers?.hosted ?? []).includes(named.name);
  if (!opted) return back(`this instance hasn't opted into ${label} (policy.yaml settings.providers)`);
  const p: ProviderConfig | undefined = named.kind === 'local' ? d.cfg.agents.providers?.local : d.cfg.agents.providers?.hosted?.[named.name];
  if (!p) return back(`${label} is not configured (agents.yaml providers)`);
  const keyFile = d.providerKeys?.[p.credential];
  if (!keyFile) return back(`${label}'s key (${p.credential}) is not installed (credentials.yaml provider_keys)`);
  const refused = providerRefusal(named.kind, { route: req.route.kind, highRisk: req.route.highRisk === true });
  if (refused) return back(refused);
  const gate = gatePasses(d.stateDir, req.role, p.model);
  if (!gate.ok) return back(`not evaluated to pass: ${gate.why}`);
  if (named.kind === 'local') {
    if (p.gpu_lock) {
      const held = (d.lockHeld ?? flockHeld)(p.gpu_lock);
      if (held !== false) return back(held ? `the GPU lock ${p.gpu_lock} is held by another workload` : `the GPU lock ${p.gpu_lock} can't be checked`);
    }
    const h = await healthCheck(p, d.fetch);
    if (!h.ok) return back(`the local model server is down or slow: ${h.why}`);
  }
  return { req: { ...req, model: p.model, provider: { name: label, kind: named.kind, baseUrl: p.base_url, keyFile } }, fellBack: null };
}

/**
 * Why a change a hosted open model built may not stand (or null): it is L3, touches a money path, or changes agent
 * instructions (a skill, AGENTS.md, a role prompt). Hosted models never do that work; the task redoes it on Anthropic.
 */
export function hostedChangeRefusal(o: { files: ChangeFile[]; labels: string[]; moneyPaths: () => RegExp[]; review: ReviewConfig }): string | null {
  if (instructionTargets(o.files.map((f) => f.path)).length) return 'a hosted model changed agent instructions, which it may never do';
  let lvl: ReturnType<typeof computeLevel>;
  try {
    lvl = computeLevel({ files: o.files, labels: o.labels, moneyPaths: o.moneyPaths() }, o.review);
  } catch {
    return "a hosted model's change can't be levelled, so it can't stand";
  }
  if ((lvl.categories['money-path'] ?? []).length) return 'a hosted model changed a money path, which it may never do';
  if (lvl.level === 'L3') return 'a hosted model made an L3 change, which it may never do';
  return null;
}
