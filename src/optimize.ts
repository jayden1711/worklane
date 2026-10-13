// The weekly optimization pass, its pure parts: the declared benchmarks (benchmarks.yaml), the targets (those
// benchmarks and the slowest tests the metrics recorded), the numbers (median and MAD over N runs), and the one
// rule that decides whether a change is an improvement: its median beats the baseline's by more than the noise,
// 2 x the larger MAD (and 1% of the baseline median, so a jitter-free benchmark still needs a real gain).
// Wired in src/coordinator/optimize.ts.
import { z } from 'zod';
import type { StoredEvent } from './events/types.js';

/** The label on an optimization task: it routes the build to the strongest model (src/model-routing.ts). */
export const OPTIMIZE_LABEL = 'optimize';
/** A `targets` entry standing for the slowest test the metrics recorded (testrun.durations, ci.test_durations). */
export const SLOWEST_TESTS = 'slowest_tests';
/** The event types item 27's metrics record per-test durations in; read by name, so an older log simply has none. */
export const DURATION_EVENTS = ['testrun.durations', 'ci.test_durations'] as const;
/** The smallest improvement that counts, as a fraction of the baseline median, whatever the spread. */
export const MIN_GAIN = 0.01;
const DAY = 24 * 3600_000;

/** A valid regular expression with at least one capture group. */
function groups1(p: string): boolean {
  try {
    return new RegExp(`${p}|`).exec('')!.length > 1;
  } catch {
    return false;
  }
}

const metric = z.union([
  /** The command's own wall-clock time, in ms. */
  z.literal('wall_ms'),
  /** A number the command prints: the first capture group of `pattern` (the last match in its output). */
  z.strictObject({
    pattern: z.string().min(1).refine(groups1, 'must be a regular expression with a capture group for the number'),
    unit: z.string().max(20).default(''),
  }),
]);

const benchmark = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,59}$/, 'lowercase letters, digits, _ . or -'),
  /** Run from the repo root, like a tests.yaml command. Its exit code must be 0 for a run to count. */
  command: z.string().min(1),
  /** How many times it runs on each side (main, then the change). */
  repeats: z.number().int().min(3).max(30).default(5),
  metric: metric.default('wall_ms'),
  lower_is_better: z.boolean().default(true),
  /** Optional: a command whose output (its end) goes in the agent's brief as the profile, run once on main. */
  profile: z.string().min(1).optional(),
});

/** benchmarks.yaml in the config folder: the project's declared benchmarks. No framework: a command and a number. */
export const BenchmarksConfig = z.strictObject({
  version: z.literal(1),
  benchmarks: z.array(benchmark).default([]),
});
export type BenchmarksConfig = z.infer<typeof BenchmarksConfig>;
export type Benchmark = z.infer<typeof benchmark>;

/** config.yaml `optimize`: the weekly pass, off by default. */
export const OptimizeConfig = z
  .strictObject({
    enabled: z.boolean().default(false),
    /** The day it runs: 0 Sunday ... 6 Saturday (local time). */
    weekday: z.number().int().min(0).max(6).default(0),
    /** Not before this time on that day (local, HH:MM). */
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM').default('02:00'),
    /** A hard stop: what its tasks may spend in a week (every run.cost of the week's optimization tasks). */
    budget_usd: z.number().positive().max(500).default(10),
    /** PRs it may open in a week. */
    max_prs: z.number().int().min(1).max(5).default(1),
    /**
     * Which targets, in priority order: benchmark names from benchmarks.yaml, and `slowest_tests` for the slowest
     * test the metrics recorded. Empty: every benchmark, then the slowest test (when slow_test_command is set).
     */
    targets: z.array(z.string().min(1)).default([]),
    /**
     * How one slow test is run on its own, its wall time the metric: `{name}` is the test's name with every
     * character other than a letter, digit, `_` or `-` replaced by `.` (a regex wildcard), so it is safe unquoted
     * in any shell and works as a name filter (node --test-name-pattern, jest -t, go test -run).
     */
    slow_test_command: z.string().min(1).optional(),
    /** Runs on each side for a slow-test target. */
    repeats: z.number().int().min(3).max(30).default(5),
  })
  .prefault({});
export type OptimizeConfig = z.infer<typeof OptimizeConfig>;

/** A target the pass can pick: a declared benchmark, or one slow test. */
export interface Target {
  /** `bench:<name>` or `test:<test name>`: what attempts are recorded by. */
  key: string;
  label: string;
  command: string;
  repeats: number;
  metric: Benchmark['metric'];
  unit: string;
  lowerIsBetter: boolean;
  profile?: string;
}

/** The errors in an optimize config against the benchmarks declared (for the config's cross-check). */
export function optimizeProblems(o: OptimizeConfig, benchmarks: BenchmarksConfig | undefined): { path: string; message: string }[] {
  const names = new Set((benchmarks?.benchmarks ?? []).map((b) => b.name));
  const out: { path: string; message: string }[] = [];
  o.targets.forEach((t, i) => {
    if (t === SLOWEST_TESTS) {
      if (!o.slow_test_command) out.push({ path: `optimize.targets.${i}`, message: `${SLOWEST_TESTS} needs optimize.slow_test_command` });
    } else if (!names.has(t)) out.push({ path: `optimize.targets.${i}`, message: `no benchmark named ${t} in benchmarks.yaml` });
  });
  return out;
}

const safeName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '.');

/** The slowest test the metrics recorded in the week before `now`: the highest median of its recorded durations. */
export function slowestTests(events: readonly { type: string; ts: string; payload: unknown }[], now: number): { name: string; ms: number }[] {
  const by = new Map<string, number[]>();
  for (const e of events) {
    if (!(DURATION_EVENTS as readonly string[]).includes(e.type) || Date.parse(e.ts) < now - 7 * DAY) continue;
    for (const t of (e.payload as { tests?: { name: string; ms: number }[] }).tests ?? []) by.set(t.name, [...(by.get(t.name) ?? []), t.ms]);
  }
  return [...by].map(([name, ms]) => ({ name, ms: median(ms) })).sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name));
}

/** Every target, in priority order (config `targets`, else every benchmark then the slowest test). */
export function targets(o: OptimizeConfig, benchmarks: BenchmarksConfig | undefined, slow: { name: string; ms: number }[]): Target[] {
  const declared = benchmarks?.benchmarks ?? [];
  const order = o.targets.length ? o.targets : [...declared.map((b) => b.name), ...(o.slow_test_command ? [SLOWEST_TESTS] : [])];
  const out: Target[] = [];
  for (const t of order) {
    if (t === SLOWEST_TESTS) {
      const top = slow[0];
      if (!top || !o.slow_test_command) continue;
      out.push({ key: `test:${top.name}`, label: `the slowest test, ${top.name} (median ${Math.round(top.ms)} ms this week)`, command: o.slow_test_command.replaceAll('{name}', safeName(top.name)), repeats: o.repeats, metric: 'wall_ms', unit: 'ms', lowerIsBetter: true });
      continue;
    }
    const b = declared.find((x) => x.name === t);
    if (!b) continue;
    out.push({ key: `bench:${b.name}`, label: `the benchmark ${b.name}`, command: b.command, repeats: b.repeats, metric: b.metric, unit: b.metric === 'wall_ms' ? 'ms' : b.metric.unit, lowerIsBetter: b.lower_is_better, ...(b.profile ? { profile: b.profile } : {}) });
  }
  return out;
}

/** A target by its key, as the config now declares it (null: no longer declared). */
export function targetByKey(key: string, o: OptimizeConfig, benchmarks: BenchmarksConfig | undefined): Target | null {
  if (key.startsWith('test:')) {
    const name = key.slice('test:'.length);
    return o.slow_test_command ? targets({ ...o, targets: [SLOWEST_TESTS] }, undefined, [{ name, ms: 0 }]).map((t) => ({ ...t, label: `the slow test ${name}` }))[0] ?? null : null;
  }
  return targets({ ...o, targets: [key.slice('bench:'.length)] }, benchmarks, [])[0] ?? null;
}

/** Due on `weekday` at or after `at` (local time), when the last pass started 6 or more days ago (or never). */
export function optimizeDue(now: Date, lastStartedAt: string | null, o: Pick<OptimizeConfig, 'weekday' | 'at'>): boolean {
  if (now.getDay() !== o.weekday) return false;
  const [h, m] = o.at.split(':').map(Number) as [number, number];
  const slot = new Date(now);
  slot.setHours(h, m, 0, 0);
  if (now.getTime() < slot.getTime()) return false;
  return lastStartedAt === null || now.getTime() - Date.parse(lastStartedAt) >= 6 * DAY;
}

/** The top target: the first one in priority order never tried, else the one tried longest ago. */
export function pickTarget(all: Target[], lastTried: (key: string) => number | null): Target | null {
  if (!all.length) return null;
  const never = all.find((t) => lastTried(t.key) === null);
  if (never) return never;
  return [...all].sort((a, b) => lastTried(a.key)! - lastTried(b.key)!)[0]!;
}

/** One run's number: its wall time, or the last match of the metric's pattern in its output. Null: none printed. */
export function readMetric(m: Benchmark['metric'], out: string, wallMs: number): number | null {
  if (m === 'wall_ms') return wallMs;
  const re = new RegExp(m.pattern, 'g');
  let last: number | null = null;
  for (const x of out.matchAll(re)) {
    const n = Number(x[1]);
    if (Number.isFinite(n)) last = n;
  }
  return last;
}

export function median(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The median absolute deviation: the spread, robust to one slow outlier. */
export function mad(xs: readonly number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

export interface Sample {
  runs: number[];
  median: number;
  mad: number;
}

export const sample = (runs: number[]): Sample => ({ runs, median: median(runs), mad: mad(runs) });

export interface Verdict {
  improved: boolean;
  /** How much better the change's median is (in the metric's unit; negative: worse). */
  gain: number;
  /** As a percentage of the baseline median. */
  pct: number;
  /** What a gain must beat: 2 x the larger MAD, at least MIN_GAIN of the baseline median. */
  noise: number;
  why: string;
}

/** The rule: an improvement only when the change's median beats the baseline's by more than the noise. */
export function judge(before: Sample, after: Sample, lowerIsBetter: boolean, unit = ''): Verdict {
  const gain = lowerIsBetter ? before.median - after.median : after.median - before.median;
  const noise = Math.max(2 * Math.max(before.mad, after.mad), MIN_GAIN * Math.abs(before.median));
  const pct = before.median ? (gain / Math.abs(before.median)) * 100 : 0;
  const u = unit ? ` ${unit}` : '';
  const nums = `median ${fmt(before.median)}${u} before, ${fmt(after.median)}${u} after (${gain >= 0 ? '' : '-'}${fmt(Math.abs(gain))}${u} ${gain >= 0 ? 'better' : 'worse'}, ${fmt(pct)}%); noise ${fmt(noise)}${u} (2 x MAD, at least ${MIN_GAIN * 100}% of the baseline)`;
  if (gain <= 0) return { improved: false, gain, pct, noise, why: `no improvement: ${nums}` };
  if (gain <= noise) return { improved: false, gain, pct, noise, why: `within the noise: ${nums}` };
  return { improved: true, gain, pct, noise, why: `improved: ${nums}` };
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) >= 100 ? 0 : 2));

/** The task's brief: what to change, and the one rule it is measured by. Its done_when is the full suite. */
export function optimizeIssue(t: Target, base: Sample, sha: string, profile: string): { title: string; body: string } {
  const u = t.unit ? ` ${t.unit}` : '';
  return {
    title: `Optimize ${t.key}: median ${fmt(base.median)}${u}`,
    body: [
      `**Outcome:** ${t.label} gets measurably ${t.lowerIsBetter ? 'lower' : 'higher'}: \`${t.command}\`, ${t.repeats} runs, ${t.metric === 'wall_ms' ? 'its wall time' : `the number it prints (\`${t.metric.pattern}\`)`}.`,
      `**Baseline:** on main \`${sha.slice(0, 12)}\`: median ${fmt(base.median)}${u}, MAD ${fmt(base.mad)}${u}; runs: ${base.runs.map(fmt).join(', ')}.`,
      `**Constraints:** change only what improves this number. Same behavior; every test passes. No new dependencies, no change to tests, config or the benchmark itself. The coordinator re-runs the benchmark ${t.repeats} times on your change: it becomes a PR only if the median beats the baseline by more than 2 x the spread (MAD); otherwise it is discarded.`,
      '**Profile** (the end of its output on main):',
      '```',
      profile.replace(/`{3,}/g, "'''").slice(-4000) || '(no output)',
      '```',
      '```done_when',
      '- suite: full',
      '```',
    ].join('\n'),
  };
}

/** The PR body's measurement section: before and after, and every raw run. */
export function prLines(target: string, unit: string, lowerIsBetter: boolean, before: Sample & { sha: string }, after: Sample & { sha: string }, v: Pick<Verdict, 'gain' | 'pct' | 'noise'>): string[] {
  const u = unit ? ` ${unit}` : '';
  return [
    `**Optimization** (\`${target}\`, ${lowerIsBetter ? 'lower' : 'higher'} is better): median ${fmt(before.median)}${u} → ${fmt(after.median)}${u}, ${fmt(v.gain)}${u} better (${fmt(v.pct)}%), beyond the noise of ${fmt(v.noise)}${u}.`,
    '',
    '| | commit | median | MAD | runs |',
    '|---|---|---|---|---|',
    `| before (main) | \`${before.sha.slice(0, 12)}\` | ${fmt(before.median)} | ${fmt(before.mad)} | ${before.runs.map(fmt).join(', ')} |`,
    `| after | \`${after.sha.slice(0, 12)}\` | ${fmt(after.median)} | ${fmt(after.mad)} | ${after.runs.map(fmt).join(', ')} |`,
  ];
}

/**
 * The PR body's measurement section, from an issue's events: the improved result at `head` and its pass (for the
 * unit). None for any PR that is not an optimization measured at that head.
 */
export function optimizePrLines(events: readonly Pick<StoredEvent, 'type' | 'payload'>[], head: string): string[] {
  type R = { target: string; head: string | null; outcome: string; before: (Sample & { sha: string }) | null; after: (Sample & { sha: string }) | null; gain: number | null; pct: number | null; noise: number | null };
  const r = events.filter((e) => e.type === 'optimize.result').map((e) => e.payload as R).filter((x) => x.head === head && x.outcome === 'improved').at(-1);
  const pass = events.filter((e) => e.type === 'optimize.pass').map((e) => e.payload as { unit: string; lower_is_better: boolean }).at(-1);
  if (!r?.before || !r.after || !pass) return [];
  return prLines(r.target, pass.unit, pass.lower_is_better, r.before, r.after, { gain: r.gain ?? 0, pct: r.pct ?? 0, noise: r.noise ?? 0 });
}
