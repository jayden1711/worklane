// The soak test's verdict (docs/soak.md; the run is test/soak.test.ts, scheduled by .github/workflows/soak.yml). A
// coordinator works for hours with stand-in agents, ticking on a fixed period; every SAMPLE it records what it holds.
// Pure: samples in, findings out. What fails a soak:
//   - a leak: heap, RSS or open file handles grown past the limit from the first quarter's median (after the warm-up),
//     read from the samples and from their upper envelope (each block's highest), by the highest of the last END_PEAK,
//     the last quarter's median, or the robust slope over the run (capped at the rise seen); or any one sample more than
//     PEAK_FACTOR times the limit above it (memory held mid-run and let go before the end);
//   - what the coordinator's stop() leaves (R1181t D3): with `stopped`, the last sample is read after stop() and idle(),
//     and processes or worktrees above the first quarter's, a run or a slot still open, or another count past its
//     growth limit fail;
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
  /** Agent runs that didn't succeed (run.finished not succeeded, run.startup_failed) so far (R1181l 5). */
  failedRuns?: number;
  /** Other failure events so far: every event type ending in .failed or _failed, run.startup_failed aside (R1181l 5, R1181p D6). */
  failureEvents?: number;
  /** Entries in the coordinator's worktree folder: a checkout git no longer lists is still one (R1181k D1). */
  worktreeDirs?: number;
  /** Files and folders under the soak's folder (24,000 empty files grow no bytes: R1181l 3). */
  files?: number;
  /** 1 when the machine's full-run test lock is held at an idle sample (R1181n): a lock never let go. */
  fullRunHeld?: number;
  /** The resident memory of the counted child processes (R1181n: a child's memory weighed nothing). */
  childRss?: number;
  /** inotify watches this process and the counted children hold (null where they can't be counted: R1181n, R1181p D3). */
  watches?: number | null;
  /**
   * The used space of the filesystems the soak can write to, plus the kernel's shared memory (statfs, /proc/meminfo
   * Shmem): what no folder walk can name, an unlinked open file or a memfd (R1181o D1, R1181p D2). Read only on a real
   * soak on Linux, where nothing else writes; null elsewhere (not judged).
   */
  levelBytes?: number | null;
  /** Open file handles the counted children hold (Linux, /proc/<pid>/fd; null elsewhere): R1181t D2, a child's leak of them weighed nothing. */
  childFds?: number | null;
  /**
   * The job's cgroup (a real soak on Linux, R1181t D1, D4): its processes, every one whatever its uid, session or pid
   * history (cgroup.procs, its sub-groups included), and its kernel memory less what the kernel can reclaim, plus its
   * socket buffers (memory.stat kernel - slab_reclaimable + sock: R1181u C1, R1181x D1), which bounds a pipe's or a
   * socket's buffers held only in flight, which no fd table names. Null elsewhere.
   */
  cgroupProcs?: number | null;
  cgroupKernelBytes?: number | null;
  /** The used inodes of the level's filesystems (a real soak on Linux, R1181z D3): judged at stop only. */
  levelFiles?: number | null;
  /** Files and folders under the worktree folder, part of `files` (R1181y Y1: a task's checkout open at the stop sample). */
  worktreeFiles?: number;
  /** Files in the worktree folder no checkout tracks: untracked or ignored in a worktree, or in another entry (R1181aa AA1). */
  worktreeLeftovers?: number;
  /**
   * Worktrees and worktree-folder entries no open task owns (R1181af AF1): a task's checkout (`<cli>-issue-<n>`) is
   * owned while its issue is filed and not landed; the main checkout aside, anything else is a stray.
   */
  worktreeStrays?: number;
  /** The walked folders' files on a filesystem levelFiles counts (a real soak on Linux, R1181aa AA2). */
  levelWalked?: number | null;
  /** SysV IPC objects alive (a real soak on Linux, R1181z D2): they outlive every process. */
  sysvIpc?: number | null;
  /** POSIX message queues alive (/dev/mqueue; a real soak on Linux, null where it isn't mounted): R1181ab D3. */
  mqueues?: number | null;
  /** This user's keys and their bytes (/proc/key-users qnkeys, qnbytes; a real soak on Linux): R1181ab D4. */
  userKeys?: number | null;
  userKeyBytes?: number | null;
  /**
   * Claim refs on the remote that no open task holds (R1181ak D6): a released claim leaves none, so any at stop is a
   * leak, and so is growth. The engine leaves one after a lease renewal (#1275), which the stand-ins' runs are too
   * short to reach (docs/soak.md).
   */
  claimRefs?: number | null;
  /** Timers alive in this process (Timeouts, counted by async_hooks): a per-task poller left running (R1181ak D7). */
  timers?: number;
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
  /** Worktrees (and the worktree folder's entries) and live child processes: growth, as open file handles are judged. */
  worktreeGrowth: number;
  childGrowth: number;
  /** The disk under the soak's folder less the event log (judged per landed task on its own): per landed task after the
   *  warm-up, and as a growth with the 4x peak (R1181k D1, R1181l 3: the log is ~240 KB a task; a checkout kept per
   *  task adds ~21 KB in this fixture, which the worktree folder's count catches). */
  diskBytesPerTask: number;
  diskGrowthBytes: number;
  /** Files and folders under the soak's folder, per landed task after the warm-up. */
  filesPerTask: number;
  /** The job cgroup's unreclaimable kernel memory (R1181t D1): growth, with the 4x peak, as memory is judged. */
  kernelGrowthBytes: number;
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
  worktreeGrowth: 2,
  childGrowth: 4,
  diskBytesPerTask: 64 * 2 ** 10,
  diskGrowthBytes: 256 * 2 ** 20,
  filesPerTask: 64,
  kernelGrowthBytes: 64 * 2 ** 20,
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

/** What a shutdown may add, read by the stop sample against the last run sample (R1181x D2). */
export const STOP_DISK_BYTES = 16 * 2 ** 20;
export const STOP_FILES = 64;
export const STOP_LOG_BYTES = 2 ** 20;
/** Growth in the bytes of this user's keys (the quota is 20,000 a uid by default): R1181ab D4. */
export const USER_KEY_BYTES = 2048;
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
export function soakVerdict(input: readonly SoakSample[], limits: SoakLimits = SOAK_LIMITS, o: { expectedMs?: number; sampleMs?: number; issueEveryMs?: number; extended?: boolean; linux?: boolean; stopped?: boolean } = {}): { failures: string[]; measured: Record<string, string | number> } {
  const failures: string[] = [];
  // `stopped` (R1181t D3): the last sample was read after the coordinator's stop() and idle(), so what its shutdown
  // leaves is seen. It is judged on its own below, against the run's first quarter, not as one more sample of the run.
  const samples = o.stopped ? input.slice(0, -1) : input;
  if (samples.length < 4) return { failures: [`only ${samples.length} sample(s): a soak needs at least 4 to compare its start and end`], measured: {} };
  // Every field the verdict reads must be there: a sample missing one can't be judged, and that fails closed.
  // `extended`: the driver's own run, which records errors, worktrees and disk too (R1181j 1, 2); a driver that drops
  // them fails closed. `linux`: there the watches can always be counted, so they are required too (R1181o), and on a
  // real soak (`expectedMs`) the filesystems' level as well (R1181q N2: a level that read null went unjudged, unnamed). (Without it they are judged when there, so the frozen acceptance file's samples stay valid.)
  const fields: (keyof SoakSample)[] = ['at', 'rss', 'heapUsed', 'eventsBytes', 'walBytes', 'events', 'tickMs', 'maxTickMs', 'tasksDone', 'filed', 'oldestUnlandedMs', 'openRuns', 'oldestOpenRunMs', 'slotsHeld', ...(o.extended ? (['errors', 'worktrees', 'diskBytes', 'children', 'failedRuns', 'failureEvents', 'worktreeDirs', 'files', 'fullRunHeld', 'childRss'] as const) : []), ...(o.extended && o.linux ? (['watches', 'childFds'] as const) : []), ...(o.extended && o.linux && o.expectedMs !== undefined ? (['levelBytes', 'cgroupProcs', 'cgroupKernelBytes', 'levelFiles', 'sysvIpc'] as const) : [])];
  const missing = fields.filter((k) => input.some((s) => typeof s[k] !== 'number' || !Number.isFinite(s[k])));
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
  const stop = o.stopped ? input.at(-1) : undefined;

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
  // From the run's start, the warm-up included (R1181n: an error in the first 10 minutes, or before the first sample
  // after them, was never judged): the stand-in agents never fail, so the count should stay 0.
  if (has('errors')) {
    errors = end.errors!;
    if (errors > 0) failures.push(`errors: ${errors} coordinator.error event(s) in the run (limit 0): a step failing, its work still landing`);
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
  // R1181l 5: an agent run that didn't succeed, or another failure event, after the warm-up fails (the stand-in agents
  // never fail, so each is the coordinator's or the harness's).
  for (const [k, what] of [['failedRuns', 'agent run(s) that did not succeed'], ['failureEvents', 'failure event(s) (a type ending in .failed or _failed)']] as const) {
    if (!has(k)) continue;
    const n = end[k]!;
    if (n > 0) failures.push(`errors: ${n} ${what} in the run (limit 0)`);
  }
  // R1181n: the full-run test lock held at an idle sample was never let go, as a held slot.
  const lockAt = samples.find((s) => (s.fullRunHeld ?? 0) > 0);
  if (lockAt) failures.push(`leaked the full-run lock: held at minute ${Math.round(lockAt.at / 60_000)}, with nothing in flight at a sample`);
  // R1181n: the children's memory, as this process's RSS is judged.
  if (has('childRss')) leak("the child processes' RSS", growth(use, (s) => s.childRss!), limits.rssGrowthBytes, MB);
  // R1181n: inotify watches, as open file handles (where they can be counted).
  if (use.some((s) => typeof s.watches === 'number')) {
    const counted = use.filter((s) => typeof s.watches === 'number');
    if (counted.length * 2 >= use.length) {
      const g = growth(counted, (s) => s.watches!);
      leak('inotify watches', { growth: Math.round(g.growth * 10) / 10, peak: g.peak }, limits.fdGrowth, (n) => `by ${Math.round(n * 10) / 10}`);
    }
  }
  // R1181t D2: the counted children's open file handles, as this process's.
  if (use.some((s) => typeof s.childFds === 'number')) {
    const counted = use.filter((s) => typeof s.childFds === 'number');
    if (counted.length * 2 < use.length) failures.push(`the child processes' open file handles not counted in ${use.length - counted.length} of ${use.length} sample(s): a leak of them can't be judged`);
    else {
      const g = growth(counted, (s) => s.childFds!);
      leak("the child processes' open file handles", { growth: Math.round(g.growth * 10) / 10, peak: g.peak }, limits.fdGrowth, (n) => `by ${Math.round(n * 10) / 10}`);
    }
  }
  // R1181t D1, D4: the job's cgroup, as levels: its processes as child processes are judged, whatever their uid,
  // session or pid history; its unreclaimable kernel memory as memory is.
  for (const [k, what, limit, fmt] of [
    ['cgroupProcs', "the job cgroup's processes", limits.childGrowth, (n: number) => `by ${Math.round(n * 10) / 10}`],
    ['cgroupKernelBytes', "the job cgroup's unreclaimable kernel memory", limits.kernelGrowthBytes, MB],
    ['sysvIpc', 'SysV IPC objects', limits.childGrowth, (n: number) => `by ${Math.round(n * 10) / 10}`],
    ['mqueues', 'POSIX message queues', limits.childGrowth, (n: number) => `by ${Math.round(n * 10) / 10}`],
    ['userKeys', "keys in this user's keyrings", limits.childGrowth, (n: number) => `by ${Math.round(n * 10) / 10}`],
    ['userKeyBytes', "bytes of this user's keys", USER_KEY_BYTES, (n: number) => `by ${Math.round(n)} bytes`],
    ['claimRefs', 'claim refs on the remote that no open task holds', limits.childGrowth, (n: number) => `by ${Math.round(n * 10) / 10}`],
    ['timers', 'live timers', limits.fdGrowth, (n: number) => `by ${Math.round(n * 10) / 10}`],
  ] as const) {
    if (!use.some((s) => typeof s[k] === 'number')) continue;
    const counted = use.filter((s) => typeof s[k] === 'number');
    if (counted.length * 2 < use.length) failures.push(`${what} not read in ${use.length - counted.length} of ${use.length} sample(s): a leak of them can't be judged`);
    else {
      const g = growth(counted, (s) => s[k] as number);
      leak(what, k === 'cgroupKernelBytes' ? g : { growth: Math.round(g.growth * 10) / 10, peak: g.peak }, limit, fmt);
    }
  }
  // R1181o D1, R1181p D2: the filesystems' and the kernel's levels, as the disk is held (growth with the 4x peak). The
  // driver takes the event log out of it (R1181q D2: the log is judged on its own above, by its own limits).
  if (use.some((s) => typeof s.levelBytes === 'number')) {
    const counted = use.filter((s) => typeof s.levelBytes === 'number');
    if (counted.length * 2 < use.length) failures.push(`the filesystems' used space not read in ${use.length - counted.length} of ${use.length} sample(s): a leak of it can't be judged`);
    else leak("the used space of the soak's filesystems and the kernel's shared memory", growth(counted, (s) => s.levelBytes!), limits.diskGrowthBytes, MB);
  }
  // The worktree folder's entries, as worktrees: a checkout copied aside and pruned from git is still here.
  if (has('worktreeDirs')) {
    const g = growth(use, (s) => s.worktreeDirs!);
    leak("the worktree folder's entries", { growth: Math.round(g.growth * 10) / 10, peak: g.peak }, limits.worktreeGrowth, (n) => `by ${Math.round(n * 10) / 10}`);
  }
  const landedSince = Math.max(1, end.tasksDone - use[0]!.tasksDone);
  let diskPerTask: number | string = 'not recorded';
  if (has('diskBytes')) {
    // Less the event log, which is judged per task above: what's left is everything else the soak keeps on disk.
    const other = (s: SoakSample) => s.diskBytes! - s.eventsBytes;
    const perTask = (other(end) - other(use[0]!)) / landedSince;
    if (perTask > limits.diskBytesPerTask) failures.push(`disk growth: ${MB(other(end) - other(use[0]!))} under the soak's folder after the warm-up, besides the event log: ${Math.round(perTask / 1024)} KB per landed task (limit ${Math.round(limits.diskBytesPerTask / 1024)} KB)`);
    // And held, then freed (R1181l 3 V1: +8 GB for minutes 100-300 passed): growth with the 4x peak.
    leak("the disk under the soak's folder, besides the event log", growth(use, other), limits.diskGrowthBytes, MB);
    diskPerTask = `${Math.round(perTask / 1024)} KB`;
  }
  let filesPerTask: number | string = 'not recorded';
  if (has('files')) {
    const n = (end.files! - use[0]!.files!) / landedSince;
    if (n > limits.filesPerTask) failures.push(`file growth: ${end.files! - use[0]!.files!} files under the soak's folder after the warm-up, ${Math.round(n)} per landed task (limit ${limits.filesPerTask})`);
    filesPerTask = Math.round(n * 10) / 10;
  }

  // R1181t D3: what the coordinator's stop() and idle() leave, read 2 s after them. Processes, worktrees and the
  // worktree folder's entries above the first quarter's median are left behind (any one); a run open or a slot held
  // then never finished; the rest above that median by more than its growth limit.
  let leftAtStop: string | number = 'not read';
  if (stop) {
    const before = failures.length;
    const base = (k: keyof SoakSample) => median(first.map((s) => s[k]).filter((x): x is number => typeof x === 'number'));
    const at = (k: keyof SoakSample) => (typeof stop[k] === 'number' && first.some((s) => typeof s[k] === 'number') ? (stop[k] as number) : null);
    // R1181ac AC1, R1181af AF1: a task's checkout may be open at stop though no run sample saw one, so worktrees are
    // judged by task state, not the samples' phase: with the strays read, any worktree or folder entry no open task
    // owns fails (two left by the shutdown fail, the open task's own passes); without them, the first quarter's median.
    const byTask = typeof stop.worktreeStrays === 'number';
    if (byTask && stop.worktreeStrays! > 0) failures.push(`left at stop: ${stop.worktreeStrays} worktree(s) or worktree folder entr(ies) that no open task owns after stop() and idle()`);
    // R1181ak D6: a claim no open task holds is a leak at stop, whatever the run's samples read (#1275).
    if (typeof stop.claimRefs === 'number' && stop.claimRefs > 0) failures.push(`left at stop: ${stop.claimRefs} claim ref(s) on the remote that no open task holds (#1275)`);
    for (const [k, what] of [['children', 'child process(es)'], ['cgroupProcs', "process(es) in the job's cgroup"], ['sysvIpc', 'SysV IPC object(s)'], ['mqueues', 'POSIX message queue(s)'], ['userKeys', "key(s) in this user's keyrings"], ['worktrees', 'worktree(s)'], ['worktreeDirs', "entr(ies) in the worktree folder"]] as const) {
      if (byTask && (k === 'worktrees' || k === 'worktreeDirs')) continue;
      const n = at(k);
      if (n !== null && n > base(k)) failures.push(`left at stop: ${n} ${what} after stop() and idle(), above the first quarter's ${base(k)}`);
    }
    for (const [k, what, limit, fmt] of [
      ['fds', 'open file handles', limits.fdGrowth, String],
      ['timers', 'live timers', limits.fdGrowth, String],
      ['childFds', "the child processes' open file handles", limits.fdGrowth, String],
      ['watches', 'inotify watches', limits.fdGrowth, String],
      ['childRss', "the child processes' RSS", limits.rssGrowthBytes, MB],
      ['cgroupKernelBytes', "the job cgroup's unreclaimable kernel memory", limits.kernelGrowthBytes, MB],
      ['levelBytes', "the used space of the soak's filesystems and the kernel's shared memory", limits.diskGrowthBytes, MB],
    ] as const) {
      const n = at(k);
      if (n !== null && n - base(k) > limit) failures.push(`left at stop: ${what} ${fmt(n - base(k))} above the first quarter's after stop() and idle() (limit ${fmt(limit)})`);
    }
    // R1181v L1: an error or failure logged by the shutdown itself (the usual way a shutdown leaves something).
    for (const [k, what] of [['errors', 'coordinator.error event(s)'], ['failedRuns', 'agent run(s) that did not succeed'], ['failureEvents', 'failure event(s)']] as const) {
      const was = end[k];
      const now = stop[k];
      if (typeof was === 'number' && typeof now === 'number' && now > was) failures.push(`left at stop: ${now - was} ${what} logged during stop() and idle()`);
    }
    // R1181x D2: what the shutdown writes: files and disk (less the log) past the last run sample, and the event log.
    const other = (s: SoakSample) => (typeof s.diskBytes === 'number' ? s.diskBytes - s.eventsBytes : null);
    const diskEnd = other(end);
    const diskStop = other(stop);
    if (diskEnd !== null && diskStop !== null && diskStop - diskEnd > STOP_DISK_BYTES) failures.push(`left at stop: ${MB(diskStop - diskEnd)} more on disk besides the event log after stop() and idle() (limit ${MB(STOP_DISK_BYTES)})`);
    // R1181y Y1: a task's checkout open at stop is the worktree checks' to judge (its files grow with the repo: +195 after
    // 118 tasks); the files outside the worktree folder are compared.
    const unchecked = (s: SoakSample) => (typeof s.files === 'number' ? s.files - (s.worktreeFiles ?? 0) : null);
    const filesEnd = unchecked(end);
    const filesStop = unchecked(stop);
    // R1181aa AA1: inside the worktree folder, the files no checkout tracks (a checkout open at stop adds none of its own).
    if (typeof end.worktreeLeftovers === 'number' && typeof stop.worktreeLeftovers === 'number' && stop.worktreeLeftovers - end.worktreeLeftovers > STOP_FILES) failures.push(`left at stop: ${stop.worktreeLeftovers - end.worktreeLeftovers} more files in the worktree folder that no checkout tracks after stop() and idle() (limit ${STOP_FILES})`);
    if (filesEnd !== null && filesStop !== null && filesStop - filesEnd > STOP_FILES) failures.push(`left at stop: ${filesStop - filesEnd} more files and folders outside the worktree folder after stop() and idle() (limit ${STOP_FILES})`);
    if (stop.eventsBytes - end.eventsBytes > STOP_LOG_BYTES) failures.push(`left at stop: the event log grew ${MB(stop.eventsBytes - end.eventsBytes)} during stop() and idle() (limit ${MB(STOP_LOG_BYTES)})`);
    // R1181z D3: inodes used outside the walked folders (empty files cost no block), and L3: the level's bytes, against
    // the last run sample.
    if (typeof end.levelFiles === 'number' && typeof stop.levelFiles === 'number') {
      // R1181aa AA2: only the walked files on a filesystem the inode count reads (a tmpfs soak folder is in none).
      const walked = typeof end.levelWalked === 'number' && typeof stop.levelWalked === 'number' ? stop.levelWalked - end.levelWalked : typeof end.files === 'number' && typeof stop.files === 'number' ? stop.files - end.files : 0;
      const outside = stop.levelFiles - end.levelFiles - walked;
      if (outside > STOP_FILES) failures.push(`left at stop: ${outside} more files outside the soak's folders after stop() and idle() (used inodes; limit ${STOP_FILES})`);
    }
    if (typeof end.levelBytes === 'number' && typeof stop.levelBytes === 'number' && stop.levelBytes - end.levelBytes > STOP_DISK_BYTES) failures.push(`left at stop: the filesystems' level ${MB(stop.levelBytes - end.levelBytes)} above the last run sample's after stop() and idle() (limit ${MB(STOP_DISK_BYTES)})`);
    if (stop.walBytes > limits.walBytes) failures.push(`left at stop: the WAL at ${MB(stop.walBytes)} after stop() and idle() (limit ${MB(limits.walBytes)})`);
    if (stop.openRuns > 0) failures.push(`left at stop: ${stop.openRuns} agent run(s) open after stop() and idle()`);
    if (stop.slotsHeld > 0) failures.push(`left at stop: ${stop.slotsHeld} agent slot(s) held after stop() and idle()`);
    if ((stop.fullRunHeld ?? 0) > 0) failures.push('left at stop: the full-run lock held after stop() and idle()');
    leftAtStop = failures.length - before;
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
    measured: { hours: +(end.at / 3_600_000).toFixed(2), samples: samples.length, tasks_done: end.tasksDone, tasks_filed: end.filed, heap_growth: MB(heap.growth), heap_peak: MB(heap.peak), rss_growth: MB(rss.growth), fd_growth: fds ?? 'not counted', log_per_task: `${Math.round(perTask / 1024)} KB`, wal_max: MB(wal), tick_ms_first: Math.round(t0), tick_ms_last: Math.round(t1), tick_ms_slowest_first: Math.round(m0), tick_ms_slowest_last: Math.round(m1), tick_ms_per_100k_events: perEvents, oldest_unlanded_min: Math.round(Math.max(...use.map((s) => s.oldestUnlandedMs)) / 60_000), max_gap_min: +(Math.max(...samples.slice(1).map((s, i) => s.at - samples[i]!.at)) / 60_000).toFixed(1), open_runs_end: end.openRuns, slots_held_end: end.slotsHeld, errors_after_warmup: errors, worktree_growth: worktrees, child_growth: children, disk_per_task: diskPerTask, files_per_task: filesPerTask, left_at_stop: leftAtStop, not_judged: notJudged.join(', ') || 'none' },
  };
}
