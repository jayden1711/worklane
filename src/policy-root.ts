// The root side of a single machine's root-owned policy.yaml (issue #726; the rules in src/policy-gate.ts):
//   <cli> policy own <instance>                 root: make the instance's policy.yaml root's (0644), its content kept,
//                                               and record it; prints the isolation and merge keys, so the admin sees
//                                               any a coordinator-user process loosened earlier (setup's policy step)
//   <cli> policy set <instance> <key> <value>   root: one change, checked
// The instance is the coordinator user wl-<instance>'s; its home comes from the user database, never an argument.
// Asked through sudo by a coordinator user (SUDO_USER wl-...), a loosening of land_mode or main_watch is refused.
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { BRAND } from './brand.js';
import { PolicyFile } from './instance.js';
import { instanceNameOk } from './instance-name.js';
import { isRoot, userHomeDir, userUid } from './os/index.js';
import { readInOwnedDir, replaceInOwnedDir } from './os/root-file.js';
import { decodePolicyValue, HELPER_ONLY, ownCommand, POLICY_ROOT_DIR, POLICY_SET_KEYS, policyRootRequired } from './policy-gate.js';
import { LIMITS_PATH, loadLimits, settingsProblems } from './settings.js';

const FILE = 'policy.yaml';
/** The keys an admin should see whenever root takes a policy over: what isolates the agents, and what merges. */
const WATCHED = ['sandbox', 'allow_same_user', 'land_mode', 'main_watch', 'auto_merge'] as const;
const loose = (p: PolicyFile) => [...(!p.sandbox ? ['sandbox: false'] : []), ...(p.allow_same_user ? ['allow_same_user: true'] : []), ...(p.land_mode !== 'pr' ? [`land_mode: ${p.land_mode}`] : []), ...(p.main_watch !== 'auto' ? [`main_watch: ${p.main_watch}`] : [])];

/** Where the work happens, and as whom; tests stand in for the user database and root. */
export interface PolicyRootDeps {
  home?: (user: string) => string | null;
  uid?: (user: string) => number | null;
  rootUid?: number;
  rootGid?: number;
  markerDir?: string;
  limitsPath?: string;
}

/** An instance's policy.yaml on this machine: its coordinator's instance home (real path), and that user's uid. */
export function instancePolicy(instance: string, d: PolicyRootDeps = {}): { dir: string; file: string; coordUid: number } {
  if (!instanceNameOk(instance)) throw new Error(`${instance}: not an instance name`);
  const user = `wl-${instance}`;
  const home = (d.home ?? userHomeDir)(user);
  const coordUid = (d.uid ?? userUid)(user);
  if (!home || coordUid === null) throw new Error(`no user ${user} on this machine`);
  const dir = join(realpathSync(home), '.local', 'state', BRAND.cli, 'instances', instance);
  return { dir, file: join(dir, FILE), coordUid };
}

function parsePolicy(text: string, file: string): PolicyFile {
  const r = PolicyFile.safeParse(parseDocument(text).toJS());
  if (!r.success) throw new Error(`${file} is invalid, so it is left as it is: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

/**
 * Make an instance's policy.yaml root's, 0644, with its content as it is (setup's policy step, and an admin after a
 * refusal), and record that in root's directory, so the engine reads it only while it stays root's. Returns the keys
 * an admin should check, and which of them are loose.
 */
export function ownPolicy(instance: string, d: PolicyRootDeps = {}): { file: string; keys: Record<string, unknown>; loose: string[] } {
  const { dir, file, coordUid } = instancePolicy(instance, d);
  const rootUid = d.rootUid ?? 0;
  const text = readInOwnedDir(dir, FILE, coordUid, [coordUid, rootUid]);
  const policy = parsePolicy(text, file);
  replaceInOwnedDir({ dir, name: FILE, text, dirOwner: coordUid, uid: rootUid, gid: d.rootGid ?? 0, mode: 0o644 });
  const markers = d.markerDir ?? POLICY_ROOT_DIR;
  mkdirSync(markers, { recursive: true, mode: 0o755 });
  const tmp = join(markers, `.${instance}.tmp-${process.pid}`);
  writeFileSync(tmp, `${file}\n`, { mode: 0o644 });
  renameSync(tmp, join(markers, instance));
  return { file, keys: Object.fromEntries(WATCHED.map((k) => [k, policy[k]])), loose: loose(policy) };
}

/** Where a key sits in the file: `settings.workers` is settings: { workers }, `budget.daily_usd` budget: { daily_usd }. */
const pathOf = (key: string) => key.split('.');
const getIn = (o: unknown, path: string[]): unknown => path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);

/**
 * One change to a root policy.yaml, as root: a key and value in its shape (src/policy-gate.ts), checked
 * against the schema and the machine's limits, then written root's, 0644. `by`: who asked (sudo's SUDO_USER); a
 * coordinator user (wl-...) may never loosen land_mode or main_watch, whatever its arguments.
 */
export function setPolicy(instance: string, key: string, arg: string, by: string | null, d: PolicyRootDeps = {}): { key: string; from: unknown; to: unknown } {
  if (!Object.hasOwn(POLICY_SET_KEYS, key)) throw new Error(`${key} isn't a key that changes this way (${Object.keys(POLICY_SET_KEYS).join(', ')})`);
  const value = decodePolicyValue(key, arg);
  if (value === undefined) throw new Error(`${arg} isn't a value for ${key}`);
  if (by && /^wl-/.test(by) && Object.hasOwn(HELPER_ONLY, key) && HELPER_ONLY[key] !== arg) throw new Error(`${key}: ${arg} loosens the instance, which is an admin's, at a root shell (sudo ${BRAND.cli} policy set ${instance} ${key} ${arg}); a dashboard may only tighten it`);
  const { dir, file, coordUid } = instancePolicy(instance, d);
  if (!policyRootRequired(file, d.markerDir)) throw new Error(`${file} isn't root's yet: make it so first (${ownCommand(instance)})`);
  const rootUid = d.rootUid ?? 0;
  const text = readInOwnedDir(dir, FILE, coordUid, [rootUid]);
  const doc = parseDocument(text);
  const from = getIn(doc.toJS(), pathOf(key)) ?? null;
  doc.setIn(pathOf(key), value);
  const next = parsePolicy(doc.toString(), file);
  const limits = loadLimits(d.limitsPath ?? LIMITS_PATH);
  const problems = settingsProblems(next.settings, limits, next);
  if (next.budget.daily_usd > limits.daily_budget_usd.max) problems.push(`budget.daily_usd ${next.budget.daily_usd} is over ${limits.daily_budget_usd.max} (machine limits)`);
  if (next.agents.max_workers > limits.workers.max) problems.push(`agents.max_workers ${next.agents.max_workers} is over ${limits.workers.max} (machine limits)`);
  if (problems.length) throw new Error(`refused: ${problems.join('; ')}`);
  replaceInOwnedDir({ dir, name: FILE, text: doc.toString(), dirOwner: coordUid, uid: rootUid, gid: d.rootGid ?? 0, mode: 0o644 });
  return { key, from, to: value };
}

/** `<cli> policy own|set ...`, as root. */
export function policyCommand(sub: string | undefined, rest: string[]): number {
  const usage = `usage: ${BRAND.cli} policy own <instance> | policy set <instance> <key> <value>   (as root)`;
  if (!isRoot()) {
    console.error(`policy ${sub ?? ''} is root's: run it with sudo\n${usage}`);
    return 2;
  }
  const deps: PolicyRootDeps = {};
  try {
    if (sub === 'own' && rest.length === 1) {
      const r = ownPolicy(rest[0]!, deps);
      console.log(`${r.file} is root's now (0644), its content as it was:\n${Object.entries(r.keys).map(([k, v]) => `  ${k}: ${String(v)}`).join('\n')}`);
      if (r.loose.length) console.log(`CHECK: ${r.loose.join(', ')} loosens this instance. If you didn't set it, a process running as the instance's coordinator user may have: change it with sudo ${BRAND.cli} policy set ${rest[0]} <key> <value>, or edit the file as root.`);
      return 0;
    }
    if (sub === 'set' && rest.length === 3) {
      console.log(JSON.stringify(setPolicy(rest[0]!, rest[1]!, rest[2]!, process.env.SUDO_USER ?? null, deps)));
      return 0;
    }
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  console.error(usage);
  return 2;
}
