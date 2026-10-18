// Guardrail hooks and permission rules for an instance's agent runs only.
//
// `install --instance <name>` writes them to agent-settings.json in the
// instance's home (owned by the coordinator user, 0700, which the agent user
// can neither read nor write). The runner reads that file for every agent run
// and hands it to claude with --settings. Human sessions in the repo never see
// it, and the repo needs no .claude/settings.json.
//
// Why --settings, and what a project's own .claude/settings.json can still do
// (Claude Code docs, settings, permissions and hooks pages; checked against
// Claude Code 2.1.296):
// - Precedence is managed > command line (--settings) > local project >
//   shared project > user. A key we set in --settings beats the project's.
// - Lists merge across sources, and a deny rule from any source beats an
//   allow from any other: a project file can't lift our deny rules.
// - Hooks merge across sources: a project file can add hooks, not remove ours.
// - disableAllHooks is read after precedence: a project `true` turns off every
//   non-managed hook, ours included, unless a higher source sets `false`. We
//   set `false` in --settings.
// - A project's `env` is applied to hooks over the process environment, so the
//   run's harness variables are pinned in --settings too; and a project file
//   that sets env, widens allow rules, or sets anything but hooks and
//   permission rules refuses the run (projectSettingsRefusal).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from './brand.js';

/** Leading env assignment that marks our hook commands (the shell ignores it otherwise). */
export const HOOK_MARKER = `${BRAND.envPrefix}_HOOK=1`;

/** The file in an instance's home that holds its agents' hooks and rules. */
export const AGENT_SETTINGS_FILE = 'agent-settings.json';
export const agentSettingsPath = (instanceHome: string) => join(instanceHome, AGENT_SETTINGS_FILE);

/** The hook events every agent run must carry, each failing closed. */
export const GUARDED_EVENTS = ['PreToolUse', 'SessionStart', 'SessionEnd'] as const;

export interface HookEntry {
  matcher?: string;
  hooks: { type: 'command'; command: string; timeout?: number }[];
}
export type Settings = Record<string, unknown> & {
  hooks?: Record<string, HookEntry[]>;
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] } & Record<string, unknown>;
  env?: Record<string, string>;
  disableAllHooks?: boolean;
};

export class AgentSettingsError extends Error {}

export interface HookCheck {
  event: string;
  ok: boolean;
  detail: string;
}

/**
 * Whether settings carry each guarded hook once, failing closed for agents, with its engine present.
 * `enginePath` maps the path in a command to a file on this machine (e.g. $CLAUDE_PROJECT_DIR expanded).
 */
export function hookChecks(s: Settings, enginePath: (p: string) => string = (p) => p): HookCheck[] {
  return GUARDED_EVENTS.map((event) => {
    const cmds = (s.hooks?.[event] ?? []).flatMap((e) => e.hooks ?? []).map((h) => h.command).filter((c) => typeof c === 'string' && c.includes(HOOK_MARKER));
    if (cmds.length !== 1) return { event, ok: false, detail: cmds.length ? `${cmds.length} ${BRAND.cli} entries (expected 1)` : 'not installed' };
    const cmd = cmds[0]!;
    const raw = cmd.match(/E="([^"]+)"/)?.[1];
    const path = raw ? enginePath(raw) : undefined;
    if (!cmd.includes('|| exit 2') || !/_AGENT" = 1 \]; then [^;]*>&2; exit 2/.test(cmd)) return { event, ok: false, detail: 'does not fail closed for agents' };
    if (!path || !existsSync(path)) return { event, ok: false, detail: `engine not found at ${path ?? '(unparsed)'}` };
    return { event, ok: true, detail: 'installed, fails closed' };
  });
}

function readSettings(file: string): Settings {
  const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a JSON object');
  return v as Settings;
}

/** The file each instance's agent settings were read from, for a refusal that names it. */
const settingsFiles = new WeakMap<object, string>();
/** The file `readAgentSettings` read these settings from, or undefined. */
export const agentSettingsFileOf = (s: object): string | undefined => settingsFiles.get(s);

/** Every way an instance's agent settings fall short: the hooks, and disableAllHooks pinned off. */
export function agentSettingsProblems(s: Settings): string[] {
  const out = hookChecks(s).filter((c) => !c.ok).map((c) => `hook ${c.event}: ${c.detail}`);
  if (s.disableAllHooks !== false) out.push('disableAllHooks is not pinned to false, so a project file could turn the hooks off');
  return out;
}

/** An instance's agent settings, checked. Missing, unreadable or incomplete: an error, never "no hooks". */
export function readAgentSettings(instanceHome: string): Settings {
  const file = agentSettingsPath(instanceHome);
  if (!existsSync(file)) throw new AgentSettingsError(`${file} missing`);
  let s: Settings;
  try {
    s = readSettings(file);
  } catch (e) {
    throw new AgentSettingsError(`${file} unreadable: ${(e as Error).message}`);
  }
  const problems = agentSettingsProblems(s);
  if (problems.length) throw new AgentSettingsError(`${file}: ${problems.join('; ')}`);
  settingsFiles.set(s, file);
  return s;
}

/** A checkout's own .claude/settings.json, when it carries our hooks: where installs before agent settings put them. */
export function legacyProjectHooks(dir: string): boolean {
  const file = join(dir, '.claude', 'settings.json');
  if (!existsSync(file)) return false;
  try {
    return hookChecks(readSettings(file), (p) => p.replace('$CLAUDE_PROJECT_DIR', dir)).every((c) => c.ok);
  } catch {
    return false;
  }
}

/** The command that writes an instance's agent settings, run as its coordinator user. */
export const installCommand = (instance: string, checkout: string) => `${BRAND.cli} install --root ${JSON.stringify(checkout)} --instance ${instance}`;

/**
 * The guardrail settings for an instance's agent runs: its agent settings, and nothing else. Hooks in a checkout's
 * own .claude/settings.json (where installs before agent settings put them) never stand in: without agent
 * settings, the run and the coordinator refuse to start, naming the command that fixes it.
 */
export function guardrailSettings(instanceHome: string, instance: string, checkout: string): Settings {
  const file = agentSettingsPath(instanceHome);
  if (!existsSync(file)) throw new AgentSettingsError(`no agent settings at ${file}, so ${instance}'s agent runs have no guardrail hooks; as its coordinator user, run \`${installCommand(instance, checkout)}\``);
  return readAgentSettings(instanceHome);
}

/** What a project's .claude/settings.json may set for an agent run: hooks (they only add) and permission rules. */
const PROJECT_KEYS = new Set(['$schema', 'hooks', 'permissions']);
const PROJECT_PERMISSION_KEYS = new Set(['allow', 'deny', 'ask']);

/**
 * Why an agent run in `cwd` must not start because of the checkout's .claude/settings.json, or null. Deny and ask
 * rules only tighten and hooks only add, so they're fine; an allow rule our settings don't have would widen what
 * the agent may do, and any other key (env, sandbox, additionalDirectories, defaultMode, ...) could loosen the run.
 * .claude/settings.local.json isn't checked: the runner loads project settings only (--setting-sources project).
 */
export function projectSettingsRefusal(cwd: string, ours: Settings): string | null {
  const file = join(cwd, '.claude', 'settings.json');
  if (!existsSync(file)) return null;
  let s: Settings;
  try {
    s = readSettings(file);
  } catch (e) {
    return `${file} can't be read (${(e as Error).message}), so what it changes can't be checked`;
  }
  const keys = Object.keys(s).filter((k) => !PROJECT_KEYS.has(k));
  const pkeys = Object.keys(s.permissions ?? {}).filter((k) => !PROJECT_PERMISSION_KEYS.has(k));
  const allowed = new Set(ours.permissions?.allow ?? []);
  const wider = (s.permissions?.allow ?? []).filter((a) => !allowed.has(a));
  const why = [
    // WHY: #584 added an effortLevel here and every agent run on the repo refused to start; a default effort is the runner's (#579).
    ...(keys.length ? [`it sets ${keys.map((k) => (k === 'effortLevel' ? "effortLevel (an agent's effort is set by the runner, per role: #579, not by the project)" : k)).join(', ')}`] : []),
    ...(pkeys.length ? [`it sets permissions.${pkeys.join(', permissions.')}`] : []),
    ...(wider.length ? [`it allows ${wider.join(', ')}, beyond the instance's agent settings`] : []),
  ];
  return why.length ? `the checkout's .claude/settings.json could loosen agent runs: ${why.join('; ')}. Remove those entries (agents get their hooks and rules from the instance), or add allow rules to guardrails.yaml pre_approved and re-run \`${BRAND.cli} install --instance <name>\`` : null;
}

const union = (...lists: (string[] | undefined)[]) => [...new Set(lists.flatMap((l) => l ?? []))];

/**
 * Commit and PR attribution off (#576): the repo's attribution is the DCO sign-off only, so an agent adds no
 * Co-Authored-By trailer, no "Generated with" line and no session link. Claude Code's own setting names (its settings
 * schema in the pinned CLI, 2.1.296: src/tool-install.ts): `attribution.commit` and `attribution.pr`, an empty string
 * hiding each; `attribution.sessionUrl: false`, no Claude-Session trailer or PR-body link; and `includeCoAuthoredBy`,
 * the deprecated form older versions read. The object form, not `attribution: false`, which older versions reject.
 * WHY a key here must be valid for the pinned CLI: 2.1.296 drops a whole --settings with one invalid value, hooks and
 * deny rules included, silently (measured on the #619 review: a run probe with --debug).
 */
export const NO_ATTRIBUTION = { attribution: { commit: '', pr: '', sessionUrl: false }, includeCoAuthoredBy: false } as const;

/**
 * The settings one agent run gets with --settings: the instance's guardrails, the lane's own (its sandbox and deny
 * rules) and the run's harness variables, pinned so no project file can change them. disableAllHooks stays false,
 * and attribution stays off whatever the instance's or the lane's settings say.
 */
export function runSettings(ours: Settings, lane: object | undefined, pinnedEnv: Record<string, string>): Settings {
  const l = (lane ?? {}) as Settings;
  const hooks: Record<string, HookEntry[]> = {};
  for (const e of new Set([...Object.keys(ours.hooks ?? {}), ...Object.keys(l.hooks ?? {})])) hooks[e] = [...(ours.hooks?.[e] ?? []), ...(l.hooks?.[e] ?? [])];
  const perm = (k: 'allow' | 'deny' | 'ask') => {
    const v = union(ours.permissions?.[k], l.permissions?.[k]);
    return v.length ? { [k]: v } : {};
  };
  return {
    ...l,
    ...ours,
    hooks,
    permissions: { ...perm('allow'), ...perm('deny'), ...perm('ask') },
    env: { ...(ours.env ?? {}), ...(l.env ?? {}), ...pinnedEnv },
    disableAllHooks: false,
    ...NO_ATTRIBUTION,
  };
}

/**
 * Proof that claude applied a run's --settings (#626). The pinned Claude Code (2.1.296, src/tool-install.ts) drops
 * the whole --settings when one value in it is invalid, deny rules and hooks included, and says nothing; the run
 * goes on without its guardrails. So every --settings carries a check value, new for each run, and the run stops
 * unless claude's init event reports that value back before any line but a system one (settingsAppliedProblem); a
 * session that ends with it unconfirmed fails.
 *
 * The value rides in outputStyle, read in the 2.1.296 package: its settings schema takes any string there; the init
 * event's output_style is the merged settings' outputStyle as given; and a name no style has resolves to no style,
 * the same as the default, so the agent's prompt doesn't change. Nothing else can set it: a project file that sets
 * any key but hooks and permission rules refuses the run (projectSettingsRefusal), --settings outranks it, and the
 * value is made when the run starts. A CLI upgrade re-runs test/runner-settings-applied.test.ts and must keep these.
 */
export const SETTINGS_CHECK_KEY = 'outputStyle';

/** A fresh check value for one run's --settings. */
export const settingsCheckValue = (): string => `${BRAND.cli}-settings-check-${randomBytes(8).toString('hex')}`;

/**
 * Why a run must stop because claude's init event doesn't show this run's --settings applied, or null.
 * `what` names the settings (the instance's agent settings file, when they came from one).
 */
export function settingsAppliedProblem(init: { output_style?: unknown }, check: string, what: string): string | null {
  if (init.output_style === check) return null;
  return `claude did not apply the --settings this run passed (${what}): its init event doesn't report the run's check value in output_style, so the run's deny rules and hooks may be off (one invalid value makes claude drop the whole file without a word)`;
}
