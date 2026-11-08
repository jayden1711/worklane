// The soak test's verdict (docs/soak.md; the run is test/soak.test.ts, scheduled by .github/workflows/soak.yml). A
// coordinator works for hours with stand-in agents; every SAMPLE it records what it holds. Pure: samples in, findings
// out. What fails a soak:
//   - a leak: the median heap, RSS or open file handles of the last quarter, or of the end (its last END_SAMPLES), above
//     the first quarter's (after the warm-up) by more than the limit;
//   - a stuck run: an agent run started and not finished for longer than stuck_minutes, at the end;
//   - log growth: the event log growing more per finished task than log_bytes_per_task, or its WAL past wal_bytes
//     (checkpoints stopped);
//   - drift: the last quarter's median tick slower than tick_drift times the first quarter's;
//   - leaked slots: agent slots still held at the end with no run going;
//   - too little work: fewer finished tasks than min_tasks (a soak that did nothing proves nothing).

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

/** The end a leak is judged by too: its last this many samples (or the last quarter's, if fewer). */
export const END_SAMPLES = 10;

const MB = (n: number) => `${(n / 2 ** 20).toFixed(1)} MB`;

/** What failed the soak (empty: it passed), and what it measured. */
export function soakVerdict(samples: readonly SoakSample[], limits: SoakLimits = SOAK_LIMITS): { failures: string[]; measured: Record<string, string | number> } {
  const failures: string[] = [];
  if (samples.length < 4) return { failures: [`only ${samples.length} sample(s): a soak needs at least 4 to compare its start and end`], measured: {} };
  const warm = samples.filter((s) => s.at >= limits.warmupMs);
  const use = warm.length >= 4 ? warm : samples;
  const q = Math.max(1, Math.floor(use.length / 4));
  const first = use.slice(0, q);
  const last = use.slice(-q);
  // Growth is judged twice against the first quarter: by the last quarter, and by the END (its last END_SAMPLES).
  // WHY (#1181 review): quarter medians alone missed a late step (a leak in the last half hour moves no quarter's
  // median) and read a linear leak at about three quarters of its size; the end sees both.
  const end10 = use.slice(-Math.min(END_SAMPLES, q));
  const grew = (f: (s: SoakSample) => number) => Math.max(median(last.map(f)), median(end10.map(f))) - median(first.map(f));
  const heap = grew((s) => s.heapUsed);
  const rss = grew((s) => s.rss);
  if (heap > limits.heapGrowthBytes) failures.push(`leak: the heap grew ${MB(heap)} from the first quarter to the last or the end (limit ${MB(limits.heapGrowthBytes)})`);
  if (rss > limits.rssGrowthBytes) failures.push(`leak: RSS grew ${MB(rss)} (limit ${MB(limits.rssGrowthBytes)})`);
  const counted = use.every((s) => s.fds !== null);
  const fds = counted ? grew((s) => s.fds!) : null;
  if (fds !== null && fds > limits.fdGrowth) failures.push(`leak: open file handles grew by ${fds} (limit ${limits.fdGrowth})`);
  const end = samples.at(-1)!;
  if (end.openRuns && end.oldestOpenRunMs > limits.stuckMinutes * 60_000) failures.push(`stuck: ${end.openRuns} agent run(s) open, the oldest for ${Math.round(end.oldestOpenRunMs / 60_000)} min (limit ${limits.stuckMinutes})`);
  if (end.slotsHeld > end.openRuns) failures.push(`leaked slots: ${end.slotsHeld} agent slot(s) held with ${end.openRuns} run(s) open`);
  const perTask = end.tasksDone ? (end.eventsBytes - samples[0]!.eventsBytes) / end.tasksDone : 0;
  if (perTask > limits.logBytesPerTask) failures.push(`log growth: the event log grew ${Math.round(perTask / 1024)} KB per finished task (limit ${Math.round(limits.logBytesPerTask / 1024)} KB)`);
  const wal = Math.max(...samples.map((s) => s.walBytes));
  if (wal > limits.walBytes) failures.push(`log growth: the WAL reached ${MB(wal)} (limit ${MB(limits.walBytes)}): checkpoints aren't keeping up`);
  const t0 = median(first.map((s) => s.tickMs));
  const t1 = median(last.map((s) => s.tickMs));
  if (t0 > 0 && t1 > t0 * limits.tickDrift) failures.push(`drift: the median tick went from ${Math.round(t0)} ms to ${Math.round(t1)} ms (limit ${limits.tickDrift}×)`);
  if (end.tasksDone < limits.minTasks) failures.push(`too little work: ${end.tasksDone} task(s) finished (at least ${limits.minTasks})`);
  return {
    failures,
    measured: { hours: +(end.at / 3_600_000).toFixed(2), samples: samples.length, tasks_done: end.tasksDone, heap_growth: MB(heap), rss_growth: MB(rss), fd_growth: fds ?? 'not counted', log_per_task: `${Math.round(perTask / 1024)} KB`, wal_max: MB(wal), tick_ms_first: Math.round(t0), tick_ms_last: Math.round(t1), open_runs_end: end.openRuns, slots_held_end: end.slotsHeld },
  };
}
