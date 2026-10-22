import { spawnSync } from '../os/child-process.js';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
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

/** The most readRegular reads by default: a config file, a `.git` pointer or a task file is a few KB. */
export const REGULAR_FILE_MAX_BYTES = 1024 * 1024;

/** A file readRegular won't read: not a regular file, or over its size cap. */
export class NotRegularFile extends Error {}

/**
 * `file`'s text when it is a regular file of at most `max` bytes (a symlink is followed, as readFileSync follows it);
 * null when there is none (ENOENT). A FIFO, socket, device or directory, or a file over `max`, throws NotRegularFile;
 * any other failure throws as it is.
 * THREAT (#890 round 9): an agent can put a FIFO at a name in its own checkout (`.git`, the config folder's YAML files), and
 * readFileSync on a FIFO nobody writes to waits forever: in the coordinator's process that holds every run and every
 * stop. So the file is checked before it is opened (a device is never opened), opened with O_NONBLOCK (a FIFO swapped
 * in after the check opens at once instead of waiting), checked again on the descriptor, and read up to `max` + 1 bytes.
 */
export function readRegular(file: string, max = REGULAR_FILE_MAX_BYTES): string | null {
  const notRegular = () => new NotRegularFile(`${file} isn't a regular file (a FIFO, socket, device or directory), so it isn't read`);
  try {
    if (!statSync(file).isFile()) throw notRegular();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw notRegular();
    const over = (n: number) => new NotRegularFile(`${file} is ${n} bytes, over ${max}, so it isn't read`);
    if (st.size > max) throw over(st.size);
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > max) throw over(n);
    }
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Load and validate every config file. Throws ConfigInvalid listing all errors. Each file is read with readRegular:
 * one that isn't a regular file, or is over its cap, is an error in the config, never waited on.
 */
export function loadConfig(root: string): Config {
  const dir = join(root, BRAND.configDir);
  if (!existsSync(dir)) throw new ConfigInvalid([{ file: BRAND.configDir, path: '', message: `missing; run \`${BRAND.cli} install\`` }]);
  return configFrom(root, (file) => {
    const path = join(dir, file);
    if (!existsSync(path)) return null;
    try {
      return readRegular(path);
    } catch (e) {
      if (e instanceof NotRegularFile) throw new ConfigInvalid([{ file, path: '', message: e.message }]);
      throw e;
    }
  });
}

/**
 * The config committed at `rev` (e.g. origin/main), read from git and never from the working tree: the same files,
 * schema and checks as loadConfig. Throws ConfigInvalid listing all errors. `dir` stays the checkout's.
 */
export function loadConfigAt(root: string, rev: string): Config {
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
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
