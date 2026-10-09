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

const name = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, 'lowercase letters, digits and dashes');

export const InstanceFile = z.strictObject({
  version: z.literal(1),
  name,
  // One repo per instance until multi-repo instances exist.
  repos: z.array(z.strictObject({ path: z.string().min(1), repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be owner/repo') })).length(1),
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
});

export type PolicyFile = z.infer<typeof PolicyFile>;
export type CredentialsFile = z.infer<typeof CredentialsFile>;

export interface Instance {
  name: string;
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
  return { name: instanceName, home, stateDir: join(home, 'state'), repo, policy, credentials, config };
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
  write('instance.yaml', `version: 1\nname: ${instanceName}\nrepos:\n  - path: ${JSON.stringify(resolve(repoPath))}\n    repo: ${repo}\n`);
  write('policy.yaml', `version: 1\nbudget: { daily_usd: 20 }\nagents: { max_workers: 2, max_stage: 1 }\nland_mode: pr\n`);
  write(
    'credentials.yaml',
    `# References only. Point these at credentials made for this instance; never your own login.\nversion: 1\ngithub: { kind: gh-config-dir, path: ${JSON.stringify(join(home, 'gh'))} }\nclaude: { config_dir: ${JSON.stringify(join(home, 'claude'))} }\n`,
  );
  return home;
}
