import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { BRAND } from '../brand.js';
import { FILES, type AgentsConfig, type DeployConfig, type GuardrailsConfig, type ProjectConfig, type ReviewConfig, type TestsConfig } from './schema.js';

export interface Config {
  root: string;
  dir: string;
  project: ProjectConfig;
  agents: AgentsConfig;
  guardrails: GuardrailsConfig;
  tests: TestsConfig;
  review?: ReviewConfig;
  deploy?: DeployConfig;
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
const OPTIONAL = ['review.yaml', 'deploy.yaml'] as const;

function parseFile(path: string, file: string, errors: ConfigError[]): unknown {
  const doc = parseDocument(readFileSync(path, 'utf8'), { uniqueKeys: true });
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
  const errors: ConfigError[] = [];
  const out: Record<string, unknown> = {};
  if (!existsSync(dir)) throw new ConfigInvalid([{ file: BRAND.configDir, path: '', message: `missing; run \`${BRAND.cli} install\`` }]);
  for (const file of [...REQUIRED, ...OPTIONAL]) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      if ((REQUIRED as readonly string[]).includes(file)) errors.push({ file, path: '', message: 'missing' });
      continue;
    }
    const raw = parseFile(path, file, errors);
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
  });
}
