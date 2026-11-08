// Feature flags for risky engine changes (docs/feature-flags.md): a new behaviour that could hurt a project ships
// behind a flag, off until a repo turns it on.
//   - One reader: flagOn(name). It reads only this module's snapshot of the flags the default branch's committed
//     config turns on, at a recorded commit; no config object carries flags (every parsed `flags:` is a frozen {}).
//     WHY (#1173 reviews R1173g, R1173h): with flags on the config, every path that built one (the checkout's start,
//     the tool guard, the CLI, the dashboard, loadConfigAt on a branch) was another way to read a flag on, a mutable
//     object a write could turn one on in, and an inherited property a polluted prototype could.
//   - One writer: the coordinator's config step calls adoptFlags. It takes no commit: it asks the remote for the
//     default branch's head, and adopts that commit's flags only when the commit is here and its config is valid
//     (#1173 review R1173j), so a caller can only ever adopt what the default branch says now. The flags are checked
//     here in plain code, so a swapped schema can't loosen them. A test holds that nothing else names it.
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

/** A commit's config, validated as the coordinator would apply it (null: none there, or invalid): cached by commit. */
const validAt = new Map<string, Config | null>();

/** The default branch's head on the remote itself (ls-remote), never a local ref an agent could move. Null: unknown. */
export function remoteHead(repo: string, remote: string, branch: string): string | null {
  gitRemote(remote);
  const r = gitSpawnSync(['ls-remote', '--exit-code', remote, `refs/heads/${branch}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  const sha = r.status === 0 ? (r.stdout.split('\t')[0] ?? '').trim() : '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** The flags `sha`'s config turns on, when that commit is here and its config is valid (and passes `check`); else null. */
function flagsAt(repo: string, sha: string, known: readonly string[], check?: (cfg: Config) => ConfigError[]): readonly string[] | null {
  // A commit not here yet (the fetch hasn't brought it) is no answer: never cached, asked again next time.
  if (gitSpawnSync(['cat-file', '-e', `${sha}^{commit}`], { cwd: repo, stdio: 'ignore' }).status !== 0) return null;
  if (!validAt.has(sha)) {
    let cfg: Config | null = null;
    try {
      cfg = loadConfigAt(repo, sha);
    } catch {
      // no config at that commit, or an invalid one: nothing to adopt from it
    }
    validAt.set(sha, cfg);
  }
  const cfg = validAt.get(sha) ?? null;
  if (!cfg || (check?.(cfg) ?? []).length) return null;
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
 * The coordinator's config step, once a tick: adopt the flags the default branch's config turns on at its head, as
 * the remote says it is now (#1173 review R1173j D1, D2, D4: no caller names the commit, so none can hand in one a
 * local ref was moved to, or one never validated). The commit must be here (fetched) and its config valid, by the
 * schema and `check`; otherwise the last adopted flags stay, as the last good config does. Then record a flip for every
 * known flag whose state differs from the one last recorded (never recorded: off), and for a recorded flag the engine
 * no longer knows that was on, BEFORE the snapshot changes (R1173j D3: a flag is never on without its record).
 */
export function adoptFlags(o: { log: EventLog; repo: string; remote: string; branch: string; actor: string; check?: (cfg: Config) => ConfigError[] }): EventPayload<'flag.flipped'>[] {
  const known = knownFlags();
  const head = remoteHead(o.repo, o.remote, o.branch);
  const read = head ? flagsAt(o.repo, head, known, o.check) : null;
  const sha = read ? head : (snapshot?.sha ?? null);
  const on = read ?? (snapshot ? snapshot.on.filter((n) => known.includes(n)) : []);
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
  snapshot = sha ? Object.freeze({ sha, on: Object.freeze([...on]) }) : null;
  return out;
}
