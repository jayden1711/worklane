// `<cli> rollout status --flag <name> [--file <rollout.json>]`: where a flagged change stands, ring by ring
// (src/rollout.ts, docs/rollout.md). Read-only: it opens each instance's event log read-only and changes nothing.
//   exit 0: the status (and the one next step); 1: the rollout file, a log, the machine's instance list or ring 0's
//   repo can't be used; 2: a usage error.
//
// WHERE an instance is (#1174 review R1174c 2): this user's own instances dir, or, on a separate-users machine (each
// instance's state in its own 0700 coordinator home, docs/separate-users.md), that home's. Run as root, it reads every
// home; run as anyone else, each instance it can't read is unread, and holds.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { BRAND } from './brand.js';
import type { StoredEvent } from './events/types.js';
import { readEvents } from './events/read-only.js';
import { FLAGS } from './flags.js';
import { instancesDir } from './instance.js';
import { engineRepos } from './managed-apps.js';
import { userHomeDir } from './os/index.js';
import { srvCheckoutPath } from './os/system-paths.js';
import { readRollout, ringZeroProblem, rolloutStatus, type Rollout } from './rollout.js';

const USAGE = `usage: ${BRAND.cli} rollout status --flag <name> [--file <rollout.json>]`;
const NAME = /^[a-z][a-z0-9-]{0,40}$/;

export interface RolloutDeps {
  /** A user's home (the passwd database). */
  homeOf: (user: string) => string | null;
  /** This user's own instances dir. */
  ownDir: () => string;
  /** Where server instances' checkouts are (/srv/<cli>): its entries are the machine's server instances. */
  srvRoot: () => string;
  engine: () => { repos: string[]; problem: string | null };
}

const DEFAULT_DEPS: RolloutDeps = { homeOf: userHomeDir, ownDir: instancesDir, srvRoot: () => dirname(dirname(srvCheckoutPath('x', 'y'))), engine: engineRepos };

/** Where instance `n`'s folder is: this user's instances dir, else its coordinator user's home's; null: neither. */
export function instanceDirOf(n: string, d: RolloutDeps): string | null {
  const own = join(d.ownDir(), n);
  if (existsSync(join(own, 'instance.yaml'))) return own;
  const home = d.homeOf(`wl-${n}`);
  const theirs = home ? join(home, '.local', 'state', BRAND.cli, 'instances', n) : null;
  return theirs && existsSync(join(theirs, 'instance.yaml')) ? theirs : null;
}

/** The repos an instance's instance.yaml names (null: can't tell). */
function reposOf(dir: string | null): string[] | null {
  if (!dir) return null;
  try {
    const y = parse(readFileSync(join(dir, 'instance.yaml'), 'utf8')) as { repos?: { repo?: unknown }[] } | null;
    const repos = (y?.repos ?? []).map((r) => r?.repo).filter((r): r is string => typeof r === 'string');
    return repos.length ? repos : null;
  } catch {
    return null;
  }
}

const entries = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && NAME.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
};

export function rolloutCommand(sub: string | undefined, args: readonly string[], o: { out?: (s: string) => void; err?: (s: string) => void; eventsOf?: (instance: string) => StoredEvent[]; instances?: () => string[]; now?: Date; deps?: Partial<RolloutDeps> } = {}): number {
  const out = o.out ?? console.log;
  const err = o.err ?? console.error;
  const d: RolloutDeps = { ...DEFAULT_DEPS, ...o.deps };
  // Options as pairs, each once: anything else is a usage error (a stray word is never skipped).
  const given = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const [k, v] = [args[i]!, args[i + 1]];
    if (!['--flag', '--file'].includes(k) || v === undefined || v.startsWith('--') || given.has(k)) {
      err(USAGE);
      return 2;
    }
    given.set(k, v);
  }
  if (sub !== 'status' || !given.get('--flag')) {
    err(USAGE);
    return 2;
  }
  const flag = given.get('--flag')!;
  let rollout: Rollout;
  const file = given.get('--file');
  try {
    const r = readRollout(file);
    rollout = r.rollout;
    if (!r.checked) out(`note: ${file} is read as it is, not as root's rollout.json (whose owner and mode are checked): try-out only`);
  } catch (e) {
    err(`can't use ${file ?? 'rollout.json'}: ${(e as Error).message.split('\n')[0]}`);
    return 1;
  }
  const dirOf = (n: string) => instanceDirOf(n, d);
  const eventsOf = o.eventsOf ?? ((n: string) => {
    const dir = dirOf(n);
    if (!dir) throw new Error(`no instance folder for ${n} here or in wl-${n}'s home`);
    return readEvents(join(dir, 'state', 'events.db'));
  });
  const logs = new Map<string, StoredEvent[]>();
  const inRings = rollout.rings.flatMap((r) => r.instances);
  for (const n of inRings) {
    try {
      logs.set(n, eventsOf(n));
    } catch (e) {
      err(`can't read ${n}'s event log: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  // The machine's instances: this user's instances dir, and the server instances (/srv/<cli>/<name>). A list that
  // doesn't name every ring instance is not the machine's whole list (R1174c 2): it holds.
  const known = [...new Set((o.instances ?? (() => [...entries(d.ownDir()), ...entries(d.srvRoot())]))())].sort();
  const notListed = inRings.filter((n) => !known.includes(n));
  const listing = notListed.length ? `this machine's instance list doesn't name ${notListed.join(', ')} (run as root on a separate-users machine)` : null;
  const others = known.filter((n) => !inRings.includes(n));
  const outside = new Map<string, StoredEvent[]>();
  for (const n of others) {
    try {
      outside.set(n, eventsOf(n));
    } catch (e) {
      err(`can't read ${n}'s event log (in no ring): ${(e as Error).message.split('\n')[0]}`);
    }
  }
  // Ring 0 is the engine's own repo, and no engine instance is outside it (R1174d 5).
  const engine = d.engine();
  const repos = new Map([...inRings, ...others].map((n) => [n, reposOf(dirOf(n))] as const));
  const ringZero = ringZeroProblem({ rollout, repos, engine: engine.problem ? null : engine.repos, outsideNames: others });
  if (!(flag in FLAGS)) out(`note: ${flag} is not a flag this engine knows (${Object.keys(FLAGS).join(', ') || 'none yet'}); every ring reads it as off`);
  const s = rolloutStatus({ rollout, flag, logs, now: o.now ?? new Date(), outside, outsideNames: others, ringZero, listing });
  for (const [i, r] of s.rings.entries()) out(`ring ${i} ${r.ring} (${r.instances.join(', ')}): ${r.state}: ${r.why}`);
  for (const n of s.outsideOn) out(`outside the rollout: ${n} has ${flag} on, in no ring`);
  out(`next: ${s.next}`);
  return logs.size === inRings.length && !s.outsideUnread.length && !listing && !ringZero ? 0 : 1;
}
