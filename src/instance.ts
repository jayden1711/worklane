// Instances: one per project, each with its own home outside any repo.
//   <instances dir>/<name>/instance.yaml     which repo(s) this instance works
//   <instances dir>/<name>/policy.yaml       operator policy: budget, limits, allowlists
//   <instances dir>/<name>/credentials.yaml  references to credentials, never values
//   <instances dir>/<name>/state/            event log, locks, worktree records
// The repo's own config folder keeps project behavior (tests, review levels,
// skills) and is reviewed like code; it may only tighten the instance policy.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { BRAND } from './brand.js';
import { ConfigInvalid, loadConfig, type Config, type ConfigError } from './config/load.js';
import { stateDir } from './os/index.js';
import type { RunAs } from './runner.js';
import { homeCredentialStores, sandboxSettings } from './sandbox.js';

const name = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, 'lowercase letters, digits and dashes');

export const InstanceFile = z.strictObject({
  version: z.literal(1),
  name,
  // One repo per instance until multi-repo instances exist.
  repos: z.array(z.strictObject({ path: z.string().min(1), repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be owner/repo') })).length(1),
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

export const PolicyFile = z.strictObject({
  version: z.literal(1),
  budget: z.strictObject({ daily_usd: z.number().positive() }),
  agents: z
    .strictObject({
      max_workers: z.number().int().min(0).max(32).default(2),
      max_stage: z.number().int().min(1).max(9).default(1),
    })
    .prefault({}),
  land_mode: z.enum(['direct', 'pr']).default('pr'),
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
  // The Claude Code config dir holding this instance's login (CLAUDE_CONFIG_DIR).
  claude: z.strictObject({ config_dir: path }),
  /** An API key file for eval lanes: owned by the eval user, unreadable to every other. */
  eval_key: path.optional(),
});

export type PolicyFile = z.infer<typeof PolicyFile>;
export type CredentialsFile = z.infer<typeof CredentialsFile>;

export interface Instance {
  name: string;
  runAs: { user: string; home: string; claudeConfigDir?: string } | null;
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
  if (cfg.agents.stage > policy.agents.max_stage) v('agents.yaml', 'stage', `stage ${cfg.agents.stage} exceeds the policy's max_stage ${policy.agents.max_stage}`);
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
  if (Object.values(policy.lanes).some((l) => l.run_as === 'eval') && !inst.run_as?.eval_user) {
    throw new ConfigInvalid([{ file: join(home, 'instance.yaml'), path: 'run_as.eval_user', message: 'a lane runs as eval, so set eval_user and eval_home' }]);
  }
  const runAs = inst.run_as ? { user: inst.run_as.agent_user, home: inst.run_as.agent_home, ...(inst.run_as.claude_config_dir ? { claudeConfigDir: inst.run_as.claude_config_dir } : {}) } : null;
  const evalAs = inst.run_as?.eval_user ? { user: inst.run_as.eval_user, home: inst.run_as.eval_home ?? `/home/${inst.run_as.eval_user}` } : null;
  return { name: instanceName, home, stateDir: join(home, 'state'), repo, policy, credentials, config, runAs, evalAs };
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
  need(c.claude.config_dir, 'Claude: config dir');
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
export function initInstance(instanceName: string, repoPath: string, repo: string, dir = instancesDir()): string {
  if (!name.safeParse(instanceName).success) throw new Error(`instance name "${instanceName}": lowercase letters, digits and dashes`);
  const home = join(dir, instanceName);
  if (existsSync(home)) throw new Error(`instance "${instanceName}" already exists at ${home}`);
  mkdirSync(join(home, 'state'), { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const write = (file: string, text: string) => writeFileSync(join(home, file), text, { mode: 0o600 });
  write(
    'instance.yaml',
    `version: 1\nname: ${instanceName}\nrepos:\n  - path: ${JSON.stringify(resolve(repoPath))}\n    repo: ${repo}\n# Agents run as this unprivileged user (create it first; see the docs on separate users).\nrun_as:\n  agent_user: ${instanceName}-agent\n  agent_home: /home/${instanceName}-agent\n`,
  );
  write('policy.yaml', `version: 1\nbudget: { daily_usd: 20 }\nagents: { max_workers: 2, max_stage: 1 }\nland_mode: pr\n`);
  write(
    'credentials.yaml',
    `# References only. Point these at credentials made for this instance; never your own login.\nversion: 1\ngithub: { kind: gh-config-dir, path: ${JSON.stringify(join(home, 'gh'))} }\nclaude: { config_dir: ${JSON.stringify(join(home, 'claude'))} }\n`,
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
    const claudeDir = runAs?.claudeConfigDir ?? (runAs ? join(home, '.claude') : i.credentials.claude.config_dir);
    const denyRead = [i.home, ...homeCredentialStores(home), join(claudeDir, '.credentials.json'), ...(lane.run_as === 'eval' || !i.credentials.eval_key ? [] : [i.credentials.eval_key])];
    out[name] = { ...(runAs ? { runAs } : {}), ...(i.policy.sandbox ? { settings: sandboxSettings({ lane: { allowedDomains: lane.allowed_domains }, denyRead }) } : {}) };
  }
  return out;
}
