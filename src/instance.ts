// Instances: one per project, each with a home outside any repo: instance.yaml (its repo), policy.yaml (operator
// policy), credentials.yaml (references, never values), state/. The repo's config folder may only tighten the policy.
import { AutomationsPolicy } from './automations/schema.js';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { BRAND } from './brand.js';
import { ownEnv } from './os/own-env.js';
import { INSTANCE_FILE_NAME_MAX, instanceNameProblem } from './instance-name.js';
import { CLI_AGENTS } from './providers.js';
import { ConfigInvalid, loadConfig, type Config, type ConfigError } from './config/load.js';
import { defaultAgentPath, homeOf, homesRoot, normalAbsolute, normalHome, NOT_NORMAL_ABSOLUTE, replaceFileAtomically, stateDir, userExists, type ProjectRunAs } from './os/index.js';
import type { RunAs } from './runner.js';
import { homeCredentialStores, sandboxSettings } from './sandbox.js';
import { policyInstance, readPolicyChecked } from './policy-gate.js';
import { autoMergeKilled } from './policy-kill.js';
import { RESEARCH_DIR, RESEARCH_LANE, RESEARCH_REPO_LANE } from './research.js';
import { CHAT_LANE } from './intake/chat.js';
// WHY (#785): the env the guard reads and the chat lane's deny rules come from the guard's own locked modules, never
// through src/research.ts or src/intake/chat.ts, which aren't locked: a change there can't swap them under this file.
import { RESEARCH_ROOT_ENV } from './guard/research.js';
import { CHAT_KEY_GLOBS, CHAT_ROOT_ENV } from './guard/chat.js';
import { fileURLToPath } from 'node:url';

/**
 * The agents' tool guard's own entry, for hooks a lane adds itself (dist/src/hook-main.js beside this file): not the
 * CLI, so the guard's process loads only its locked import tree (#665).
 */
const HOOK_MAIN = fileURLToPath(new URL('./hook-main.js', import.meta.url));

// An instance's own users and units are never another's (src/instance-name.ts); an instance that runs as its owner's
// user may keep a longer name than a machine's (INSTANCE_FILE_NAME_MAX).
const name = z.string().superRefine((s, ctx) => {
  const why = instanceNameProblem(s, INSTANCE_FILE_NAME_MAX);
  if (why) ctx.addIssue({ code: 'custom', message: why });
});

// A configured path: normalAbsolute (as projectCommand checks), refused at load, never rewritten (#713). A relative
// one depends on the coordinator's cwd, a lexical `..` can name another file than the kernel reaches, and the sandbox
// hides each by this exact path.
const path = z
  .string()
  .min(1)
  .refine((p) => isAbsolute(p), { message: 'must be an absolute path' })
  .refine((p) => !isAbsolute(p) || normalAbsolute(p), { message: `${NOT_NORMAL_ABSOLUTE}: name the real path` });
/** A home: the same rule, but `/` is allowed (some users' home; never hidden). */
const homePath = z
  .string()
  .min(1)
  .refine((p) => isAbsolute(p), { message: 'must be an absolute path' })
  .refine((p) => !isAbsolute(p) || normalHome(p), { message: `${NOT_NORMAL_ABSOLUTE}: name the real path` });

export const InstanceFile = z.strictObject({
  version: z.literal(1),
  name,
  // One repo per instance until multi-repo instances exist.
  repos: z.array(z.strictObject({ path: z.string().min(1), repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be owner/repo') })).length(1),
  /** The identity on every commit agents and the coordinator make. Default: the GitHub App's bot identity. */
  commit_identity: z.strictObject({ name: z.string().min(1), email: z.string().regex(/^[^@\s]+@[^@\s]+$/, 'an email address') }).optional(),
  /** The unprivileged OS user agents run as. The coordinator's user holds the credentials; this one holds nothing. */
  run_as: z
    .strictObject({
      agent_user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, 'a POSIX user name'),
      agent_home: homePath,
      claude_config_dir: path.optional(),
      /** A second unprivileged user for lanes that run as `eval`: the only one able to read the eval key. */
      eval_user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, 'a POSIX user name').optional(),
      /** Resolved from the system's user database when left out; required where it can't be. */
      eval_home: homePath.optional(),
      /**
       * PATH for project commands run as the agent users (tests, checks, setup steps). The instance's owner sets it;
       * a repo's tests.yaml never can. Default: the system directories, plus Homebrew's on macOS.
       */
      path: z.string().regex(/^\/[^:\s]*(:\/[^:\s]*)*$/, 'absolute directories separated by colons').optional(),
    })
    .optional(),
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');

/**
 * The operator's settings for this instance: each one set here wins over the repo's value (which is the
 * default when it's absent). Bounds come from the machine's limits file; see settings.ts.
 */
export const InstanceSettings = z.strictObject({
  workers: z.number().int().min(0).optional(),
  daily_budget_usd: z.number().positive().optional(),
  ci_repair: z.strictObject({ enabled: z.boolean().optional(), max_fixes_per_pr: z.number().int().min(0).optional() }).optional(),
  run_windows: z.array(z.strictObject({ from: hhmm, to: hhmm })).optional(),
  /** Daily caps on research runs (web searches, page fetches, estimated spend). Absent: the engine's defaults. */
  research: z
    .strictObject({
      max_searches_per_day: z.number().int().min(0).optional(),
      max_fetches_per_day: z.number().int().min(0).optional(),
      max_usd_per_day: z.number().min(0).optional(),
      /** May research runs read the repo (read-only)? Off unless the owner turns it on: meant for public repos. */
      repo_access: z.boolean().optional(),
    })
    .optional(),
  /** Caps every model this instance runs at a tier (src/model-routing.ts): a model above it runs as the cap instead. */
  model_cap: z.enum(['haiku', 'sonnet', 'opus']).optional(),
  /**
   * Open-model providers this instance opts into (agents.yaml providers): the local model, and hosted providers by
   * name. Absent: none; every role keeps its normal model.
   */
  providers: z
    .strictObject({
      local: z.boolean().optional(),
      hosted: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/)).optional(),
      /** WHY: item 38. Opt-in per CLI (src/cli-agents.ts); none listed, none runs. */
      cli: z.array(z.enum(CLI_AGENTS)).optional(),
    })
    .optional(),
  /** Tiered evaluation for this instance (agents.yaml eval_routing): the cheap model, its levels, escalation. */
  eval_routing: z
    .strictObject({
      cheap_model: z.string().min(1).optional(),
      cheap_levels: z.array(z.enum(['L0', 'L1', 'L2', 'L3'])).optional(),
      escalate: z.boolean().optional(),
    })
    .optional(),
  /** The stuck-run guard (stuck.ts): off, dry-run (log only) or on (a stuck run is stopped). Absent: dry-run. */
  stuck_guard: z.enum(['off', 'dry-run', 'on']).optional(),
  /** Daily caps on work intake (reports per sender, drafts, estimated spend). Absent: the intake config's values. */
  intake: z
    .strictObject({
      reports_per_sender_per_day: z.number().int().min(1).optional(),
      drafts_per_day: z.number().int().min(1).optional(),
      max_usd_per_day: z.number().min(0).optional(),
    })
    .optional(),
  /** The dashboard chat's attachments (src/chat-attachments.ts): size caps in MB and days kept. Absent: the engine's defaults. */
  chat_attachments: z
    .strictObject({
      max_file_mb: z.number().positive().max(100).optional(),
      max_message_mb: z.number().positive().max(250).optional(),
      retention_days: z.number().int().min(1).max(365).optional(),
    })
    .optional(),
  /**
   * The dashboard chat (src/chat-pick.ts): what one person who isn't an owner may spend on chat answers in a local
   * day, across all their conversations. Here, in the owner's policy.yaml, so no writer can raise it. Absent: $10.
   */
  chat: z.strictObject({ person_daily_usd: z.number().positive().max(1000).optional() }).optional(),
});
export type InstanceSettings = z.infer<typeof InstanceSettings>;

export const PolicyFile = z.strictObject({
  version: z.literal(1),
  budget: z.strictObject({ daily_usd: z.number().positive() }),
  agents: z
    .strictObject({
      max_workers: z.number().int().min(0).max(32).default(2),
    })
    .prefault({}),
  land_mode: z.enum(['direct', 'pr']).default('pr'),
  /**
   * The instance's kill switch for auto-merge (PR mode): off, every PR waits for a human. On, the repo's
   * review.yaml `merge` rules decide, and can only narrow it. Re-read on every check, so turning it off
   * takes effect without a restart.
   */
  auto_merge: z.boolean().default(false),
  /**
   * Whether the repo's review.yaml may let writers approve a high-risk merge (`approvals: { land: writers }`, #715).
   * Off (the default): only the owners approve, whatever review.yaml says. Never settable from the dashboard (not a
   * policy-edit.ts POLICY_KEYS key): root or the coordinator user edits this file today, root alone once #769 makes it
   * root's. Read on every approval,
   * so turning it off takes effect at once. WHY not a config refusal: turning it off must never stop an instance
   * starting (a repo config refused at start, with its checkout's copy asking the same, would).
   */
  writers_approve_land: z.boolean().default(false),
  /**
   * The main watch (src/main-watch.ts): auto, it guards the default branch whenever GitHub doesn't protect it (the
   * protection API answers 403 or 404); off, it doesn't. Read on every pass.
   */
  main_watch: z.enum(['auto', 'off']).default('auto'),
  /** Automations (docs/automations.md): off until an owner turns them on; the caps over all of them. */
  automations: AutomationsPolicy,
  /** Instance settings that win over the repo's: worker count, daily budget, CI fix runs, run windows. */
  settings: InstanceSettings.default({}),
  /**
   * Agents run as a separate OS user by default (instance.yaml run_as).
   * Setting this lets them run as the coordinator's own user, which can read
   * every credential the coordinator holds: for trying things out only.
   */
  allow_same_user: z.boolean().default(false),
  /** Claude Code's sandbox for agent commands. On unless turned off here, explicitly. */
  sandbox: z.boolean().default(true),
  /**
   * Lanes: the hosts agent commands may reach, and which user runs them. An
   * issue picks a lane with a lane:<name> label; without one it runs in default.
   */
  lanes: z
    .record(z.string().regex(/^[a-z][a-z0-9-]{0,30}$/), z.strictObject({ allowed_domains: z.array(z.string()).default([]), run_as: z.enum(['agent', 'eval']).default('agent') }))
    .default({ default: { allowed_domains: [], run_as: 'agent' } })
    .refine((l) => 'default' in l, 'lanes must include default'),
  /** When set, the repo's network allowlist and pre-approved tools must be subsets of these. */
  network_allow: z.array(z.string()).optional(),
  pre_approved: z.array(z.string()).optional(),
  /**
   * The value report's hours-saved estimate (src/value-report.ts, #708): its constants, in minutes, all three or none.
   * Absent: the engine's defaults, which the report says are guesses. Display only: read by GET /api/value alone, no
   * gate reads it, and the dashboard can't write it (not a policy-edit.ts POLICY_KEYS key nor a settings.ts one).
   * Bounded at a working day each (480), as a bad value fails here like any other key: the instance doesn't load.
   */
  value_report: z
    .strictObject({
      hours_estimate: z
        .strictObject({ base_min: z.number().min(0).max(480), per_100_lines_min: z.number().min(0).max(480), cap_min: z.number().min(0).max(480) })
        .optional(),
    })
    .optional(),
});

export const CredentialsFile = z.strictObject({
  version: z.literal(1),
  // A dedicated gh config dir (its own login) or a GitHub App key. Never the operator's personal login.
  github: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('gh-config-dir'), path }),
    z.strictObject({ kind: z.literal('app'), app_id: z.number().int().positive(), installation_id: z.number().int().positive(), key_path: path }),
  ]),
  // The Claude Code config dir holding the agents' login (CLAUDE_CONFIG_DIR), when agents run as the
  // coordinator's own user. With run_as, each agent user signs in to Claude in its own home instead.
  claude: z.strictObject({ config_dir: path }).optional(),
  /** An API key file for eval lanes: owned by the eval user, unreadable to every other. */
  eval_key: path.optional(),
  /**
   * The agent user's Anthropic API key file (credentials.sh <name> api-key): owned by the agent user, 0400. When
   * set, the instance's agent runs bill to this key instead of the agent user's Claude login; claude reads it through
   * apiKeyHelper as the agent user. The coordinator can't read it, and no agent command may (the sandbox denies it).
   */
  agent_api_key: path.optional(),
  /**
   * Open-model providers' keys (agents.yaml providers, by credential name): each a file owned by the agent user, 0400,
   * installed with credentials.sh <name> provider-key. claude reads it through apiKeyHelper as the agent user; it is
   * never in an environment, the coordinator can't read it, and no agent command may (the sandbox denies it).
   */
  provider_keys: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/), path).optional(),
  /**
   * Work intake's credentials: the chat bot's token, the Slack app's two tokens and the Linear API key, each a file
   * only the coordinator user can read (0400), installed with credentials.sh or the dashboard's paste box. No agent
   * can read them. Paths only, never a value.
   */
  intake: z
    .strictObject({
      discord_token: path.optional(),
      /** The Slack app-level token (xapp-, connections:write): opens the Socket Mode connection. */
      slack_app_token: path.optional(),
      /** The Slack bot token (xoxb-): who the bot is, senders' names for redaction, and the replies. */
      slack_bot_token: path.optional(),
      /** The Linear personal API key (lin_api_): read the team's labelled issues, comment on them. */
      linear_api_key: path.optional(),
    })
    .optional(),
});

export type PolicyFile = z.infer<typeof PolicyFile>;
export type CredentialsFile = z.infer<typeof CredentialsFile>;

export interface Instance {
  name: string;
  /** `hide`: what its project commands' sandbox hides (projectCommandHides). */
  runAs: { user: string; home: string; claudeConfigDir?: string; path?: string; hide: readonly string[] } | null;
  /** Set in instance.yaml; otherwise resolved at start (the App's bot identity). */
  commitIdentity?: { name: string; email: string };
  evalAs: { user: string; home: string; path?: string } | null;
  home: string;
  stateDir: string;
  repo: { path: string; repo: string };
  policy: PolicyFile;
  credentials: CredentialsFile;
  /** The repo's config, checked against the policy. */
  config: Config;
}

export function instancesDir(): string {
  return ownEnv().get(`${BRAND.envPrefix}_INSTANCES_DIR`) ?? join(stateDir(), 'instances');
}

function readYaml<S extends z.ZodType>(schema: S, file: string, errors: ConfigError[], text?: string): z.infer<S> | undefined {
  if (text === undefined && !existsSync(file)) {
    errors.push({ file, path: '', message: 'missing' });
    return undefined;
  }
  const doc = parseDocument(text ?? readFileSync(file, 'utf8'), { uniqueKeys: true });
  if (doc.errors.length) {
    for (const e of doc.errors) errors.push({ file, path: '', message: e.message.split('\n')[0]! });
    return undefined;
  }
  const r = schema.safeParse(doc.toJS());
  if (r.success) return r.data;
  for (const i of r.error.issues) errors.push({ file, path: i.path.join('.'), message: i.message });
  return undefined;
}

/**
 * A policy.yaml, unless root's record says it is root's and it isn't: then refused, and never read (src/policy-gate.ts).
 * Root's auto_merge kill switch (src/policy-kill.ts) is checked first: while it is there, auto_merge is off, whatever
 * the file says.
 */
function readPolicyYaml(file: string, errors: ConfigError[]): PolicyFile | undefined {
  const killed = autoMergeKilled(policyInstance(file));
  const r = readPolicyChecked(file);
  if (r && 'refused' in r) {
    errors.push({ file, path: '', message: r.refused });
    return undefined;
  }
  const policy = readYaml(PolicyFile, file, errors, r?.text);
  return policy && killed ? { ...policy, auto_merge: false } : policy;
}

/** Every way the repo's config loosens the instance policy. A repo may only tighten it. */
export function policyViolations(cfg: Config, policy: PolicyFile): ConfigError[] {
  const out: ConfigError[] = [];
  const v = (file: string, p: string, message: string) => out.push({ file: `${BRAND.configDir}/${file}`, path: p, message: `${message}; a repo can only tighten the instance policy` });
  if (cfg.agents.daily_budget_usd > policy.budget.daily_usd) v('agents.yaml', 'daily_budget_usd', `${cfg.agents.daily_budget_usd} exceeds the policy budget ${policy.budget.daily_usd}`);
  const w = cfg.agents.roles.workers;
  for (const k of ['count', 'max'] as const) if (w?.[k] !== undefined && w[k]! > policy.agents.max_workers) v('agents.yaml', `roles.workers.${k}`, `${w[k]} exceeds the policy's max_workers ${policy.agents.max_workers}`);
  if (policy.land_mode === 'pr' && cfg.project.land_mode === 'direct') v('config.yaml', 'land_mode', 'direct landing, but the policy requires pr');
  if (policy.network_allow) for (const d of cfg.guardrails.network.allow) if (!policy.network_allow.includes(d)) v('guardrails.yaml', 'network.allow', `${d} is not in the policy's network_allow`);
  if (policy.pre_approved) for (const t of cfg.guardrails.pre_approved) if (!policy.pre_approved.includes(t)) v('guardrails.yaml', 'pre_approved', `${t} is not in the policy's pre_approved`);
  return out;
}

/** What an instance requires of its repo's config beyond the schema: its own repo, and only tightening its policy. */
export function instanceConfigProblems(config: Config, repo: string, policy: PolicyFile): ConfigError[] {
  const errors: ConfigError[] = [];
  if (config.project.project.repo !== repo) errors.push({ file: `${BRAND.configDir}/config.yaml`, path: 'project.repo', message: `${config.project.project.repo} is not the instance's repo ${repo}` });
  return [...errors, ...policyViolations(config, policy)];
}

/** Load an instance and its repo config. Throws ConfigInvalid listing every problem, including any loosening. */
export function loadInstance(instanceName: string, dir = instancesDir()): Instance {
  const home = join(dir, instanceName);
  if (!existsSync(home)) throw new ConfigInvalid([{ file: home, path: '', message: `no instance "${instanceName}"; run \`${BRAND.cli} instance init\`` }]);
  const errors: ConfigError[] = [];
  const inst = readYaml(InstanceFile, join(home, 'instance.yaml'), errors);
  const policy = readPolicyYaml(join(home, 'policy.yaml'), errors);
  const credentials = readYaml(CredentialsFile, join(home, 'credentials.yaml'), errors);
  if (inst && inst.name !== instanceName) errors.push({ file: join(home, 'instance.yaml'), path: 'name', message: `"${inst.name}" does not match the directory "${instanceName}"` });
  if (errors.length || !inst || !policy || !credentials) throw new ConfigInvalid(errors);
  const repo = { ...inst.repos[0]!, path: resolve(home, inst.repos[0]!.path) };
  const config = loadConfig(repo.path);
  errors.push(...instanceConfigProblems(config, repo.repo, policy));
  if (errors.length) throw new ConfigInvalid(errors);
  if (!inst.run_as && !policy.allow_same_user) {
    throw new ConfigInvalid([{ file: join(home, 'instance.yaml'), path: 'run_as', message: `agents must run as their own OS user: set run_as (agent_user, agent_home), or allow_same_user: true in policy.yaml to accept agents reading the coordinator's credentials` }]);
  }
  if (!inst.run_as && !credentials.claude) {
    throw new ConfigInvalid([{ file: join(home, 'credentials.yaml'), path: 'claude', message: 'agents run as the coordinator user, so set claude.config_dir to the Claude login they use' }]);
  }
  if (Object.values(policy.lanes).some((l) => l.run_as === 'eval') && !inst.run_as?.eval_user) {
    throw new ConfigInvalid([{ file: join(home, 'instance.yaml'), path: 'run_as.eval_user', message: 'a lane runs as eval, so set eval_user and eval_home' }]);
  }
  const path = inst.run_as?.path ?? defaultAgentPath();
  const ccd = inst.run_as?.claude_config_dir;
  const runAs = inst.run_as ? { user: inst.run_as.agent_user, home: inst.run_as.agent_home, path, ...(ccd ? { claudeConfigDir: ccd } : {}), hide: projectCommandHides(home, repo.path, credentials, ccd) } : null;
  let evalAs: { user: string; home: string; path: string } | null = null;
  if (inst.run_as?.eval_user) {
    const evalHome = inst.run_as.eval_home ?? resolveHome(inst.run_as.eval_user);
    if (!evalHome) throw new ConfigInvalid([{ file: join(home, 'instance.yaml'), path: 'run_as.eval_home', message: `can't find ${inst.run_as.eval_user}'s home on this machine; set eval_home` }]);
    // The user database's answer is held to the same rule as a configured home: refused, never rewritten.
    if (!normalHome(evalHome)) throw new ConfigInvalid([{ file: join(home, 'instance.yaml'), path: 'run_as.eval_home', message: `${inst.run_as.eval_user}'s home ${JSON.stringify(evalHome)} ${NOT_NORMAL_ABSOLUTE}; set eval_home to its real path` }]);
    evalAs = { user: inst.run_as.eval_user, home: evalHome, path };
  }
  return { name: instanceName, home, stateDir: join(home, 'state'), repo, policy, credentials, config, runAs, evalAs, ...(inst.commit_identity ? { commitIdentity: inst.commit_identity } : {}) };
}

/**
 * Credential references must point at something before a coordinator starts.
 * Missing means refuse to start; there is no fallback to anyone's own login.
 */
export function credentialProblems(c: CredentialsFile): string[] {
  const out: string[] = [];
  const need = (p: string, what: string) => !existsSync(p) && out.push(`${what} not found at ${p}`);
  if (c.github.kind === 'gh-config-dir') need(c.github.path, 'GitHub: gh config dir');
  else need(c.github.key_path, 'GitHub: App private key');
  if (c.claude) need(c.claude.config_dir, 'Claude: config dir');
  if (c.intake?.discord_token) need(c.intake.discord_token, 'Intake: chat bot token');
  if (c.intake?.slack_app_token) need(c.intake.slack_app_token, 'Intake: Slack app-level token');
  if (c.intake?.slack_bot_token) need(c.intake.slack_bot_token, 'Intake: Slack bot token');
  if (c.intake?.linear_api_key) need(c.intake.linear_api_key, 'Intake: Linear API key');
  return out;
}

/** Everything an instance needs on this machine before it starts: its credentials, and the agent user it runs agents as. */
export function instanceProblems(i: Instance): string[] {
  const out = credentialProblems(i.credentials);
  for (const r of i.runAs ? [i.runAs, ...(i.evalAs ? [i.evalAs] : [])] : []) {
    if (!userExists(r.user)) out.push(`agent user ${r.user} (instance.yaml run_as) does not exist on this machine`);
    else if (!existsSync(r.home)) out.push(`agent user ${r.user}'s home ${r.home} not found`);
  }
  return out;
}

/**
 * Whether an instance merges its own PRs by its policy (the coordinator asks before each merge): root's kill switch
 * (src/policy-kill.ts) first, and while it is there the policy is never read, so no lock, parse or bad file can turn
 * it back on. A policy that doesn't load throws (the coordinator reads that as off).
 */
export function instanceAutoMerge(instanceName: string, dir = instancesDir()): boolean {
  return !autoMergeKilled(instanceName) && loadInstance(instanceName, dir).policy.auto_merge;
}

/** A policy file on its own, e.g. a copy of an instance's, to check a repo config against. */
export function readPolicy(file: string): { policy: PolicyFile | undefined; errors: ConfigError[] } {
  const errors: ConfigError[] = [];
  return { policy: readPolicyYaml(file, errors), errors };
}

/**
 * The policies of the instances on this machine that run a repo (owner/name),
 * so a change to its config can be checked against them before it merges.
 * Instances this user can't read are skipped.
 */
export function policiesForRepo(repo: string, dir = instancesDir()): { name: string; policy: PolicyFile | undefined; errors: ConfigError[] }[] {
  let names: string[];
  try {
    names = listInstances(dir);
  } catch {
    return [];
  }
  const out: { name: string; policy: PolicyFile | undefined; errors: ConfigError[] }[] = [];
  for (const n of names) {
    const inst = readYaml(InstanceFile, join(dir, n, 'instance.yaml'), []);
    if (!inst?.repos.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) continue;
    out.push({ name: n, ...readPolicy(join(dir, n, 'policy.yaml')) });
  }
  return out;
}

export function listInstances(dir = instancesDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'instance.yaml')))
    .map((e) => e.name)
    .sort();
}

/** Create an instance home with skeleton files, readable only by its owner. Credentials stay placeholders to fill in. */
/** How a user's home is found (the OS user database); tests replace it. */
export let resolveHome: (user: string) => string | null = (user) => homeOf(user);
export function setResolveHome(f: (user: string) => string | null): void {
  resolveHome = f;
}

export function initInstance(instanceName: string, repoPath: string, repo: string, dir = instancesDir(), agentUser = `${instanceName}-agent`, agentHome = resolveHome(agentUser) ?? `${homesRoot()}/${agentUser}`): string {
  const why = instanceNameProblem(instanceName, INSTANCE_FILE_NAME_MAX);
  if (why) throw new Error(`instance name "${instanceName}": ${why}`);
  const home = join(dir, instanceName);
  if (existsSync(home)) throw new Error(`instance "${instanceName}" already exists at ${home}`);
  mkdirSync(join(home, 'state'), { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const write = (file: string, text: string) => writeFileSync(join(home, file), text, { mode: 0o600 });
  write(
    'instance.yaml',
    `version: 1\nname: ${instanceName}\nrepos:\n  - path: ${JSON.stringify(resolve(repoPath))}\n    repo: ${repo}\n# Agents run as this unprivileged user (create it first; see the docs on separate users).\nrun_as:\n  agent_user: ${agentUser}\n  agent_home: ${JSON.stringify(agentHome)}\n`,
  );
  write('policy.yaml', `version: 1\nbudget: { daily_usd: 20 }\nagents: { max_workers: 2 }\nland_mode: pr\n# On: the harness merges its own PRs that review.yaml's merge rules allow; off: every PR waits for you.\nauto_merge: false\n`);
  write(
    'credentials.yaml',
    `# References only. Point these at credentials made for this instance; never your own login.\nversion: 1\ngithub: { kind: gh-config-dir, path: ${JSON.stringify(join(home, 'gh'))} }\n# claude: { config_dir: ... }   only when agents run as this user (no run_as)\n`,
  );
  return home;
}

/**
 * How each lane runs: as which user, and inside which sandbox. Agent commands
 * may never read the coordinator's instance home, credential stores in the
 * running user's home, or that user's Claude login file; lanes other than
 * the eval user's may not read the eval key either.
 */
export function laneRuns(i: Instance): Record<string, { runAs?: RunAs; settings?: ReturnType<typeof sandboxSettings> }> {
  const out: Record<string, { runAs?: RunAs; settings?: ReturnType<typeof sandboxSettings> }> = {};
  for (const [name, lane] of Object.entries(i.policy.lanes)) {
    const who = lane.run_as === 'eval' ? i.evalAs : i.runAs;
    const runAs: RunAs | undefined = who ? { ...who } : undefined;
    const home = runAs?.home ?? ownEnv().get('HOME') ?? '';
    const claudeDir = runAs?.claudeConfigDir ?? (runAs ? join(home, '.claude') : i.credentials.claude!.config_dir);
    const denyRead = [i.home, ...homeCredentialStores(home), join(claudeDir, '.credentials.json'), ...(lane.run_as === 'eval' || !i.credentials.eval_key ? [] : [i.credentials.eval_key]), ...(i.credentials.agent_api_key ? [i.credentials.agent_api_key] : []), ...Object.values(i.credentials.provider_keys ?? {})];
    out[name] = { ...(runAs ? { runAs } : {}), ...(i.policy.sandbox ? { settings: sandboxSettings({ lane: { allowedDomains: lane.allowed_domains }, denyRead }) } : {}) };
  }
  return out;
}

/** A research lane's settings: Read/Glob/Grep deny rules, the research-mode hook, and the sandbox when the policy has it on. */
export interface ResearchLaneSettings {
  permissions: { deny: string[] };
  hooks?: object;
  /** Pinned for the run's hooks (the chat lane's root). */
  env?: Record<string, string>;
  sandbox?: ReturnType<typeof sandboxSettings>['sandbox'];
}

/**
 * The two research lanes, as the default lane's user. `research` (no repo access) denies every read of the checkout
 * (and so its worktrees), and of the instance's task and chat files, in the sandbox and in Read rules, and adds the
 * engine's hook in research mode, which refuses any file read outside the research bundles: its working directory
 * is a bundle with no project settings, so the project's own hook doesn't run there. `research-repo` may read
 * the repo like any agent. Both get their settings whether or not the policy's sandbox is on.
 */
export function researchLanes(i: Instance, base: { runAs?: RunAs } | undefined): Record<string, { runAs?: RunAs; settings: ResearchLaneSettings; ownHooks?: boolean }> {
  const root = dirname(i.repo.path);
  const researchRoot = join(root, RESEARCH_DIR);
  const runAs = base?.runAs;
  const home = runAs?.home ?? ownEnv().get('HOME') ?? '';
  const claudeDir = runAs?.claudeConfigDir ?? (runAs ? join(home, '.claude') : i.credentials.claude?.config_dir ?? join(home, '.claude'));
  const always = [i.home, ...homeCredentialStores(home), join(claudeDir, '.credentials.json'), ...(i.credentials.eval_key ? [i.credentials.eval_key] : []), ...(i.credentials.agent_api_key ? [i.credentials.agent_api_key] : []), ...Object.values(i.credentials.provider_keys ?? {})];
  const noRepo = [...always, i.repo.path, join(root, 'tasks'), join(root, 'chat')];
  const settingsFor = (denyRead: string[], hook: boolean): ResearchLaneSettings => {
    const s = sandboxSettings({ lane: { allowedDomains: [] }, denyRead });
    const deny = [...s.permissions.deny, ...denyRead.map((p) => `Glob(/${p.startsWith('/') ? p : `/${p}`}/**)`), ...denyRead.map((p) => `Grep(/${p.startsWith('/') ? p : `/${p}`}/**)`)];
    const hooks = hook ? { hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `${RESEARCH_ROOT_ENV}=${JSON.stringify(researchRoot)} node ${JSON.stringify(HOOK_MAIN)} pre-tool-use || exit 2`, timeout: 30 }] }] } } : {};
    return { ...(i.policy.sandbox ? { sandbox: s.sandbox } : {}), permissions: { deny }, ...hooks };
  };
  // The chat channels' lane: the checkout read-only, like research-repo, under the instance's own guardrail hooks,
  // whose chat mode (CHAT_ROOT_ENV, pinned here) refuses anything outside the checkout and every credential, key and
  // .env file; the instance's other directories and key-like files are denied to Read, Glob and Grep here too.
  const chat = settingsFor([...always, join(root, 'tasks'), join(root, 'chat'), researchRoot], false);
  const keyRules = CHAT_KEY_GLOBS.map((g) => `Read(${g})`);
  return {
    // Its own hook, in research mode: the instance's guardrail hooks would refuse a directory with no project config.
    [RESEARCH_LANE]: { ...(runAs ? { runAs } : {}), settings: settingsFor(noRepo, true), ownHooks: true },
    [RESEARCH_REPO_LANE]: { ...(runAs ? { runAs } : {}), settings: settingsFor(always, false) },
    [CHAT_LANE]: { ...(runAs ? { runAs } : {}), settings: { ...chat, permissions: { deny: [...chat.permissions.deny, ...keyRules] }, env: { [CHAT_ROOT_ENV]: i.repo.path } } },
  };
}

/** Only an instance's credential references: for the git credential helper, which must work before the repo is cloned. */
export function loadInstanceCredentials(instanceName: string, dir = instancesDir()): { stateDir: string; repos: string[]; credentials: CredentialsFile } {
  const home = join(dir, instanceName);
  const errors: ConfigError[] = [];
  const inst = readYaml(InstanceFile, join(home, 'instance.yaml'), errors);
  const credentials = readYaml(CredentialsFile, join(home, 'credentials.yaml'), errors);
  if (errors.length || !inst || !credentials) throw new ConfigInvalid(errors);
  return { stateDir: join(home, 'state'), repos: inst.repos.map((r) => r.repo), credentials };
}

/** An instance-file problem as one line (ConfigInvalid's own message starts with the repo config's heading). */
export const instanceFilesProblem = (e: unknown): string => (e instanceof ConfigInvalid ? e.errors.map((x) => `${x.file}${x.path ? ` at ${x.path}` : ''}: ${x.message}`).join('; ') : (e as Error).message.split('\n')[0]!);

/**
 * An instance's setup, before its repo has a config: where its checkout is and who its agents run as, with its
 * credential references and policy. Server auto-config needs it (src/server-auto-config.ts); loadInstance needs the
 * repo config too.
 */
export function loadInstanceSetup(instanceName: string, dir = instancesDir()): { home: string; stateDir: string; repo: { path: string; repo: string }; credentials: CredentialsFile; policy: PolicyFile; runAs: (RunAs & ProjectRunAs) | null } {
  const home = join(dir, instanceName);
  const errors: ConfigError[] = [];
  const inst = readYaml(InstanceFile, join(home, 'instance.yaml'), errors);
  const policy = readPolicyYaml(join(home, 'policy.yaml'), errors);
  const credentials = readYaml(CredentialsFile, join(home, 'credentials.yaml'), errors);
  if (errors.length || !inst || !policy || !credentials) throw new ConfigInvalid(errors);
  const repoPath = resolve(home, inst.repos[0]!.path);
  const runAs = inst.run_as ? { user: inst.run_as.agent_user, home: inst.run_as.agent_home, path: inst.run_as.path ?? defaultAgentPath(), hide: projectCommandHides(home, repoPath, credentials, inst.run_as.claude_config_dir) } : null;
  return { home, stateDir: join(home, 'state'), repo: { ...inst.repos[0]!, path: repoPath }, credentials, policy, runAs };
}

/**
 * What a project command never sees beyond ~/.claude*: the instance home, a Claude config dir set elsewhere, every
 * file credentials.yaml names. Never a directory holding the checkout, where commands run.
 */
export function projectCommandHides(instanceHome: string, repoPath: string, c: CredentialsFile, claudeConfigDir?: string): string[] {
  const named = [instanceHome, claudeConfigDir, c.github.kind === 'app' ? c.github.key_path : c.github.path, c.claude?.config_dir, c.eval_key, c.agent_api_key, ...Object.values(c.provider_keys ?? {}), ...Object.values(c.intake ?? {})];
  const holdsRepo = (p: string) => repoPath === p || repoPath.startsWith(p.endsWith('/') ? p : `${p}/`);
  // As written, never dropped or rewritten: projectCommand refuses one not in normal form.
  return [...new Set(named.filter((p): p is string => typeof p === 'string'))].filter((p) => !holdsRepo(p));
}

/** How an instance's GitHub App was made, as its setup recorded it (beside the App's key): the manifest flow, or by hand. */
export type AppOrigin = 'manifest' | 'by-hand';
const APP_ORIGIN_FILE = 'made-by';
export const appOriginText = (o: AppOrigin | null) => (o === 'manifest' ? 'made through the manifest flow' : o === 'by-hand' ? 'made by hand (credentials.sh github-app)' : 'how it was made is not recorded');
export function readAppOrigin(keyPath: string): AppOrigin | null {
  try {
    const t = readFileSync(join(dirname(keyPath), APP_ORIGIN_FILE), 'utf8').trim();
    return t === 'manifest' || t === 'by-hand' ? t : null;
  } catch {
    return null;
  }
}

/**
 * Point credentials.yaml at its GitHub App, validated before it is written (0600, renamed into place), recording how
 * the App was made beside its key; the App entry's one writer (credentials.sh github-app, the manifest flow).
 */
export function setGithubApp(file: string, app: { appId: number; installationId: number; keyPath: string }, origin: AppOrigin): void {
  const doc = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : 'version: 1\n');
  if (doc.errors.length) throw new Error(`${file} isn't valid YAML: ${doc.errors[0]!.message.split('\n')[0]}`);
  if (!doc.has('version')) doc.set('version', 1);
  doc.set('github', { kind: 'app', app_id: app.appId, installation_id: app.installationId, key_path: app.keyPath });
  const r = CredentialsFile.safeParse(doc.toJS());
  if (!r.success) throw new Error(`${file} would not be valid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  // Each keeps its directory's owner: root (the manifest flow) writes them for the coordinator user.
  replaceFileAtomically(file, String(doc), 0o600, dirname(file));
  replaceFileAtomically(join(dirname(app.keyPath), APP_ORIGIN_FILE), `${origin}\n`, 0o600, dirname(app.keyPath));
}

/**
 * Point credentials.yaml at the chat bot's token file (intake.discord_token), validated before it is written (0600,
 * renamed into place); its one writer. Only the path: the token is never read. Refused: a path that isn't absolute,
 * isn't a plain file, or that its group or others can read (the token is the coordinator user's alone).
 */
export function setDiscordToken(file: string, tokenFile: string): void {
  setIntakeCredential(file, 'discord_token', tokenFile);
}

/** The intake credentials credentials.yaml names (under `intake:`), each a path to a 0400 file. */
export const INTAKE_CREDENTIAL_KEYS = ['discord_token', 'slack_app_token', 'slack_bot_token', 'linear_api_key'] as const;
export type IntakeCredentialKey = (typeof INTAKE_CREDENTIAL_KEYS)[number];

/**
 * Point credentials.yaml at one intake credential's file (intake.<key>), validated before it is written (0600, renamed
 * into place); their one writer. Only the path: the secret is never read. Refused: a path that isn't absolute, isn't
 * a plain file, or that its group or others can read (the secret is the coordinator user's alone).
 */
export function setIntakeCredential(file: string, key: IntakeCredentialKey, tokenFile: string): void {
  if (!INTAKE_CREDENTIAL_KEYS.includes(key)) throw new Error(`not an intake credential: ${String(key)}`);
  if (!isAbsolute(tokenFile)) throw new Error(`the token file must be an absolute path, not ${tokenFile}`);
  if (!existsSync(file)) throw new Error(`no ${file}: the instance's GitHub credential comes first (credentials.sh <name> github-app writes it)`);
  let st;
  try {
    st = lstatSync(tokenFile);
  } catch {
    throw new Error(`no token file ${tokenFile}`);
  }
  if (!st.isFile()) throw new Error(`${tokenFile} is not a plain file`);
  // WHY: POSIX only; Windows has no mode bits to read.
  if (typeof process.getuid === 'function' && st.mode & 0o077) throw new Error(`${tokenFile} is open to its group or others (mode ${(st.mode & 0o777).toString(8)}); the bot token is its owner's alone (chmod 400)`);
  const doc = parseDocument(readFileSync(file, 'utf8'));
  if (doc.errors.length) throw new Error(`${file} isn't valid YAML: ${doc.errors[0]!.message.split('\n')[0]}`);
  doc.setIn(['intake', key], tokenFile);
  const r = CredentialsFile.safeParse(doc.toJS());
  if (!r.success) throw new Error(`${file} would not be valid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  // WHY: lineWidth 0, so a long path doesn't re-wrap the file's other lines.
  replaceFileAtomically(file, doc.toString({ lineWidth: 0 }), 0o600, dirname(file));
}
