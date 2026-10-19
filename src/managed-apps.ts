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
// own source paths stand aside (review.ts LockScope), the push gate's scripts under scripts/ among them; the config
// folder's, CI's, and the git hooks' and secret scan's files (.githooks/**, .denylist*, .gitleaks*) still hold. Nor is
// the engine's own repo ever an app (engineRepos), whatever the file says; and with no root updates.json to say which
// repo the engine updates from, no repo is.
//
// INVARIANT: fails closed. No file; one that isn't root's regular file alone (a symlink, another owner, writable by its
// group or others, too big, unreadable); one not in exactly the script's form; one that doesn't name this instance
// with this repo; or no telling which repo is the engine (engineRepos): the engine's scope, and every lock applies.
import { readFileSync } from 'node:fs';
import { instanceNameOk } from './instance-name.js';
import { readRegularFile } from './os/index.js';
import { SYSTEM_ROOT_VAR, etcPath, systemRootRefusal } from './os/system-paths.js';
import type { LockScope } from './review.js';

export const MANAGED_APPS_FILE = () => etcPath('managed-apps.json');
/** The root script that changes it, as a root shell runs it. */
export const MANAGED_APPS_SCRIPT = 'scripts/setup/managed-apps.sh';

/** The test preload's mark (test/isolate.ts ISOLATED): an own property of globalThis, set by code in the process (rootUid). */
const TEST_PRELOAD = Symbol.for('test-isolation');

/**
 * The owner root's files must have: uid 0. Only in a test process (the test preload ran in it, and its system root is
 * honoured: systemRootRefusal) is it this user's, who stands in for root there: root's files are then inside the
 * test's own system root (etcPath), all of them this user's.
 * WHY (#747, owner decision 2026-10-18): the tests passed readLockScope another root uid and another file, through a
 * parameter that any src/ caller could pass too, and that a polluted Object.prototype filled in. There is no such
 * parameter now, and no variable for it: a polluted Object.prototype can't set an own property of globalThis, and the
 * engine's package ships no test code (package.json files: dist/src, not dist/test). Only code running in the process
 * can set the mark: planted src/ code, a dependency, or a preload that NODE_OPTIONS (--import/--require) or node's
 * own --import names; no other environment variable can. Such code also needs a system root of this user's alone
 * with a mark matching its token, both variables, and, under systemd, to delete the systemd markers. It could as well
 * patch this check or the scope itself, so the mark gives it nothing new.
 * INVARIANT: 0 in every process where no code set the mark; 0 as root, while a systemd marker is set, or with a system
 * root that isn't marked (systemRootRefusal), mark or not.
 */
function rootUid(): number {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  if (uid === 0 || !Object.hasOwn(globalThis, TEST_PRELOAD) || !process.env[SYSTEM_ROOT_VAR] || systemRootRefusal() !== null) return 0;
  return uid;
}

/**
 * A GitHub owner/name exactly as scripts/setup/lib.sh repo_ok takes it (a test runs both on the same strings): the
 * owner a GitHub login (github_login_ok: at most 39 letters, digits and single inner hyphens), the name at most 100
 * letters, digits, '.', '_' and '-', and not '.' or '..'.
 */
const REPO = /^(?=[A-Za-z0-9-]{1,39}\/)[A-Za-z0-9](?:-?[A-Za-z0-9])*\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;

/**
 * One of root's /etc files, read as every root file is (readRegularFile: O_NOFOLLOW, a regular file, at most 64 KB)
 * and only when it is root's alone: owned by root (rootUid), not writable by its group or others. Otherwise why not.
 */
function readRootFile(file: string): { kind: 'file'; text: string } | { kind: 'missing' } | { kind: 'bad'; problem: string } {
  const f = readRegularFile(file, 64 * 1024);
  if (f.kind === 'missing') return { kind: 'missing' };
  if (f.kind !== 'file') return { kind: 'bad', problem: `${file}: ${f.kind}` };
  if (f.uid !== rootUid() || Number.parseInt(f.mode, 8) & 0o022) return { kind: 'bad', problem: `${file} isn't root's alone (owner uid ${f.uid}, mode ${f.mode})` };
  return { kind: 'file', text: f.text };
}

/**
 * The instances root names as managed apps, each with its repo; none, with why, when the file can't be trusted.
 * `file` is only for reading another copy in root's form; readLockScope reads root's own (MANAGED_APPS_FILE) alone.
 */
export function readManagedApps(file = MANAGED_APPS_FILE()): { apps: Record<string, string>; problem: string | null } {
  const none = (problem: string | null) => ({ apps: {}, problem });
  const f = readRootFile(file);
  if (f.kind === 'missing') return none(null);
  if (f.kind !== 'file') return none(f.problem);
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
 * A GitHub owner/name from a repo URL (https or ssh; with or without .git or a trailing slash), or null.
 * The one parser (#747): install's origin (gitRemoteRepo) and setup's origin step use it too, each trimming git's
 * answer first. Not trimmed here: for the engine's repos (engineRepos), a URL it doesn't take means every lock.
 */
export function githubRepoOf(url: string): string | null {
  const m = /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  // WHY (owner decision 2026-10-18): GitHub has no repo named '.git' (nor '.' or '..', which REPO refuses), and a
  // remote URL naming one must not reach install's config or setup's state as a repo.
  return m && REPO.test(m[1]!) && !/\/\.git$/i.test(m[1]!) ? m[1]! : null;
}

/** The installed engine's package.json (dist/src/ -> the package root): root installs it, no repo's content says it. */
const ENGINE_PACKAGE = new URL('../../package.json', import.meta.url);
/** The file root's updater follows (scripts/setup/updates.sh writes it). */
const UPDATES_FILE = () => etcPath('updates.json');

/**
 * The repos that are the engine on this machine: the installed package.json's repository.url, and root's
 * updates.json's repo_url. Each read can only add a repo held as the engine (more locks, never fewer), so when either
 * can't be told (no repository URL; no updates.json, or one that isn't JSON or doesn't name a GitHub repo) `problem`
 * says so and the caller holds every lock.
 * WHY (#665, owner decision 2026-10-18): a missing updates.json is "can't tell", not "package.json alone tells": the
 * package field is inside the engine's repo, so alone it let the engine's code under another repo name be an app.
 * WHY (#747): its presence decides whether any managed app can exist, so it is read as root's other files are
 * (readRootFile): a symlink, a non-regular or oversized file, or one not root's alone is "can't tell" too.
 */
export function engineRepos(): { repos: string[]; problem: string | null } {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(ENGINE_PACKAGE, 'utf8'));
  } catch (e) {
    return { repos: [], problem: `the engine's package.json can't be read (${(e as Error).message})` };
  }
  const r = (pkg as { repository?: unknown } | null)?.repository;
  const url = typeof r === 'string' ? r : typeof (r as { url?: unknown } | null)?.url === 'string' ? (r as { url: string }).url : '';
  const own = githubRepoOf(url);
  if (!own) return { repos: [], problem: `the engine's package.json names no GitHub repository (${JSON.stringify(url)})` };
  const updates = UPDATES_FILE();
  const f = readRootFile(updates);
  if (f.kind === 'missing') return { repos: [own], problem: `${updates} doesn't exist, so the repo the engine updates from can't be told` };
  if (f.kind !== 'file') return { repos: [own], problem: `${f.problem}, so the repo the engine updates from can't be told` };
  let u: unknown;
  try {
    u = JSON.parse(f.text);
  } catch (e) {
    return { repos: [own], problem: `${updates} can't be read as JSON (${(e as Error).message})` };
  }
  const followed = githubRepoOf(String((u as { repo_url?: unknown } | null)?.repo_url ?? ''));
  if (!followed) return { repos: [own], problem: `${updates} doesn't name the GitHub repo the engine updates from` };
  return { repos: [own, followed], problem: null };
}

/**
 * Whose repo this instance works, for the self-modification locks: a managed app's only when root's file names this
 * instance with exactly this repo (GitHub names compare without case), and that repo isn't the engine's own
 * (engineRepos); otherwise the engine's. `why` says which, for the coordinator's start-up line.
 * INVARIANT: never throws; any error is the engine's scope.
 * INVARIANT (#747): it takes the instance and its repo, nothing else: which file, and whose it must be, are root's
 * (MANAGED_APPS_FILE, rootUid), never a caller's.
 */
export function readLockScope(instance: string, repo: string): { scope: LockScope; why: string } {
  const engine = (why: string) => ({ scope: 'engine' as const, why: `every self-modification lock applies: ${why}` });
  try {
    const file = MANAGED_APPS_FILE();
    const { apps, problem } = readManagedApps(file);
    if (problem) return engine(problem);
    const named = Object.hasOwn(apps, instance) ? apps[instance] : undefined;
    if (named === undefined) return engine(`${file} doesn't name instance ${instance} as a managed app`);
    if (named.toLowerCase() !== repo.toLowerCase()) return engine(`${file} names instance ${instance} for ${named}, not ${repo}`);
    // WHY: root marking the engine's own repo as an app by mistake (or by hand) would turn its source locks off.
    const eng = engineRepos();
    if (eng.problem) return engine(`which repo is the engine can't be told: ${eng.problem}`);
    if (eng.repos.some((e) => e.toLowerCase() === repo.toLowerCase())) return engine(`${repo} is the engine's own repo (its package.json or updates.json), never a managed app`);
    return { scope: 'managed-app', why: `root's ${file} says ${repo} is a managed app, not the engine: the locks on the engine's own source paths don't apply` };
  } catch (e) {
    return engine(`root's managed apps file couldn't be read (${(e as Error)?.message ?? String(e)})`);
  }
}
