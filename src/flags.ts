// Feature flags for risky engine changes (docs/feature-flags.md): a new behaviour that could hurt a project ships
// behind a flag, off until a repo turns it on.
//   - One reader: flagOn(name). It reads only this module's snapshot of the flags the default branch's committed
//     config turns on, at a recorded commit; no config object carries flags (every parsed `flags:` is a frozen {}).
//     WHY (#1173 reviews R1173g, R1173h): with flags on the config, every path that built one (the checkout's start,
//     the tool guard, the CLI, the dashboard, loadConfigAt on a branch) was another way to read a flag on, a mutable
//     object a write could turn one on in, and an inherited property a polluted prototype could.
//   - One writer: the coordinator's config step calls adoptFlags. Nothing it is passed picks the source: it asks
//     origin for its default branch's head, and adopts that commit's flags only when the commit is here and its
//     config is valid, by the schema and the instance's check (#1173 reviews R1173j, R1173k); otherwise every flag is
//     off (R1173l). So a caller can only ever adopt what the default branch says now. The flags are checked here in
//     plain code, so a swapped schema can't loosen them. A test holds that nothing else names it.
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
import { gitRemote } from './git-remote.js';
import { loadConfigAt, type Config, type ConfigError } from './config/load.js';

export { FLAG_NAME, FLAGS, RETIRED_FLAGS, flagsSchema, type FlagInfo } from './config/schema.js';

/** The flags on, at the commit they were read from; null: none adopted (every flag off). Never handed out. */
let snapshot: Readonly<{ sha: string; on: readonly string[] }> | null = null;
/** Flags this process turned off whose off record isn't durable yet, each with the commit that turned it off. */
const offUnrecorded = new Map<string, string | null>();

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
  offUnrecorded.clear();
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

/** A commit's valid config (a failed read is never kept: R1173l D2, it is read again on the next tick). */
const validAt = new Map<string, Config>();

/** The remote's lines `<sha>\t<ref>` for `args`, or null. */
function lsRemote(repo: string, args: string[]): string[] | null {
  const r = gitSpawnSync(['ls-remote', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}

/**
 * The default branch's head on origin, as origin says it is now: origin's own default branch (its HEAD), and the one
 * line for exactly `refs/heads/<that branch>` (R1173l D1: the first line could be `refs/heads/a/refs/heads/main`).
 * Nothing a caller passes picks the source (R1173k K1). Null: unknown.
 */
export function remoteHead(repo: string): { branch: string; sha: string } | null {
  gitRemote('origin');
  const sym = lsRemote(repo, ['--symref', 'origin', 'HEAD']);
  const branch = /^ref: refs\/heads\/([^\t\s]+)\tHEAD$/.exec(sym?.find((l) => l.startsWith('ref: ')) ?? '')?.[1];
  if (!branch) return null;
  const ref = `refs/heads/${branch}`;
  const exact = (lsRemote(repo, ['origin', ref]) ?? []).map((l) => l.split('\t')).filter((p) => p.length === 2 && p[1] === ref);
  const sha = exact.length === 1 ? exact[0]![0]! : '';
  return /^[0-9a-f]{40}$/.test(sha) ? { branch, sha } : null;
}

/** The flags `sha`'s config turns on, when that commit is here and its config is valid and passes `check`; else null. */
function flagsAt(repo: string, sha: string, known: readonly string[], check: (cfg: Config) => ConfigError[]): readonly string[] | null {
  if (gitSpawnSync(['cat-file', '-e', `${sha}^{commit}`], { cwd: repo, stdio: 'ignore' }).status !== 0) return null;
  let cfg = validAt.get(sha);
  if (!cfg) {
    try {
      cfg = loadConfigAt(repo, sha);
    } catch {
      return null;
    }
    validAt.set(sha, cfg);
  }
  if (check(cfg).length) return null;
  const r = gitSpawnSync(['show', `${sha}:${BRAND.configDir}/config.yaml`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const read = flagsInText(r.stdout, known, retiredFlags());
  return 'on' in read ? Object.freeze(read.on) : null;
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
 * The coordinator's config step, once a tick: adopt the flags origin's default branch turns on at its head now, when
 * that commit is here (fetched) and its config valid, by the schema and by `check` (the instance's own; required: a
 * caller can't leave it out). Nothing a caller passes picks the remote, the branch or the commit (R1173k K1).
 * - A head that can't be read, a commit not here, or a config not valid: every flag OFF (R1173l D2: a failed read
 *   never keeps a flag on). Never cached, so the next tick reads again.
 * - Each change from the state last recorded is a flag.flipped, written before the change; a flag goes ON only once
 *   its record is durably written (R1173k K2, R1173l D3: a buffered or dropped record turns nothing on). Returns what
 *   it recorded.
 */
export function adoptFlags(o: { log: EventLog; repo: string; actor: string; branch: string; check: (cfg: Config) => ConfigError[] }): EventPayload<'flag.flipped'>[] {
  const known = knownFlags();
  // origin's HEAD must be the default branch this instance is configured for (R1173n M3: an origin HEAD moved to an
  // unprotected branch turned flags on from it). A mismatch reads nothing: every flag off. So does a read or a check
  // that throws (R1173p 1: the instance's check reads policy.yaml, which can throw, and the flag stayed on).
  let head: { branch: string; sha: string } | null = null;
  let read: readonly string[] | null = null;
  try {
    head = remoteHead(o.repo);
    read = head && head.branch === o.branch ? flagsAt(o.repo, head.sha, known, o.check) : null;
  } catch {
    read = null;
  }
  const sha = read && head ? head.sha : null;
  const on = read ?? [];
  const before = snapshot?.on ?? [];
  // Turn-offs first, before anything here can throw (R1173m/n N2, N3: a failed record write kept a flag on while the
  // log said off): only what is on now and still on at the head stays on until the records are written.
  const keep = on.filter((n) => before.includes(n));
  // A flag turned off here is off unrecorded until its record is durable (R1173p 2: its off record lost, then main
  // turned it on again, and the log, still reading on, recorded no change).
  for (const n of before) if (!keep.includes(n) && !offUnrecorded.has(n)) offUnrecorded.set(n, sha);
  snapshot = sha ? Object.freeze({ sha, on: Object.freeze([...keep]) }) : null;
  const was = recordedFlags(o.log);
  const out: EventPayload<'flag.flipped'>[] = [];
  const write = (p: EventPayload<'flag.flipped'>) => {
    if (o.log.append('flag.flipped', p, o.actor).id === 0) durable = false;
    out.push(p);
  };
  let durable = true;
  for (const flag of [...new Set([...known, ...was.keys()])].sort()) {
    let from = was.get(flag) ?? false;
    // The log still reads on for a flag this process turned off: record that off first, as it ran.
    if (from && offUnrecorded.has(flag)) {
      write({ flag, from: true, to: false, sha: offUnrecorded.get(flag) ?? null });
      from = false;
    }
    const to = on.includes(flag);
    if (from !== to) write({ flag, from, to, sha });
  }
  // Durable only when nothing is held in memory: a held record reads as recorded on the next tick (R1173m 1: a real
  // SQLITE_FULL turned a flag on with no row on disk). A held record from an earlier tick is still held here.
  if (o.log.buffered().count > 0) durable = false;
  if (durable) offUnrecorded.clear();
  // Durably recorded: the head's flags on; otherwise nothing goes on that wasn't (the turn-offs above stand).
  if (durable && sha) snapshot = Object.freeze({ sha, on: Object.freeze([...on]) });
  return out;
}
