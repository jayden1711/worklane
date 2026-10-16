import { flockHeld } from '../os/index.js';
import { gatePasses, healthCheck, providerOf, providerRefusal, tierRefusal } from '../providers.js';
import { isProtectedPath } from '../guardrails/engine.js';
import { computeLevel } from '../review.js';
import { instructionTargets } from '../skilleval.js';
/** The run as it will start: on its provider, or on its fallback, with why it fell back (null when it didn't). */
export async function resolveProvider(req, d) {
    const named = providerOf(req.model);
    if (!named)
        return { req, fellBack: null };
    const label = named.kind === 'local' ? 'local' : `${named.kind}:${named.name}`;
    const fallback = req.route?.fallback ?? 'sonnet';
    const back = (reason) => ({ req: { ...req, model: fallback }, fellBack: { provider: label, reason } });
    if (!req.route)
        return back('the run has no route, so it may not go to an open model');
    const until = d.limited?.(label);
    if (until)
        return back(`${label} hit its usage or rate limit; skipped until ${until}`);
    const opted = named.kind === 'local' ? d.settings.providers?.local === true : named.kind === 'cli' ? (d.settings.providers?.cli ?? []).some((a) => a === named.name) : (d.settings.providers?.hosted ?? []).includes(named.name);
    if (!opted)
        return back(`this instance hasn't opted into ${label} (policy.yaml settings.providers)`);
    if (named.kind === 'cli')
        return resolveCliAgent(req, req.route, named.name, label, d, back);
    const p = named.kind === 'local' ? d.cfg.agents.providers?.local : d.cfg.agents.providers?.hosted?.[named.name];
    if (!p)
        return back(`${label} is not configured (agents.yaml providers)`);
    const keyFile = d.providerKeys?.[p.credential];
    if (!keyFile)
        return back(`${label}'s key (${p.credential}) is not installed (credentials.yaml provider_keys)`);
    const refused = providerRefusal(named.kind, { route: req.route.kind, highRisk: req.route.highRisk === true });
    if (refused)
        return back(refused);
    // The instance's model cap holds for hosted models by their price tier; above it, the run takes its fallback,
    // which the cap then applies to as to any Anthropic run.
    const overCap = tierRefusal(named.kind, p.tier, d.settings.model_cap);
    if (overCap)
        return back(overCap);
    const gate = gatePasses(d.stateDir, req.role, p.model);
    if (!gate.ok)
        return back(`not evaluated to pass: ${gate.why}`);
    if (named.kind === 'local') {
        if (p.gpu_lock) {
            const held = (d.lockHeld ?? flockHeld)(p.gpu_lock);
            if (held !== false)
                return back(held ? `the GPU lock ${p.gpu_lock} is held by another workload` : `the GPU lock ${p.gpu_lock} can't be checked`);
        }
        const h = await healthCheck(p, d.fetch);
        if (!h.ok)
            return back(`the local model server is down or slow: ${h.why}`);
    }
    return { req: { ...req, model: p.model, provider: { name: label, kind: named.kind, baseUrl: p.base_url, keyFile } }, fellBack: null };
}
/** WHY: item 38. The same checks as a hosted model's, from the cli config: no key file (the CLI's login is the agent user's). */
function resolveCliAgent(req, route, agent, label, d, back) {
    const c = d.cfg.agents.providers?.cli?.[agent];
    if (!c)
        return back(`${label} is not configured (agents.yaml providers.cli)`);
    const refused = providerRefusal('cli', { route: route.kind, highRisk: route.highRisk === true });
    if (refused)
        return back(refused);
    const overCap = tierRefusal('cli', c.tier, d.settings.model_cap);
    if (overCap)
        return back(overCap);
    const gate = gatePasses(d.stateDir, req.role, c.model);
    if (!gate.ok)
        return back(`not evaluated to pass: ${gate.why}`);
    return { req: { ...req, model: c.model, provider: { name: label, kind: 'cli', agent, usdPerMtok: { in: c.usd_per_mtok_in, out: c.usd_per_mtok_out } } }, fellBack: null };
}
/**
 * WHY: item 38. Its run had no claude sandbox or hooks, so its change is held to more than a hosted model's: L1 or
 * below and no protected path, besides everything hostedChangeRefusal refuses.
 */
export function cliChangeRefusal(o) {
    const touched = o.files.map((f) => f.path).filter((p) => isProtectedPath(p, o.guardrails));
    if (touched.length)
        return `another vendor's CLI changed a protected path (${touched.slice(0, 3).join(', ')}), which it may never do`;
    const hosted = hostedChangeRefusal(o);
    if (hosted)
        return hosted.replace('a hosted model', "another vendor's CLI");
    let lvl;
    try {
        lvl = computeLevel({ files: o.files, labels: o.labels, moneyPaths: o.moneyPaths() }, o.review);
    }
    catch {
        return "another vendor's CLI made a change that can't be levelled, so it can't stand";
    }
    if (lvl.level !== 'L0' && lvl.level !== 'L1')
        return `another vendor's CLI made an ${lvl.level} change; it builds L1 work only`;
    return null;
}
/**
 * Why a change a hosted open model built may not stand (or null): it is L3, touches a money path, or changes agent
 * instructions (a skill, AGENTS.md, a role prompt). Hosted models never do that work; the task redoes it on Anthropic.
 */
export function hostedChangeRefusal(o) {
    if (instructionTargets(o.files.map((f) => f.path)).length)
        return 'a hosted model changed agent instructions, which it may never do';
    let lvl;
    try {
        lvl = computeLevel({ files: o.files, labels: o.labels, moneyPaths: o.moneyPaths() }, o.review);
    }
    catch {
        return "a hosted model's change can't be levelled, so it can't stand";
    }
    if ((lvl.categories['money-path'] ?? []).length)
        return 'a hosted model changed a money path, which it may never do';
    if (lvl.level === 'L3')
        return 'a hosted model made an L3 change, which it may never do';
    return null;
}
/** WHY: item 38. One place the build loop asks, so a cli: build can't skip its stricter check. */
export function builtChangeRefusal(provider, o) {
    if (provider?.startsWith('cli:'))
        return cliChangeRefusal(o);
    if (provider?.startsWith('hosted:'))
        return hostedChangeRefusal(o);
    return null;
}
//# sourceMappingURL=providers.js.map