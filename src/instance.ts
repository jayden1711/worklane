// Instances: one per project, each with its own home outside any repo.
//   <instances dir>/<name>/instance.yaml     which repo(s) this instance works
//   <instances dir>/<name>/policy.yaml       operator policy: budget, limits, allowlists
//   <instances dir>/<name>/credentials.yaml  references to credentials, never values
//   <instances dir>/<name>/state/            event log, locks, worktree records
// The repo's own config folder keeps project behavior (tests, review levels,
// skills) and is reviewed like code; it may only tighten the instance policy.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { BRAND } from './brand.js';
import { ConfigInvalid, loadConfig, type Config, type ConfigError } from './config/load.js';
import { stateDir, userExists } from './os/index.js';
import type { RunAs } from './runner.js';
import { homeCredentialStores, sandboxSettings } from './sandbox.js';
import { RESEARCH_DIR, RESEARCH_LANE, RESEARCH_REPO_LANE, RESEARCH_ROOT_ENV } from './research.js';
import { fileURLToPath } from 'node:url';

/** The engine's CLI, for hooks a lane adds itself (dist/src/cli.js beside this file). */
const ENGINE_CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

const name = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, 'lowercase letters, digits and dashes');

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
      agent_home: z.string().min(1),
      claude_config_dir: z.string().min(1).optional(),
      /** A second unprivileged user for lanes that run as `eval`: the only one able to read the eval key. */
      eval_user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, 'a POSIX user name').optional(),
      eval_home: z.string().min(1).optional(),
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
});

const path = z.string().min(1);
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
});

export type PolicyFile = z.infer<typeof PolicyFile>;
export type CredentialsFile = z.infer<typeof CredentialsFile>;

export interface Instance {
  name: string;
  runAs: { user: string; home: string; claudeConfigDir?: string } | null;
  /** Set in instance.yaml; otherwise resolved at start (the App's bot identity). */
  commitIdentity?: { name: string; email: string };
  evalAs: { user: string; home: string } | null;
  home: string;
  stateDir: string;
  repo: { path: string; repo: string };
  policy: PolicyFile;
  credentials: CredentialsFile;
  /** The repo's config, checked against the policy. */
  config: Config;
}

export function instancesDir(): string {
  return process.env[`${BRAND.envPrefix}_INSTANCES_DIR`] ?? join(stateDir(), 'instances');
}

function readYaml<S extends z.ZodType>(schema: S, file: string, errors: ConfigError[]): z.infer<S> | undefined {
  if (!existsSync(file)) {
    errors.push({ file, path: '', message: 'missing' });
    return undefined;
  }
  const doc = parseDocument(readFileSync(file, 'utf8'), { uniqueKeys: true });
  if (doc.errors.length) {
    for (const e of doc.errors) errors.push({ file, path: '', message: e.message.split('\n')[0]! });
    return undefined;
  }
  const r = schema.safeParse(doc.toJS());
  if (r.success) return r.data;
  for (const i of r.error.issues) errors.push({ file, path: i.path.join('.'), message: i.message });
  return undefined;
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

/** Load an instance and its repo config. Throws ConfigInvalid listing every problem, including any loosening. */
export function loadInstance(instanceName: string, dir = instancesDir()): Instance {
  const home = join(dir, instanceName);
  if (!existsSync(home)) throw new ConfigInvalid([{ file: home, path: '', message: `no instance "${instanceName}"; run \`${BRAND.cli} instance init\`` }]);
  const errors: ConfigError[] = [];
  const inst = readYaml(InstanceFile, join(home, 'instance.yaml'), errors);
  const policy = readYaml(PolicyFile, join(home, 'policy.yaml'), errors);
  const credentials = readYaml(CredentialsFile, join(home, 'credentials.yaml'), errors);
  if (inst && inst.name !== instanceName) errors.push({ file: join(home, 'instance.yaml'), path: 'name', message: `"${inst.name}" does not match the directory "${instanceName}"` });
  if (errors.length || !inst || !policy || !credentials) throw new ConfigInvalid(errors);
  const repo = { ...inst.repos[0]!, path: resolve(home, inst.repos[0]!.path) };
  const config = loadConfig(repo.path);
  if (config.project.project.repo !== repo.repo) errors.push({ file: `${BRAND.configDir}/config.yaml`, path: 'project.repo', message: `${config.project.project.repo} is not the instance's repo ${repo.repo}` });
  errors.push(...policyViolations(config, policy));
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
  const runAs = inst.run_as ? { user: inst.run_as.agent_user, home: inst.run_as.agent_home, ...(inst.run_as.claude_config_dir ? { claudeConfigDir: inst.run_as.claude_config_dir } : {}) } : null;
  const evalAs = inst.run_as?.eval_user ? { user: inst.run_as.eval_user, home: inst.run_as.eval_home ?? `/home/${inst.run_as.eval_user}` } : null;
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

/** A policy file on its own, e.g. a copy of an instance's, to check a repo config against. */
export function readPolicy(file: string): { policy: PolicyFile | undefined; errors: ConfigError[] } {
  const errors: ConfigError[] = [];
  return { policy: readYaml(PolicyFile, file, errors), errors };
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
export function initInstance(instanceName: string, repoPath: string, repo: string, dir = instancesDir(), agentUser = `${instanceName}-agent`): string {
  if (!name.safeParse(instanceName).success) throw new Error(`instance name "${instanceName}": lowercase letters, digits and dashes`);
  const home = join(dir, instanceName);
  if (existsSync(home)) throw new Error(`instance "${instanceName}" already exists at ${home}`);
  mkdirSync(join(home, 'state'), { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const write = (file: string, text: string) => writeFileSync(join(home, file), text, { mode: 0o600 });
  write(
    'instance.yaml',
    `version: 1\nname: ${instanceName}\nrepos:\n  - path: ${JSON.stringify(resolve(repoPath))}\n    repo: ${repo}\n# Agents run as this unprivileged user (create it first; see the docs on separate users).\nrun_as:\n  agent_user: ${agentUser}\n  agent_home: /home/${agentUser}\n`,
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
    const home = runAs?.home ?? process.env.HOME ?? '';
    const claudeDir = runAs?.claudeConfigDir ?? (runAs ? join(home, '.claude') : i.credentials.claude!.config_dir);
    const denyRead = [i.home, ...homeCredentialStores(home), join(claudeDir, '.credentials.json'), ...(lane.run_as === 'eval' || !i.credentials.eval_key ? [] : [i.credentials.eval_key])];
    out[name] = { ...(runAs ? { runAs } : {}), ...(i.policy.sandbox ? { settings: sandboxSettings({ lane: { allowedDomains: lane.allowed_domains }, denyRead }) } : {}) };
  }
  return out;
}

/** A research lane's settings: Read/Glob/Grep deny rules, the research-mode hook, and the sandbox when the policy has it on. */
export interface ResearchLaneSettings {
  permissions: { deny: string[] };
  hooks?: object;
  sandbox?: ReturnType<typeof sandboxSettings>['sandbox'];
}

/**
 * The two research lanes, as the default lane's user. `research` (no repo access) denies every read of the checkout
 * (and so its worktrees), and of the instance's task and chat files, in the sandbox and in Read rules, and adds the
 * engine's hook in research mode, which refuses any file read outside the research bundles: its working directory
 * is a bundle with no project settings, so the project's own hook doesn't run there. `research-repo` may read
 * the repo like any agent. Both get their settings whether or not the policy's sandbox is on.
 */
export function researchLanes(i: Instance, base: { runAs?: RunAs } | undefined): Record<string, { runAs?: RunAs; settings: ResearchLaneSettings }> {
  const root = dirname(i.repo.path);
  const researchRoot = join(root, RESEARCH_DIR);
  const runAs = base?.runAs;
  const home = runAs?.home ?? process.env.HOME ?? '';
  const claudeDir = runAs?.claudeConfigDir ?? (runAs ? join(home, '.claude') : i.credentials.claude?.config_dir ?? join(home, '.claude'));
  const always = [i.home, ...homeCredentialStores(home), join(claudeDir, '.credentials.json'), ...(i.credentials.eval_key ? [i.credentials.eval_key] : [])];
  const noRepo = [...always, i.repo.path, join(root, 'tasks'), join(root, 'chat')];
  const settingsFor = (denyRead: string[], hook: boolean): ResearchLaneSettings => {
    const s = sandboxSettings({ lane: { allowedDomains: [] }, denyRead });
    const deny = [...s.permissions.deny, ...denyRead.map((p) => `Glob(/${p.startsWith('/') ? p : `/${p}`}/**)`), ...denyRead.map((p) => `Grep(/${p.startsWith('/') ? p : `/${p}`}/**)`)];
    const hooks = hook ? { hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `${RESEARCH_ROOT_ENV}=${JSON.stringify(researchRoot)} node ${JSON.stringify(ENGINE_CLI)} hook pre-tool-use || exit 2`, timeout: 30 }] }] } } : {};
    return { ...(i.policy.sandbox ? { sandbox: s.sandbox } : {}), permissions: { deny }, ...hooks };
  };
  return {
    [RESEARCH_LANE]: { ...(runAs ? { runAs } : {}), settings: settingsFor(noRepo, true) },
    [RESEARCH_REPO_LANE]: { ...(runAs ? { runAs } : {}), settings: settingsFor(always, false) },
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
