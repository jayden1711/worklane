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
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { BRAND } from './brand.js';
import { changedNames, ignoredNames, lookAwayNames, untrackedNames } from './coordinator/change-files.js';
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
const LOADED_INSTRUCTIONS = ['CLAUDE.md', '.claude/CLAUDE.md'];
/** What these runs never load (measured, R1185f L3: --setting-sources project): a local settings file and CLAUDE.local.md. */
const NOT_LOADED = /(^|\/)\.claude\/settings\.local\.json$|(^|\/)claude\.local\.md$/i;
/** How many `@` imports deep a loaded instruction file's imports are followed (as Claude Code follows them). */
const MAX_IMPORT_DEPTH = 5;
/** Bytes alike but for line endings (R1185f L2: a checkout under eol=crlf or core.autocrlf), as git's text conversion makes them. */
const sameText = (a: Buffer, b: Buffer) => a.equals(b) || a.toString('latin1').replace(/\r\n/g, '\n') === b.toString('latin1').replace(/\r\n/g, '\n');
/** The most entries under a `.claude/` folder it walks for links; past it, the run is refused (fail closed). */
const MAX_CLAUDE_DIR_ENTRIES = 10_000;

/**
 * Why an agent run in `cwd` must not start because what Claude Code loads from the checkout isn't what its last
 * commit holds (#958), or null. A project command (a worktree setup step, a dependency's install script) runs as the
 * agent user and can write `.claude/settings.json` with a SessionStart hook, or a CLAUDE.md, into the checkout; the
 * next run would load it, and run the hook outside any sandbox. So the run is refused for any of these:
 * - anything under `.claude/` (ignored files too, as a gitignored settings.local.json; never the coordinator's own
 *   `.claude/worktrees/`) or any CLAUDE.md (tracked or untracked) that differs from the checkout's
 *   HEAD, or isn't in it;
 * - a `.claude` that is a link or not a folder, or a link anywhere under one (R1185a D1): git lists a linked folder as
 *   one entry and never looks inside, and what it points at is never compared;
 * - a CLAUDE.md or .claude/CLAUDE.md in a folder from the top down to `cwd` (and `.claude/rules/**/*.md`), the files Claude Code
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
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    // Not a checkout only when there is no `.git` from cwd up to `/` (R1185h H5, H7, H8): a `.git` git can't read (a
    // garbage HEAD or a rewritten gitdir in the agent-writable `.git/worktrees/<id>/`, core.bare set) refuses.
    const dotGit = gitEntryAbove(cwd);
    if (dotGit === null) return null;
    return `the checkout's agent settings and instructions couldn't be compared with its last commit: ${dotGit} is there, but git can't read the checkout at ${cwd} (${(inside.stderr || inside.stdout || `exit ${inside.status}`).trim().slice(0, 200)})`;
  }
  let changed: string[];
  try {
    // Through the one helper for changed names (src/coordinator/change-files.ts): what differs from HEAD (staged or
    // not), what is untracked, and under .claude/ what is ignored too; listed only where they can match.
    // From the checkout's top, so the paths and the literal pathspec (the helper reads every pathspec literally) are
    // the top's. Untracked files are listed whole (an ignored tree such as node_modules isn't), and filtered here.
    const top = gitSpawnSync(['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    if (top.status !== 0 || !top.stdout.trim()) throw new Error(`git can't say where the checkout at ${cwd} starts`);
    const root = top.stdout.trim();
    // Under a `.claude` (or `.claude` itself) in any folder from the top down to cwd, never the coordinator's own
    // `.claude/worktrees/` (R1185f F5); a CLAUDE.md anywhere. Names folded (R1185f F1: on a case-insensitive file
    // system `.CLAUDE/settings.json` is the `.claude/settings.json` Claude Code opens). Never what these runs don't
    // load (NOT_LOADED, R1185f L3).
    const prefixes = foldersDown(root, cwd).map((f) => (f ? `${f}/.claude` : '.claude').toLowerCase());
    const inClaudeDir = (p: string) => {
      const l = p.toLowerCase();
      return prefixes.some((x) => l === x || l.startsWith(`${x}/`)) && !l.startsWith('.claude/worktrees/') && !NOT_LOADED.test(p);
    };
    const instructions = (p: string) => /(^|\/)claude\.md$/i.test(p);
    // The `.claude` folders git is asked about for ignored files, by their names on disk (any case).
    const claudeDirs = foldersDown(root, cwd).flatMap((f) => {
      try {
        return readdirSync(join(root, f)).filter((n) => n.toLowerCase() === '.claude').map((n) => (f ? `${f}/${n}` : n));
      } catch {
        return [];
      }
    });
    // An untracked file that is empty and regular is a sandbox mount point: inert (D2).
    const placeholder = (p: string) => {
      try {
        const st = lstatSync(join(root, p));
        return st.isFile() && st.size === 0;
      } catch {
        return false;
      }
    };
    // A tracked agent file gone from disk loads nothing (R1185f L1: a sparse checkout leaves folders out): not counted.
    // A tracked file a sparse checkout left out (flagged, R1185f L1) loads nothing; one simply deleted is a change
    // (R1185g G5: a committed .claude/settings.json with deny rules, removed by a setup step).
    const flagged = new Set(lookAwayNames(root));
    const onDisk = (p: string) => {
      try {
        lstatSync(join(root, p));
        return true;
      } catch {
        return !flagged.has(p);
      }
    };
    const differs = changedNames(root, ['HEAD']).filter((p) => (inClaudeDir(p) || (instructions(p) && !NOT_LOADED.test(p))) && onDisk(p));
    const untracked = untrackedNames(root).filter((p) => (inClaudeDir(p) || (instructions(p) && !NOT_LOADED.test(p))) && !placeholder(p));
    const ignored = claudeDirs.length ? ignoredNames(root, claudeDirs).filter((p) => inClaudeDir(p) && !placeholder(p)) : [];
    const head = headEntries(root);
    const links = linkedClaudeDirs(root, cwd, head, placeholder);
    // Every tracked agent file (and each committed link's target) against HEAD's bytes, whatever the index says, and
    // the index flags that make git look away from one (D4: --skip-worktree, --assume-unchanged).
    const agent = (p: string) => inClaudeDir(p) || (instructions(p) && !NOT_LOADED.test(p)) || links.targets.some((t) => p === t || p.startsWith(`${t}/`));
    changed = [...new Set([...differs, ...untracked, ...ignored, ...links.refused, ...trackedDiffer(root, head, agent), ...hiddenFromGit(root, agent), ...loadedInstructionsChanged(root, cwd), ...ancestorsChanged(root)])];
  } catch (e) {
    return `the checkout's agent settings and instructions couldn't be compared with its last commit (${(e as Error).message})`;
  }
  if (!changed.length) return null;
  const shown = changed.slice(0, 5).map((p) => JSON.stringify(p)).join(', ');
  return `the checkout's agent settings or instructions (${shown}${changed.length > 5 ? ` and ${changed.length - 5} more` : ''}) differ from its last commit or aren't in it: written by a setup step or a command since, a run would load them, and a hook there would run outside the sandbox`;
}

/** The first `.git` (a folder, a file or a link) from `cwd` up to `/`, or null when there is none. */
function gitEntryAbove(cwd: string): string | null {
  let dir = cwd;
  for (let n = 0; n < 256; n++) {
    try {
      lstatSync(join(dir, '.git'));
      return join(dir, '.git');
    } catch {
      // none here
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
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

/** HEAD's tree, every entry: path to its mode and object (`ls-tree -r -z`, read by the one name reader's rules). */
function headEntries(root: string): Map<string, { mode: string; sha: string }> {
  const r = gitSpawnSync(['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { cwd: root, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-tree HEAD failed: ${r.stderr.toString('utf8').trim().slice(0, 300)}`);
  const out = new Map<string, { mode: string; sha: string }>();
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab === -1) continue;
    const [mode, , sha] = rec.slice(0, tab).split(' ');
    out.set(rec.slice(tab + 1), { mode: mode!, sha: sha! });
  }
  return out;
}

/** A blob's bytes at HEAD. */
function blob(root: string, sha: string): Buffer {
  const r = gitSpawnSync(['cat-file', 'blob', sha], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git cat-file ${sha} failed`);
  return r.stdout;
}

/**
 * Each of HEAD's entries `agent` picks whose file on disk isn't HEAD's (D4): the bytes, or a link's target text, read
 * directly, so an index flag or a refresh can't make git look away. Missing on disk: a change, unless a sparse checkout
 * left it out (flagged). A submodule is skipped.
 */
function trackedDiffer(root: string, head: Map<string, { mode: string; sha: string }>, agent: (p: string) => boolean): string[] {
  const out: string[] = [];
  const sparse = new Set(lookAwayNames(root));
  for (const [p, e] of head) {
    if (!agent(p) || e.mode === '160000') continue;
    let st;
    try {
      st = lstatSync(join(root, p));
    } catch {
      // Gone from disk: a sparse checkout's left-out file (flagged) loads nothing (R1185f L1); one deleted outright is
      // a change (R1185g G5).
      if (!sparse.has(p)) out.push(p);
      continue;
    }
    if (e.mode === '120000') {
      if (!st.isSymbolicLink() || readlinkSync(join(root, p)) !== blob(root, e.sha).toString('utf8')) out.push(p);
    } else if (!st.isFile() || !sameText(blob(root, e.sha), readFileSync(join(root, p)))) out.push(p);
  }
  return out;
}

/** Each tracked path `agent` picks that git is told to look away from (skip-worktree, assume-unchanged: lookAwayNames). */
function hiddenFromGit(root: string, agent: (p: string) => boolean): string[] {
  // Only a file that is there: a sparse checkout flags the files it leaves out (R1185f L1), and those load nothing.
  return lookAwayNames(root).filter((p) => {
    if (!agent(p)) return false;
    try {
      lstatSync(join(root, p));
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Each `.claude` from the top down to `cwd`, and each link under one, that may hold what HEAD doesn't (D1, D5).
 * `refused`: a `.claude` that isn't a folder (an empty file is a sandbox mount point: allowed), and a link that HEAD
 * doesn't hold as the same link, or whose target is outside the checkout, isn't there, or holds what HEAD doesn't
 * (changed, untracked or ignored files, not counting empty placeholders, or a link of its own refused the same way).
 * `targets`: each committed link's target in the checkout, whose tracked files are then compared too.
 */
function linkedClaudeDirs(root: string, cwd: string, head: Map<string, { mode: string; sha: string }>, placeholder: (p: string) => boolean): { refused: string[]; targets: string[] } {
  const refused: string[] = [];
  const targets: string[] = [];
  const realRoot = realpathSync(root);
  const visited = new Set<string>();
  let seen = 0;
  const inside = (rel: string) => rel && !rel.startsWith('..') && !rel.startsWith(sep);
  // A link at `p`: allowed only as HEAD holds it, its target inside, and that target holding nothing HEAD doesn't.
  const link = (p: string) => {
    const e = head.get(p);
    let target: string;
    try {
      if (e?.mode !== '120000' || readlinkSync(join(root, p)) !== blob(root, e.sha).toString('utf8')) throw new Error('not as committed');
      target = relative(realRoot, realpathSync(join(root, p)));
    } catch {
      refused.push(p);
      return;
    }
    if (!inside(target)) {
      refused.push(p);
      return;
    }
    const t = target.split(sep).join('/');
    // Where its committed text says, read as text from its folder: the same place as where it leads, or a folder on
    // the way was swapped for a link (R1185g G4: `config` -> `examples`, so `../config/claude.json` lands elsewhere).
    const lexical = normalize(join(dirname(p), readlinkSync(join(root, p)))).split(sep).join('/');
    if (lexical !== t) {
      refused.push(p);
      return;
    }
    targets.push(t);
    if (!lstatSync(join(root, t)).isDirectory()) {
      // A file target must be one HEAD holds as a regular file (R1185f D6/F2), so its bytes are compared with HEAD's.
      const te = head.get(t);
      if (!te || (te.mode !== '100644' && te.mode !== '100755')) refused.push(p);
    } else {
      const extra = [...untrackedNames(root, [t]).filter((x) => !placeholder(x)), ...ignoredNames(root, [t]).filter((x) => !placeholder(x))];
      if (extra.length) refused.push(p);
      walk(t);
    }
  };
  const walk = (dir: string) => {
    const real = realpathSync(join(root, dir));
    if (visited.has(real)) return;
    visited.add(real);
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (p === '.claude/worktrees') continue;
      if (++seen > MAX_CLAUDE_DIR_ENTRIES) throw new Error(`over ${MAX_CLAUDE_DIR_ENTRIES} entries under .claude`);
      if (e.isSymbolicLink()) link(p);
      else if (e.isDirectory()) walk(p);
      // Not a file, a folder or a link (a FIFO, a socket, a device, R1185h H12): nothing a run should open.
      else if (!e.isFile()) refused.push(p);
    }
  };
  for (const folder of foldersDown(root, cwd)) {
    const rel = folder ? `${folder}/.claude` : '.claude';
    let st;
    try {
      st = lstatSync(join(root, rel));
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) link(rel);
    else if (st.isDirectory()) walk(rel);
    // An empty regular file is a sandbox mount point (D2): nothing loads from it.
    else if (!(st.isFile() && st.size === 0)) refused.push(rel);
  }
  return { refused, targets };
}

/**
 * Each instruction file Claude Code loads up front (LOADED_INSTRUCTIONS, from the top down to `cwd`) whose bytes aren't
 * HEAD's (D3): compared directly, whatever ignore rules say (line endings aside, R1185f L2). Through a link, the target's
 * bytes against HEAD's at the target's path, which must be in the checkout. An empty, untracked file is a placeholder
 * (D2). Missing: it loads nothing. Each `@` import (also from `.claude/rules/**/*.md`, R1185g G1) in one (R1185f F6) is read the same way, MAX_IMPORT_DEPTH deep: one
 * outside the checkout refuses, since nothing compares it.
 */
function loadedInstructionsChanged(root: string, cwd: string): string[] {
  const out: string[] = [];
  const realRoot = realpathSync(root);
  const visited = new Set<string>();
  for (const folder of foldersDown(root, cwd)) {
    for (const name of LOADED_INSTRUCTIONS) instructionChanged(root, realRoot, folder ? `${folder}/${name}` : name, 0, visited, out);
    // `.claude/rules/**/*.md`, which Claude Code loads too, with their imports (R1185g G1).
    const rules = folder ? `${folder}/.claude/rules` : '.claude/rules';
    let found: string[] = [];
    try {
      found = readdirSync(join(root, rules), { recursive: true }).map((x) => String(x).split(sep).join('/')).filter((x) => /\.md$/i.test(x));
    } catch {
      found = [];
    }
    for (const f of found.sort()) instructionChanged(root, realRoot, `${rules}/${f}`, 0, visited, out);
  }
  return out;
}

/** instructionChanged's reading of one file at `rel` (from the checkout's top), then of its imports; names go in `out`. */
function instructionChanged(root: string, realRoot: string, rel: string, depth: number, visited: Set<string>, out: string[]): void {
  if (visited.has(rel)) return;
  visited.add(rel);
  let st;
  try {
    st = lstatSync(join(root, rel));
  } catch {
    return;
  }
  let at = rel;
  if (st.isSymbolicLink()) {
    let target: string;
    try {
      target = relative(realRoot, realpathSync(join(root, rel)));
    } catch {
      out.push(rel); // a dangling link: refused rather than guessed
      return;
    }
    if (!target || target.startsWith('..') || target.startsWith(sep)) {
      out.push(rel); // outside the checkout: never compared
      return;
    }
    at = target.split(sep).join('/');
    st = lstatSync(join(root, at));
  }
  if (!st.isFile()) {
    out.push(rel);
    return;
  }
  const bytes = readFileSync(join(root, at));
  const head = gitSpawnSync(['cat-file', 'blob', `HEAD:${at}`], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (head.status !== 0) {
    if (st.size > 0) out.push(rel); // not in HEAD, and not empty
    return;
  }
  if (!sameText(head.stdout, bytes)) {
    out.push(rel);
    return;
  }
  if (depth >= MAX_IMPORT_DEPTH) return;
  // Its imports: `@path` at a word's start, outside code (fenced blocks and backticks left out), as Claude Code reads them.
  // As Claude Code reads them (R1185h H9-H11): code and HTML comments left out; the token is every non-space character
  // (with `\\ ` as a space), cut at `#`, nothing stripped from its end.
  const text = bytes.toString('utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const dir = at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : '';
  for (const m of text.matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/g)) {
    const spec = m[1]!.split('#')[0]!.replace(/\\ /g, ' ');
    if (!spec) continue;
    // Outside the checkout (`~/`, `/`, `..` past the top): nothing compares it, so one that is there refuses. One that
    // isn't loads nothing (R1185g G2: a per-developer `@~/.claude/...` import, an `@/alias` in prose).
    const outsideFile = (abs: string) => {
      try {
        lstatSync(abs);
        out.push(`${rel} imports ${spec} (outside the checkout, and it is there)`);
      } catch {
        // not there: it loads nothing
      }
    };
    if (spec.startsWith('~/')) {
      for (const h of new Set([process.env.HOME, homedir()].filter((x): x is string => !!x))) outsideFile(join(h, spec.slice(2)));
      continue;
    }
    if (spec.startsWith('/')) {
      outsideFile(spec);
      continue;
    }
    const parts = dir ? dir.split('/') : [];
    let outside = false;
    for (const seg of spec.split('/')) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') outside = parts.pop() === undefined || outside;
      else parts.push(seg);
    }
    if (outside || !parts.length) {
      outsideFile(join(root, dir, spec));
      continue;
    }
    instructionChanged(root, realRoot, parts.join('/'), depth + 1, visited, out);
  }
}

/**
 * The instruction files Claude Code loads from folders above this checkout (R1185f F3: from every parent folder, up to
 * `/`): each such folder inside another checkout (a task worktree under the main checkout's `.claude/worktrees/`) has
 * its CLAUDE.md and .claude/CLAUDE.md compared with that checkout's HEAD, as this checkout's are. Named from this
 * checkout's top. A folder in no checkout isn't read (a machine's or a user's own files, as ~/.claude/CLAUDE.md).
 */
function ancestorsChanged(root: string): string[] {
  const out: string[] = [];
  let dir = dirname(root);
  for (let n = 0; n < 64 && dir !== dirname(dir); n++) {
    const top = gitSpawnSync(['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
    if (top.status !== 0 || !top.stdout.trim()) {
      dir = dirname(dir);
      continue;
    }
    const outer = top.stdout.trim();
    for (const p of loadedInstructionsChanged(outer, dir)) out.push(relative(root, join(outer, p.replace(/ imports .*$/, ''))) + (p.includes(' imports ') ? p.slice(p.indexOf(' imports ')) : ''));
    dir = dirname(outer);
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
