// Machine health for the dashboard: memory, swap, load and disk for the
// machine, and memory and CPU for the harness's slice and this instance's
// service; how long each check takes and which got slower; what the agent
// runs used per day. Pure: the event log and a stats snapshot (the OS
// adapter's machineStats, src/os/stats.ts) in, a view and suggestions out.
// Anything the stats couldn't read stays null here, never guessed.
import type { StoredEvent } from './events/types.js';
import type { MachineStats } from './os/stats.js';
import { mergeMetrics, type MergeMetrics } from './merge-metrics.js';

export type { MachineStats } from './os/stats.js';

/** When a check counts as having got slower: the median of its last `recent` runs against the median of up to `prior` runs before them. */
export const REGRESSION = { recent: 5, prior: 20, minPrior: 5, slowerBy: 0.25, minDeltaMs: 2_000 } as const;

export interface CheckTiming {
  check: string;
  runs: number;
  /** Oldest first: when it ran, how long it took, how it ended. */
  series: { at: string; ms: number; status: string }[];
  recentMedianMs: number;
  priorMedianMs: number | null;
  /** Got slower by REGRESSION's rule: (recent - prior) / prior. */
  regression: { slowerPct: number } | null;
}

export interface UsageDay {
  day: string;
  runs: number;
  /** The agent CLI's own per-run cost estimates, summed: not money billed. */
  estimatedUsd: number;
  turns: number;
  /** Runs that ended on the usage limit. */
  rateLimited: number;
  /** Login trouble: a run stopped on a login mismatch, or a retry to refresh the login's token. */
  authProblems: number;
  /** Retries after a transient error, by cause (token_refresh, rate_limit, overloaded, server_error, network, other). */
  retries: Record<string, number>;
  retryWaitMs: number;
  /** Waits of a second or more for a login another run was using. */
  lockWaits: number;
  lockWaitMs: number;
}

export interface HealthView {
  instance: string | null;
  /** The OS adapter's snapshot, as read; null if it couldn't be taken. */
  machine: MachineStats | null;
  cores: number | null;
  checks: { timings: CheckTiming[]; slowest: string[]; regressions: string[]; rule: string };
  usage: { days: UsageDay[]; quotaNote: string };
  /** What conflict fixes, light checks and hotspot holds cost per merged PR, over the last MERGE_DAYS days. */
  merge: MergeMetrics;
  suggestions: string[];
}

/** The window the merge-flow figures cover. */
export const MERGE_DAYS = 7;

/** A merge-metrics flag ("X adds N min per merged PR: consider Y") as a suggestion: "Consider Y (X adds N min per merged PR)." */
export function mergeFlagSuggestion(flag: string): string {
  const i = flag.indexOf(': consider ');
  if (i < 0) return /^consider /i.test(flag) ? `C${flag.slice(1)}` : `Consider looking at this: ${flag}`;
  const cost = flag.slice(0, i);
  const what = flag.slice(i + ': consider '.length).replace(/\.$/, '');
  return `Consider ${what} (${cost.charAt(0).toLowerCase()}${cost.slice(1)}).`;
}

export const QUOTA_NOTE = "How much of the Claude subscription's usage limit is left isn't visible to this harness: it counts only its own runs, their estimated cost, and the rate-limit replies they got.";

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Each check's run times (verify-stage check.result duration_ms, recorded when it ran), oldest first, with the slowest and the ones that got slower. */
export function checkTimings(events: StoredEvent[], keep = 30): HealthView['checks'] {
  const by = new Map<string, { at: string; ms: number; status: string }[]>();
  for (const e of events) {
    // Verify-stage checks are the project's commands, the same each run; a landing's entries are notes about one batch.
    if (e.type !== 'check.result' || (e.payload as { stage?: string }).stage !== 'verify') continue;
    for (const c of (e.payload as { checks: { check: string; status: string; duration_ms?: number }[] }).checks) {
      if (c.duration_ms === undefined) continue; // not run (skipped, busy) or recorded before durations were
      by.set(c.check, [...(by.get(c.check) ?? []), { at: e.ts, ms: c.duration_ms, status: c.status }]);
    }
  }
  const timings: CheckTiming[] = [...by].map(([check, all]) => {
    const recent = all.slice(-REGRESSION.recent);
    const prior = all.slice(-(REGRESSION.recent + REGRESSION.prior), -REGRESSION.recent);
    const recentMedianMs = median(recent.map((x) => x.ms));
    const priorMedianMs = prior.length >= REGRESSION.minPrior ? median(prior.map((x) => x.ms)) : null;
    const slower = priorMedianMs ? (recentMedianMs - priorMedianMs) / priorMedianMs : 0;
    const regression = recent.length >= REGRESSION.recent && priorMedianMs !== null && slower > REGRESSION.slowerBy && recentMedianMs - priorMedianMs >= REGRESSION.minDeltaMs ? { slowerPct: Math.round(slower * 100) } : null;
    return { check, runs: all.length, series: all.slice(-keep), recentMedianMs, priorMedianMs, regression };
  });
  timings.sort((a, b) => b.recentMedianMs - a.recentMedianMs);
  return {
    timings,
    slowest: timings.slice(0, 3).map((t) => t.check),
    regressions: timings.filter((t) => t.regression).map((t) => t.check),
    rule: `slower: the median of the last ${REGRESSION.recent} runs is more than ${REGRESSION.slowerBy * 100}% (and ${REGRESSION.minDeltaMs / 1000} s) over the median of up to ${REGRESSION.prior} runs before them`,
  };
}

/** What the agent runs used, per day (UTC), newest first. */
export function usageByDay(events: StoredEvent[], days = 14): UsageDay[] {
  const out = new Map<string, UsageDay>();
  const day = (ts: string) => {
    const d = ts.slice(0, 10);
    let u = out.get(d);
    if (!u) out.set(d, (u = { day: d, runs: 0, estimatedUsd: 0, turns: 0, rateLimited: 0, authProblems: 0, retries: {}, retryWaitMs: 0, lockWaits: 0, lockWaitMs: 0 }));
    return u;
  };
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case 'run.started':
        day(e.ts).runs++;
        break;
      case 'run.cost': {
        const u = day(e.ts);
        u.estimatedUsd += Number(p.usd) || 0;
        u.turns += Number(p.turns) || 0;
        break;
      }
      case 'run.finished':
        if (p.reason === 'rate_limited') day(e.ts).rateLimited++;
        if (p.reason === 'auth_mismatch') day(e.ts).authProblems++;
        break;
      case 'run.transient_retry': {
        const u = day(e.ts);
        const cause = String(p.cause);
        u.retries[cause] = (u.retries[cause] ?? 0) + 1;
        u.retryWaitMs += Number(p.wait_ms) || 0;
        if (cause === 'token_refresh') u.authProblems++;
        break;
      }
      case 'run.lock_waited': {
        const u = day(e.ts);
        u.lockWaits++;
        u.lockWaitMs += Number(p.wait_ms) || 0;
        break;
      }
    }
  }
  return [...out.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, days).map((u) => ({ ...u, estimatedUsd: Math.round(u.estimatedUsd * 100) / 100 }));
}

const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;
const secs = (ms: number) => `${Math.round(ms / 1000)} s`;

/** Conservative thresholds: below them, nothing is suggested. */
export const THRESHOLDS = { memoryAvailablePct: 10, swapUsedPct: 25, unitMemoryPct: 90, diskFreePct: 10, diskFreeGb: 10, rateLimitsPerDay: 3, lockWaitMinPerDay: 30, loadPerCore: 1.5 } as const;

/** Suggestions only, each a "consider", never a change made; one line saying so when there's nothing to suggest. */
export function suggestions(v: Omit<HealthView, 'suggestions'>, o: { today?: string; diskLabels?: Record<string, string> } = {}): string[] {
  const today = o.today ?? new Date().toISOString().slice(0, 10);
  const out: string[] = [];
  const m = v.machine;
  if (m?.memory && m.memory.totalBytes > 0) {
    const pct = (m.memory.availableBytes / m.memory.totalBytes) * 100;
    if (pct < THRESHOLDS.memoryAvailablePct) out.push(`Consider running fewer agents at once (the policy's max_workers): only ${Math.round(pct)}% of memory (${gb(m.memory.availableBytes)}) is available.`);
  }
  if (m?.memory && m.memory.swapTotalBytes > 0) {
    const pct = ((m.memory.swapTotalBytes - m.memory.swapFreeBytes) / m.memory.swapTotalBytes) * 100;
    if (pct > THRESHOLDS.swapUsedPct) out.push(`Consider running fewer agents at once: ${Math.round(pct)}% of swap is in use, which slows every run.`);
  }
  for (const u of m?.units ?? []) {
    if ('error' in u || u.memoryCurrent === null || !u.memoryMax) continue;
    const pct = (u.memoryCurrent / u.memoryMax) * 100;
    if (pct >= THRESHOLDS.unitMemoryPct) out.push(`Consider raising ${u.unit}'s memory limit (MemoryMax) or running fewer agents: it is at ${Math.round(pct)}% of it.`);
  }
  if (m?.load && v.cores && m.load[1] / v.cores > THRESHOLDS.loadPerCore) out.push(`Consider running fewer agents at once: the 5-minute load (${m.load[1].toFixed(1)}) is over ${THRESHOLDS.loadPerCore}× the ${v.cores} cores.`);
  for (const d of m?.disks ?? []) {
    if ('error' in d || d.totalBytes <= 0) continue;
    const pct = (d.freeBytes / d.totalBytes) * 100;
    if (pct < THRESHOLDS.diskFreePct || d.freeBytes / 1e9 < THRESHOLDS.diskFreeGb) out.push(`Consider freeing space on ${o.diskLabels?.[d.path] ?? d.path} (old worktrees, logs): ${gb(d.freeBytes)} (${Math.round(pct)}%) free.`);
  }
  const t = v.usage.days.find((u) => u.day === today);
  if (t && t.rateLimited >= THRESHOLDS.rateLimitsPerDay) out.push(`Consider fewer agents at once or spreading work over the day: ${t.rateLimited} runs hit the usage limit today.`);
  if (t && t.lockWaitMs / 60_000 >= THRESHOLDS.lockWaitMinPerDay) out.push(`Consider fewer agents at once: runs waited ${Math.round(t.lockWaitMs / 60_000)} min today for a login another run was using.`);
  for (const f of v.merge.flags) out.push(mergeFlagSuggestion(f));
  for (const name of v.checks.regressions) {
    const c = v.checks.timings.find((x) => x.check === name)!;
    out.push(`Consider looking at why "${name}" got slower: a median of ${secs(c.recentMedianMs)} over its last ${REGRESSION.recent} runs, against ${secs(c.priorMedianMs!)} before (+${c.regression!.slowerPct}%).`);
  }
  return out.length ? out : ['Nothing to suggest: memory, disk, load, usage and check times are within the usual limits.'];
}

/** The whole health view. */
export function healthView(events: StoredEvent[], machine: MachineStats | null, o: { cores?: number | null; today?: string; diskLabels?: Record<string, string>; now?: Date } = {}): HealthView {
  const started = [...events].reverse().find((e) => e.type === 'coordinator.started')?.payload as { instance?: string } | undefined;
  const since = new Date((o.now ?? new Date()).getTime() - MERGE_DAYS * 86_400_000);
  const base = { instance: started?.instance ?? null, machine, cores: o.cores ?? null, checks: checkTimings(events), usage: { days: usageByDay(events), quotaNote: QUOTA_NOTE }, merge: mergeMetrics(events, { since }) };
  return { ...base, suggestions: suggestions(base, o) };
}
