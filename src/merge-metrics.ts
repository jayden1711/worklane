// What the conflict machinery costs the flywheel, from the event log alone:
// conflict fixes (how many, minutes from conflict to merged, how many needed
// the owner), light combined-state checks (how many, minutes added) and
// hotspot holds (how many, minutes tasks waited). Each is also shown per
// merged PR, and flagged with a suggested tuning when it adds more than a few
// minutes per merged PR on average. Pure: the health panel, the PRs page and
// the weekly report all call `mergeMetrics`.

/**
 * The events these read (their shapes, as recorded):
 *   conflict_fix.detected  { issue, number, head, base_sha }
 *   conflict_fix.started   { issue, number, head, base_sha, strategy, attempt, lease }
 *   conflict_fix.finished  { issue, number, base_sha, strategy, outcome: 'pushed'|'no_push'|'gave_up'|'interrupted', head, files, waits_owner, reasons, detail }
 *   light_check.finished   { issue, number, head, main_sha, overlap, outcome: 'merge'|'conflict'|'hold', wait_ms }
 *   hotspot.held           { issue, by, files }
 *   hotspot.released       { issue, waited_ms, files }
 *   pr.closed              { issue, number, merged }      (existing: a PR merged, by anyone)
 */
export interface MetricEvent {
  ts: string;
  type: string;
  payload: unknown;
}

export interface MergeMetrics {
  since: string;
  mergedPrs: number;
  conflicts: { count: number; needOwner: number; minutesToMerged: number[]; medianMinutes: number | null; perMergedPr: number };
  lightChecks: { count: number; minutesAdded: number; perMergedPr: number; outcomes: Record<string, number> };
  holds: { count: number; minutesWaited: number; perMergedPr: number; byFile: { file: string; minutes: number; count: number }[] };
  /** One line per measure that costs more than `thresholdMinutes` per merged PR, with a suggested tuning. */
  flags: string[];
}

/** "A few minutes": above this many added minutes per merged PR, a measure is flagged. */
export const FLAG_MINUTES = 3;

const p = <T>(e: MetricEvent) => e.payload as T;
const minutes = (ms: number) => ms / 60_000;
const round1 = (n: number) => Math.round(n * 10) / 10;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function mergeMetrics(events: MetricEvent[], o: { since: Date; thresholdMinutes?: number }): MergeMetrics {
  const t0 = o.since.getTime();
  const inWindow = events.filter((e) => Date.parse(e.ts) >= t0);
  const threshold = o.thresholdMinutes ?? FLAG_MINUTES;
  const merged = inWindow.filter((e) => e.type === 'pr.closed' && p<{ merged: boolean }>(e).merged);
  const mergedAt = new Map<number, number>();
  for (const e of merged) mergedAt.set(p<{ number: number }>(e).number, Date.parse(e.ts));
  const n = merged.length;
  const per = (total: number) => (n ? round1(total / n) : 0);

  // Conflict fixes: from the first time a PR was seen conflicting (per base) to its merge.
  const detected = inWindow.filter((e) => e.type === 'conflict_fix.detected');
  const firstConflict = new Map<number, number>();
  for (const e of detected) {
    const pr = p<{ number: number }>(e).number;
    if (!firstConflict.has(pr)) firstConflict.set(pr, Date.parse(e.ts));
  }
  const toMerged: number[] = [];
  for (const [pr, at] of firstConflict) {
    const m = mergedAt.get(pr);
    if (m !== undefined && m >= at) toMerged.push(round1(minutes(m - at)));
  }
  const finished = inWindow.filter((e) => e.type === 'conflict_fix.finished');
  const needOwner = new Set(finished.filter((e) => p<{ waits_owner: boolean; outcome: string }>(e).waits_owner || p<{ outcome: string }>(e).outcome === 'gave_up').map((e) => p<{ number: number }>(e).number)).size;
  const conflictMinutes = toMerged.reduce((a, b) => a + b, 0);

  // Light checks: the time each one added before its merge.
  const lights = inWindow.filter((e) => e.type === 'light_check.finished');
  const lightMinutes = round1(lights.reduce((a, e) => a + minutes(p<{ wait_ms: number }>(e).wait_ms), 0));
  const outcomes: Record<string, number> = {};
  for (const e of lights) outcomes[p<{ outcome: string }>(e).outcome] = (outcomes[p<{ outcome: string }>(e).outcome] ?? 0) + 1;

  // Hotspot holds: how long tasks waited, and on which files.
  const held = inWindow.filter((e) => e.type === 'hotspot.held');
  const released = inWindow.filter((e) => e.type === 'hotspot.released');
  const holdMinutes = round1(released.reduce((a, e) => a + minutes(p<{ waited_ms: number }>(e).waited_ms), 0));
  const files = new Map<string, { minutes: number; count: number }>();
  for (const e of released) {
    const r = p<{ waited_ms: number; files?: string[] }>(e);
    for (const f of r.files ?? []) {
      const x = files.get(f) ?? { minutes: 0, count: 0 };
      x.minutes = round1(x.minutes + minutes(r.waited_ms));
      x.count++;
      files.set(f, x);
    }
  }
  const byFile = [...files].map(([file, x]) => ({ file, ...x })).sort((a, b) => b.minutes - a.minutes);

  const out: MergeMetrics = {
    since: o.since.toISOString(),
    mergedPrs: n,
    conflicts: { count: firstConflict.size, needOwner, minutesToMerged: toMerged, medianMinutes: median(toMerged), perMergedPr: per(conflictMinutes) },
    lightChecks: { count: lights.length, minutesAdded: lightMinutes, perMergedPr: per(lightMinutes), outcomes },
    holds: { count: held.length, minutesWaited: holdMinutes, perMergedPr: per(holdMinutes), byFile },
    flags: [],
  };

  const conflictFiles = new Map<string, number>();
  for (const e of finished) for (const f of p<{ files?: string[] }>(e).files ?? []) conflictFiles.set(f, (conflictFiles.get(f) ?? 0) + 1);
  const topConflict = [...conflictFiles].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
  if (out.conflicts.perMergedPr > threshold)
    out.flags.push(`Conflict fixes add ${out.conflicts.perMergedPr} min per merged PR: consider listing ${topConflict.length ? topConflict.join(', ') : 'the files they conflict on'} as hotspots so those tasks don't run at once`);
  if (out.lightChecks.perMergedPr > threshold)
    out.flags.push(`Combined-state checks add ${out.lightChecks.perMergedPr} min per merged PR: consider a faster tests.yaml runner.changed, or turning the check off for this repo if main rarely breaks after a merge`);
  if (out.holds.perMergedPr > threshold)
    out.flags.push(`Hotspot holds add ${out.holds.perMergedPr} min per merged PR${byFile[0] ? `, most on ${byFile[0].file}` : ''}: consider removing it from the repo's hotspots if those tasks rarely conflict, or splitting the file`);
  return out;
}
