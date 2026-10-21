import { gitSpawnSync } from '../os/git.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { BRAND } from '../brand.js';
import { ciNoneProblems } from '../ci-none.js';
import { optimizeProblems, type BenchmarksConfig } from '../optimize.js';
import { FILES, type AgentsConfig, type AppConfig, type DeployConfig, type GuardrailsConfig, type ProjectConfig, type ReviewConfig, type TestsConfig } from './schema.js';

export interface Config {
  root: string;
  dir: string;
  project: ProjectConfig;
  agents: AgentsConfig;
  guardrails: GuardrailsConfig;
  tests: TestsConfig;
  review?: ReviewConfig;
  deploy?: DeployConfig;
  /** The project's app, for browser checks; absent: browser checks are off (Track B is inactive). */
  app?: AppConfig;
  /** The project's declared benchmarks, for the weekly optimization pass (src/optimize.ts); absent: none. */
  benchmarks?: BenchmarksConfig;
  /** Role prompts (roles/<role>.md by role) as committed, for a config read from git; absent: read from `dir`. */
  roles?: Record<string, string>;
}

export interface ConfigError {
  file: string;
  path: string;
  message: string;
}

export class ConfigInvalid extends Error {
  constructor(readonly errors: ConfigError[]) {
    super(`${BRAND.configDir}/ is invalid:\n` + errors.map((e) => `  ${e.file}${e.path ? ` at ${e.path}` : ''}: ${e.message}`).join('\n'));
  }
}

const REQUIRED = ['config.yaml', 'agents.yaml', 'guardrails.yaml', 'tests.yaml'] as const;
const OPTIONAL = ['review.yaml', 'deploy.yaml', 'app.yaml', 'benchmarks.yaml'] as const;

function parseFile(text: string, file: string, errors: ConfigError[]): unknown {
  const doc = parseDocument(text, { uniqueKeys: true });
  for (const e of doc.errors) errors.push({ file, path: '', message: e.message.split('\n')[0]! });
  return doc.errors.length ? undefined : doc.toJS();
}

function validate<S extends z.ZodType>(schema: S, value: unknown, file: string, errors: ConfigError[]): z.infer<S> | undefined {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  for (const issue of r.error.issues) errors.push({ file, path: issue.path.join('.'), message: issue.message });
  return undefined;
}

/** Load and validate every config file. Throws ConfigInvalid listing all errors. */
export function loadConfig(root: string): Config {
  const dir = join(root, BRAND.configDir);
  if (!existsSync(dir)) throw new ConfigInvalid([{ file: BRAND.configDir, path: '', message: `missing; run \`${BRAND.cli} install\`` }]);
  return configFrom(root, (file) => {
    const path = join(dir, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  });
}

/**
 * The config committed at `rev` (e.g. origin/main), read from git and never from the working tree: the same files,
 * schema and checks as loadConfig. Throws ConfigInvalid listing all errors. `dir` stays the checkout's.
 */
export function loadConfigAt(root: string, rev: string): Config {
  const git = (...args: string[]) => gitSpawnSync(args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  if (git('rev-parse', '-q', '--verify', `${rev}:${BRAND.configDir}`).status !== 0) throw new ConfigInvalid([{ file: BRAND.configDir, path: '', message: `missing at ${rev}` }]);
  const show = (file: string) => {
    const r = git('show', `${rev}:${BRAND.configDir}/${file}`);
    return r.status === 0 ? r.stdout : null;
  };
  const cfg = configFrom(root, show);
  // The role prompts at the same commit, so agents get the instructions that config goes with.
  const listed = git('ls-tree', '--name-only', `${rev}:${BRAND.configDir}/roles`);
  const roles: Record<string, string> = {};
  for (const name of listed.status === 0 ? listed.stdout.split('\n') : []) {
    if (!name.endsWith('.md')) continue;
    const text = show(`roles/${name}`);
    if (text !== null) roles[name.slice(0, -3)] = text;
  }
  return { ...cfg, roles };
}

/** Parse, validate and cross-check every config file `read` returns (null: the file is absent). */
export function configFrom(root: string, read: (file: string) => string | null): Config {
  const dir = join(root, BRAND.configDir);
  const errors: ConfigError[] = [];
  const out: Record<string, unknown> = {};
  for (const file of [...REQUIRED, ...OPTIONAL]) {
    const text = read(file);
    if (text === null) {
      if ((REQUIRED as readonly string[]).includes(file)) errors.push({ file, path: '', message: 'missing' });
      continue;
    }
    const raw = parseFile(text, file, errors);
    if (raw !== undefined) out[file] = validate(FILES[file], raw, file, errors);
  }
  if (!errors.length) crossCheck(out, errors);
  if (errors.length) throw new ConfigInvalid(errors);
  return {
    root,
    dir,
    project: out['config.yaml'] as ProjectConfig,
    agents: out['agents.yaml'] as AgentsConfig,
    guardrails: out['guardrails.yaml'] as GuardrailsConfig,
    tests: out['tests.yaml'] as TestsConfig,
    ...(out['review.yaml'] ? { review: out['review.yaml'] as ReviewConfig } : {}),
    ...(out['deploy.yaml'] ? { deploy: out['deploy.yaml'] as DeployConfig } : {}),
    ...(out['app.yaml'] ? { app: out['app.yaml'] as AppConfig } : {}),
    ...(out['benchmarks.yaml'] ? { benchmarks: out['benchmarks.yaml'] as BenchmarksConfig } : {}),
  };
}

function crossCheck(out: Record<string, unknown>, errors: ConfigError[]) {
  const project = out['config.yaml'] as ProjectConfig;
  const guardrails = out['guardrails.yaml'] as GuardrailsConfig;
  const writers = new Set(project.owners.writers);
  if (!writers.has(project.owners.default)) {
    errors.push({ file: 'config.yaml', path: 'owners.default', message: 'default owner must be one of owners.writers' });
  }
  project.owners.areas.forEach((a, i) => {
    if (!writers.has(a.owner)) errors.push({ file: 'config.yaml', path: `owners.areas.${i}.owner`, message: `${a.owner} is not in owners.writers` });
  });
  const ids = new Set<string>();
  guardrails.rules.forEach((r, i) => {
    if (ids.has(r.id)) errors.push({ file: 'guardrails.yaml', path: `rules.${i}.id`, message: `duplicate rule id ${r.id}` });
    ids.add(r.id);
    if ('connection' in r.match && !guardrails.fingerprints[r.match.connection.fingerprints]) {
      errors.push({ file: 'guardrails.yaml', path: `rules.${i}.match.connection.fingerprints`, message: `no fingerprint set named ${r.match.connection.fingerprints}` });
    }
  });  // Every optimize target names a declared benchmark (or the slowest test, with a command to run one).
  for (const e of optimizeProblems(project.optimize, out['benchmarks.yaml'] as BenchmarksConfig | undefined)) errors.push({ file: 'config.yaml', ...e });
  for (const e of ciNoneProblems(project, out['tests.yaml'] as TestsConfig)) errors.push({ file: 'config.yaml', ...e });
}
