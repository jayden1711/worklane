// Canary rollout of a risky change, ring by ring (docs/rollout.md). One engine serves every instance on a machine, so
// rings stage a change behind a feature flag (src/flags.ts), not an engine version: the flag goes on for ring 0 (the
// engine's own repo), then each later ring in order, each only once the ring before it has soaked healthy. Engine
// versions keep their own gate (the scratch-repo canary and the updater's rollback, docs/canary.md).
//
// Root's /etc/<cli>/rollout.json names the rings' instances (never this repository: no project's name is in it). This
// module only reads: each instance's event log, and says per ring what it saw and what to do next. It never flips a
// flag: turning one on or off is a reviewed config PR in that ring's repos, as every flag change is.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { StoredEvent } from './events/types.js';
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
    })
    .prefault({}),
});
export type Rollout = z.infer<typeof RolloutFile>;

export function readRollout(path = ROLLOUT_FILE()): Rollout {
  return RolloutFile.parse(JSON.parse(readFileSync(path, 'utf8')));
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
    default:
      return null;
  }
}

export type RingState = 'off' | 'partial' | 'soaking' | 'promoted' | 'roll back' | 'out of order';

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

/** Each instance's last recorded state of `flag` (flag.flipped), and when it was last turned on. */
function flagState(events: readonly StoredEvent[], flag: string): { on: boolean; since: string | null } {
  let on = false;
  let since: string | null = null;
  for (const e of events) {
    if (e.type !== 'flag.flipped') continue;
    const p = e.payload as { flag: string; to: boolean };
    if (p.flag !== flag) continue;
    on = p.to;
    since = p.to ? e.ts : null;
  }
  return { on, since };
}

/**
 * Every ring's state for `flag`, in order, and the one next step. `logs`: each instance's events (missing: unread,
 * which holds the ring: nothing is promoted on a log no one could read).
 */
export function rolloutStatus(o: {
  rollout: Rollout;
  flag: string;
  logs: ReadonlyMap<string, readonly StoredEvent[]>;
  now: Date;
  /** The machine's other instances (in no ring), by name, with their events; missing: unread. */
  outside?: ReadonlyMap<string, readonly StoredEvent[]>;
  outsideNames?: readonly string[];
}): { rings: RingStatus[]; next: string; outsideOn: string[]; outsideUnread: string[] } {
  const { soak_hours, min_merges } = o.rollout.promote;
  const rings: RingStatus[] = [];
  let earlierPromoted = true;
  for (const r of o.rollout.rings) {
    const missing = r.instances.filter((n) => !o.logs.has(n));
    const states = r.instances.map((n) => ({ n, ...flagState(o.logs.get(n) ?? [], o.flag) }));
    const onCount = states.filter((s) => s.on).length;
    const onSince = onCount ? states.map((s) => s.since).filter((s): s is string => s !== null).sort().at(-1) ?? null : null;
    let merges = 0;
    const bad: string[] = [];
    for (const s of states) {
      if (!s.on || !s.since) continue;
      let first: string | null = null;
      for (const e of o.logs.get(s.n) ?? []) {
        if (e.ts < s.since) continue;
        if (e.type === 'merge.done') merges++;
        first ??= badSign(e);
      }
      if (first) bad.push(`${s.n}: ${first}`);
    }
    const base = { ring: r.name, instances: r.instances, onSince, merges, bad: bad.slice(0, 5) };
    let st: RingStatus;
    // WHY this order (#1174 review): what the readable logs show that calls for a rollback comes first, so one log that
    // can't be read never hides it; an unread log then only stops a ring being judged off, partial or promoted.
    const unread = missing.length ? `can't read the event log of ${missing.join(', ')}` : '';
    if (onCount && !earlierPromoted) st = { ...base, state: 'out of order', why: `on before the ring before it was promoted: turn it off here until that ring is${unread ? `; and ${unread}` : ''}` };
    else if (onCount && bad.length) st = { ...base, state: 'roll back', why: `${bad.join('; ')}${unread ? `; and ${unread}` : ''}` };
    else if (missing.length) st = { ...base, state: onCount ? 'soaking' : 'off', why: `${unread}: nothing is promoted on an unread log` };
    else if (onCount === 0) st = { ...base, state: 'off', why: 'the flag is off in every instance of this ring' };
    else if (onCount < r.instances.length) st = { ...base, state: 'partial', why: `on in ${onCount} of ${r.instances.length} instances: turn it on in all of them, or off in all` };
    else {
      const hours = (o.now.getTime() - Date.parse(onSince!)) / 3_600_000;
      st = hours >= soak_hours && merges >= min_merges
        ? { ...base, state: 'promoted', why: `${Math.floor(hours)} h on, ${merges} merges, nothing went wrong` }
        : { ...base, state: 'soaking', why: `${Math.floor(hours)} of ${soak_hours} h, ${merges} of ${min_merges} merges` };
    }
    rings.push(st);
    earlierPromoted &&= st.state === 'promoted';
  }
  const set = (to: boolean, ring: RingStatus) => `set \`flags.${o.flag}: ${to}\` in the config.yaml of ${ring.instances.join(', ')} (a PR in each repo)`;
  const back = rings.findIndex((r) => r.state === 'roll back' || r.state === 'out of order');
  // WHY (#1174 review, defect 3): an instance in no ring can have the flag on (its repo's own config PR); the rollout
  // never put it there, so it is always rolled back, and one whose log can't be read holds every step that turns a
  // ring on or calls the flag done.
  const outsideNames = o.outsideNames ?? [...(o.outside?.keys() ?? [])];
  const outsideOn = outsideNames.filter((n) => o.outside?.has(n) && flagState(o.outside.get(n)!, o.flag).on).sort();
  const outsideUnread = outsideNames.filter((n) => !o.outside?.has(n)).sort();
  const outsideBack = outsideOn.length ? `roll back outside the rollout (${outsideOn.join(', ')}: in no ring of rollout.json): set \`flags.${o.flag}: false\` in the config.yaml of ${outsideOn.join(', ')} (a PR in each repo)` : '';
  let next: string;
  if (back >= 0) {
    const on = rings.slice(back).filter((r) => r.onSince !== null || r.state === 'partial');
    next = `${outsideBack ? `${outsideBack}; and ` : ''}roll back ring ${rings[back]!.ring} (${rings[back]!.why}): ${on.map((r) => set(false, r)).join('; then ')}`;
  } else if (outsideBack) next = outsideBack;
  else if (outsideUnread.length) next = `wait: can't read the event log of ${outsideUnread.join(', ')} (in no ring): nothing is turned on while the flag may be on there`;
  else {
    const first = rings.find((r) => r.state !== 'promoted');
    if (!first) next = `every ring is promoted: ${o.flag} can become the default (remove the flag, docs/feature-flags.md)`;
    else if (first.state === 'off') next = `turn it on for ring ${first.ring}: ${set(true, first)}`;
    else next = `wait: ring ${first.ring} is ${first.state} (${first.why})`;
  }
  return { rings, next, outsideOn, outsideUnread };
}
