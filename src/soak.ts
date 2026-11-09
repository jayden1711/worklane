// The soak test's verdict (docs/soak.md; the run is test/soak.test.ts, scheduled by .github/workflows/soak.yml). A
// coordinator works for hours with stand-in agents, ticking on a fixed period; every SAMPLE it records what it holds.
// Pure: samples in, findings out. What fails a soak:
//   - a leak: heap, RSS or open file handles grown past the limit from the first quarter's median (after the warm-up),
//     read from the samples and from their upper envelope (each block's highest), by the highest of the last END_PEAK,
//     the last quarter's median, or the robust slope over the run (capped at the rise seen); or any one sample more than
//     PEAK_FACTOR times the limit above it (memory held mid-run and let go before the end);
//   - work in flight at a sample: the driver samples after the coordinator's idle(), so an open agent run or a held
//     slot then is one that never finished or leaked, however young it reads;
//   - log growth: the event log growing more per landed task than log_bytes_per_task over the run or over ANY 30-minute
//     window, or its WAL past wal_bytes (checkpoints stopped);
//   - drift: the median tick, or each interval's slowest, over the last quarter or the last 30 minutes, slower than
//     tick_drift times the first quarter's; or a tick whose cost grows
//     with the log (its slope against the log's events, per 100k of them, past tick_ms_per_100k_events);
//   - a hang: a gap between samples past GAP_FACTOR times their usual spacing, or a tick slower than stuck_minutes;
//   - too little work: fewer distinct tasks landed than min_tasks; more than max_backlog filed and not landed at a sample
//     after the warm-up; or tasks filed since the last landing, that landing longer ago than stall_minutes.

export interface SoakSample {
  /** Milliseconds since the soak started. */
  at: number;
  rss: number;
  heapUsed: number;
  /** Open file handles (null where the platform can't count them). */
  fds: number | null;
  eventsBytes: number;
  walBytes: number;
  /** Events in the log (its last id). */
  events: number;
  /** Median tick time (a tick and the coordinator's idle()) over the interval since the last sample. */
  tickMs: number;
  /** The slowest tick in that interval. */
  maxTickMs: number;
  /** Distinct tasks (issues) landed so far. */
  tasksDone: number;
  /** Tasks filed so far (the driver files one every SOAK_ISSUE_EVERY_S). */
  filed: number;
  /** The age of the oldest task filed and not landed (0: none). */
  oldestUnlandedMs: number;
  /** Agent runs started and not finished, with the oldest one's age. */
  openRuns: number;
  oldestOpenRunMs: number;
  /** Agent slot files held. */
  slotsHeld: number;
  // Read by the driver since R1181j (optional to the verdict unless it is asked for them, `extended`):
  /** coordinator.error events in the log so far: a step that fails on every tick still lands work (R1181j 1). */
  errors?: number;
  /** The coordinator's git worktrees (R1181j 2: one never removed is a full checkout per task). */
  worktrees?: number;
  /** Bytes on disk under the soak's own folder (its repos, worktrees and log). */
  diskBytes?: number;
  /** This process's live child processes (null where the platform can't count them). */
  children?: number | null;
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
  /** A tick's cost against the log's size: its slope, in ms per 100k events (0: not judged). */
  tickMsPer100kEvents: number;
  minTasks: number;
  /** At most this many tasks filed and not landed at a sample after the warm-up. */
  maxBacklog: number;
  /** Tasks filed since the last landing, and that landing longer ago than this at the end: stalled. */
  stallMinutes: number;
  /** Worktrees and live child processes: growth, as open file handles are judged (R1181j 2). */
  worktreeGrowth: number;
  childGrowth: number;
  /** Disk growth under the soak's folder per landed task after the warm-up (R1181j 2). */
  diskBytesPerTask: number;
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
  tickMsPer100kEvents: 250,
  minTasks: 1,
  maxBacklog: 10,
  stallMinutes: 5,
  worktreeGrowth: 4,
  childGrowth: 4,
  diskBytesPerTask: 2 * 2 ** 20,
};

/**
 * Agent runs started and not finished at `now`, and the oldest one's age. Each run.finished closes the NEWEST open
 * run.started of the same issue and role (events carry no run id): one issue's runs in one role follow each other, so
 * the newest open one is the one finishing, and an orphan left before a retry keeps its own age. WHY (#1181 review
 * R1181f SL3): closing the oldest let each retry's finish close the orphan, which then read as the latest retry's age.
 * Other issues' runs never close each other (R1181b). The verdict fails on any open run at a sample, whatever its age.
 */
export function openRunsOf(events: readonly { type: string; ts: string; payload: unknown }[], now: number): { open: number; oldestMs: number } {
  const open = new Map<string, string[]>();
  const key = (p: unknown) => {
    const o = p as { issue?: unknown; role?: unknown };
    return `${String(o.issue)}\u0000${String(o.role)}`;
  };
  for (const e of events) {
    if (e.type === 'run.started') open.set(key(e.payload), [...(open.get(key(e.payload)) ?? []), e.ts]);
    else if (e.type === 'run.finished') open.get(key(e.payload))?.pop();
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

/** The envelope's end: the highest of its last this many blocks (about the last 30 samples). */
export const END_PEAK = 3;
/** The end window drift is judged over too (R1181c). */
export const END_WINDOW_MS = 30 * 60_000;
/** The samples' end: the median of their last this many. */
export const END_MEDIAN = 10;
/** At least this share of the samples the run's length and sample period call for. */
export const MIN_SAMPLE_SHARE = 0.9;
/** At least this share of the tasks the run's length and filing period call for must be filed (the driver files between ticks). */
export const MIN_LANDED_SHARE = 0.5;
/** The upper envelope's block: the highest of each this many samples (a sawtooth's peaks, R1181f S1). */
export const ENVELOPE_BLOCK = 10;
/** Any one sample this many times a growth limit above the start fails, wherever it is in the run (R1181f G1). */
export const PEAK_FACTOR = 4;
/** A gap between samples this many times their median spacing (and at least GAP_MIN_MS) is a hang (R1181f T1). */
export const GAP_FACTOR = 3;
export const GAP_MIN_MS = 5 * 60_000;
/** The window the log's per-task rate is judged over, slid across the whole run (R1181f L1, L2). */
export const LOG_WINDOW_MS = 30 * 60_000;
/**
 * A window is judged per task when it landed at least this many tasks and half the run's median window: with fewer it
 * would measure idle ticks, not tasks, so it is judged by its bytes instead, against LOG_QUIET_FACTOR times the median
 * window's (a burst while little lands still fails).
 */
export const LOG_WINDOW_MIN_TASKS = 5;
export const LOG_QUIET_FACTOR = 3;
/** The tick-against-log slope is judged only over at least this many new events (fewer: too noisy to project). */
export const DRIFT_MIN_EVENTS = 10_000;

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

/**
 * Growth of `f` over `pts`: against its first quarter's median, the end, the last quarter and the capped slope; and the
 * end against the run's low point (#1181 review R1181h 1: a high first quarter, a startup set let go, hid any later
 * leak up to it). `robustEnd`: the raw samples' end is the median of their last END_MEDIAN (R1181h 5: the highest of
 * the last 3 read noise as growth on a steady rise); the envelope's stays the highest of its last END_PEAK blocks, so
 * a late spike of a few samples is still read.
 */
function growthOf(pts: readonly { at: number; v: number }[], robustEnd: boolean): { growth: number; peak: number } {
  const fq = Math.max(1, Math.floor(pts.length / 4));
  const base = median(pts.slice(0, fq).map((p) => p.v));
  const endLevel = robustEnd ? median(pts.slice(-END_MEDIAN).map((p) => p.v)) : Math.max(...pts.slice(-END_PEAK).map((p) => p.v));
  const peakEnd = endLevel - base;
  const lastQ = median(pts.slice(-fq).map((p) => p.v)) - base;
  const top = Math.max(...pts.map((p) => p.v));
  const peak = top - base;
  // The slope over the run, never more than the rise seen: the highest sample less the first quarter's lowest (#1181
  // review R1181e: a rise that levels off read ~1.4x; against the median, a linear one would read ~7/8).
  const seen = top - Math.min(...pts.slice(0, fq).map((p) => p.v));
  const slope = Math.min(theilSen(pts.map((p) => ({ x: p.at, y: p.v }))) * (pts.at(-1)!.at - pts[0]!.at), seen);
  // The run's low point: the lowest median of a block of ENVELOPE_BLOCK samples before the end's.
  const blocks: number[] = [];
  for (let i = 0; i + ENVELOPE_BLOCK <= pts.length - END_MEDIAN; i += ENVELOPE_BLOCK) blocks.push(median(pts.slice(i, i + ENVELOPE_BLOCK).map((p) => p.v)));
  const fromLow = robustEnd && blocks.length ? median(pts.slice(-END_MEDIAN).map((p) => p.v)) - Math.min(...blocks) : 0;
  return { growth: Math.max(peakEnd, lastQ, slope, fromLow), peak };
}

/**
 * Growth read from the samples and from their upper envelope (the highest of each ENVELOPE_BLOCK samples, at the
 * block's last time): a sawtooth whose troughs sit at the base and whose peaks rise is read by its peaks. And the
 * run's single highest sample, judged against PEAK_FACTOR times the limit.
 */
function growth(samples: readonly SoakSample[], f: (s: SoakSample) => number): { growth: number; peak: number } {
  const pts = samples.map((s) => ({ at: s.at, v: f(s) }));
  const env: { at: number; v: number }[] = [];
  for (let i = 0; i < pts.length; i += ENVELOPE_BLOCK) {
    const b = pts.slice(i, i + ENVELOPE_BLOCK);
    env.push({ at: b.at(-1)!.at, v: Math.max(...b.map((p) => p.v)) });
  }
  const a = growthOf(pts, true);
  // The envelope against its own first quarter: blocks' highest against blocks' highest, so noise isn't growth.
  const e = env.length >= 4 ? growthOf(env, false) : { growth: 0, peak: 0 };
  return { growth: Math.max(a.growth, e.growth), peak: a.peak };
}

/** What failed the soak (empty: it passed), and what it measured. */
/**
 * `o.expectedMs`: the hours asked for. `o.sampleMs`, `o.issueEveryMs`: the driver's sample and filing periods, which
 * the gaps and the work are judged against (#1181 reviews R1181g, R1181h 2: against the run's own spacing, a
 * coordinator slow on every tick set its own limit). Given expectedMs, they default to the driver's own (60 s, 30 s).
 */
export function soakVerdict(samples: readonly SoakSample[], limits: SoakLimits = SOAK_LIMITS, o: { expectedMs?: number; sampleMs?: number; issueEveryMs?: number; extended?: boolean } = {}): { failures: string[]; measured: Record<string, string | number> } {
  const failures: string[] = [];
  if (samples.length < 4) return { failures: [`only ${samples.length} sample(s): a soak needs at least 4 to compare its start and end`], measured: {} };
  // Every field the verdict reads must be there: a sample missing one can't be judged, and that fails closed.
  // `extended`: the driver's own run, which records errors, worktrees and disk too (R1181j 1, 2); a driver that drops
  // them fails closed. (Without it they are judged when there, so the frozen acceptance file's samples stay valid.)
  const fields: (keyof SoakSample)[] = ['at', 'rss', 'heapUsed', 'eventsBytes', 'walBytes', 'events', 'tickMs', 'maxTickMs', 'tasksDone', 'filed', 'oldestUnlandedMs', 'openRuns', 'oldestOpenRunMs', 'slotsHeld', ...(o.extended ? (['errors', 'worktrees', 'diskBytes'] as const) : [])];
  const missing = fields.filter((k) => samples.some((s) => typeof s[k] !== 'number' || !Number.isFinite(s[k])));
  if (missing.length) return { failures: [`samples missing ${missing.join(', ')}: nothing was judged`], measured: {} };
  // WHY (#1181 review): with too few samples past the warm-up, the warm-up's were judged instead, so a 4-minute run
  // passed as a soak. Too short is a failure; and a run must last (nearly) as long as it was asked to.
  const warm = samples.filter((s) => s.at >= limits.warmupMs);
  if (warm.length < 4) return { failures: [`too short: ${warm.length} sample(s) after the ${Math.round(limits.warmupMs / 60_000)}-minute warm-up (at least 4): nothing was judged`], measured: {} };
  const ran = samples.at(-1)!.at;
  if (o.expectedMs !== undefined && ran < o.expectedMs * 0.9) failures.push(`too short: it ran ${(ran / 3_600_000).toFixed(2)} h of the ${(o.expectedMs / 3_600_000).toFixed(2)} h asked for`);
  const sampleMs = o.sampleMs ?? (o.expectedMs !== undefined ? 60_000 : undefined);
  const issueEveryMs = o.issueEveryMs ?? (o.expectedMs !== undefined ? 30_000 : undefined);
  if (o.expectedMs !== undefined && sampleMs) {
    const want = Math.floor(o.expectedMs / sampleMs);
    if (samples.length < want * MIN_SAMPLE_SHARE) failures.push(`hang: ${samples.length} samples of the ${want} its ${(o.expectedMs / 3_600_000).toFixed(2)} h at one every ${Math.round(sampleMs / 1000)} s call for (at least ${Math.round(MIN_SAMPLE_SHARE * 100)}%): its ticks were too slow to sample`);
  }
  const use = warm;
  const q = Math.max(1, Math.floor(use.length / 4));
  const first = use.slice(0, q);
  const last = use.slice(-q);
  const end = samples.at(-1)!;

  // Leaks.
  const leak = (what: string, g: { growth: number; peak: number }, limit: number, fmt: (n: number) => string) => {
    if (g.growth > limit) failures.push(`leak: ${what} grew ${fmt(g.growth)} (at the end, the last quarter or its slope over the run, of the samples or their peaks; limit ${fmt(limit)})`);
    else if (g.peak > limit * PEAK_FACTOR) failures.push(`leak: ${what} peaked ${fmt(g.peak)} above its start mid-run (limit ${PEAK_FACTOR}x ${fmt(limit)}: held, then let go)`);
  };
  const heap = growth(use, (s) => s.heapUsed);
  const rss = growth(use, (s) => s.rss);
  leak('the heap', heap, limits.heapGrowthBytes, MB);
  leak('RSS', rss, limits.rssGrowthBytes, MB);
  // Open file handles are judged over the samples that counted them. WHY (#1181 review): one uncounted sample turned the
  // check off for the whole run. Most uncounted is a failure: a leak there couldn't be seen.
  const counted = use.filter((s) => s.fds !== null);
  let fds: number | null = null;
  if (counted.length * 2 < use.length) failures.push(`open file handles not counted in ${use.length - counted.length} of ${use.length} sample(s): a leak of them can't be judged`);
  else {
    const g = growth(counted, (s) => s.fds!);
    fds = Math.round(g.growth * 10) / 10;
    leak('open file handles', { growth: fds, peak: g.peak }, limits.fdGrowth, (n) => `by ${Math.round(n * 10) / 10}`);
  }
  // R1181j 1: an error after the warm-up fails (a coordinator logging one on every tick still landed work, and passed).
  const has = (k: keyof SoakSample) => use.every((s) => typeof s[k] === 'number' && Number.isFinite(s[k]));
  let errors: number | string = 'not recorded';
  if (has('errors')) {
    errors = end.errors! - use[0]!.errors!;
    if (errors > 0) failures.push(`errors: ${errors} coordinator.error event(s) after the warm-up (limit 0): a step failing, its work still landing`);
  }
  // R1181j 2: the coordinator's worktrees and this process's children, as open file handles; the disk per landed task.
  let worktrees: number | string = 'not recorded';
  if (has('worktrees')) {
    const g = growth(use, (s) => s.worktrees!);
    worktrees = Math.round(g.growth * 10) / 10;
    leak('worktrees', { growth: worktrees, peak: g.peak }, limits.worktreeGrowth, (n) => `by ${Math.round(n * 10) / 10}`);
  }
  // Child processes as open file handles: judged over the samples that counted them, most uncounted a failure.
  let children: number | string = 'not recorded';
  if (use.some((s) => s.children !== undefined)) {
    const childCounted = use.filter((s) => typeof s.children === 'number');
    if (childCounted.length * 2 < use.length) failures.push(`child processes not counted in ${use.length - childCounted.length} of ${use.length} sample(s): a leak of them can't be judged`);
    else {
      const g = growth(childCounted, (s) => s.children!);
      children = Math.round(g.growth * 10) / 10;
      leak('child processes', { growth: children, peak: g.peak }, limits.childGrowth, (n) => `by ${Math.round(n * 10) / 10}`);
    }
  }
  let diskPerTask: number | string = 'not recorded';
  if (has('diskBytes')) {
    const landedSince = Math.max(1, end.tasksDone - use[0]!.tasksDone);
    diskPerTask = (end.diskBytes! - use[0]!.diskBytes!) / landedSince;
    if (diskPerTask > limits.diskBytesPerTask) failures.push(`disk growth: ${MB(end.diskBytes! - use[0]!.diskBytes!)} under the soak's folder after the warm-up, ${Math.round(diskPerTask / 1024)} KB per landed task (limit ${Math.round(limits.diskBytesPerTask / 1024)} KB)`);
    diskPerTask = `${Math.round(diskPerTask / 1024)} KB`;
  }

  // Work in flight at a sample: none, ever (#1181 review R1181f SL1-SL3). The driver samples after the coordinator's
  // idle(), when nothing is in flight; an open run then never finished (it threw after it started) and a held slot
  // leaked. Ages read from the log can be re-paired by a retry (openRunsOf), so the count decides, not the age.
  const openAt = samples.find((s) => s.openRuns > 0);
  if (openAt) failures.push(`never finished: ${openAt.openRuns} agent run(s) open at minute ${Math.round(openAt.at / 60_000)}, with nothing in flight at a sample (the oldest read as ${Math.round(openAt.oldestOpenRunMs / 60_000)} min)`);
  const slotAt = samples.find((s) => s.slotsHeld > 0);
  if (slotAt) failures.push(`leaked slots: ${slotAt.slotsHeld} agent slot(s) held at minute ${Math.round(slotAt.at / 60_000)} with ${slotAt.openRuns} run(s) open, with nothing in flight at a sample`);

  // A hang: a gap between samples, or one slow tick (R1181f T1): a run stuck for hours that ended before the next
  // sample was never seen open.
  const spacing = sampleMs ?? median(samples.slice(1).map((s, i) => s.at - samples[i]!.at));
  const gapLimit = Math.max(GAP_FACTOR * spacing, GAP_MIN_MS);
  const gapAt = samples.findIndex((s, i) => i > 0 && s.at - samples[i - 1]!.at > gapLimit);
  if (gapAt > 0) failures.push(`hang: no sample for ${Math.round((samples[gapAt]!.at - samples[gapAt - 1]!.at) / 60_000)} min before minute ${Math.round(samples[gapAt]!.at / 60_000)} (limit ${Math.round(gapLimit / 60_000)} min)`);
  const slowAt = samples.find((s) => s.maxTickMs > limits.stuckMinutes * 60_000);
  if (slowAt) failures.push(`hang: a tick took ${Math.round(slowAt.maxTickMs / 60_000)} min before minute ${Math.round(slowAt.at / 60_000)} (limit ${limits.stuckMinutes} min)`);

  // The log per landed task, over the whole run and over every LOG_WINDOW_MS window (#1181 review R1181f L1, L2: a burst
  // mid-run hid from windows anchored at the end).
  const rate = (a: SoakSample, b: SoakSample) => (b.tasksDone - a.tasksDone > 0 ? (b.eventsBytes - a.eventsBytes) / (b.tasksDone - a.tasksDone) : 0);
  let perTask = rate(samples[0]!, end);
  const windows: { tasks: number; bytes: number; at: number }[] = [];
  for (let i = 0, j = 0; i < samples.length; i++) {
    while (j < samples.length && samples[j]!.at - samples[i]!.at < LOG_WINDOW_MS) j++;
    if (j === samples.length) break;
    windows.push({ tasks: samples[j]!.tasksDone - samples[i]!.tasksDone, bytes: samples[j]!.eventsBytes - samples[i]!.eventsBytes, at: samples[i]!.at });
  }
  const busy = Math.max(LOG_WINDOW_MIN_TASKS, median(windows.map((w) => w.tasks)) / 2);
  const quietLimit = LOG_QUIET_FACTOR * median(windows.map((w) => w.bytes));
  for (const w of windows) if (w.tasks >= busy) perTask = Math.max(perTask, w.bytes / w.tasks);
  const loud = windows.find((w) => w.tasks < busy && w.bytes > quietLimit);
  if (loud) failures.push(`log growth: the event log grew ${MB(loud.bytes)} in ${LOG_WINDOW_MS / 60_000} min from minute ${Math.round(loud.at / 60_000)} while ${loud.tasks} task(s) landed (limit ${LOG_QUIET_FACTOR}x the usual window's ${MB(quietLimit / LOG_QUIET_FACTOR)})`);
  if (perTask > limits.logBytesPerTask) failures.push(`log growth: the event log grew ${Math.round(perTask / 1024)} KB per landed task (over the run or a ${LOG_WINDOW_MS / 60_000}-minute window of it; limit ${Math.round(limits.logBytesPerTask / 1024)} KB)`);
  const wal = Math.max(...samples.map((s) => s.walBytes));
  if (wal > limits.walBytes) failures.push(`log growth: the WAL reached ${MB(wal)} (limit ${MB(limits.walBytes)}): checkpoints aren't keeping up`);

  // Drift: quarter medians, and the tick's cost against the log (R1181f D1: a tick linear in the log's size). The driver
  // ticks on a fixed period, so the log grows at a known rate.
  const t0 = median(first.map((s) => s.tickMs));
  const t1 = median(last.map((s) => s.tickMs));
  if (t0 > 0 && t1 > t0 * limits.tickDrift) failures.push(`drift: the median tick went from ${Math.round(t0)} ms to ${Math.round(t1)} ms (limit ${limits.tickDrift}×)`);
  // And each interval's slowest tick (R1181h 3: one tick in three growing with the log left the median flat).
  const m0 = median(first.map((s) => s.maxTickMs));
  const m1 = median(last.map((s) => s.maxTickMs));
  if (m0 > 0 && m1 > m0 * limits.tickDrift) failures.push(`drift: the slowest tick of an interval went from ${Math.round(m0)} ms to ${Math.round(m1)} ms (limit ${limits.tickDrift}×)`);
  // And the run's last 30 minutes (R1181c's final check: ticks going from 50 to 1000 ms in the last 35 min left the
  // last quarter's median flat). Judged once the run is long enough for that window to be well inside its last quarter.
  const tail = samples.filter((x) => x.at >= end.at - END_WINDOW_MS);
  // R1181j N3: a check a short run is too short for is named in `measured`, not passed in silence.
  const notJudged: string[] = [];
  if (!(tail.length >= 5 && end.at - use[0]!.at >= 4 * END_WINDOW_MS)) notJudged.push(`the last ${END_WINDOW_MS / 60_000} min's drift (needs ${(4 * END_WINDOW_MS) / 60_000} min after the warm-up)`);
  if (tail.length >= 5 && end.at - use[0]!.at >= 4 * END_WINDOW_MS) {
    const e0 = median(tail.map((x) => x.tickMs));
    if (t0 > 0 && e0 > t0 * limits.tickDrift) failures.push(`drift: the median tick of the last ${END_WINDOW_MS / 60_000} min is ${Math.round(e0)} ms, from ${Math.round(t0)} ms (limit ${limits.tickDrift}×)`);
    // And each interval's slowest tick over that window (R1231c: 80 -> 1200 ms in only the last 35 min passed).
    const em = median(tail.map((x) => x.maxTickMs));
    if (m0 > 0 && em > m0 * limits.tickDrift) failures.push(`drift: the slowest tick of an interval in the last ${END_WINDOW_MS / 60_000} min is ${Math.round(em)} ms, from ${Math.round(m0)} ms (limit ${limits.tickDrift}×)`);
  }
  const newEvents = end.events - use[0]!.events;
  let perEvents: number | string = 'not judged';
  if (limits.tickMsPer100kEvents > 0 && newEvents < DRIFT_MIN_EVENTS) notJudged.push(`the tick against the log (needs ${DRIFT_MIN_EVENTS} new events, had ${newEvents})`);
  if (limits.tickMsPer100kEvents > 0 && newEvents >= DRIFT_MIN_EVENTS) {
    const median100k = Math.round(theilSen(use.map((s) => ({ x: s.events, y: s.tickMs }))) * 100_000);
    const slowest100k = Math.round(theilSen(use.map((s) => ({ x: s.events, y: s.maxTickMs }))) * 100_000);
    perEvents = Math.max(median100k, slowest100k);
    if (median100k > limits.tickMsPer100kEvents) failures.push(`drift: a tick costs ${median100k} ms more per 100k events in the log (limit ${limits.tickMsPer100kEvents}): it grows with the log`);
    else if (slowest100k > limits.tickMsPer100kEvents) failures.push(`drift: the slowest tick of an interval costs ${slowest100k} ms more per 100k events in the log (limit ${limits.tickMsPer100kEvents}): some ticks grow with the log`);
  }

  // Work.
  if (end.tasksDone < limits.minTasks) failures.push(`too little work: ${end.tasksDone} task(s) landed (at least ${limits.minTasks})`);
  // Filed against the schedule (R1181g: the driver files between ticks, so a coordinator slow on every tick filed, and
  // landed, little, and the backlog looked fine). Landing behind filing is the backlog's and the age's to judge.
  if (o.expectedMs !== undefined && issueEveryMs) {
    const scheduled = Math.floor(Math.min(ran, o.expectedMs) / issueEveryMs);
    if (end.filed < scheduled * MIN_LANDED_SHARE) failures.push(`too little work: ${end.filed} task(s) filed of the ${scheduled} its schedule (one every ${Math.round(issueEveryMs / 1000)} s) calls for (at least ${Math.round(MIN_LANDED_SHARE * 100)}%): the coordinator's ticks held the driver up`);
  }
  // No task may wait longer than stuck_minutes (R1181h V3: ten that never landed passed the backlog limit).
  const waited = use.find((s) => s.oldestUnlandedMs > limits.stuckMinutes * 60_000);
  if (waited) failures.push(`too little work: a task filed ${Math.round(waited.oldestUnlandedMs / 60_000)} min before minute ${Math.round(waited.at / 60_000)} hadn't landed (limit ${limits.stuckMinutes} min)`);
  // A backlog at a sample after the warm-up (R1181f W1: half the tasks never landing passed a 50% share).
  const behind = use.find((s) => s.filed - s.tasksDone > limits.maxBacklog);
  if (behind) failures.push(`too little work: ${behind.filed - behind.tasksDone} of ${behind.filed} task(s) filed not landed at minute ${Math.round(behind.at / 60_000)} (at most ${limits.maxBacklog})`);
  // A stall at the end (#1181 reviews R1181c, R1181d): tasks filed since the last landing, that landing more than
  // stall_minutes before the end.
  const lastLanding = [...samples].reverse().find((s, i, r) => i === r.length - 1 || s.tasksDone > r[i + 1]!.tasksDone)!;
  const filedSince = end.filed - lastLanding.filed;
  const sinceMin = (end.at - lastLanding.at) / 60_000;
  // The limit: stall_minutes, or 3x the run's own median gap between landings when they come in batches (R1181h 6: a
  // merge train landing every 10 min failed by where in a cycle the run ended).
  const landings = samples.filter((s, i) => i > 0 && s.tasksDone > samples[i - 1]!.tasksDone).map((s) => s.at);
  const cadence = landings.length > 2 ? median(landings.slice(1).map((t, i) => t - landings[i]!)) / 60_000 : 0;
  const stallLimit = Math.max(limits.stallMinutes, 3 * cadence);
  if (filedSince > 0 && sinceMin > stallLimit) failures.push(`stalled: no task landed in the last ${Math.round(sinceMin)} min (${filedSince} filed since; limit ${Math.round(stallLimit)} min; ${end.tasksDone} landed in all)`);
  return {
    failures,
    measured: { hours: +(end.at / 3_600_000).toFixed(2), samples: samples.length, tasks_done: end.tasksDone, tasks_filed: end.filed, heap_growth: MB(heap.growth), heap_peak: MB(heap.peak), rss_growth: MB(rss.growth), fd_growth: fds ?? 'not counted', log_per_task: `${Math.round(perTask / 1024)} KB`, wal_max: MB(wal), tick_ms_first: Math.round(t0), tick_ms_last: Math.round(t1), tick_ms_slowest_first: Math.round(m0), tick_ms_slowest_last: Math.round(m1), tick_ms_per_100k_events: perEvents, oldest_unlanded_min: Math.round(Math.max(...use.map((s) => s.oldestUnlandedMs)) / 60_000), max_gap_min: +(Math.max(...samples.slice(1).map((s, i) => s.at - samples[i]!.at)) / 60_000).toFixed(1), open_runs_end: end.openRuns, slots_held_end: end.slotsHeld, errors_after_warmup: errors, worktree_growth: worktrees, child_growth: children, disk_per_task: diskPerTask, not_judged: notJudged.join(', ') || 'none' },
  };
}
