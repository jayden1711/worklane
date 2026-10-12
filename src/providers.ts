// Open-model providers: a model can name one instead of an Anthropic model. `local` is a small model behind an
// Anthropic-compatible server on this machine (directly, or through a translating proxy in front of an
// OpenAI-compatible server); `hosted:<name>` is a hosted open model the owner configured. The runner keeps using
// the claude CLI, with ANTHROPIC_BASE_URL set for the run and the key reaching claude only through apiKeyHelper
// (a 0400 file the agent user's claude reads), never an environment variable. What each provider may do is fixed
// here, in code: local for the intake replier, intake triage and the stage judge; hosted for easy builds and
// research, never for high-risk, L3, money-path or agent-instructions work, and never for the evaluator at L1+.
// A role uses an open model only if this instance opted in, the role passed its held-out evals on that model, and
// the provider is up; otherwise it runs on its normal model, and the fallback is recorded.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoutedRun } from './model-routing.js';

export type ProviderKind = 'local' | 'hosted';

export interface ProviderConfig {
  /** Anthropic-compatible endpoint: the runner sets ANTHROPIC_BASE_URL to it for the run. */
  base_url: string;
  /** The credential's name: its key file comes from the instance's credentials.yaml provider_keys, never the repo. */
  credential: string;
  /** The provider's own model id, passed to claude --model. */
  model: string;
  /** Estimated price per million tokens, in and out (hosted); local runs cost nothing. */
  usd_per_mtok_in?: number | undefined;
  usd_per_mtok_out?: number | undefined;
  /** Local: a GPU lock another workload holds while it runs (flock); while it's held, local runs fall back. */
  gpu_lock?: string | undefined;
  /** Local: the health check's latency cap; slower (or down) means fall back. */
  latency_ms?: number | undefined;
}

/** A model setting that names a provider: `local`, or `hosted:<name>`; null for a plain (Anthropic) model. */
export function providerOf(model: string): { kind: ProviderKind; name: string } | null {
  if (model === 'local') return { kind: 'local', name: 'local' };
  const m = /^hosted:([a-z0-9][a-z0-9_-]{0,40})$/.exec(model);
  return m ? { kind: 'hosted', name: m[1]! } : null;
}

/** What each kind of provider may run (code, not config). Builds here are the L1/L2 build route only. */
export const PROVIDER_USES: Record<ProviderKind, readonly (RoutedRun | 'build')[]> = {
  local: ['intake_replier', 'intake_triage', 'stage_judge'],
  hosted: ['build', 'research'],
};

/** Why a provider may not run this, or null. Hosted never gets high-risk work (labels, escalation, L3). */
export function providerRefusal(kind: ProviderKind, use: { route: RoutedRun | 'build' | 'evaluator' | 'other'; highRisk?: boolean }): string | null {
  if (use.route === 'evaluator') return 'the evaluator never runs on an open model at L1+';
  if (!(PROVIDER_USES[kind] as readonly string[]).includes(use.route)) return `${kind} models run only ${PROVIDER_USES[kind].join(', ')}, not ${use.route}`;
  if (kind === 'hosted' && use.highRisk) return 'hosted models never build high-risk, L3, money-path or agent-instructions work';
  return null;
}

/** The provider's host, for the network allowlist and the report. */
export function providerHost(p: Pick<ProviderConfig, 'base_url'>): string {
  return new URL(p.base_url).hostname;
}

/** A local server is up when it answers quickly; anything else (an error, a timeout, too slow) is down. */
export async function healthCheck(p: Pick<ProviderConfig, 'base_url' | 'latency_ms'>, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<{ ok: true; ms: number } | { ok: false; why: string }> {
  const cap = p.latency_ms ?? 3000;
  const started = now();
  try {
    const r = await fetchImpl(new URL('/v1/models', p.base_url), { method: 'GET', signal: AbortSignal.timeout(cap) });
    const ms = now() - started;
    if (ms > cap) return { ok: false, why: `answered in ${ms} ms, over the ${cap} ms cap` };
    if (r.status >= 500) return { ok: false, why: `answered ${r.status}` };
    return { ok: true, ms };
  } catch (e) {
    return { ok: false, why: `unreachable: ${(e as Error).message.slice(0, 120)}` };
  }
}

/** The eval gate's record: a role may run on a provider's model only once it passed its evals there. */
export const PROVIDER_GATE_FILE = join('evals', 'provider-gate.json');

export interface GateEntry {
  /** Held-out score on the provider's model, and on the role's normal model, as rubric items met. */
  held_out: { passed: number; total: number };
  baseline: { passed: number; total: number };
  visible: { passed: number; total: number };
  samples: number;
  at: string;
}

/** Whether `role` passed on `model` (the provider's id): held-out not below the baseline, at 3 samples or more. */
export function gatePasses(stateDir: string, role: string, model: string): { ok: true } | { ok: false; why: string } {
  const f = join(stateDir, PROVIDER_GATE_FILE);
  let gate: Record<string, Record<string, GateEntry>> = {};
  try {
    if (existsSync(f)) gate = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return { ok: false, why: `the eval gate record (${f}) can't be read` };
  }
  const e = gate[role]?.[model];
  if (!e) return { ok: false, why: `${role} has no eval on ${model} on record` };
  if (e.samples < 3) return { ok: false, why: `${role} on ${model} was evaluated at ${e.samples} sample(s); 3 are needed` };
  if (e.held_out.passed < e.baseline.passed || e.held_out.total !== e.baseline.total) return { ok: false, why: `${role} scored lower held-out on ${model} (${e.held_out.passed}/${e.held_out.total} vs ${e.baseline.passed}/${e.baseline.total})` };
  return { ok: true };
}

/** A run's estimated cost on a provider: local is free; hosted, from the configured prices, else unknown (null). */
export function providerCost(kind: ProviderKind, p: Pick<ProviderConfig, 'usd_per_mtok_in' | 'usd_per_mtok_out'>, tokens: { in: number; out: number }): number | null {
  if (kind === 'local') return 0;
  if (p.usd_per_mtok_in === undefined || p.usd_per_mtok_out === undefined) return null;
  return (tokens.in * p.usd_per_mtok_in + tokens.out * p.usd_per_mtok_out) / 1_000_000;
}
