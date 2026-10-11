// Measure, then suggest: per-project test tuning from what the harness has measured (check durations, the
// machine's cores and memory, and a profile from `tune` when there is one). Pure: numbers in, proposals out.
// A proposal is a decision for the owner, with the numbers; nothing changes until they answer, and the
// change itself then goes through a reviewed PR.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FailureProposal } from './failure-modes.js';

export type TuningProposal = FailureProposal;

/** One suite run at a given worker count, from `tune`. */
export interface ProfileRun {
  workers: number;
  seconds: number;
  ok: boolean;
  /** The largest single process's peak memory (one test worker), when the OS reports it. */
  peakWorkerMb: number | null;
}

/** What `tune` measured, kept in the instance's state. */
export interface TuneProfile {
  at: string;
  command: string;
  cores: number;
  memAvailableMb: number | null;
  runs: ProfileRun[];
  /** The slowest tests, when the runner reports per-test times. */
  slowTests?: { id: string; seconds: number }[];
}

export const TUNING = {
  /** A worker count is "as fast" as the best within this factor. */
  asFast: 1.1,
  /** Share of available memory test workers may use together. */
  memoryShare: 0.8,
  /** A full-suite check whose median is at least this long is worth splitting. */
  slowSuiteMin: 15,
  /** Runs needed before a median counts. */
  minSamples: 5,
  /** A test at least this slow is a candidate for the nightly tier. */
  slowTestSeconds: 30,
};

/**
 * The worker count to use: the fewest workers within `asFast` of the fastest passing run (more workers past
 * that point only take cores from other tasks), then no more than the memory available holds.
 */
export function recommendWorkers(runs: ProfileRun[], memAvailableMb: number | null): { workers: number; why: string } | null {
  const ok = runs.filter((r) => r.ok && r.seconds > 0);
  if (!ok.length) return null;
  const best = Math.min(...ok.map((r) => r.seconds));
  const fast = ok.filter((r) => r.seconds <= best * TUNING.asFast).sort((a, b) => a.workers - b.workers)[0]!;
  let workers = fast.workers;
  let why = `${fast.workers} worker(s) ran in ${fast.seconds.toFixed(0)} s, within ${Math.round((TUNING.asFast - 1) * 100)}% of the fastest (${best.toFixed(0)} s)`;
  const peak = Math.max(0, ...ok.map((r) => r.peakWorkerMb ?? 0));
  if (memAvailableMb && peak > 0) {
    const fits = Math.max(1, Math.floor((memAvailableMb * TUNING.memoryShare) / peak));
    if (fits < workers) {
      workers = fits;
      why += `; memory holds only ${fits} (${peak.toFixed(0)} MB per worker, ${memAvailableMb.toFixed(0)} MB available)`;
    }
  }
  return { workers, why };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
};
const minutes = (ms: number) => ms / 60_000;

export interface TuningInput {
  /** Verify-stage check durations, oldest first. */
  checks: { check: string; durationMs: number }[];
  /** The project's full-suite check (as it appears in check results). */
  fullCheck?: string;
  /** The worker cap in force now (tests.yaml cores.max, or a fixed worker count), if any. */
  currentWorkers: number | null;
  profile?: TuneProfile | null;
}

/** The profile `tune` left in the instance's state, if any. */
export function readTuneProfile(stateDir: string): TuneProfile | null {
  try {
    const p = JSON.parse(readFileSync(join(stateDir, 'tune-profile.json'), 'utf8')) as TuneProfile;
    return Array.isArray(p?.runs) ? p : null;
  } catch {
    return null;
  }
}

/** Variable names that usually hold a test worker count. */
export const WORKER_VAR = /WORKERS|JOBS|PARALLEL|THREADS|PROCS|CONCURRENCY/i;

/** The worker cap in force: tests.yaml cores.max, else a fixed number in a worker variable, else none. */
export function currentWorkerCap(tests: { cores?: { max?: number | undefined }; env: Record<string, string> }): number | null {
  if (tests.cores?.max !== undefined) return tests.cores.max;
  for (const [name, value] of Object.entries(tests.env)) if (WORKER_VAR.test(name) && /^\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * The tuning input from the event log: every verify-stage check's duration, and the full-suite check, which is
 * whichever of the candidates (runner.full and the project's checks) has the longest median among what ran.
 */
export function tuningInput(events: { type: string; payload: unknown }[], tests: { runner: { full: string }; checks: string[]; cores?: { max?: number | undefined }; env: Record<string, string> }, profile: TuneProfile | null): TuningInput {
  const checks = events
    .filter((e) => e.type === 'check.result' && (e.payload as { stage?: string }).stage === 'verify')
    .flatMap((e) => ((e.payload as { checks?: { check: string; duration_ms?: number; status: string }[] }).checks ?? []).filter((c) => c.status !== 'skipped' && typeof c.duration_ms === 'number').map((c) => ({ check: c.check, durationMs: c.duration_ms! })));
  const byMedian = [tests.runner.full, ...tests.checks]
    .map((check) => ({ check, med: median(checks.filter((c) => c.check === check).map((c) => c.durationMs)) }))
    .filter((x) => x.med > 0)
    .sort((a, b) => b.med - a.med);
  return { checks, ...(byMedian[0] ? { fullCheck: byMedian[0].check } : {}), currentWorkers: currentWorkerCap(tests), profile };
}

export function tuningProposals(input: TuningInput): TuningProposal[] {
  const out: TuningProposal[] = [];
  const p = input.profile;
  if (p) {
    const rec = recommendWorkers(p.runs, p.memAvailableMb);
    if (rec && rec.workers !== input.currentWorkers) {
      out.push({
        key: `tune:workers:${rec.workers}`,
        question: `Set the test worker cap to ${rec.workers} (now ${input.currentWorkers ?? 'not set'})?`,
        options: ['open a PR with this', 'leave it'],
        recommendation: 'open a PR with this',
        receipts: [
          `open a PR with this: tests.yaml cores.max ${rec.workers}, reviewed like any config change`,
          `why: ${rec.why}`,
          `profiled ${p.at.slice(0, 10)} on ${p.cores} cores: ${p.command}`,
          ...p.runs.map((r) => `${r.workers} worker(s): ${r.ok ? `${r.seconds.toFixed(0)} s` : 'failed'}${r.peakWorkerMb ? `, ${r.peakWorkerMb.toFixed(0)} MB per worker` : ''}`),
        ],
      });
    }
  }
  if (input.fullCheck) {
    const recent = input.checks.filter((c) => c.check === input.fullCheck).slice(-10);
    const med = minutes(median(recent.map((c) => c.durationMs)));
    if (recent.length >= TUNING.minSamples && med >= TUNING.slowSuiteMin) {
      const slow = (p?.slowTests ?? []).filter((t) => t.seconds >= TUNING.slowTestSeconds).sort((a, b) => b.seconds - a.seconds).slice(0, 10);
      out.push({
        key: `tune:split:${input.fullCheck}`,
        question: `${input.fullCheck} takes ${med.toFixed(0)} min (median of the last ${recent.length}); move the slowest tests to the nightly tier?`,
        options: slow.length ? ['open a PR moving these to nightly', 'leave it'] : ['profile the suite (tune) to name them', 'leave it'],
        recommendation: slow.length ? 'open a PR moving these to nightly' : 'profile the suite (tune) to name them',
        receipts: [
          slow.length ? `open a PR moving these to nightly: ${slow.length} test(s), ${slow.reduce((s, t) => s + t.seconds, 0).toFixed(0)} s together, run every night instead of on every attempt` : 'profile the suite (tune) to name them: no per-test times yet',
          ...slow.map((t) => `${t.id}: ${t.seconds.toFixed(0)} s`),
        ],
      });
    }
  }
  return out;
}
