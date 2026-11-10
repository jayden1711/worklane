// Feature flags for risky engine changes (docs/feature-flags.md): a new behaviour that could hurt a project ships
// behind a flag, off until a repo turns it on.
//   - One reader: a coordinator's `flags.on(name)` (a FlagState, below). It reads only that coordinator's snapshot of
//     the flags the default branch's committed config turns on, at a recorded commit; no config object carries flags
//     (every parsed `flags:` is a frozen {}). Per coordinator, never per process (R1173af AF1: a harness-eval replay
//     runs its own Coordinator in the instance's process, and a shared state let a task repo's config flip the
//     instance's flags unrecorded).
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
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { BRAND } from './brand.js';
import type { EventLog } from './events/log.js';
import type { EventPayload } from './events/types.js';
import { FLAG_NAME, knownFlags, retiredFlags } from './config/schema.js';
import { gitSpawnSync } from './os/git.js';
import { syncToDisk, writeOwnerOnly } from './os/index.js';
import { gitRemote } from './git-remote.js';
import { loadConfigAt, type Config, type ConfigError } from './config/load.js';

export { FLAG_NAME, FLAGS, RETIRED_FLAGS, flagsSchema, type FlagInfo } from './config/schema.js';

/**
 * One coordinator's flags: what it adopted, and its offs not recorded yet. R1173af AF1: these were module globals, one
 * set per process, and a harness-eval replay's own Coordinator in the instance's process (src/harness-evals/replay.ts)
 * turned the instance's flags on and off from a task repo's config, with no record in the instance's log. Each
 * Coordinator owns one now (`coordinator.flags`), and only this module can read or change what is inside: a FlagState
 * is a handle, its state kept here (below), so nothing outside can write a flag on.
 */
export class FlagState {
  constructor() {
    inner.set(this, { snapshot: null, offUnrecorded: new Map(), offFile: null });
    Object.freeze(this);
  }
  /** Whether a flag is on: only when the default branch's committed config, at the adopted commit, says `true` for it. */
  on(name: string): boolean {
    const s = of(this).snapshot;
    return s !== null && s.on.includes(name);
  }
  /** What is on, and from which commit (a copy): for the audit and the dashboard. */
  state(): { sha: string | null; on: string[] } {
    const s = of(this).snapshot;
    return { sha: s?.sha ?? null, on: [...(s?.on ?? [])] };
  }
}
// R1173ah AH2: the instance is frozen; so are its methods, so no code outside this module can make `on` say true.
Object.freeze(FlagState.prototype);
Object.freeze(FlagState);
type Inner = {
  /** The flags on, at the commit they were read from; null: none adopted (every flag off). Never handed out. */
  snapshot: Readonly<{ sha: string; on: readonly string[] }> | null;
  /** Flags this coordinator turned off whose off record isn't durable yet, each with the commit that turned it off. */
  offUnrecorded: Map<string, string | null>;
  offFile: OffFile | null;
};
const inner = new WeakMap<FlagState, Inner>();
function of(s: FlagState): Inner {
  const i = inner.get(s);
  if (!i) throw new Error('not a FlagState');
  return i;
}
/**
 * The same offs, kept on disk beside the event log until the log stores their off rows (R1173r 1: a SQLITE_BUSY longer
 * than the busy timeout ends the tick and the process, and the next process knew nothing of them). Written, synced,
 * before the turn-off takes effect; read once per process. A full disk that stops this write too is the stated limit.
 */
// Each entry keeps the log's last stored id when the flag went off: the entry is done once a stored off row of the flag
// comes after it, whatever the timing of a flush, a stop or a rewrite (R1173u, R1173v: three rounds of clearing it at
// the right moment each left a stale entry, whose off and on a restart then wrote again).
// R1173w, R1173x: an id means something only in the log it was taken from, so each entry also keeps that row's stamp
// (`at`). A log restored from a backup, replaced, or with an `after` past its last id doesn't have that row: the entry
// is from another log, and is judged against this one (below).
type OffEntry = { sha: string | null; after: number; at: string | null };
type OffFile = { path: string; held: Map<string, OffEntry>; saved: boolean; judged: boolean };
/** The file's name, beside the event log (instance-move clears it when a log is imported over this one). */
export const OFF_FILE = 'flags-unrecorded.json';
/** The log's last stored id and that row's stamp: where an entry stands in this log. */
function anchorOf(log: EventLog): { after: number; at: string | null } {
  const after = log.lastId();
  const r = after ? (log.db.prepare('SELECT ts FROM events WHERE id = ?').get(after) as { ts: string } | undefined) : undefined;
  return { after, at: r?.ts ?? null };
}
/** Whether the entry was taken from this log: its row is here, with its stamp. */
function anchored(log: EventLog, e: OffEntry): boolean {
  if (e.at === null) return false;
  const r = log.db.prepare('SELECT ts FROM events WHERE id = ?').get(e.after) as { ts: string } | undefined;
  return r?.ts === e.at;
}
function loadOffFile(st: Inner, log: EventLog): void {
  if (typeof log.path !== 'string' || log.path === ':memory:') return; // no folder to keep it in: memory only
  const path = join(dirname(log.path), OFF_FILE);
  if (st.offFile?.path !== path) {
    st.offFile = { path, held: new Map(), saved: true, judged: false };
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      saved = null; // none (or unreadable: nothing to add)
    }
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [flag, v] of Object.entries(saved as Record<string, unknown>)) {
        const { sha, after, at } = (v && typeof v === 'object' ? v : {}) as { sha?: unknown; after?: unknown; at?: unknown };
        if (!FLAG_NAME.test(flag) || !(sha === null || (typeof sha === 'string' && /^[0-9a-f]{40,64}$/.test(sha)))) continue;
        if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) continue;
        st.offFile.held.set(flag, { sha, after, at: typeof at === 'string' ? at : null });
      }
    }
  }
  if (!st.offFile.judged) judgeOffFile(st, log);
}
/**
 * The file's entries judged against this log, once per process: one from another log (restored, replaced, a bad
 * `after`) is anchored here when the log still reads the flag on, so its off is written once and then pruned as any
 * other; else it is dropped. Then those whose off is stored are pruned, and the rest handed to the map. A read that
 * fails (R1173x X5: SQLITE_BUSY at a process's first tick) leaves them to judge at the next tick; their flags stay off
 * until then.
 */
function judgeOffFile(st: Inner, log: EventLog): void {
  if (!st.offFile) return;
  // R1173ab AB3: any failure, a read or the save, puts the entries back as they were before the judge ran (a read that
  // threw after a re-anchor left that re-anchor in memory only, and the next judge took it as anchored).
  const before = new Map(st.offFile.held);
  try {
    if (st.offFile.held.size) {
      const recorded = recordedFlags(log);
      let changed = false;
      for (const [flag, e] of st.offFile.held) {
        if (anchored(log, e)) continue;
        if (recorded.get(flag)) st.offFile.held.set(flag, { sha: e.sha, ...anchorOf(log) });
        else st.offFile.held.delete(flag);
        changed = true;
      }
      if (changed) {
        saveOffFile(st);
        // R1173z Z2: a re-anchor that can't be saved would be redone at the next start, and its off written again:
        // the entries go back as they were and stay unjudged (their flags off) until the file can be saved.
        if (!st.offFile.saved) throw new Error(`${OFF_FILE} couldn't be saved`);
      }
      pruneOffFile(st, log);
    }
    st.offFile.judged = true;
  } catch {
    st.offFile.held = before;
    return;
  }
  for (const [flag, e] of st.offFile.held) if (!st.offUnrecorded.has(flag)) st.offUnrecorded.set(flag, e.sha);
}
function saveOffFile(st: Inner): void {
  if (!st.offFile) return;
  try {
    if (st.offFile.held.size) {
      writeOwnerOnly(st.offFile.path, `${JSON.stringify(Object.fromEntries(st.offFile.held))}\n`);
      syncToDisk(st.offFile.path);
    } else rmSync(st.offFile.path, { force: true });
    st.offFile.saved = true;
  } catch {
    // a full disk: tried again at every tick until it is written (R1173t D2); a stop before then is the stated limit
    st.offFile.saved = false;
  }
}
/** The id of each flag's last stored off row (held records are not stored: a process that stops loses them). */
function storedOffs(log: EventLog): Map<string, number> {
  const last = new Map<string, number>();
  for (const r of log.db.prepare("SELECT id, payload FROM events WHERE type = 'flag.flipped' ORDER BY id").all() as { id: number; payload: string }[]) {
    const p = JSON.parse(r.payload) as EventPayload<'flag.flipped'>;
    if (!p.to) last.set(p.flag, r.id);
  }
  return last;
}
/** Each entry whose off is a stored row after it went off leaves the file (and the map). */
function pruneOffFile(st: Inner, log: EventLog): void {
  if (!st.offFile?.held.size) return;
  const stored = storedOffs(log);
  let changed = false;
  for (const [flag, e] of st.offFile.held) {
    if ((stored.get(flag) ?? -1) > e.after) {
      st.offFile.held.delete(flag);
      st.offUnrecorded.delete(flag);
      changed = true;
    }
  }
  if (changed) saveOffFile(st);
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
export function adoptFlags(o: { flags: FlagState; log: EventLog; repo: string; actor: string; branch: string; check: (cfg: Config) => ConfigError[] }): EventPayload<'flag.flipped'>[] {
  const st = of(o.flags);
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
  // The file of offs not yet recorded, judged against this log (it catches its own failures: R1173x X5). A flag it
  // names that couldn't be judged yet stays off this tick.
  loadOffFile(st, o.log);
  const unjudged = st.offFile && !st.offFile.judged ? [...st.offFile.held.keys()] : [];
  const on = (read ?? []).filter((n) => !unjudged.includes(n));
  const before = st.snapshot?.on ?? [];
  // Turn-offs first, before anything here can throw (R1173m/n N2, N3: a failed record write kept a flag on while the
  // log said off): only what is on now and still on at the head stays on until the records are written.
  const keep = on.filter((n) => before.includes(n));
  // A flag turned off here is off unrecorded until its record is durable (R1173p 2: its off record lost, then main
  // turned it on again, and the log, still reading on, recorded no change), kept on disk first (R1173r 1).
  const turnedOff = before.filter((n) => !keep.includes(n) && !st.offUnrecorded.has(n));
  for (const n of turnedOff) {
    st.offUnrecorded.set(n, sha);
    // Where it stands in this log; a read that fails must not stop the turn-off: then an anchor no log has, so the
    // entry is never pruned in this process and is judged as from another log at the next start.
    let anchor: { after: number; at: string | null };
    try {
      anchor = anchorOf(o.log);
    } catch {
      anchor = { after: Number.MAX_SAFE_INTEGER, at: null };
    }
    st.offFile?.held.set(n, { sha, ...anchor });
  }
  if (turnedOff.length || st.offFile?.saved === false) saveOffFile(st);
  st.snapshot = sha ? Object.freeze({ sha, on: Object.freeze([...keep]) }) : null;
  const was = recordedFlags(o.log);
  const out: EventPayload<'flag.flipped'>[] = [];
  /** Flags whose off couldn't be appended this tick (its anchor not read or saved): they alone wait (R1173ad AD1). */
  const skipped = new Set<string>();
  /** Appends the record; false when an off couldn't be appended yet (its anchor not read and saved: see below). */
  const write = (p: EventPayload<'flag.flipped'>): boolean => {
    // R1173y Y-1, R1173z Z1: an entry with no anchor (its read failed at the turn-off) is anchored here, just before its
    // off is appended, so that off prunes it; else a restart judged it from another log and wrote the pair again.
    // R1173aa AA-1, R1173ab AB1, AB2: the off is appended only once its anchor is read AND saved. A read that throws or
    // a save that fails puts the entry back as it was and ends this tick for that flag alone (R1173ad AD1: the whole
    // tick's durability went with it, so another flag's stored on never took effect): it stays off and unrecorded, its
    // off tried again at the next tick, and the tick ends with an error naming it (below).
    const e = st.offFile?.held.get(p.flag);
    if (!p.to && e && e.at === null) {
      try {
        st.offFile!.held.set(p.flag, { sha: e.sha, ...anchorOf(o.log) });
        saveOffFile(st);
        if (!st.offFile!.saved) throw new Error(`${OFF_FILE} couldn't be saved`);
      } catch {
        st.offFile!.held.set(p.flag, e);
        skipped.add(p.flag);
        return false;
      }
    }
    if (o.log.append('flag.flipped', p, o.actor).id === 0) durable = false;
    // Its off appended (written or held): never written again (R1173q 1: every held tick wrote the pair again).
    else if (!p.to) st.offUnrecorded.delete(p.flag);
    out.push(p);
    return true;
  };
  let durable = true;
  for (const flag of [...new Set([...known, ...was.keys()])].sort()) {
    // A flag the file names that couldn't be judged yet: no record this tick (its own off, with its commit, comes first
    // once it is judged); it stays off meanwhile (R1173x X5).
    if (unjudged.includes(flag)) continue;
    let from = was.get(flag) ?? false;
    // The log already reads off: nothing unrecorded.
    if (!from) st.offUnrecorded.delete(flag);
    // The log still reads on for a flag turned off (by this process, or one before it): record that off first, as it ran.
    if (from && st.offUnrecorded.has(flag)) {
      // Not appended yet (its anchor couldn't be read or saved): nothing else for this flag until it is.
      if (!write({ flag, from: true, to: false, sha: st.offUnrecorded.get(flag) ?? null })) continue;
      from = false;
    }
    const to = on.includes(flag);
    if (from !== to) write({ flag, from, to, sha });
  }
  // Durable only when nothing is held in memory: a held record reads as recorded on the next tick (R1173m 1: a real
  // SQLITE_FULL turned a flag on with no row on disk). A held record from an earlier tick is still held here.
  if (o.log.buffered().count > 0) durable = false;
  if (durable) for (const k of [...st.offUnrecorded.keys()]) if (!skipped.has(k)) st.offUnrecorded.delete(k);
  // The file keeps an entry until its off is a stored row: checked at every tick, and at a process's start.
  if (st.offFile?.judged) pruneOffFile(st, o.log);
  // Durably recorded: the head's flags on; otherwise nothing goes on that wasn't (the turn-offs above stand).
  if (durable && sha) st.snapshot = Object.freeze({ sha, on: Object.freeze(on.filter((n) => !skipped.has(n))) });
  // R1173ac AC-1: a flag held back (its off not recordable yet, or the file not judged) is never silent: after the
  // tick's work, one error names them, so the config step records coordinator.error at every tick until it clears.
  if (skipped.size || unjudged.length) {
    const parts = [skipped.size ? `an off not recorded yet (its position in the log couldn't be read or saved): ${[...skipped].sort().join(', ')}` : '', unjudged.length ? `${OFF_FILE} not judged yet (the log couldn't be read): ${[...unjudged].sort().join(', ')}` : ''].filter(Boolean);
    throw new FlagsHeldError(`flags held off: ${parts.join('; ')}; each stays off and is tried again at the next tick`);
  }
  return out;
}

/** A tick that adopted flags but held some back (R1173ac AC-1): its records and snapshot stand; this reports the rest. */
export class FlagsHeldError extends Error {
  override name = 'FlagsHeldError';
}
