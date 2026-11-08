// Feature flags for risky engine changes (docs/feature-flags.md): a new behaviour that could hurt a project ships
// behind a flag, off until a repo turns it on.
//   - Off by default, always: a flag is on only where the repo's config.yaml says `flags: { <name>: true }`.
//   - Per repo: they live in the repo's own config, so each project opts in by itself, through a reviewed commit (the
//     config is read from the default branch, src/config/live.ts).
//   - Only flags the engine knows: a name not in FLAGS makes the config invalid (the coordinator keeps running on the
//     last good one and raises config_invalid), so a typo never turns something on, or silently nothing.
//   - Every flip is audited: the coordinator records a `flag.flipped` event (the flag, from, to, the config's commit)
//     whenever a flag's state differs from the last one recorded, so a flip made while it was down is recorded too.
// Pure but for recordFlagFlips, which reads and appends to the event log.
import { z } from 'zod';
import type { EventLog } from './events/log.js';
import type { EventPayload } from './events/types.js';

export interface FlagInfo {
  /** What turning it on changes, in a sentence. */
  what: string;
  /** The PR that added it. */
  since: string;
}

/**
 * The flags this engine knows. Add one with the change it guards; remove it once the change is the default everywhere
 * (and say so in the changelog). A flag's name: lowercase letters, digits and underscores.
 */
export const FLAGS: Readonly<Record<string, FlagInfo>> = {};

export const FLAG_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** config.yaml `flags:`: known names only, each true or false; absent is `{}` (every flag off). */
export function flagsSchema(known: readonly string[] = Object.keys(FLAGS)) {
  return z
    .record(z.string().regex(FLAG_NAME, 'a flag name is lowercase letters, digits and underscores'), z.boolean())
    .default({})
    .superRefine((flags, ctx) => {
      for (const name of Object.keys(flags)) {
        if (!known.includes(name)) ctx.addIssue({ code: 'custom', path: [name], message: `no such flag: ${name} (the engine knows ${known.length ? known.join(', ') : 'none'}; docs/feature-flags.md)` });
      }
    });
}

/** Whether a flag is on for this repo: only an explicit `true` counts; anything else is off. */
export const flagOn = (flags: Readonly<Record<string, boolean>> | undefined, name: string): boolean => flags?.[name] === true;

/** The flags' states as the log last recorded them (flag.flipped, in order); a flag never recorded is off. */
export function recordedFlags(log: EventLog): Map<string, boolean> {
  const state = new Map<string, boolean>();
  for (const e of log.read(0, ['flag.flipped'])) {
    const p = e.payload as EventPayload<'flag.flipped'>;
    state.set(p.flag, p.to);
  }
  return state;
}

/**
 * Record a flip for every known flag whose state differs from the one last recorded (or, never recorded, from off),
 * and for a recorded flag the engine no longer knows that was on (it is off now). Returns what it recorded.
 */
export function recordFlagFlips(o: { log: EventLog; flags: Readonly<Record<string, boolean>> | undefined; sha: string | null; actor: string; known?: readonly string[] }): EventPayload<'flag.flipped'>[] {
  const known = o.known ?? Object.keys(FLAGS);
  const was = recordedFlags(o.log);
  const out: EventPayload<'flag.flipped'>[] = [];
  for (const flag of [...new Set([...known, ...was.keys()])].sort()) {
    const from = was.get(flag) ?? false;
    const to = known.includes(flag) && flagOn(o.flags, flag);
    if (from === to) continue;
    const p = { flag, from, to, sha: o.sha };
    o.log.append('flag.flipped', p, o.actor);
    out.push(p);
  }
  return out;
}
