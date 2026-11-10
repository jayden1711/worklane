// Canary rollout of a risky change, ring by ring (docs/rollout.md). One engine serves every instance on a machine, so
// rings stage a change behind a feature flag (src/flags.ts), not an engine version: the flag goes on for ring 0 (the
// engine's own repo), then each later ring in order, each only once the ring before it has soaked healthy. Engine
// versions keep their own gate (the scratch-repo canary and the updater's rollback, docs/canary.md).
//
// Root's /etc/<cli>/rollout.json names the rings' instances (never this repository: no project's name is in it). This
// module only reads: each instance's event log, and says per ring what it saw and what to do next. It never flips a
// flag: turning one on or off is a reviewed config PR in that ring's repos, as every flag change is.
//
// What a ring's state is judged from (#1174 reviews R1174c, R1174d):
//   - the log's own order, not its clock: what came after the last flip that turned the flag on is what happened while
//     it was on (a clock stepped back never hides a bad sign); the clock only measures the soak's hours;
//   - the flip history: a ring turned on before the ring before it was promoted is out of order for good, until the
//     flag goes off there and on again;
//   - liveness: a ring is promoted only on a coordinator seen ticking recently, with no unclean restart and at most
//     max_errors coordinator errors since the flip (silence is not health);
//   - every log: a ring with a log no one could read is unknown, never off, and holds every step that turns a ring on.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { StoredEvent } from './events/types.js';
import { readRootFile } from './os/root-file.js';
import { etcPath } from './os/system-paths.js';

export const ROLLOUT_FILE = () => etcPath('rollout.json');

export const RolloutFile = z.strictObject({
  /** In order: ring 0 first (the engine's own repo's instance), then each project's. An instance is in one ring. */
  rings: z
    .array(z.strictObject({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/), instances: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)).min(1) }))
    .min(1)
    .superRefine((rings, ctx) => {
      const seen = new Set<string>();
      for (const [i, r] of rings.entries()) for (const n of r.instances) {
        if (seen.has(n)) ctx.addIssue({ code: 'custom', path: [i, 'instances'], message: `instance ${n} is in more than one ring` });
        seen.add(n);
      }
    }),
  /** What a ring must show, after the flag went on for it, before the next ring may turn it on. */
  promote: z
    .strictObject({
      soak_hours: z.number().int().min(1).max(24 * 30).default(48),
      min_merges: z.number().int().min(0).max(1000).default(3),
      /** Each instance's last coordinator.tick at most this long ago: a coordinator that stopped ticking isn't soaking. */
      live_minutes: z.number().int().min(5).max(24 * 60).default(30),
      /** More coordinator.error events than this since the flip is a bad sign. */
      max_errors: z.number().int().min(0).max(1000).default(2),
    })
    .prefault({}),
});
export type Rollout = z.infer<typeof RolloutFile>;

/**
 * Root's rollout.json, as root's other policy files are read (#747, R1174d 6): a link, a non-regular or oversized file,
 * or one that isn't root's alone is refused. `file` given (a copy to try out): read as it is, and `checked` says so.
 */
export function readRollout(file?: string, rootUid = 0): { rollout: Rollout; checked: boolean } {
  if (file !== undefined) return { rollout: RolloutFile.parse(JSON.parse(readFileSync(file, 'utf8'))), checked: false };
  const r = readRootFile(ROLLOUT_FILE(), rootUid);
  if ('problem' in r) throw new Error(`${r.problem}: rollout.json is root's alone (docs/rollout.md)`);
  return { rollout: RolloutFile.parse(JSON.parse(r.text)), checked: true };
}

/** Events that mean the change may be hurting a ring once its flag is on: each one rolls the ring back. */
export function badSign(e: StoredEvent): string | null {
  switch (e.type as string) {
    case 'merge.stopped':
      return 'auto-merge stopped';
    case 'merge.main_result': {
      const o = (e.payload as { outcome?: string }).outcome;
      return o === 'red' || o === 'timed_out' ? `the default branch went ${o === 'red' ? 'red' : 'unknown (timed out)'} after a merge` : null;
    }
    case 'config.invalid':
      return 'the config went invalid';
    case 'testrun.fault':
      return `a test run met a machine fault (${(e.payload as { fault?: string }).fault ?? 'unknown'})`;
    case 'coordinator.stopped':
      return (e.payload as { clean?: boolean }).clean === false ? 'the coordinator stopped uncleanly' : null;
    case 'coordinator.error':
      // R1174j J4: events lost to a full disk past the in-memory buffer: a bad sign among them is gone with them.
      return (e.payload as { kind?: string }).kind === 'disk_full' ? 'events were lost to a full disk (what they said is unknown)' : null;
    default:
      return null;
  }
}

export type RingState = 'off' | 'partial' | 'soaking' | 'promoted' | 'roll back' | 'out of order' | 'unknown';

export interface RingStatus {
  ring: string;
  instances: string[];
  state: RingState;
  /** When the flag was last turned on in this ring (the latest of its instances'), or null. */
  onSince: string | null;
  merges: number;
  /** What went wrong since it went on (each instance's first, at most 5). */
  bad: string[];
  why: string;
}

/** One instance's log, read in its own order: the flag's state, and what happened after the flip that turned it on. */
export interface InstanceRead {
  on: boolean;
  /** The ts of the flip that turned it on (the last one), or null. */
  since: string | null;
  /** merge.done after that flip, by log order: their ts, one per PR (R1174f A4: a PR recorded twice counts once). */
  merges: string[];
  /** The first bad sign after that flip, by log order. */
  bad: string | null;
  /** The ts of the last coordinator.tick, anywhere in the log. */
  lastTick: string | null;
  /** A bad sign in an earlier on-period (rolled back before, then turned on again). */
  badBefore: string | null;
  /** Off by the engine's own off (it read no config from the default branch): the repo didn't turn it off. */
  engineOff: boolean;
  /** The flip's stamp is before events logged ahead of it: a clock behind, so the soak can't be timed. */
  skewed: boolean;
  /** When the stretch of config-on time began, at the earliest (for judging order against the ring before), or null. */
  stretchSince: string | null;
  /** R1174t D1: the build whose start began the soak again (an update or a rollback after the flip), or null. */
  rebuilt: { version: string; at: string } | null;
  /** Time since the flip the coordinator was stopped cleanly (a stop to the next start): no soak (R1174j J3). */
  downMs: number;
}

export function readInstance(events: readonly StoredEvent[], flag: string, maxErrors: number, liveMs = Infinity): InstanceRead {
  // The log's order is the array's (the event ids'), never the clock's.
  let flipAt = -1;
  let since: string | null = null;
  let on = false;
  let periodStart = -1;
  let badBefore: string | null = null;
  let engineOff = false;
  // The stretch: from the on that began this run of config-on time, across the engine's own offs (R1231a, R1174f A2:
  // an engine off then on again laundered an out-of-order start and a bad sign). Only an off with a commit ends it.
  let stretchAt = -1;
  for (const [i, e] of events.entries()) {
    if (e.type !== 'flag.flipped' || (e.payload as { flag: string }).flag !== flag) continue;
    const to = (e.payload as { to: boolean }).to;
    // An off with no commit is the engine's own (it read no config from the default branch) and it is a real off: the
    // engine ran with the flag off, so the next on starts a new soak (#1174 reviews R1174g D1, R1174h H1; R1174f 1
    // had it ignored, which counted hours and merges made with the flag off). R1174f A1: an on while on is a replay,
    // never a new on-period.
    if (to && on) continue;
    engineOff = !to && (e.payload as { sha?: unknown }).sha === null;
    if (!to && !engineOff) stretchAt = -1;
    if (to && stretchAt < 0) stretchAt = i;
    if (!to && !engineOff && on && periodStart >= 0) {
      // The on-period that just ended: a bad sign in it is remembered (R1174d A3: off and on again erased it).
      const b = events.slice(periodStart + 1, i).map(badSign).find((x) => x !== null);
      if (b) badBefore = `${b} (in an earlier on-period, before ${e.ts})`;
    }
    on = to;
    if (to) {
      flipAt = i;
      since = e.ts;
      periodStart = i;
    } else since = null;
  }
  const merges: string[] = [];
  const mergedPrs = new Set<unknown>();
  let bad: string | null = null;
  let errors = 0;
  let lastTick: string | null = null;
  // Alive: the last tick comes after any recorded stop (R1174h H4: a coordinator that stopped cleanly read as alive).
  let stoppedAfterTick = false;
  // The clock: a flip stamped before an event logged ahead of it (R1174h H3a: a clock behind) can't time a soak.
  const flipTs = on && flipAt >= 0 ? Date.parse(events[flipAt]!.ts) : NaN;
  // A loop, not Math.max(...): a spread over a long-lived log throws (R1174j J5: past ~125k events).
  let latestBefore = -Infinity;
  // A stamp that doesn't parse is skipped (R1174k D2: one NaN made the whole bound NaN, and the hold never fired).
  if (on) for (let i = 0; i < flipAt; i++) {
    const t = Date.parse(events[i]!.ts);
    if (Number.isFinite(t)) latestBefore = Math.max(latestBefore, t);
  }
  // And an event logged after the flip but stamped before it (R1174j J2: a clock ahead at the flip hid an early on), or
  // a stamp that doesn't parse (J6), can't time a soak either.
  let skewed = on && latestBefore - flipTs > 60_000;
  let downMs = 0;
  let stoppedAt: number | null = null;
  // R1174k D1, R1174l A1/A2: a coordinator suspended, paused, frozen or hung, or a clock stepped forward, records no
  // stop: a gap of more than live_minutes between two ticks of one run is no soak either.
  let prevTick: number | null = null;
  // R1174r D1: whether the run since the last start has ticked. A start stopped before any tick soaked nothing, however
  // short: else chained runs of under live_minutes that never ticked promoted a ring.
  let runTicked = true;
  // A coordinator.started with no clean stop since the one before it: the process died (a crash loop shows as several).
  let running = false;
  // R1174t D1: the build each start ran (`version`, src/service.ts). A start after the flip on a build other than the
  // run before it (an update, or a rollback) begins the soak again, like a new flip: the code behind the flag changed,
  // and the canary runs with every flag off, so the soak is the only test the new flagged code gets.
  let runVersion: unknown = null;
  let newBuild = false;
  let rebuilt: { version: string; at: string } | null = null;
  for (const [i, e] of events.entries()) {
    // Merges and the soak count from the last on (the engine ran with the flag off before it); bad signs from the
    // stretch's start (an engine off and on again forgives nothing).
    const after = on && i > flipAt;
    const inStretch = on && stretchAt >= 0 && i > stretchAt;
    if (e.type === 'coordinator.tick' && Number.isFinite(Date.parse(e.ts))) {
      lastTick = e.ts;
      stoppedAfterTick = false;
    }
    if (e.type === 'coordinator.stopped') stoppedAfterTick = true;
    if (e.type === 'coordinator.started') {
      if (inStretch && running) bad ??= 'the coordinator restarted without a clean stop';
      running = true;
      const v = (e.payload as { version?: unknown }).version;
      newBuild = after && runVersion !== null && v !== runVersion;
      runVersion = v ?? null;
    }
    if (e.type === 'coordinator.stopped' && (e.payload as { clean?: boolean }).clean === true) running = false;
    if (!inStretch) continue;
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts) || (after && ts < flipTs - 60_000)) skewed = true;
    // R1174t D1: a new build's start: the soak, its stopped time and its merges start again here. Bad signs still count
    // from the stretch's start (a new build forgives nothing).
    if (newBuild) {
      since = e.ts;
      downMs = 0;
      merges.length = 0;
      mergedPrs.clear();
      stoppedAt = null;
      newBuild = false;
      rebuilt = { version: String(runVersion), at: e.ts };
    }
    // R1174j J3: a clean stop, then a start: the time between is no soak (a coordinator stopped 48 of 50 h promoted).
    if (after && e.type === 'coordinator.stopped' && (e.payload as { clean?: boolean }).clean === true) stoppedAt = ts;
    // A stop ends a run: the silence from its last tick to the stop is no soak either (R1174m P1, R1174n N1: a host
    // suspended for 46 h, then a clean stop and restart on resume, promoted); the stop's own time to the next start is
    // the clean stop's (above). A start begins a new run from its own stamp, so nothing is counted twice. A run that
    // never ticked is counted whatever its length (R1174r D1); Math.max keeps a stop stamped before its start from
    // subtracting.
    if (after && e.type === 'coordinator.stopped' && prevTick !== null && Number.isFinite(ts) && (ts - prevTick > liveMs || !runTicked)) downMs += Math.max(0, ts - prevTick);
    if (after && e.type === 'coordinator.stopped') prevTick = null;
    // R1174m D3, R1174n N2 (the owner's decision (b)): a start is life only once a tick follows it, so its time to the
    // first tick (or to a stop with none) is a gap like any other: a coordinator that hung right after starting soaked
    // nothing. The flip to the first tick stays a stated limit.
    if (after && e.type === 'coordinator.started') {
      prevTick = Number.isFinite(ts) ? ts : null;
      runTicked = false;
    }
    if (after && e.type === 'coordinator.tick' && Number.isFinite(ts)) {
      if (prevTick !== null && ts - prevTick > liveMs) downMs += ts - prevTick;
      // R1174p D1: each gap from the tick before as stamped, never the furthest stamp seen: a tick stamped ahead (the
      // first after a flip or start, or a ratchet of steps under live_minutes) hid the silence after it.
      prevTick = ts;
      runTicked = true;
    }
    if (after && e.type === 'coordinator.started' && stoppedAt !== null) {
      if (Number.isFinite(stoppedAt) && Number.isFinite(ts)) downMs += Math.max(0, ts - stoppedAt);
      stoppedAt = null;
    }
    if (after && e.type === 'merge.done') {
      const n = (e.payload as { number?: unknown }).number;
      // Merged after the flip, by its own merged_at when it has one (R1174h H2: a merge made before the flip and
      // recorded after it counted).
      const at = (e.payload as { merged_at?: unknown }).merged_at;
      const before = typeof at === 'string' && Number.isFinite(Date.parse(at)) && Date.parse(at) < flipTs;
      // By its PR number, once each; a merge with no number can't be told from a repeat, so it never counts (R1174i/j).
      if (!before && n !== undefined && n !== null && !mergedPrs.has(n)) merges.push(e.ts);
      if (n !== undefined && n !== null) mergedPrs.add(n);
    }
    if (inStretch && e.type === 'coordinator.error' && ++errors > maxErrors) bad ??= `${errors} coordinator errors since it went on (limit ${maxErrors})`;
    if (inStretch) bad ??= badSign(e);
  }
  // When the stretch began, for judging order against the ring before (R1174h H3b): the earlier of its flip's stamp
  // and the stamp of the event logged just before it, since a flip logged after a silence may be stamped late.
  // And the earliest stamp of any event in the stretch (R1174j J2: a clock ahead at the flip, fixed after it).
  let stretchTs = NaN;
  if (on && stretchAt >= 0) {
    stretchTs = stretchAt > 0 ? Date.parse(events[stretchAt - 1]!.ts) : Infinity;
    for (let i = stretchAt; i < events.length; i++) {
      const t = Date.parse(events[i]!.ts);
      if (Number.isFinite(t)) stretchTs = Math.min(stretchTs, t);
    }
  }
  return { on, since: on ? since : null, merges, bad, lastTick: stoppedAfterTick ? null : lastTick, badBefore, engineOff: !on && engineOff, skewed, stretchSince: Number.isFinite(stretchTs) ? new Date(stretchTs).toISOString() : null, downMs, rebuilt: on ? rebuilt : null };
}

/** Each instance's last recorded state of `flag` (flag.flipped), in log order. */
const isOn = (events: readonly StoredEvent[], flag: string) => readInstance(events, flag, Infinity).on;

/**
 * Whether ring 0 is the engine's own repo and nothing else, and no engine instance is outside it (R1174d 5). `repos`:
 * each instance's repos (null: can't tell). `engine`: the engine's own repos (null: can't tell).
 */
export function ringZeroProblem(o: { rollout: Rollout; repos: ReadonlyMap<string, readonly string[] | null>; engine: readonly string[] | null; outsideNames?: readonly string[] }): string | null {
  if (o.engine === null || !o.engine.length) return "can't tell the engine's own repos";
  const engine = new Set(o.engine.map((r) => r.toLowerCase()));
  const ring0 = o.rollout.rings[0]!.instances;
  const ownsEngine = (n: string) => (o.repos.get(n) ?? null)?.some((r) => engine.has(r.toLowerCase())) ?? null;
  for (const n of ring0) {
    const own = ownsEngine(n);
    if (own === null) return `can't tell ${n}'s repo (ring 0 must be the engine's own repo)`;
    if (!own) return `ring 0 (${o.rollout.rings[0]!.name}) has ${n}, which is not an instance of the engine's own repo (${o.engine.join(', ')})`;
  }
  for (const n of [...o.rollout.rings.slice(1).flatMap((r) => r.instances), ...(o.outsideNames ?? [])]) {
    const own = ownsEngine(n);
    if (own === null) return `can't tell ${n}'s repo (an instance of the engine's own repo belongs in ring 0)`;
    if (own) return `${n} is an instance of the engine's own repo but isn't in ring 0`;
  }
  return null;
}

/**
 * Every ring's state for `flag`, in order, and the one next step. `logs`: each instance's events (missing: unread,
 * which makes the ring unknown and holds every turn-on).
 */
export function rolloutStatus(o: {
  rollout: Rollout;
  flag: string;
  logs: ReadonlyMap<string, readonly StoredEvent[]>;
  now: Date;
  /** The machine's other instances (in no ring), by name, with their events; missing: unread. */
  outside?: ReadonlyMap<string, readonly StoredEvent[]>;
  outsideNames?: readonly string[];
  /** Whether ring 0 is the engine's own repo (ringZeroProblem): a problem holds every turn-on. Absent: not checked. */
  ringZero?: string | null;
  /** The machine's instance list couldn't be made whole (it doesn't name every ring instance): holds every turn-on. */
  listing?: string | null;
}): { rings: RingStatus[]; next: string; outsideOn: string[]; outsideUnread: string[] } {
  const { soak_hours, min_merges, live_minutes, max_errors } = o.rollout.promote;
  const rings: RingStatus[] = [];
  /** When the ring before was promoted (ms), null: not promoted. Ring 0 has no ring before it. */
  let prevPromotedAt: number | null = Number.NEGATIVE_INFINITY;
  let prevName = '';
  for (const r of o.rollout.rings) {
    const missing = r.instances.filter((n) => !o.logs.has(n));
    const reads = r.instances.filter((n) => o.logs.has(n)).map((n) => ({ n, ...readInstance(o.logs.get(n)!, o.flag, max_errors, live_minutes * 60_000) }));
    const onReads = reads.filter((s) => s.on);
    const onCount = onReads.length;
    const sinces = onReads.map((s) => s.since!).sort();
    const onSince = sinces.at(-1) ?? null;
    const earliest = onReads.map((s) => s.stretchSince ?? s.since!).sort()[0] ?? null;
    const mergeTs = onReads.flatMap((s) => s.merges).sort();
    const bad = onReads.filter((s) => s.bad).map((s) => `${s.n}: ${s.bad}`);
    const base = { ring: r.name, instances: r.instances, onSince, merges: mergeTs.length, bad: bad.slice(0, 5) };
    const unread = missing.length ? `can't read the event log of ${missing.join(', ')}` : '';
    const also = unread ? `; and ${unread}` : '';
    let st: RingStatus;
    let promotedAt: number | null = null;
    if (onCount && prevPromotedAt === null) st = { ...base, state: 'out of order', why: `on before ring ${prevName} was promoted: turn it off here until that ring is${also}` };
    else if (onCount && Date.parse(earliest!) < prevPromotedAt!) st = { ...base, state: 'out of order', why: `turned on at ${earliest}, before ring ${prevName} was promoted (${new Date(prevPromotedAt!).toISOString()}): turn it off here and on again${also}` };
    else if (onCount && bad.length) st = { ...base, state: 'roll back', why: `${bad.join('; ')}${also}` };
    else if (missing.length) st = { ...base, state: 'unknown', why: `${unread}: nothing is promoted or turned on while a ring's log is unread` };
    else if (reads.some((s) => s.engineOff)) st = { ...base, state: 'unknown', why: `${reads.filter((s) => s.engineOff).map((s) => s.n).join(', ')} runs with the flag off by itself (it read no config from its default branch): fix that before anything is turned on (R1174f A2)` };
    else if (onCount === 0) st = { ...base, state: 'off', why: 'the flag is off in every instance of this ring' };
    else if (onCount < r.instances.length) st = { ...base, state: 'partial', why: `on in ${onCount} of ${r.instances.length} instances: turn it on in all of them, or off in all` };
    else {
      // Each instance's soak is its time since its flip, less the time it was stopped cleanly (R1174j J3); the ring's
      // is its shortest.
      const hours = Math.min(...onReads.map((s) => (o.now.getTime() - Date.parse(s.since!) - s.downMs) / 3_600_000));
      // A last tick stamped in the future (a clock ahead) is no sign of life (R1174f A5): alive is a tick in the last
      // live_minutes, by this clock.
      const age = (t: string) => o.now.getTime() - Date.parse(t);
      const stale = onReads.filter((s) => s.lastTick === null || age(s.lastTick) > live_minutes * 60_000 || age(s.lastTick) < -60_000).map((s) => s.n);
      // min_merges in EACH instance (R1174f 3: one that did no work was promoted on the others' merges).
      const short = onReads.filter((s) => s.merges.length < min_merges).map((s) => `${s.n}: ${s.merges.length} of ${min_merges} merges`);
      const before = onReads.map((s) => s.badBefore).find((x) => x) ?? null;
      const rebuiltNote = onReads.filter((s) => s.rebuilt).map((s) => `${s.n}: the soak started again at ${s.rebuilt!.at} on build ${s.rebuilt!.version} (an update or a rollback)`);
      const earlier = `${before ? `; rolled back before: ${before}` : ''}${rebuiltNote.length ? `; ${rebuiltNote.join('; ')}` : ''}`;
      const skewed = onReads.filter((s) => s.skewed).map((s) => s.n);
      if (stale.length) st = { ...base, state: 'soaking', why: `no coordinator tick in the last ${live_minutes} min from ${stale.join(', ')} (or it stopped since): a coordinator that isn't running isn't soaking${earlier}` };
      else if (skewed.length) st = { ...base, state: 'soaking', why: `${skewed.join(', ')}: the flip is stamped before events logged ahead of it (a clock behind), so the soak can't be timed: turn it off and on again${earlier}` };
      else if (hours >= soak_hours && !short.length) {
        st = { ...base, state: 'promoted', why: `${Math.floor(hours)} h on, ${mergeTs.length} merges (at least ${min_merges} in each instance), nothing went wrong${earlier}` };
        // Promoted once its hours were done and every instance had its min_merges-th merge.
        const lastNeeded = min_merges ? Math.max(...onReads.map((s) => Date.parse([...s.merges].sort()[min_merges - 1]!))) : Number.NEGATIVE_INFINITY;
        promotedAt = Math.max(...onReads.map((s) => Date.parse(s.since!) + s.downMs + soak_hours * 3_600_000), lastNeeded);
      } else st = { ...base, state: 'soaking', why: `${Math.floor(hours)} of ${soak_hours} h${short.length ? `; ${short.join(', ')}` : `, ${mergeTs.length} merges`}${earlier}` };
    }
    rings.push(st);
    prevPromotedAt = st.state === 'promoted' ? promotedAt : null;
    prevName = r.name;
  }
  const set = (to: boolean, ring: RingStatus) => `set \`flags.${o.flag}: ${to}\` in the config.yaml of ${ring.instances.join(', ')} (a PR in each repo)`;
  const back = rings.findIndex((r) => r.state === 'roll back' || r.state === 'out of order');
  // WHY (#1174 review, defect 3): an instance in no ring can have the flag on (its repo's own config PR); the rollout
  // never put it there, so it is always rolled back, and one whose log can't be read holds every step that turns a
  // ring on or calls the flag done.
  const outsideNames = o.outsideNames ?? [...(o.outside?.keys() ?? [])];
  const outsideOn = outsideNames.filter((n) => o.outside?.has(n) && isOn(o.outside.get(n)!, o.flag)).sort();
  const outsideUnread = outsideNames.filter((n) => !o.outside?.has(n)).sort();
  const outsideBack = outsideOn.length ? `roll back outside the rollout (${outsideOn.join(', ')}: in no ring of rollout.json): set \`flags.${o.flag}: false\` in the config.yaml of ${outsideOn.join(', ')} (a PR in each repo)` : '';
  const unknown = rings.filter((r) => r.state === 'unknown');
  let next: string;
  if (back >= 0) {
    // Every later ring that is or may be on (R1174c 1: an unread one too).
    const on = rings.slice(back).filter((r) => r.onSince !== null || r.state === 'partial' || r.state === 'unknown');
    next = `${outsideBack ? `${outsideBack}; and ` : ''}roll back ring ${rings[back]!.ring} (${rings[back]!.why}): ${on.map((r) => (r.state === 'unknown' ? `${set(false, r)} if it is on there (its log can't be read)` : set(false, r))).join('; then ')}`;
  } else if (outsideBack) next = outsideBack;
  else if (o.ringZero) next = `wait: ${o.ringZero}: fix rollout.json first (docs/rollout.md); nothing is turned on until ring 0 is the engine's own repo`;
  else if (o.listing) next = `wait: ${o.listing}: nothing is turned on while an instance may be missing`;
  else if (unknown.length || outsideUnread.length) {
    // Name what holds: each unread log, and each ring unknown for another reason (R1231h: an instance running with the
    // flag off by itself named no one).
    const unread = [...unknown.flatMap((r) => r.instances.filter((n) => !o.logs.has(n))), ...outsideUnread];
    const held = [...(unread.length ? [`can't read the event log of ${unread.join(', ')}`] : []), ...unknown.filter((r) => r.instances.every((n) => o.logs.has(n))).map((r) => `ring ${r.ring} is unknown (${r.why})`)];
    next = `wait: ${held.join('; ')}: nothing is turned on while the flag may be on there`;
  }
  else {
    const first = rings.find((r) => r.state !== 'promoted');
    if (!first) next = `every ring is promoted: ${o.flag} can become the default (remove the flag, docs/feature-flags.md)`;
    else if (first.state === 'off') next = `turn it on for ring ${first.ring}: ${set(true, first)}`;
    else next = `wait: ring ${first.ring} is ${first.state} (${first.why})`;
  }
  return { rings, next, outsideOn, outsideUnread };
}
