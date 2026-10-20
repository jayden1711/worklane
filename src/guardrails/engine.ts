// Guardrail evaluation for one tool call. Precedence matches Claude Code's
// own permissions: deny > ask > (no objection). "none" means the hook says
// nothing and the normal permission flow continues; the engine never returns
// "allow", because a hook's allow would bypass the user's own prompts.
import { isAbsolute, relative, resolve } from 'node:path';
import type { GuardrailsConfig, Rule } from '../config/schema.js';
import { basename, splitCommands, type SimpleCommand } from './shell.js';
import { connectionsIn, fingerprint } from './fingerprint.js';
import { globToRegExp } from './glob.js';
import { pushHookFileRefusal, pushHookShellRefusal } from './push-hook.js';
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
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);

/**
 * Secret globs: "~/" is the home directory, "./" or a bare path the project
 * root, "/" absolute. A leading "!" excludes (e.g. "!./.env.example").
 */
function matchesSecret(globs: string[], target: string, cwd: string, ctx: EvalContext): boolean {
  const expanded = target.startsWith('~/') && ctx.home ? resolve(ctx.home, target.slice(2)) : target;
  const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  const one = (g: string) => matchesSecretGlob(g, abs, cwd, ctx);
  return globs.some((g) => !g.startsWith('!') && one(g)) && !globs.some((g) => g.startsWith('!') && one(g.slice(1)));
}

function matchesSecretGlob(g: string, abs: string, cwd: string, ctx: EvalContext): boolean {
  {
    if (g.startsWith('~/')) {
      if (!ctx.home) return false;
      const rel = relative(ctx.home, abs).split('\\').join('/');
      return !rel.startsWith('..') && globToRegExp(g.slice(2)).test(rel);
    }
    if (isAbsolute(g)) return globToRegExp(g.slice(1)).test(abs.split('\\').join('/').replace(/^\//, ''));
    return globToRegExp(g).test(relToRoot(ctx.projectRoot, cwd, abs));
  }
}

function filePathOf(call: ToolCall): string | null {
  const p = call.input.file_path ?? call.input.notebook_path ?? call.input.path ?? call.input.pattern_path;
  return typeof p === 'string' ? p : null;
}

function relToRoot(root: string, cwd: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  return relative(root, abs).split('\\').join('/');
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

function ruleMatches(rule: Rule, call: ToolCall, commands: SimpleCommand[], ctx: EvalContext): boolean {
  const m = rule.match;
  const unless = rule.unless ? new RegExp(rule.unless.pattern) : null;
  if ('path' in m) {
    const res = m.path.globs.map((g) => globToRegExp(g));
    const targets: string[] = [];
    if (EDIT_TOOLS.has(call.tool)) {
      const p = filePathOf(call);
      if (p) targets.push(p);
    }
    for (const c of commands) targets.push(...c.writes);
    return targets.some((t) => res.some((re) => re.test(relToRoot(ctx.projectRoot, call.cwd, t))));
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

  for (const rule of cfg.rules) {
    if (!rule.applies_to.includes(mode)) continue;
    if (!ruleMatches(rule, call, commands, ctx)) continue;
    if (rule.action === 'block') return { decision: 'deny', rule: rule.id, reason: rule.reason };
    ask ??= { decision: 'ask', rule: rule.id, reason: rule.reason };
  }

  // Everything below is agent-only. Human sessions get only the rules above
  // (the dangerous-action blocks and asks); no harness-edit block, no secret
  // file block, no domain allowlist.
  if (!ctx.agent) return ask ?? { decision: 'none' };

  // Harness files: agents may not write them.
  {
    const targets: string[] = [];
    if (EDIT_TOOLS.has(call.tool)) {
      const p = filePathOf(call);
      if (p) targets.push(p);
    }
    for (const c of commands) targets.push(...c.writes);
    // A target may be a directory (rm -rf .claude, mv x .claude): it matches if anything under it would.
    const hit = targets.find((t) => isProtectedPath(relToRoot(ctx.projectRoot, call.cwd, t), cfg));
    if (hit && AGENTS_MD_RES.some((re) => re.test(relToRoot(ctx.projectRoot, call.cwd, hit)))) {
      return { decision: 'deny', rule: 'agents-md', reason: `${hit}: agents never write AGENTS.md; a line reaches it only when an owner promotes a learning on the dashboard` };
    }
    if (hit) return { decision: 'deny', rule: 'protected-path', reason: `${hit} is harness config; change it through a reviewed proposal` };
  }

  // WHY: the push gate's first-time-setup hatch and git's pre-push hook are a person's, never an agent's (push-hook.ts).
  {
    const abs = (t: string) => (isAbsolute(t) ? t : resolve(call.cwd, t));
    const p = EDIT_TOOLS.has(call.tool) ? filePathOf(call) : null;
    const refusal = (p ? pushHookFileRefusal(p, abs(p), call.input) : null) ?? (call.tool === 'Bash' && typeof call.input.command === 'string' ? pushHookShellRefusal(call.input.command, commands, abs) : null);
    if (refusal) return { decision: 'deny', rule: refusal.rule, reason: refusal.reason };
  }

  // Commit identity: the harness sets it; an agent never commits as anyone it chooses.
  if (commands.some(setsCommitIdentity)) {
    return { decision: 'deny', rule: 'commit-identity', reason: 'commits carry the harness identity, already set in your environment; commit without setting an author, committer or user.name/user.email' };
  }

  // Secret files: agents may not read or write them, by tool or by shell argument.
  if (cfg.secret_paths.length) {
    const candidates: string[] = [];
    const p = filePathOf(call);
    if (p && (READ_TOOLS.has(call.tool) || EDIT_TOOLS.has(call.tool))) candidates.push(p);
    for (const c of commands) candidates.push(...c.argv.slice(1).filter((a) => !a.startsWith('-')), ...c.writes);
    const hit = candidates.find((t) => matchesSecret(cfg.secret_paths, t, call.cwd, ctx));
    if (hit) return { decision: 'deny', rule: 'secret-path', reason: `${hit} holds credentials; agents never read them` };
  }

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
