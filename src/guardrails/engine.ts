// Guardrail evaluation for one tool call. Precedence matches Claude Code's
// own permissions: deny > ask > (no objection). "none" means the hook says
// nothing and the normal permission flow continues; the engine never returns
// "allow", because a hook's allow would bypass the user's own prompts.
import { isAbsolute, relative, resolve } from 'node:path';
import type { GuardrailsConfig, Rule } from '../config/schema.js';
import { basename, splitCommands, type SimpleCommand } from './shell.js';
import { connectionsIn, fingerprint } from './fingerprint.js';
import { globToRegExp } from './glob.js';

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

function hostAllowed(host: string, allow: string[]): boolean {
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
  if (cfg.protected_paths.length) {
    const res = cfg.protected_paths.map((g) => globToRegExp(g));
    const targets: string[] = [];
    if (EDIT_TOOLS.has(call.tool)) {
      const p = filePathOf(call);
      if (p) targets.push(p);
    }
    for (const c of commands) targets.push(...c.writes);
    const hit = targets.find((t) => res.some((re) => re.test(relToRoot(ctx.projectRoot, call.cwd, t))));
    if (hit) return { decision: 'deny', rule: 'protected-path', reason: `${hit} is harness config; change it through a reviewed proposal` };
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
