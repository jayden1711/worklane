// The soak test's verdict (docs/soak.md; the run is test/soak.test.ts, scheduled by .github/workflows/soak.yml). A
// coordinator works for hours with stand-in agents; every SAMPLE it records what it holds. Pure: samples in, findings
// out. What fails a soak:
//   - a leak: heap, RSS or open file handles grown past the limit from the first quarter's median (after the warm-up), by
//     the highest of the last END_PEAK samples, the last quarter's median, or the robust slope over the run;
//   - a stuck run: an agent run open for longer than stuck_minutes at any sample; a run never finished at the end;
//   - log growth: the event log growing more per finished task than log_bytes_per_task (over the run, its last quarter
//     or its last 30 minutes), or its WAL past wal_bytes
//     (checkpoints stopped);
//   - drift: the last quarter's median tick slower than tick_drift times the first quarter's;
//   - leaked slots: agent slots held beyond the runs open at any sample after the warm-up, or any at the end;
//   - too little work: fewer finished tasks than min_tasks, or than min_landed_share of the tasks filed; stalled: none
//     landed in the last quarter while tasks were filed (a soak that did nothing, or stopped, proves nothing).

export interface SoakSample {
  /** Milliseconds since the soak started. */
  at: number;
  rss: number;
  heapUsed: number;
  /** Open file handles (null where the platform can't count them). */
  fds: number | null;
  eventsBytes: number;
  walBytes: number;
  /** Median tick time over the interval since the last sample. */
  tickMs: number;
  /** Tasks finished (landed) so far. */
  tasksDone: number;
  /** Tasks filed so far (the driver files one every SOAK_ISSUE_EVERY_S). */
  filed: number;
  /** Agent runs started and not finished, with the oldest one's age. */
  openRuns: number;
  oldestOpenRunMs: number;
  /** Agent slot files held. */
  slotsHeld: number;
}

export interface SoakLimits {
  warmupMs: number;
  heapGrowthBytes: number;
  rssGrowthBytes: number;
  fdGrowth: number;
  stuckMinutes: number;
  logBytesPerTask: number;
  walBytes: number;
  tickDrift: number;
  minTasks: number;
  /** At least this share of the tasks filed must have landed (the rest may be in flight). */
  minLandedShare: number;
  /** Tasks filed since the last landing, and that landing longer ago than this at the end: stalled. */
  stallMinutes: number;
}

export const SOAK_LIMITS: SoakLimits = {
  warmupMs: 10 * 60_000,
  heapGrowthBytes: 128 * 2 ** 20,
  rssGrowthBytes: 256 * 2 ** 20,
  fdGrowth: 32,
  stuckMinutes: 30,
  logBytesPerTask: 256 * 2 ** 10,
  walBytes: 64 * 2 ** 20,
  tickDrift: 3,
  minTasks: 1,
  minLandedShare: 0.5,
  stallMinutes: 5,
};

/**
 * Agent runs started and not finished at `now`, and the oldest one's age. Each run.finished closes the oldest open
 * run.started of the same issue and role. WHY (#1181 review): pairing by count took the newest open run's age once runs
 * finished out of order (two agent slots), so a run stuck for hours read as minutes, with its slot.
 */
export function openRunsOf(events: readonly { type: string; ts: string; payload: unknown }[], now: number): { open: number; oldestMs: number } {
  const open = new Map<string, string[]>();
  const key = (p: unknown) => {
    const o = p as { issue?: unknown; role?: unknown };
    return `${String(o.issue)}\u0000${String(o.role)}`;
  };
  for (const e of events) {
    if (e.type === 'run.started') open.set(key(e.payload), [...(open.get(key(e.payload)) ?? []), e.ts]);
    else if (e.type === 'run.finished') open.get(key(e.payload))?.shift();
  }
  const starts = [...open.values()].flat();
  return { open: starts.length, oldestMs: starts.length ? now - Math.min(...starts.map((t) => Date.parse(t))) : 0 };
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The end a leak is judged by too: the highest of its last this many samples. */
export const END_PEAK = 3;

const MB = (n: number) => `${(n / 2 ** 20).toFixed(1)} MB`;

/**
 * A robust slope (Theil-Sen: the median of every pair's slope) of `y` over `x`, per unit of x. WHY (#1181 review R1181d):
 * quarter medians read a linear leak at about 86% of its size; a slope over the run reads it whole, and one GC dip or
 * spike barely moves it.
 */
export function theilSen(points: readonly { x: number; y: number }[]): number {
  const slopes: number[] = [];
  // At most ~400 points (a sample a minute for 5.5 h): every pair is ~80k slopes.
  const pts = points.length > 400 ? points.filter((_, i) => i % Math.ceil(points.length / 400) === 0) : points;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) if (pts[j]!.x !== pts[i]!.x) slopes.push((pts[j]!.y - pts[i]!.y) / (pts[j]!.x - pts[i]!.x));
  return median(slopes);
}

/** What failed the soak (empty: it passed), and what it measured. */
export function soakVerdict(samples: readonly SoakSample[], limits: SoakLimits = SOAK_LIMITS, o: { expectedMs?: number } = {}): { failures: string[]; measured: Record<string, string | number> } {
  const failures: string[] = [];
  if (samples.length < 4) return { failures: [`only ${samples.length} sample(s): a soak needs at least 4 to compare its start and end`], measured: {} };
  // WHY (#1181 review): with too few samples past the warm-up, the warm-up's were judged instead, so a 4-minute run
  // passed as a soak. Too short is a failure; and a run must last (nearly) as long as it was asked to.
  const warm = samples.filter((s) => s.at >= limits.warmupMs);
  if (warm.length < 4) return { failures: [`too short: ${warm.length} sample(s) after the ${Math.round(limits.warmupMs / 60_000)}-minute warm-up (at least 4): nothing was judged`], measured: {} };
  const ran = samples.at(-1)!.at;
  if (o.expectedMs !== undefined && ran < o.expectedMs * 0.9) failures.push(`too short: it ran ${(ran / 3_600_000).toFixed(2)} h of the ${(o.expectedMs / 3_600_000).toFixed(2)} h asked for`);
  const use = warm;
  const q = Math.max(1, Math.floor(use.length / 4));
  const first = use.slice(0, q);
  const last = use.slice(-q);
  // Growth (heap, RSS, open file handles) is the largest of three readings, each against the first quarter's median.
  // WHY (#1181 reviews): quarter medians missed a late step or spike and under-read a linear leak.
  //   - the end: the highest of the last END_PEAK samples (the driver forces a GC before each, so a peak is held memory);
  //   - the last quarter's median;
  //   - the robust slope over the run after the warm-up, times its length (a slow leak, read whole).
  const growth = (pts: readonly SoakSample[], f: (s: SoakSample) => number) => {
    const fq = Math.max(1, Math.floor(pts.length / 4));
    const base = median(pts.slice(0, fq).map(f));
    const peakEnd = Math.max(...pts.slice(-END_PEAK).map(f)) - base;
    const lastQ = median(pts.slice(-fq).map(f)) - base;
    const slope = theilSen(pts.map((s) => ({ x: s.at, y: f(s) }))) * (pts.at(-1)!.at - pts[0]!.at);
    return Math.max(peakEnd, lastQ, slope);
  };
  const heap = growth(use, (s) => s.heapUsed);
  const rss = growth(use, (s) => s.rss);
  if (heap > limits.heapGrowthBytes) failures.push(`leak: the heap grew ${MB(heap)} (at the end, the last quarter or its slope over the run; limit ${MB(limits.heapGrowthBytes)})`);
  if (rss > limits.rssGrowthBytes) failures.push(`leak: RSS grew ${MB(rss)} (limit ${MB(limits.rssGrowthBytes)})`);
  // Open file handles are judged over the samples that counted them. WHY (#1181 review): one uncounted sample turned the
  // check off for the whole run. Most uncounted is a failure: a leak there couldn't be seen.
  const counted = use.filter((s) => s.fds !== null);
  let fds: number | null = null;
  if (counted.length * 2 < use.length) failures.push(`open file handles not counted in ${use.length - counted.length} of ${use.length} sample(s): a leak of them can't be judged`);
  else {
    fds = Math.round(growth(counted, (s) => s.fds!) * 10) / 10;
    if (fds > limits.fdGrowth) failures.push(`leak: open file handles grew by ${fds} (limit ${limits.fdGrowth})`);
  }
  const end = samples.at(-1)!;
  // Runs and slots at EVERY sample, not only the last (#1181 review R1181d): the driver samples after the coordinator's
  // idle(), when no run is in flight, so an open run then is one that never finished (it threw after it started), and a
  // held slot is a leaked one. A run stuck for hours that closed just before the end was missed, and so was a slot held
  // mid-run.
  const stuckAt = samples.find((s) => s.openRuns && s.oldestOpenRunMs > limits.stuckMinutes * 60_000);
  if (stuckAt) failures.push(`stuck: ${stuckAt.openRuns} agent run(s) open at minute ${Math.round(stuckAt.at / 60_000)}, the oldest for ${Math.round(stuckAt.oldestOpenRunMs / 60_000)} min (limit ${limits.stuckMinutes})`);
  if (end.openRuns) failures.push(`never finished: ${end.openRuns} agent run(s) started and not finished at the end (the oldest ${Math.round(end.oldestOpenRunMs / 60_000)} min): with nothing in flight at a sample, each is a run that ended without its record`);
  const leakAt = use.find((s) => s.slotsHeld > s.openRuns) ?? (end.slotsHeld ? end : undefined);
  if (leakAt) failures.push(`leaked slots: ${leakAt.slotsHeld} agent slot(s) held at minute ${Math.round(leakAt.at / 60_000)} with ${leakAt.openRuns} run(s) open`);
  // The log per landed task, over the whole run AND over its last quarter and its last stall_minutes x 6 (#1181 review
  // R1181d): a whole-run average hid a late surge and a second half over the limit.
  const rate = (a: SoakSample, b: SoakSample) => (b.tasksDone - a.tasksDone > 0 ? (b.eventsBytes - a.eventsBytes) / (b.tasksDone - a.tasksDone) : 0);
  const tailLog = samples.find((s) => s.at >= end.at - 30 * 60_000)!;
  const perTask = Math.max(rate(samples[0]!, end), rate(last[0]!, end), rate(tailLog, end));
  if (perTask > limits.logBytesPerTask) failures.push(`log growth: the event log grew ${Math.round(perTask / 1024)} KB per finished task (over the run, its last quarter or its last 30 min; limit ${Math.round(limits.logBytesPerTask / 1024)} KB)`);
  const wal = Math.max(...samples.map((s) => s.walBytes));
  if (wal > limits.walBytes) failures.push(`log growth: the WAL reached ${MB(wal)} (limit ${MB(limits.walBytes)}): checkpoints aren't keeping up`);
  const t0 = median(first.map((s) => s.tickMs));
  const t1 = median(last.map((s) => s.tickMs));
  if (t0 > 0 && t1 > t0 * limits.tickDrift) failures.push(`drift: the median tick went from ${Math.round(t0)} ms to ${Math.round(t1)} ms (limit ${limits.tickDrift}×)`);
  if (end.tasksDone < limits.minTasks) failures.push(`too little work: ${end.tasksDone} task(s) finished (at least ${limits.minTasks})`);
  // WHY (#1181 review): a coordinator that stopped landing after a few tasks passed on min_tasks alone, its ticks fast
  // and its log still. Work must keep landing to the end, and a share of what was filed must have landed.
  const lastLanded = end.tasksDone - last[0]!.tasksDone;
  const lastFiled = end.filed - last[0]!.filed;
  if (lastFiled > 0 && lastLanded <= 0) failures.push(`stalled: no task landed in the last quarter (${lastFiled} filed in it; ${end.tasksDone} landed in all)`);
  // And the end itself (#1181 reviews R1181c, R1181d): one task landed early in the last quarter cleared a stall that
  // began after it. Tasks filed since the last landing, with that landing more than stall_minutes before the end, is a
  // stall too.
  const lastLanding = [...samples].reverse().find((s, i, r) => i === r.length - 1 || s.tasksDone > r[i + 1]!.tasksDone)!;
  const filedSince = end.filed - lastLanding.filed;
  const sinceMin = (end.at - lastLanding.at) / 60_000;
  if (filedSince > 0 && sinceMin > limits.stallMinutes) failures.push(`stalled: no task landed in the last ${Math.round(sinceMin)} min (${filedSince} filed since; limit ${limits.stallMinutes} min; ${end.tasksDone} landed in all)`);
  if (end.filed && end.tasksDone < end.filed * limits.minLandedShare) failures.push(`too little work: ${end.tasksDone} of ${end.filed} task(s) filed landed (at least ${Math.round(limits.minLandedShare * 100)}%)`);
  return {
    failures,
    measured: { hours: +(end.at / 3_600_000).toFixed(2), samples: samples.length, tasks_done: end.tasksDone, tasks_filed: end.filed, heap_growth: MB(heap), rss_growth: MB(rss), fd_growth: fds ?? 'not counted', log_per_task: `${Math.round(perTask / 1024)} KB`, wal_max: MB(wal), tick_ms_first: Math.round(t0), tick_ms_last: Math.round(t1), open_runs_end: end.openRuns, slots_held_end: end.slotsHeld },
  };
}
