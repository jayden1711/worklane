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
}

export function readInstance(events: readonly StoredEvent[], flag: string, maxErrors: number): InstanceRead {
  // The log's order is the array's (the event ids'), never the clock's.
  let flipAt = -1;
  let since: string | null = null;
  let on = false;
  let periodStart = -1;
  let badBefore: string | null = null;
  let engineOff = false;
  for (const [i, e] of events.entries()) {
    if (e.type !== 'flag.flipped' || (e.payload as { flag: string }).flag !== flag) continue;
    const to = (e.payload as { to: boolean }).to;
    // An off with no commit is the engine's own (it read no config from the default branch) and it is a real off: the
    // engine ran with the flag off, so the next on starts a new soak (#1174 reviews R1174g D1, R1174h H1; R1174f 1
    // had it ignored, which counted hours and merges made with the flag off). R1174f A1: an on while on is a replay,
    // never a new on-period.
    if (to && on) continue;
    engineOff = !to && (e.payload as { sha?: unknown }).sha === null;
    if (!to && on && periodStart >= 0) {
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
  const latestBefore = on && flipAt > 0 ? Math.max(...events.slice(0, flipAt).map((e) => Date.parse(e.ts))) : -Infinity;
  const skewed = on && latestBefore - flipTs > 60_000;
  // A coordinator.started with no clean stop since the one before it: the process died (a crash loop shows as several).
  let running = false;
  for (const [i, e] of events.entries()) {
    const after = on && i > flipAt;
    if (e.type === 'coordinator.tick') {
      lastTick = e.ts;
      stoppedAfterTick = false;
    }
    if (e.type === 'coordinator.stopped') stoppedAfterTick = true;
    if (e.type === 'coordinator.started') {
      if (after && running) bad ??= 'the coordinator restarted without a clean stop';
      running = true;
    }
    if (e.type === 'coordinator.stopped' && (e.payload as { clean?: boolean }).clean === true) running = false;
    if (!after) continue;
    if (e.type === 'merge.done') {
      const n = (e.payload as { number?: unknown }).number;
      // Merged after the flip, by its own merged_at when it has one (R1174h H2: a merge made before the flip and
      // recorded after it counted).
      const at = (e.payload as { merged_at?: unknown }).merged_at;
      const before = typeof at === 'string' && Number.isFinite(Date.parse(at)) && Date.parse(at) < flipTs;
      if (!before && (n === undefined || n === null || !mergedPrs.has(n))) merges.push(e.ts);
      if (n !== undefined && n !== null) mergedPrs.add(n);
    }
    if (e.type === 'coordinator.error' && ++errors > maxErrors) bad ??= `${errors} coordinator errors since it went on (limit ${maxErrors})`;
    bad ??= badSign(e);
  }
  return { on, since: on ? since : null, merges, bad, lastTick: stoppedAfterTick ? null : lastTick, badBefore, engineOff: !on && engineOff, skewed };
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
    const reads = r.instances.filter((n) => o.logs.has(n)).map((n) => ({ n, ...readInstance(o.logs.get(n)!, o.flag, max_errors) }));
    const onReads = reads.filter((s) => s.on);
    const onCount = onReads.length;
    const sinces = onReads.map((s) => s.since!).sort();
    const onSince = sinces.at(-1) ?? null;
    const earliest = sinces[0] ?? null;
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
      const hours = (o.now.getTime() - Date.parse(onSince!)) / 3_600_000;
      // A last tick stamped in the future (a clock ahead) is no sign of life (R1174f A5): alive is a tick in the last
      // live_minutes, by this clock.
      const age = (t: string) => o.now.getTime() - Date.parse(t);
      const stale = onReads.filter((s) => s.lastTick === null || age(s.lastTick) > live_minutes * 60_000 || age(s.lastTick) < -60_000).map((s) => s.n);
      // min_merges in EACH instance (R1174f 3: one that did no work was promoted on the others' merges).
      const short = onReads.filter((s) => s.merges.length < min_merges).map((s) => `${s.n}: ${s.merges.length} of ${min_merges} merges`);
      const before = onReads.map((s) => s.badBefore).find((x) => x) ?? null;
      const earlier = before ? `; rolled back before: ${before}` : '';
      const skewed = onReads.filter((s) => s.skewed).map((s) => s.n);
      if (stale.length) st = { ...base, state: 'soaking', why: `no coordinator tick in the last ${live_minutes} min from ${stale.join(', ')} (or it stopped since): a coordinator that isn't running isn't soaking${earlier}` };
      else if (skewed.length) st = { ...base, state: 'soaking', why: `${skewed.join(', ')}: the flip is stamped before events logged ahead of it (a clock behind), so the soak can't be timed: turn it off and on again${earlier}` };
      else if (hours >= soak_hours && !short.length) {
        st = { ...base, state: 'promoted', why: `${Math.floor(hours)} h on, ${mergeTs.length} merges (at least ${min_merges} in each instance), nothing went wrong${earlier}` };
        // Promoted once its hours were done and every instance had its min_merges-th merge.
        const lastNeeded = min_merges ? Math.max(...onReads.map((s) => Date.parse([...s.merges].sort()[min_merges - 1]!))) : Number.NEGATIVE_INFINITY;
        promotedAt = Math.max(Date.parse(onSince!) + soak_hours * 3_600_000, lastNeeded);
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
  else if (unknown.length || outsideUnread.length) next = `wait: can't read the event log of ${[...unknown.flatMap((r) => r.instances.filter((n) => !o.logs.has(n))), ...outsideUnread].join(', ')}: nothing is turned on while the flag may be on there`;
  else {
    const first = rings.find((r) => r.state !== 'promoted');
    if (!first) next = `every ring is promoted: ${o.flag} can become the default (remove the flag, docs/feature-flags.md)`;
    else if (first.state === 'off') next = `turn it on for ring ${first.ring}: ${set(true, first)}`;
    else next = `wait: ring ${first.ring} is ${first.state} (${first.why})`;
  }
  return { rings, next, outsideOn, outsideUnread };
}
