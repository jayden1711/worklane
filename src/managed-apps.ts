// WHY (#665): the self-modification locks (src/review.ts) name the engine's own source files by path, so in a managed
// app's repo they held the app's own src/contract.ts or src/hooks.ts for the owner as "the agents' tool guard". Which
// repo is the engine is root's word on this machine, never the repo's: a file, name, remote or package field inside a
// repo is what its agents, and anyone who can push to it, can change. Root names each instance whose repo is a managed
// app, with that repo, in /etc/<cli>/managed-apps.json (root:root 0644, written only by scripts/setup/managed-apps.sh
// at a root shell; no sudoers rule, machine helper command or dashboard button reaches it):
//
//   {"version":1,"apps":{"<instance>":"<owner/repo>"}}
//
// Only for that instance, working exactly that repo (its instance.yaml, outside the repo), do the locks on the engine's
// own source paths stand aside (review.ts LockScope); the config folder's, CI's and the push gate's still hold.
//
// INVARIANT: fails closed. No file; one that isn't root's regular file alone (a symlink, another owner, writable by its
// group or others, too big, unreadable); one not in exactly the script's form; or one that doesn't name this instance
// with this repo: the engine's scope, and every lock applies.
import { instanceNameOk } from './instance-name.js';
import { readRegularFile } from './os/index.js';
import { etcPath } from './os/system-paths.js';
import type { LockScope } from './review.js';

export const MANAGED_APPS_FILE = () => etcPath('managed-apps.json');
/** The root script that changes it, as a root shell runs it. */
export const MANAGED_APPS_SCRIPT = 'scripts/setup/managed-apps.sh';

/** A GitHub owner/name, as scripts/setup/lib.sh repo_ok takes it. */
const REPO = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}\/[A-Za-z0-9_.-]{1,100}$/;

/** The instances root names as managed apps, each with its repo; none, with why, when the file can't be trusted. */
export function readManagedApps(file = MANAGED_APPS_FILE(), rootUid = 0): { apps: Record<string, string>; problem: string | null } {
  const none = (problem: string | null) => ({ apps: {}, problem });
  const f = readRegularFile(file, 64 * 1024);
  if (f.kind === 'missing') return none(null);
  if (f.kind !== 'file') return none(`${file}: ${f.kind}`);
  if (f.uid !== rootUid || Number.parseInt(f.mode, 8) & 0o022) return none(`${file} isn't root's alone (owner uid ${f.uid}, mode ${f.mode})`);
  let v: unknown;
  try {
    v = JSON.parse(f.text);
  } catch {
    return none(`${file}: not JSON`);
  }
  const o = v as { version?: unknown; apps?: unknown } | null;
  const apps = o?.apps as Record<string, unknown> | undefined;
  const form = !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join() === 'apps,version' && o.version === 1 && !!apps && typeof apps === 'object' && !Array.isArray(apps);
  if (!form || !Object.entries(apps).every(([k, r]) => instanceNameOk(k) && typeof r === 'string' && REPO.test(r))) return none(`${file}: not in the form ${MANAGED_APPS_SCRIPT} writes`);
  return { apps: apps as Record<string, string>, problem: null };
}

/**
 * Whose repo this instance works, for the self-modification locks: a managed app's only when root's file names this
 * instance with exactly this repo (GitHub names compare without case); otherwise the engine's. `why` says which, for
 * the coordinator's start-up line.
 */
export function readLockScope(instance: string, repo: string, o: { file?: string; rootUid?: number } = {}): { scope: LockScope; why: string } {
  const file = o.file ?? MANAGED_APPS_FILE();
  const { apps, problem } = readManagedApps(file, o.rootUid ?? 0);
  const engine = (why: string) => ({ scope: 'engine' as const, why: `every self-modification lock applies: ${why}` });
  if (problem) return engine(problem);
  const named = Object.hasOwn(apps, instance) ? apps[instance] : undefined;
  if (named === undefined) return engine(`${file} doesn't name instance ${instance} as a managed app`);
  if (named.toLowerCase() !== repo.toLowerCase()) return engine(`${file} names instance ${instance} for ${named}, not ${repo}`);
  return { scope: 'managed-app', why: `root's ${file} says ${repo} is a managed app, not the engine: the locks on the engine's own source paths don't apply` };
}
