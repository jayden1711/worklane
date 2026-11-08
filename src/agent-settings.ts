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
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { BRAND } from './brand.js';
import { changedNames, ignoredNames, untrackedNames } from './coordinator/change-files.js';
import { gitSpawnSync } from './os/git.js';

/** Leading env assignment that marks our hook commands (the shell ignores it otherwise). */
export const HOOK_MARKER = `${BRAND.envPrefix}_HOOK=1`;

/** The file in an instance's home that holds its agents' hooks and rules. */
export const AGENT_SETTINGS_FILE = 'agent-settings.json';
export const agentSettingsPath = (instanceHome: string) => join(instanceHome, AGENT_SETTINGS_FILE);

/** The hook events every agent run must carry, each failing closed. */
export const GUARDED_EVENTS = ['PreToolUse', 'SessionStart', 'SessionEnd'] as const;

export interface HookEntry {
  matcher?: string;
  hooks: { type: 'command'; command: string; timeout?: number; onFailure?: 'continue' | 'block' }[];
}

/**
 * What Claude Code does when a PreToolUse guard hook fails rather than answers: it times out, can't start, exits with a
 * code other than 0 or 2, or prints invalid output. "block" counts the failure as exit code 2, so the tool call is
 * blocked; without it the call goes ahead (Claude Code's hooks reference; the setting's schema and its description,
 * read in the pinned 2.1.296 package, src/tool-install.ts: `onFailure: "continue" | "block"`, from 2.1.295 on).
 * The guard also refuses on its own when it runs out of time (src/hook-deadline.ts); this covers what it can't: a
 * process that never starts, or is killed.
 */
export const GUARD_ON_FAILURE = 'block' as const;

/**
 * The tools the guard's PreToolUse hook is asked about: every one (#937). WHY: a list of names let every other tool
 * (`mcp__*`, NotebookRead, LS, …) skip the guard, so its own refusal of tools it doesn't know never ran. `*` is Claude
 * Code's match-all (its hooks reference; 2.1.319's hook code reads "*", "" and no matcher alike).
 */
export const GUARD_MATCHER = '*';

/**
 * These hooks with every PreToolUse command hook failing closed (GUARD_ON_FAILURE), and the guard's own entry asked
 * about every tool (GUARD_MATCHER, #937). WHY at each run (runSettings), not only at install: an instance's agent
 * settings written before this keep working, and get both with the engine update.
 */
export function guardsFailClosed(hooks: Record<string, HookEntry[]>): Record<string, HookEntry[]> {
  const pre = hooks.PreToolUse;
  if (!pre) return hooks;
  const ours = (e: HookEntry) => e.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER));
  return {
    ...hooks,
    PreToolUse: pre.map((e) => (Array.isArray(e?.hooks) ? { ...e, ...(ours(e) ? { matcher: GUARD_MATCHER } : {}), hooks: e.hooks.map((h) => (h?.type === 'command' ? { ...h, onFailure: GUARD_ON_FAILURE } : h)) } : e)),
  };
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

/**
 * Whether every PreToolUse command hook of ours in these settings fails closed (onFailure "block"). WHY (#930): a
 * checkout's own settings are used as written (people's sessions, local runs), unlike an instance's, which every run
 * gets with it (runSettings, guardsFailClosed); an agent running as the same user can stop the hook, and without it
 * Claude Code runs the call after the timeout.
 */
export function guardBlocksOnFailure(s: Settings): boolean {
  const ours = (s.hooks?.PreToolUse ?? []).flatMap((e) => e?.hooks ?? []).filter((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER));
  return ours.length > 0 && ours.every((h) => h.onFailure === GUARD_ON_FAILURE);
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

/** The instruction files Claude Code loads up front from each folder from the checkout's top down to the run's cwd. */
const LOADED_INSTRUCTIONS = ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'];
/** The most entries under a `.claude/` folder it walks for links; past it, the run is refused (fail closed). */
const MAX_CLAUDE_DIR_ENTRIES = 10_000;

/**
 * Why an agent run in `cwd` must not start because what Claude Code loads from the checkout isn't what its last
 * commit holds (#958), or null. A project command (a worktree setup step, a dependency's install script) runs as the
 * agent user and can write `.claude/settings.json` with a SessionStart hook, or a CLAUDE.md, into the checkout; the
 * next run would load it, and run the hook outside any sandbox. So the run is refused for any of these:
 * - anything under `.claude/` (ignored files too, as a gitignored settings.local.json; never the coordinator's own
 *   `.claude/worktrees/`) or any CLAUDE.md or CLAUDE.local.md (tracked or untracked) that differs from the checkout's
 *   HEAD, or isn't in it;
 * - a `.claude` that is a link or not a folder, or a link anywhere under one (R1185a D1): git lists a linked folder as
 *   one entry and never looks inside, and what it points at is never compared;
 * - a CLAUDE.md, CLAUDE.local.md or .claude/CLAUDE.md in a folder from the top down to `cwd`, the files Claude Code
 *   loads up front, whose bytes (through a link, to its target in the checkout) aren't HEAD's, compared directly, so an
 *   ignore rule (a `.gitignore` the same step writes, info/exclude, core.excludesFile) can't hide it (R1185a D3).
 * Not counted: an empty, untracked regular file (R1185a D2), the mount points Claude Code's Linux sandbox leaves
 * (src/worktrees.ts removeSandboxPlaceholders removes the same ones after task runs; never in the main checkout, or
 * after a stuck attempt): empty, it holds no hook and no instruction. Not a checkout: null (nothing committed to compare
 * with). A git status that fails: refused (fail closed). It compares with HEAD, not the task's base: a hook an agent
 * commits itself is the merge policy's (agent-instructions waits), and not caught here. Not covered: an ignored
 * CLAUDE.md below `cwd` (as under node_modules), which Claude Code reads only when the agent works in that folder.
 */
export function uncommittedAgentFilesRefusal(cwd: string): string | null {
  const inside = gitSpawnSync(['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8' });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null;
  // Under .claude/ (and .claude itself), never the coordinator's own worktrees; a CLAUDE.md or CLAUDE.local.md anywhere.
  const inClaudeDir = (p: string) => (p === '.claude' || p.startsWith('.claude/')) && !p.startsWith('.claude/worktrees/');
  const instructions = (p: string) => /(^|\/)CLAUDE(\.local)?\.md$/.test(p);
  let changed: string[];
  try {
    // Through the one helper for changed names (src/coordinator/change-files.ts): what differs from HEAD (staged or
    // not), what is untracked, and under .claude/ what is ignored too; listed only where they can match.
    // From the checkout's top, so the paths and the literal pathspec (the helper reads every pathspec literally) are
    // the top's. Untracked files are listed whole (an ignored tree such as node_modules isn't), and filtered here.
    const top = gitSpawnSync(['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    if (top.status !== 0 || !top.stdout.trim()) throw new Error(`git can't say where the checkout at ${cwd} starts`);
    const root = top.stdout.trim();
    // An untracked file that is empty and regular is a sandbox mount point: inert (D2).
    const placeholder = (p: string) => {
      try {
        const st = lstatSync(join(root, p));
        return st.isFile() && st.size === 0;
      } catch {
        return false;
      }
    };
    const differs = changedNames(root, ['HEAD']).filter((p) => inClaudeDir(p) || instructions(p));
    const untracked = untrackedNames(root).filter((p) => (inClaudeDir(p) || instructions(p)) && !placeholder(p));
    const ignored = ignoredNames(root, ['.claude']).filter((p) => inClaudeDir(p) && !placeholder(p));
    changed = [...new Set([...differs, ...untracked, ...ignored, ...linkedClaudeDirs(root, cwd), ...loadedInstructionsChanged(root, cwd)])];
  } catch (e) {
    return `the checkout's agent settings and instructions couldn't be compared with its last commit (${(e as Error).message})`;
  }
  if (!changed.length) return null;
  const shown = changed.slice(0, 5).map((p) => JSON.stringify(p)).join(', ');
  return `the checkout's agent settings or instructions (${shown}${changed.length > 5 ? ` and ${changed.length - 5} more` : ''}) differ from its last commit or aren't in it: written by a setup step or a command since, a run would load them, and a hook there would run outside the sandbox`;
}

/** The folders from the checkout's top `root` down to `cwd`, as paths from the top ('' for the top). */
function foldersDown(root: string, cwd: string): string[] {
  let rel: string;
  try {
    rel = relative(realpathSync(root), realpathSync(cwd));
  } catch {
    rel = '';
  }
  if (rel.startsWith('..')) rel = '';
  const parts = rel ? rel.split(sep) : [];
  return parts.reduce<string[]>((acc, part) => [...acc, acc.at(-1) ? `${acc.at(-1)}/${part}` : part], ['']);
}

/** Each `.claude` from the top down to `cwd` that is a link or not a folder, and each link under one (D1). */
function linkedClaudeDirs(root: string, cwd: string): string[] {
  const out: string[] = [];
  for (const folder of foldersDown(root, cwd)) {
    const rel = folder ? `${folder}/.claude` : '.claude';
    let st;
    try {
      st = lstatSync(join(root, rel));
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      // An empty regular file is a sandbox mount point (D2): nothing loads from it.
      if (!(st.isFile() && st.size === 0)) out.push(rel);
      continue;
    }
    let seen = 0;
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (p === '.claude/worktrees') continue;
        if (++seen > MAX_CLAUDE_DIR_ENTRIES) throw new Error(`over ${MAX_CLAUDE_DIR_ENTRIES} entries under ${rel}`);
        if (e.isSymbolicLink()) out.push(p);
        else if (e.isDirectory()) walk(p);
      }
    };
    walk(rel);
  }
  return out;
}

/**
 * Each instruction file Claude Code loads up front (LOADED_INSTRUCTIONS, from the top down to `cwd`) whose bytes aren't
 * HEAD's (D3): compared directly, whatever ignore rules say. Through a link, the target's bytes against HEAD's at the
 * target's path, which must be in the checkout. An empty, untracked file is a placeholder (D2). Missing: deleted, which
 * the changed names list.
 */
function loadedInstructionsChanged(root: string, cwd: string): string[] {
  const out: string[] = [];
  const realRoot = realpathSync(root);
  for (const folder of foldersDown(root, cwd)) {
    for (const name of LOADED_INSTRUCTIONS) {
      const rel = folder ? `${folder}/${name}` : name;
      let st;
      try {
        st = lstatSync(join(root, rel));
      } catch {
        continue;
      }
      let at = rel;
      if (st.isSymbolicLink()) {
        let target: string;
        try {
          target = relative(realRoot, realpathSync(join(root, rel)));
        } catch {
          out.push(rel); // a dangling link: refused rather than guessed
          continue;
        }
        if (!target || target.startsWith('..') || target.startsWith(sep)) {
          out.push(rel); // outside the checkout: never compared
          continue;
        }
        at = target.split(sep).join('/');
        st = lstatSync(join(root, at));
      }
      if (!st.isFile()) {
        out.push(rel);
        continue;
      }
      const head = gitSpawnSync(['cat-file', 'blob', `HEAD:${at}`], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
      if (head.status !== 0) {
        if (st.size > 0) out.push(rel); // not in HEAD, and not empty
        continue;
      }
      if (!head.stdout.equals(readFileSync(join(root, at)))) out.push(rel);
    }
  }
  return out;
}

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
    hooks: guardsFailClosed(hooks),
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
 * A run's --settings: its own, attribution off (#576), and its check value spread last. INVARIANT (#626, #697): the
 * one place the order is decided, so nothing spread before it (NO_ATTRIBUTION included) can replace the check value.
 */
export const withRunCheck = <T extends object>(settings: T, check: string) => ({ ...settings, ...NO_ATTRIBUTION, [SETTINGS_CHECK_KEY]: check });

/**
 * Why a run must stop because claude's init event doesn't show this run's --settings applied, or null.
 * `what` names the settings (the instance's agent settings file, when they came from one).
 */
export function settingsAppliedProblem(init: { output_style?: unknown }, check: string, what: string): string | null {
  if (init.output_style === check) return null;
  return `claude did not apply the --settings this run passed (${what}): its init event doesn't report the run's check value in output_style, so the run's deny rules and hooks may be off (one invalid value makes claude drop the whole file without a word)`;
}
