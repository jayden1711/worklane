// Open-model providers: a model can name one instead of an Anthropic model. `local` is a small model behind an
// Anthropic-compatible server on this machine (directly, or through a translating proxy in front of an
// OpenAI-compatible server); `hosted:<name>` is a hosted open model the owner configured. The runner keeps using
// the claude CLI, with ANTHROPIC_BASE_URL set for the run and the key reaching claude only through apiKeyHelper
// (a 0400 file the agent user's claude reads), never an environment variable. What each provider may do is fixed
// here, in code: local for the intake replier, intake triage and the stage judge; hosted for easy builds and
// research, never for high-risk, L3, money-path or agent-instructions work, and never for the evaluator at L1+.
// WHY: item 38. `cli:<agent>` is another vendor's coding CLI (src/cli-agents.ts): builds only, never high-risk, and a change it
// makes stands only at L1 or below, off protected paths (cliChangeRefusal in src/coordinator/providers.ts).
// A role uses an open model only if this instance opted in, the role passed its held-out evals on that model, and
// the provider is up; otherwise it runs on its normal model, and the fallback is recorded.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_TIERS } from './model-routing.js';
export const CLI_AGENTS = ['codex', 'gemini'];
/** A model setting that names a provider: `local`, `hosted:<name>` or `cli:<agent>`; null for a plain (Anthropic) model. */
export function providerOf(model) {
    if (model === 'local')
        return { kind: 'local', name: 'local' };
    // WHY: any cli:<x> is a provider, so an unknown agent is refused as unconfigured, never sent to claude as a model.
    const cli = /^cli:([a-z0-9][a-z0-9_-]{0,40})$/.exec(model);
    if (cli)
        return { kind: 'cli', name: cli[1] };
    const m = /^hosted:([a-z0-9][a-z0-9_-]{0,40})$/.exec(model);
    return m ? { kind: 'hosted', name: m[1] } : null;
}
/** What each kind of provider may run (code, not config). Builds here are the L1/L2 build route only. */
export const PROVIDER_USES = {
    local: ['intake_replier', 'intake_triage', 'stage_judge'],
    // cross_eval: the optional second verdict on a protected change (src/cross-eval.ts); it can only hold, never pass.
    hosted: ['build', 'research', 'cross_eval'],
    cli: ['build'],
};
/** Why a provider may not run this, or null. Hosted never gets high-risk work (labels, escalation, L3). */
export function providerRefusal(kind, use) {
    if (use.route === 'evaluator')
        return 'the evaluator never runs on an open model at L1+';
    if (!PROVIDER_USES[kind].includes(use.route))
        return `${kind} models run only ${PROVIDER_USES[kind].join(', ')}, not ${use.route}`;
    // The second verdict is read-only and only ever adds a hold, so a high-risk change is exactly where it runs.
    if (use.route === 'cross_eval')
        return null;
    if (kind === 'hosted' && use.highRisk)
        return 'hosted models never build high-risk, L3, money-path or agent-instructions work';
    if (kind === 'cli' && use.highRisk)
        return 'another vendor\'s CLI never builds high-risk work: L1 builds only';
    return null;
}
/**
 * Why a hosted model may not run under the instance's model cap (or null): it declares no price tier, or its tier is
 * above the cap. Local models cost nothing and have no tier.
 */
export function tierRefusal(kind, tier, cap) {
    if (kind === 'local')
        return null;
    if (!tier)
        return 'it has no price tier declared (agents.yaml providers.hosted.<name>.tier): a hosted model without one never runs';
    if (cap && MODEL_TIERS.indexOf(tier) > MODEL_TIERS.indexOf(cap))
        return `its price tier (${tier}) is above this instance's model cap (${cap})`;
    return null;
}
/** The provider's host, for the network allowlist and the report. */
export function providerHost(p) {
    return new URL(p.base_url).hostname;
}
/** A local server is up when it answers quickly; anything else (an error, a timeout, too slow) is down. */
export async function healthCheck(p, fetchImpl = fetch, now = Date.now) {
    const cap = p.latency_ms ?? 3000;
    const started = now();
    try {
        const r = await fetchImpl(new URL('/v1/models', p.base_url), { method: 'GET', signal: AbortSignal.timeout(cap) });
        const ms = now() - started;
        if (ms > cap)
            return { ok: false, why: `answered in ${ms} ms, over the ${cap} ms cap` };
        if (r.status >= 500)
            return { ok: false, why: `answered ${r.status}` };
        return { ok: true, ms };
    }
    catch (e) {
        return { ok: false, why: `unreachable: ${e.message.slice(0, 120)}` };
    }
}
/** The eval gate's record: a role may run on a provider's model only once it passed its evals there. */
export const PROVIDER_GATE_FILE = join('evals', 'provider-gate.json');
/** Whether `role` passed on `model` (the provider's id): held-out not below the baseline, at 3 samples or more. */
export function gatePasses(stateDir, role, model) {
    const f = join(stateDir, PROVIDER_GATE_FILE);
    let gate = {};
    try {
        if (existsSync(f))
            gate = JSON.parse(readFileSync(f, 'utf8'));
    }
    catch {
        return { ok: false, why: `the eval gate record (${f}) can't be read` };
    }
    const e = gate[role]?.[model];
    if (!e)
        return { ok: false, why: `${role} has no eval on ${model} on record` };
    if (e.samples < 3)
        return { ok: false, why: `${role} on ${model} was evaluated at ${e.samples} sample(s); 3 are needed` };
    if (e.held_out.passed < e.baseline.passed || e.held_out.total !== e.baseline.total)
        return { ok: false, why: `${role} scored lower held-out on ${model} (${e.held_out.passed}/${e.held_out.total} vs ${e.baseline.passed}/${e.baseline.total})` };
    return { ok: true };
}
/** A run's estimated cost on a provider: local is free; hosted, from the configured prices, else unknown (null). */
export function providerCost(kind, p, tokens) {
    if (kind === 'local')
        return 0;
    if (p.usd_per_mtok_in === undefined || p.usd_per_mtok_out === undefined)
        return null;
    return (tokens.in * p.usd_per_mtok_in + tokens.out * p.usd_per_mtok_out) / 1_000_000;
}
//# sourceMappingURL=providers.js.map