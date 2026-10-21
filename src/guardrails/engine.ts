// Guardrail evaluation for one tool call. Precedence matches Claude Code's
// own permissions: deny > ask > (no objection). "none" means the hook says
// nothing and the normal permission flow continues; the engine never returns
// "allow", because a hook's allow would bypass the user's own prompts.
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { GuardrailsConfig, Rule } from '../config/schema.js';
import { basename, splitCommands, type SimpleCommand } from './shell.js';
import { connectionsIn, fingerprint } from './fingerprint.js';
import { globToRegExp } from './glob.js';
import { pushHookFileRefusal, pushHookShellRefusal } from './push-hook.js';
import { callAccesses, Secrets } from './access.js';
import { asWritten, hardLinked, Reach } from './reach.js';
import { BRAND } from '../brand.js';

/**
 * Harness config no agent writes, whatever a project's guardrails list (there's no opt-out): the config folder, and
 * everything under .claude/ (settings, skills, commands, agents, hooks), which Claude Code itself reads.
 */
// check-table: never-shrink
export const BUILTIN_PROTECTED = [`${BRAND.configDir}/**`, '.claude/**'];

/**
 * Under the config folder, the only paths agents may write: the agents' own role prompts and skills (a correction
 * lands there). A change to them is always high-risk and never auto-merges (review.ts AGENT_INSTRUCTIONS).
 */
// check-table: never-grow
export const AGENT_EDITABLE = [`${BRAND.configDir}/roles/**`, `${BRAND.configDir}/skills/**`];

/** WHY: item 33; an AGENTS.md line comes only from an owner promoting a learning (src/learnings.ts), never an agent. */
export const AGENTS_MD_PATHS = ['AGENTS.md', '**/AGENTS.md'];

const BUILTIN_RES = BUILTIN_PROTECTED.map((g) => globToRegExp(g));
const AGENTS_MD_RES = AGENTS_MD_PATHS.map((g) => globToRegExp(g));
const EDITABLE_RES = AGENT_EDITABLE.map((g) => globToRegExp(g));
/** A path, or a directory that holds it: `.claude` counts as under `.claude/**`. */
const under = (res: RegExp[], rel: string) => res.some((re) => re.test(rel) || re.test(`${rel}/`));

/**
 * May an agent not write this path (relative to the project root; a directory counts for what's under it)? The
 * built-in paths always apply, except the agents' own instructions. A project's own list can only add to them;
 * its catch-all for the config folder (the template's) is the built-in rule now, so it doesn't take the agents'
 * instructions away from them.
 */
export function isProtectedPath(rel: string, g: Pick<GuardrailsConfig, 'protected_paths'>): boolean {
  if (under(BUILTIN_RES, rel) && !under(EDITABLE_RES, rel)) return true;
  if (AGENTS_MD_RES.some((re) => re.test(rel))) return true;
  const own = g.protected_paths.filter((p) => p.replace(/^\.\//, '') !== `${BRAND.configDir}/**`).map((p) => globToRegExp(p));
  return under(own, rel);
}

export type Decision = 'deny' | 'ask' | 'none';

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
}

export interface EvalContext {
  projectRoot: string;
  /** Headless agent run (set by the coordinator) vs a human's interactive session. */
  agent: boolean;
  env: Record<string, string | undefined>;
  /** Fingerprint set name -> hashes. A missing set means "unknown", not "empty". */
  fingerprints: Record<string, Set<string> | undefined>;
  /** Home directory, for "~/" secret paths. */
  home?: string;
  /** Linked environment for a CLI in a directory, or null if unknown. */
  linkedEnvironment(resolver: string, cwd: string): string | null;
}

export interface Verdict {
  decision: Decision;
  rule?: string;
  reason?: string;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function filePathOf(call: ToolCall): string | null {
  const p = call.input.file_path ?? call.input.notebook_path ?? call.input.path ?? call.input.pattern_path;
  return typeof p === 'string' ? p : null;
}

function relToRoot(root: string, cwd: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  return relative(root, abs).split('\\').join('/');
}

/**
 * A path a call names, as the guard judges it. `rels`: relative to the project root, the name as given and the file it
 * reaches; `reached`: that file's absolute path; `unresolved`: where it leads can't be told (the call is refused).
 */
interface Names {
  rels: string[];
  reached: string[];
  unresolved: boolean;
}

/**
 * One call's paths, judged by the file each one reaches as well as by its name. WHY (#972): protected-path checks
 * decide on the file a write really reaches. Both readings of a path's `..` are resolved: as written, the way the file
 * system takes it, and tidied first, the way a tool may take it.
 */
class Paths {
  private readonly reach = new Reach();
  private readonly realRoot: string | null;

  constructor(private readonly root: string) {
    this.realRoot = this.reach.of(resolve(root));
  }

  private readonly seen = new Map<string, Names>();

  names(p: string, base: string): Names {
    const key = `${base}\0${p}`;
    const known = this.seen.get(key);
    if (known) return known;
    const n = this.judge(p, base);
    this.seen.set(key, n);
    return n;
  }

  private judge(p: string, base: string): Names {
    const rels = [relToRoot(this.root, base, p)];
    const reached: string[] = [];
    let unresolved = this.realRoot === null;
    for (const w of new Set([asWritten(resolve(base), p), isAbsolute(p) ? p : resolve(base, p)])) {
      const r = this.reach.of(w);
      if (r === null) {
        unresolved = true;
        continue;
      }
      reached.push(r);
      if (this.realRoot !== null) rels.push(relative(this.realRoot, r).split('\\').join('/'));
    }
    return { rels, reached, unresolved };
  }
}

/** A path as a reason names it: its start and its length, when it is long. */
const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}... (${s.length} characters)` : s);

/** The paths an Edit tool or a shell command's parsed writes name. */
function writeTargets(call: ToolCall, commands: SimpleCommand[]): string[] {
  const targets: string[] = [];
  if (EDIT_TOOLS.has(call.tool)) {
    const p = filePathOf(call);
    if (p) targets.push(p);
  }
  for (const c of commands) targets.push(...c.writes);
  return targets;
}

/** A command's long options and whether each takes a value: the next word or after `=` (required), or only after `=`. */
type LongOptions = Readonly<Record<string, 'none' | 'optional' | 'required'>>;
/** GNU cp's long options (coreutils 9). */
const CP_LONG: LongOptions = {
  archive: 'none', 'attributes-only': 'none', backup: 'optional', context: 'optional', 'copy-contents': 'none', debug: 'none', dereference: 'none',
  force: 'none', help: 'none', interactive: 'none', 'keep-directory-symlink': 'none', link: 'none', 'no-clobber': 'none', 'no-dereference': 'none',
  'no-preserve': 'required', 'no-target-directory': 'none', 'one-file-system': 'none', parents: 'none', preserve: 'optional', recursive: 'none',
  reflink: 'optional', 'remove-destination': 'none', sparse: 'required', 'strip-trailing-slashes': 'none', suffix: 'required', 'symbolic-link': 'none',
  'target-directory': 'required', update: 'optional', verbose: 'none', version: 'none',
};
/** GNU ln's long options (coreutils 9). */
const LN_LONG: LongOptions = {
  backup: 'optional', directory: 'none', force: 'none', help: 'none', interactive: 'none', logical: 'none', 'no-dereference': 'none',
  'no-target-directory': 'none', physical: 'none', relative: 'none', suffix: 'required', symbolic: 'none', 'target-directory': 'required',
  verbose: 'none', version: 'none',
};
/** cp's and ln's short options that take a value: the rest of their cluster, or the next word. */
const SHORT_WITH_VALUE = new Set(['S', 't']);

interface ReadArgs {
  opts: { name: string; value: string | undefined }[];
  operands: string[];
  /** The first long option that names none of the command's, or more than one: the guard can't tell what it does. */
  unknown?: string;
}

/**
 * A command's arguments as GNU getopt_long reads them: a long option by its name or any prefix that names only it,
 * short options clustered, options among the operands, and everything after `--` an operand.
 */
function readArgs(args: string[], longs: LongOptions): ReadArgs {
  const out: ReadArgs = { opts: [], operands: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      out.operands.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const given = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const hits = Object.hasOwn(longs, given) ? [given] : Object.keys(longs).filter((n) => given && n.startsWith(given));
      if (hits.length !== 1) {
        out.unknown ??= a;
        continue;
      }
      const name = hits[0]!;
      out.opts.push({ name, value: eq >= 0 ? a.slice(eq + 1) : longs[name] === 'required' ? args[++i] : undefined });
    } else if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j]!;
        if (SHORT_WITH_VALUE.has(c)) {
          out.opts.push({ name: c, value: j + 1 < a.length ? a.slice(j + 1) : args[++i] });
          break;
        }
        out.opts.push({ name: c, value: undefined });
      }
    } else out.operands.push(a);
  }
  return out;
}

/**
 * What a command that makes a link (ln, link, cp with a link option, rsync --link-dest) links to, and where the new
 * links go; `unreadable` when a cp or ln option can't be read (refused: it might make one); null for any other command.
 */
function linkMade(c: SimpleCommand): { sources: string[]; dest: string | null } | { unreadable: string } | null {
  const [cmd, ...args] = c.argv;
  const base = basename(cmd ?? '');
  if (base === 'link') return { sources: args.filter((a) => !a.startsWith('-')), dest: null };
  if (base === 'cp' || base === 'ln') {
    const read = readArgs(args, base === 'cp' ? CP_LONG : LN_LONG);
    if (read.unknown !== undefined) return { unreadable: read.unknown };
    if (base === 'cp' && !read.opts.some((o) => ['link', 'symbolic-link', 'l', 's'].includes(o.name))) return null;
    const target = read.opts.findLast((o) => o.name === 'target-directory' || o.name === 't');
    const { operands } = read;
    if (target) return { sources: operands, dest: target.value ?? null };
    return operands.length < 2 ? { sources: operands, dest: null } : { sources: operands.slice(0, -1), dest: operands.at(-1)! };
  }
  if (base === 'rsync') {
    // Exact, and any prefix that can only mean it (`--link-`, `--link-d`...), for an rsync that takes one.
    const sources: string[] = [];
    args.forEach((a, i) => {
      if (!a.startsWith('--')) return;
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (name.length < 'link-'.length || !'link-dest'.startsWith(name)) return;
      const value = eq >= 0 ? a.slice(eq + 1) : args[i + 1];
      if (value !== undefined) sources.push(value);
    });
    const operands = args.filter((a) => !a.startsWith('-'));
    return sources.length ? { sources, dest: operands.at(-1) ?? null } : null;
  }
  return null;
}

function optionValue(argv: string[], flags: string[]): string | null | undefined {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    for (const f of flags) {
      if (a === f) return argv[i + 1] ?? null;
      if (a.startsWith(f + '=')) return a.slice(f.length + 1);
    }
  }
  return undefined;
}

function matchesCliEnv(m: Extract<Rule['match'], { cli_env: unknown }>['cli_env'], cmd: SimpleCommand, cwd: string, ctx: EvalContext): boolean {
  const argv = cmd.argv;
  if (!argv.length || basename(argv[0]!) !== m.cli) return false;
  const positional = argv.slice(1).filter((a) => !a.startsWith('-'));
  if (m.subcommands.length && !m.subcommands.includes(positional[0] ?? '')) return false;
  const has = (f: string) => argv.some((a) => a === f || a.startsWith(f + '='));
  if (m.flags_any.length && !m.flags_any.some(has)) return false;
  if (m.flags_none.some(has)) return false;
  let env: string | null | undefined = optionValue(argv, m.env_flags);
  if (env === undefined && m.resolver !== 'none') env = ctx.linkedEnvironment(m.resolver, cwd);
  if (env === undefined || env === null) return m.unresolved === 'match';
  return m.environments.includes(env);
}

function ruleMatches(rule: Rule, call: ToolCall, commands: SimpleCommand[], ctx: EvalContext, paths: () => Paths): boolean {
  const m = rule.match;
  const unless = rule.unless ? new RegExp(rule.unless.pattern) : null;
  if ('path' in m) {
    const res = m.path.globs.map((g) => globToRegExp(g));
    // The name given and the file reached (#972): a path rule matches either.
    return writeTargets(call, commands).some((t) => paths().names(t, call.cwd).rels.some((rel) => res.some((re) => re.test(rel))));
  }
  if (call.tool !== 'Bash') return false;
  for (const c of commands) {
    const line = [...Object.entries(c.assignments).map(([k, v]) => `${k}=${v}`), ...c.argv].join(' ');
    if (unless?.test(line)) continue;
    if ('command' in m && new RegExp(m.command.pattern).test(line)) return true;
    if ('cli_env' in m && matchesCliEnv(m.cli_env, c, call.cwd, ctx)) return true;
    if ('connection' in m) {
      const set = ctx.fingerprints[m.connection.fingerprints];
      const env = { ...ctx.env, ...c.assignments };
      const conns = connectionsIn(line, env);
      if (!conns.length) continue;
      // Unknown set: we can't tell prod from anything else, so treat any DB URL as a match.
      if (!set) return true;
      if (conns.some((x) => set.has(fingerprint(x) ?? ''))) return true;
    }
  }
  return false;
}

const IDENTITY_VAR = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)$/;
const IDENTITY_KEY = /^(user|author|committer)\.(name|email)$/i;

/** Does this command pick a commit identity: env vars, git -c, git config, or --author? */
function setsCommitIdentity(c: SimpleCommand): boolean {
  if (Object.keys(c.assignments).some((k) => IDENTITY_VAR.test(k))) return true;
  const a = c.argv;
  // export/env/declare GIT_AUTHOR_NAME=...
  if (a.some((t) => IDENTITY_VAR.test(t.split('=')[0]!) && t.includes('='))) return true;
  if (basename(a[0] ?? '') !== 'git') return false;
  // Global options first: -c key=value (an identity key is enough), -C dir, and the like.
  let i = 1;
  for (; i < a.length && a[i]!.startsWith('-'); i++) {
    const opt = a[i]!;
    if (opt === '-c' || opt === '-C') {
      if (opt === '-c' && IDENTITY_KEY.test((a[i + 1] ?? '').split('=')[0]!)) return true;
      i++;
    } else if (/^-c(user|author|committer)\./i.test(opt)) return true;
  }
  const sub = a[i];
  const rest = a.slice(i + 1);
  if (sub === 'commit' && rest.some((t) => /^--author(=|$)/.test(t))) return true;
  // git config user.name X (a write); reading it (--get, --list) is fine.
  if (sub === 'config' && rest.some((t) => IDENTITY_KEY.test(t)) && !rest.some((t) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(t))) return true;
  return false;
}

/** Whether a host is on an allowlist: exact names, or `*.example.org` for it and its subdomains. */
export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase();
  return allow.some((d) => {
    const a = d.toLowerCase();
    return a.startsWith('*.') ? h.endsWith(a.slice(1)) || h === a.slice(2) : h === a;
  });
}

export function evaluate(call: ToolCall, cfg: GuardrailsConfig, ctx: EvalContext): Verdict {
  const commands = call.tool === 'Bash' && typeof call.input.command === 'string' ? splitCommands(call.input.command) : [];
  let ask: Verdict | null = null;
  const mode = ctx.agent ? 'agent' : 'interactive';
  // Made on first use: a call that names no path to write touches no file here.
  let callPaths: Paths | undefined;
  const paths = () => (callPaths ??= new Paths(ctx.projectRoot));

  for (const rule of cfg.rules) {
    if (!rule.applies_to.includes(mode)) continue;
    if (!ruleMatches(rule, call, commands, ctx, paths)) continue;
    if (rule.action === 'block') return { decision: 'deny', rule: rule.id, reason: rule.reason };
    ask ??= { decision: 'ask', rule: rule.id, reason: rule.reason };
  }

  // Everything below is agent-only. Human sessions get only the rules above
  // (the dangerous-action blocks and asks); no harness-edit block, no secret
  // file block, no domain allowlist.
  if (!ctx.agent) return ask ?? { decision: 'none' };

  // Harness files: agents may not write them. WHY (#972): the check decides on the file a write really reaches as well
  // as on the name it is given, and refuses a write when it can't tell which file that is. That refusal (`unsure`)
  // comes after the other checks, so a write they refuse is refused for their reason.
  const targets = writeTargets(call, commands);
  let unsure: Verdict | null = null;
  {
    const judged = targets.map((t) => ({ t, n: paths().names(t, call.cwd) }));
    // A target may be a directory (rm -rf .claude, mv x .claude): it matches if anything under it would.
    for (const { t, n } of judged) {
      const rel = n.rels.find((r) => isProtectedPath(r, cfg));
      if (rel === undefined) continue;
      if (AGENTS_MD_RES.some((re) => re.test(rel))) {
        return { decision: 'deny', rule: 'agents-md', reason: `${t}: agents never write AGENTS.md; a line reaches it only when an owner promotes a learning on the dashboard` };
      }
      return { decision: 'deny', rule: 'protected-path', reason: `${t} is harness config; change it through a reviewed proposal` };
    }
    for (const { t, n } of judged) {
      if (n.unresolved) unsure ??= { decision: 'deny', rule: 'protected-path', reason: `${clip(t)}: the guard can't tell which file this write reaches, so it can't check it isn't harness config; write to a plain path in the project` };
      else if (n.reached.some(hardLinked)) unsure ??= { decision: 'deny', rule: 'protected-path', reason: `${clip(t)} has more than one hard link, so a write to it changes a file the guard can't check by this name; agents write only files with one name` };
    }
    // A link that leads to harness config: whatever later writes through it, an agent never makes one. A link's own
    // text may be read from the folder the link is made in, so each source is judged from the call's directory and
    // from the destination's (as a folder, and the folder it is in).
    for (const c of commands) {
      const link = linkMade(c);
      if (!link) continue;
      if ('unreadable' in link) {
        unsure ??= { decision: 'deny', rule: 'protected-path', reason: `${basename(c.argv[0] ?? '')}: the guard can't read the option ${clip(link.unreadable)}, so it can't check what the command links or writes; spell each option out in full` };
        continue;
      }
      const dest = link.dest === null ? null : resolve(call.cwd, link.dest);
      const bases = [...new Set([resolve(call.cwd), ...(dest === null ? [] : [dest, dirname(dest)])])];
      for (const o of link.sources) {
        for (const base of bases) {
          const n = paths().names(o, base);
          if (n.rels.some((r) => isProtectedPath(r, cfg))) return { decision: 'deny', rule: 'protected-path', reason: `${clip(o)} is harness config; agents never make a link to it` };
          if (n.unresolved) unsure ??= { decision: 'deny', rule: 'protected-path', reason: `${clip(o)}: the guard can't tell which file a link to this leads to, so it can't check it isn't harness config` };
        }
      }
    }
  }

  // WHY: the push gate's first-time-setup hatch and git's pre-push hook are a person's, never an agent's (push-hook.ts).
  {
    const abs = (t: string) => (isAbsolute(t) ? t : resolve(call.cwd, t));
    const p = EDIT_TOOLS.has(call.tool) ? filePathOf(call) : null;
    const refusal = (p ? pushHookFileRefusal(p, abs(p), call.input) : null) ?? (call.tool === 'Bash' && typeof call.input.command === 'string' ? pushHookShellRefusal(call.input.command, commands, abs) : null);
    if (refusal) return { decision: 'deny', rule: refusal.rule, reason: refusal.reason };
    // The same files judged by the file each write reaches (#972).
    for (const t of targets) {
      for (const r of paths().names(t, call.cwd).reached) {
        const hit = pushHookFileRefusal(t, r, t === p ? call.input : {});
        if (hit) return { decision: 'deny', rule: hit.rule, reason: hit.reason };
      }
    }
  }

  // Commit identity: the harness sets it; an agent never commits as anyone it chooses.
  if (commands.some(setsCommitIdentity)) {
    return { decision: 'deny', rule: 'commit-identity', reason: 'commits carry the harness identity, already set in your environment; commit without setting an author, committer or user.name/user.email' };
  }

  // Secret files (a task's hidden paths among them): agents may not read, list, search or write them, by any tool or
  // shell argument. WHY (#847): every tool's paths come from one classification (access.ts), so none is checked for
  // Read only, and a tool the guard doesn't know is checked on all it is given.
  if (cfg.secret_paths.length) {
    // One instance per call: its walks share one budget. Paths first, so a cheap refusal never waits on a walk.
    const secrets = new Secrets(cfg.secret_paths, ctx);
    const accesses = callAccesses(call.tool, call.input, call.cwd, commands);
    for (const a of [...accesses.filter((x) => x.kind !== 'tree'), ...accesses.filter((x) => x.kind === 'tree')]) {
      const why = secrets.reached(a, call.cwd, call.tool);
      if (why) return { decision: 'deny', rule: 'secret-path', reason: why };
    }
  }

  if (unsure) return unsure;

  // Network: agents may only fetch allowlisted domains; new ones need approval.
  if (call.tool === 'WebFetch' && typeof call.input.url === 'string') {
    let host = '';
    try {
      host = new URL(call.input.url).hostname;
    } catch {
      return { decision: 'deny', rule: 'network', reason: 'unparseable URL' };
    }
    if (!hostAllowed(host, cfg.network.allow)) {
      return { decision: 'deny', rule: 'network', reason: `${host} is not on the network allowlist; request approval to add it` };
    }
  }

  return ask ?? { decision: 'none' };
}
