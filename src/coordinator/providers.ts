// Open-model providers, wired: a run whose model names a provider (`local`, `hosted:<name>`) goes to it only when
// every check passes, in this order, and otherwise runs on its route's fallback (the role's normal model), with a
// provider.fallback event saying why. The checks: this instance opted in; the provider is configured, root allows its
// base_url's host (src/provider-hosts.ts; before anything contacts it), and its key is installed; code allows it this
// work (src/providers.ts); the role passed its evals on the provider's model; and, for the local model, the GPU lock
// is free and the server is up and fast enough. Nothing waits on a provider.
import type { Config } from '../config/load.js';
import type { InstanceSettings } from '../instance.js';
import { flockHeld } from '../os/index.js';
import { gatePasses, healthCheck, providerOf, providerRefusal, tierRefusal, type CliAgentName, type ProviderConfig } from '../providers.js';
import { logRefusalOnce, providerHostRefusal } from '../provider-hosts.js';
import { isProtectedPath } from '../guardrails/engine.js';
import type { GuardrailsConfig } from '../config/schema.js';
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
  /** When a provider (by label) hit its usage or rate limit: the ISO time it's skipped until, or null. */
  limited?: (label: string) => string | null;
}

/** The run as it will start: on its provider, or on its fallback, with why it fell back (null when it didn't). */
export async function resolveProvider(req: RunRequest, d: ProviderDeps): Promise<{ req: RunRequest; fellBack: { provider: string; reason: string } | null }> {
  const named = providerOf(req.model);
  if (!named) return { req, fellBack: null };
  const label = named.kind === 'local' ? 'local' : `${named.kind}:${named.name}`;
  const fallback = req.route?.fallback ?? 'sonnet';
  const back = (reason: string) => ({ req: { ...req, model: fallback }, fellBack: { provider: label, reason } });
  if (!req.route) return back('the run has no route, so it may not go to an open model');
  const until = d.limited?.(label);
  if (until) return back(`${label} hit its usage or rate limit; skipped until ${until}`);
  const opted = named.kind === 'local' ? d.settings.providers?.local === true : named.kind === 'cli' ? (d.settings.providers?.cli ?? []).some((a) => a === named.name) : (d.settings.providers?.hosted ?? []).includes(named.name);
  if (!opted) return back(`this instance hasn't opted into ${label} (policy.yaml settings.providers)`);
  if (named.kind === 'cli') return resolveCliAgent(req, req.route, named.name as CliAgentName, label, d, back);
  const p: ProviderConfig | undefined = named.kind === 'local' ? d.cfg.agents.providers?.local : d.cfg.agents.providers?.hosted?.[named.name];
  if (!p) return back(`${label} is not configured (agents.yaml providers)`);
  // Root's provider hosts, read now: agents.yaml names the base_url, root decides whether a key and prompts go there.
  const hostRefused = providerHostRefusal(p.base_url);
  if (hostRefused) {
    logRefusalOnce(label, hostRefused);
    return back(hostRefused);
  }
  const keyFile = d.providerKeys?.[p.credential];
  if (!keyFile) return back(`${label}'s key (${p.credential}) is not installed (credentials.yaml provider_keys)`);
  const refused = providerRefusal(named.kind, { route: req.route.kind, highRisk: req.route.highRisk === true });
  if (refused) return back(refused);
  // The instance's model cap holds for hosted models by their price tier; above it, the run takes its fallback,
  // which the cap then applies to as to any Anthropic run.
  const overCap = tierRefusal(named.kind, p.tier, d.settings.model_cap);
  if (overCap) return back(overCap);
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

/** WHY: item 38. The same checks as a hosted model's, from the cli config: no key file (the CLI's login is the agent user's). */
function resolveCliAgent(req: RunRequest, route: NonNullable<RunRequest['route']>, agent: CliAgentName, label: string, d: ProviderDeps, back: (reason: string) => { req: RunRequest; fellBack: { provider: string; reason: string } }) {
  const c = d.cfg.agents.providers?.cli?.[agent];
  if (!c) return back(`${label} is not configured (agents.yaml providers.cli)`);
  const refused = providerRefusal('cli', { route: route.kind, highRisk: route.highRisk === true });
  if (refused) return back(refused);
  const overCap = tierRefusal('cli', c.tier, d.settings.model_cap);
  if (overCap) return back(overCap);
  const gate = gatePasses(d.stateDir, req.role, c.model);
  if (!gate.ok) return back(`not evaluated to pass: ${gate.why}`);
  return { req: { ...req, model: c.model, provider: { name: label, kind: 'cli' as const, agent, usdPerMtok: { in: c.usd_per_mtok_in, out: c.usd_per_mtok_out } } }, fellBack: null };
}

/**
 * WHY: item 38. Its run had no claude sandbox or hooks, so its change is held to more than a hosted model's: L1 or
 * below and no protected path, besides everything hostedChangeRefusal refuses.
 */
export function cliChangeRefusal(o: { files: ChangeFile[]; labels: string[]; moneyPaths: () => RegExp[]; review: ReviewConfig; guardrails: Pick<GuardrailsConfig, 'protected_paths'> }): string | null {
  const touched = o.files.map((f) => f.path).filter((p) => isProtectedPath(p, o.guardrails));
  if (touched.length) return `another vendor's CLI changed a protected path (${touched.slice(0, 3).join(', ')}), which it may never do`;
  const hosted = hostedChangeRefusal(o);
  if (hosted) return hosted.replace('a hosted model', "another vendor's CLI");
  let lvl: ReturnType<typeof computeLevel>;
  try {
    lvl = computeLevel({ files: o.files, labels: o.labels, moneyPaths: o.moneyPaths() }, o.review);
  } catch {
    return "another vendor's CLI made a change that can't be levelled, so it can't stand";
  }
  if (lvl.level !== 'L0' && lvl.level !== 'L1') return `another vendor's CLI made an ${lvl.level} change; it builds L1 work only`;
  return null;
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

/** WHY: item 38. One place the build loop asks, so a cli: build can't skip its stricter check. */
export function builtChangeRefusal(provider: string | undefined, o: Parameters<typeof cliChangeRefusal>[0]): string | null {
  if (provider?.startsWith('cli:')) return cliChangeRefusal(o);
  if (provider?.startsWith('hosted:')) return hostedChangeRefusal(o);
  return null;
}
