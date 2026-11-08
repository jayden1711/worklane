// Feature flags for risky engine changes (docs/feature-flags.md): a new behaviour that could hurt a project ships
// behind a flag, off until a repo turns it on.
//   - One reader: flagOn(name). It reads only this module's snapshot of the flags the default branch's committed
//     config turns on, at a recorded commit; no config object carries flags (every parsed `flags:` is a frozen {}).
//     WHY (#1173 reviews R1173g, R1173h): with flags on the config, every path that built one (the checkout's start,
//     the tool guard, the CLI, the dashboard, loadConfigAt on a branch) was another way to read a flag on, a mutable
//     object a write could turn one on in, and an inherited property a polluted prototype could.
//   - One writer: the coordinator's config step calls adoptFlags with the commit of the default branch whose config is
//     running (null: none, so every flag is off). The flags are read from git at that commit and checked here in
//     plain code, so a swapped schema can't loosen them. A test holds that nothing else calls it.
//   - Off by default, always: only an explicit `true` for a name in FLAGS. A name in neither FLAGS nor RETIRED_FLAGS
//     makes the config invalid (the coordinator keeps running on the last good one); here it turns nothing on.
//   - Every flip is audited: adoptFlags records a `flag.flipped` event (the flag, from, to, the commit) whenever a
//     flag's state differs from the last one recorded, so a flip made while the coordinator was down is recorded too.
import { parseDocument } from 'yaml';
import { BRAND } from './brand.js';
import type { EventLog } from './events/log.js';
import type { EventPayload } from './events/types.js';
import { FLAG_NAME, knownFlags, retiredFlags } from './config/schema.js';
import { gitSpawnSync } from './os/git.js';

export { FLAG_NAME, FLAGS, RETIRED_FLAGS, flagsSchema, type FlagInfo } from './config/schema.js';

/** The flags on, at the commit they were read from; null: none adopted (every flag off). Never handed out. */
let snapshot: Readonly<{ sha: string; on: readonly string[] }> | null = null;

/** Whether a flag is on: only when the default branch's committed config, at the adopted commit, says `true` for it. */
export function flagOn(name: string): boolean {
  const s = snapshot;
  return s !== null && s.on.includes(name);
}

/** What is on, and from which commit (a copy): for the audit and the dashboard. */
export function flagState(): { sha: string | null; on: string[] } {
  return { sha: snapshot?.sha ?? null, on: [...(snapshot?.on ?? [])] };
}

/** Every flag off. Anyone may: it only turns things off (a test resets with it). */
export function clearFlags(): void {
  snapshot = null;
}

/**
 * The flags a config.yaml's text turns on, checked here in plain code rather than by the zod schema (#1173 review
 * R1173h A8: zod's internals can be swapped at run time). `flags:` absent is none; otherwise a plain mapping of own
 * keys, each a flag name, known or retired, set to a boolean. Anything else turns nothing on.
 */
export function flagsInText(text: string, known: readonly string[] = knownFlags(), retired: readonly string[] = retiredFlags()): { on: string[] } | { error: string } {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) return { error: doc.errors[0]!.message.split('\n')[0]! };
  const raw = (doc.toJS() as { flags?: unknown } | null)?.flags;
  if (raw === undefined || raw === null) return { on: [] };
  // A mapping: YAML's toJS gives a plain object for one, an array for a list (whose keys, 0 and up, aren't flag names).
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'flags is not a mapping' };
  const on: string[] = [];
  for (const name of Object.keys(raw)) {
    const value = (raw as Record<string, unknown>)[name];
    if (!FLAG_NAME.test(name)) return { error: `not a flag name: ${JSON.stringify(name)}` };
    if (typeof value !== 'boolean') return { error: `${name} is not true or false` };
    if (known.includes(name)) {
      if (value === true) on.push(name);
    } else if (!retired.includes(name)) return { error: `no such flag: ${name}` };
  }
  return { on: on.sort() };
}

const byCommit = new Map<string, readonly string[]>();

/** The flags the config committed at `sha` turns on (none when it has no config.yaml or a bad `flags:`). */
function flagsAt(repo: string, sha: string, known: readonly string[]): readonly string[] {
  const key = `${repo}\u0000${sha}\u0000${known.join(',')}`;
  const hit = byCommit.get(key);
  if (hit) return hit;
  const r = gitSpawnSync(['show', `${sha}:${BRAND.configDir}/config.yaml`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
  const read = r.status === 0 ? flagsInText(r.stdout, known, retiredFlags()) : { on: [] };
  const on = Object.freeze('on' in read ? read.on : []);
  byCommit.set(key, on);
  return on;
}

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
 * The coordinator's config step, once a tick: adopt the flags the default branch's config turns on at `sha` (the
 * commit whose config is running; null: none), and record a flip for every known flag whose state differs from the
 * one last recorded (never recorded: off), and for a recorded flag the engine no longer knows that was on. Returns
 * what it recorded. `sha` must be a full commit id.
 */
export function adoptFlags(o: { log: EventLog; repo: string; sha: string | null; actor: string }): EventPayload<'flag.flipped'>[] {
  const known = knownFlags();
  const sha = o.sha !== null && /^[0-9a-f]{40}$/.test(o.sha) ? o.sha : null;
  const on = sha ? flagsAt(o.repo, sha, known) : [];
  snapshot = sha ? Object.freeze({ sha, on }) : null;
  const was = recordedFlags(o.log);
  const out: EventPayload<'flag.flipped'>[] = [];
  for (const flag of [...new Set([...known, ...was.keys()])].sort()) {
    const from = was.get(flag) ?? false;
    const to = on.includes(flag);
    if (from === to) continue;
    const p = { flag, from, to, sha };
    o.log.append('flag.flipped', p, o.actor);
    out.push(p);
  }
  return out;
}
