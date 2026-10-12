// What a project is built with, read from its files (nothing is run): the package manager and its lockfile,
// the test runner and its commands, and the CI workflows with the names GitHub shows for their jobs. From it,
// the project's config folder, written from the engine's templates with real values instead of placeholders.
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, parseDocument } from 'yaml';
import { BRAND } from '../brand.js';
import { loadConfig } from '../config/load.js';
import { templatesDir } from '../install.js';

export type Ecosystem = 'node' | 'python' | 'go' | 'rust' | 'unknown';

export interface Stack {
  ecosystem: Ecosystem;
  packageManager: string | null;
  lockfile: string | null;
  /** The runner, as far as the files say (vitest, jest, mocha, node:test, pytest, go test, cargo test). */
  testRunner: string | null;
  commands: { install: string | null; test: string | null; one: string | null };
  testGlobs: string[];
  appPaths: string[];
  /** Each workflow file and the check names its pull-request jobs report, as GitHub shows them. */
  workflows: { file: string; checks: string[] }[];
  /** Every pull-request check name, across workflows: the required checks proposed for main. */
  checks: string[];
  notes: string[];
}

const read = (dir: string, f: string) => {
  try {
    return readFileSync(join(dir, f), 'utf8');
  } catch {
    return null;
  }
};

const LOCKS: [string, string, string][] = [
  ['pnpm-lock.yaml', 'pnpm', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn', 'yarn install --frozen-lockfile'],
  ['bun.lockb', 'bun', 'bun install --frozen-lockfile'],
  ['bun.lock', 'bun', 'bun install --frozen-lockfile'],
  ['package-lock.json', 'npm', 'npm ci'],
  ['npm-shrinkwrap.json', 'npm', 'npm ci'],
];

function nodeStack(dir: string, pkgText: string, notes: string[]): Omit<Stack, 'workflows' | 'checks' | 'notes'> {
  let pkg: { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string>; packageManager?: string } = {};
  try {
    pkg = JSON.parse(pkgText) as typeof pkg;
  } catch {
    notes.push('package.json is not valid JSON; the test commands are guesses');
  }
  const lock = LOCKS.find(([f]) => existsSync(join(dir, f)));
  const declared = pkg.packageManager?.split('@')[0] ?? null;
  const pm = lock?.[1] ?? declared ?? 'npm';
  if (!lock) notes.push('no lockfile: worktrees install without one');
  const run = (script: string) => (pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const testScript = pkg.scripts?.test;
  const runner = deps.vitest ? 'vitest' : deps.jest ? 'jest' : deps.mocha ? 'mocha' : /\bnode\b[^&|;]*--test\b/.test(testScript ?? '') ? 'node:test' : testScript ? 'script' : null;
  const one = runner === 'vitest' ? `npx vitest run {file}` : runner === 'jest' ? `npx jest {file}` : runner === 'mocha' ? `npx mocha {file}` : runner === 'node:test' ? `node --test {file}` : null;
  const globs = runner === 'vitest' || runner === 'jest' ? ['**/*.test.{js,ts,jsx,tsx}', '**/*.spec.{js,ts,jsx,tsx}'] : ['test/**/*.test.{js,ts}', 'test/**/*.spec.{js,ts}'];
  if (!testScript) notes.push('package.json has no test script: set tests.yaml runner commands by hand');
  return {
    ecosystem: 'node',
    packageManager: pm,
    lockfile: lock?.[0] ?? null,
    testRunner: runner,
    commands: { install: lock?.[2] ?? `${pm} install`, test: testScript ? (pm === 'npm' ? 'npm test' : run('test')) : null, one },
    testGlobs: globs,
    appPaths: existsSync(join(dir, 'src')) ? ['src/**'] : ['**/*.{js,ts,jsx,tsx}'],
  };
}

/** Read the stack from a checkout. */
export function detectStack(dir: string): Stack {
  const notes: string[] = [];
  let base: Omit<Stack, 'workflows' | 'checks' | 'notes'>;
  const pkg = read(dir, 'package.json');
  if (pkg !== null) base = nodeStack(dir, pkg, notes);
  else if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'requirements.txt'))) {
    const [pm, lock, install] = existsSync(join(dir, 'uv.lock')) ? ['uv', 'uv.lock', 'uv sync --frozen'] : existsSync(join(dir, 'poetry.lock')) ? ['poetry', 'poetry.lock', 'poetry install --no-root'] : ['pip', existsSync(join(dir, 'requirements.txt')) ? 'requirements.txt' : null, existsSync(join(dir, 'requirements.txt')) ? 'pip install -r requirements.txt' : 'pip install -e .'];
    const pre = pm === 'uv' ? 'uv run ' : pm === 'poetry' ? 'poetry run ' : '';
    base = { ecosystem: 'python', packageManager: pm!, lockfile: lock ?? null, testRunner: 'pytest', commands: { install: install!, test: `${pre}pytest`, one: `${pre}pytest {file}` }, testGlobs: ['tests/**/test_*.py', 'test/**/test_*.py', '**/*_test.py'], appPaths: ['**/*.py'] };
  } else if (existsSync(join(dir, 'go.mod'))) {
    base = { ecosystem: 'go', packageManager: 'go', lockfile: existsSync(join(dir, 'go.sum')) ? 'go.sum' : null, testRunner: 'go test', commands: { install: 'go mod download', test: 'go test ./...', one: 'go test {file}' }, testGlobs: ['**/*_test.go'], appPaths: ['**/*.go'] };
  } else if (existsSync(join(dir, 'Cargo.toml'))) {
    base = { ecosystem: 'rust', packageManager: 'cargo', lockfile: existsSync(join(dir, 'Cargo.lock')) ? 'Cargo.lock' : null, testRunner: 'cargo test', commands: { install: 'cargo fetch', test: 'cargo test', one: 'cargo test --test {file}' }, testGlobs: ['tests/**/*.rs'], appPaths: ['src/**'] };
  } else {
    notes.push('no package.json, pyproject.toml, go.mod or Cargo.toml: set the test commands in tests.yaml by hand');
    base = { ecosystem: 'unknown', packageManager: null, lockfile: null, testRunner: null, commands: { install: null, test: null, one: null }, testGlobs: [], appPaths: [] };
  }
  const workflows = detectWorkflows(dir, notes);
  const checks = [...new Set(workflows.flatMap((w) => w.checks))];
  if (!workflows.length) notes.push('no GitHub Actions workflows: no required checks to propose');
  return { ...base, workflows, checks, notes };
}

type Job = { name?: unknown; strategy?: { matrix?: unknown } };

/** The values of a matrix's plain lists, in key order, as GitHub joins them into a job's name. Includes/excludes make it a guess. */
function matrixNames(name: string, matrix: unknown, notes: string[], file: string): string[] {
  if (matrix === undefined || matrix === null) return [name];
  const m = matrix as Record<string, unknown>;
  if (typeof matrix !== 'object' || Array.isArray(matrix) || Object.values(m).some((v) => typeof v === 'string' && /\$\{\{/.test(v))) {
    notes.push(`${file}: job ${name} has a computed matrix; its check names are not listed`);
    return [];
  }
  const keys = Object.keys(m).filter((k) => k !== 'include' && k !== 'exclude' && Array.isArray(m[k]));
  if (m.include || m.exclude) notes.push(`${file}: job ${name}'s matrix has include/exclude; check its names on a PR before requiring them`);
  if (!keys.length) return [name];
  let combos: string[][] = [[]];
  for (const k of keys) combos = combos.flatMap((c) => (m[k] as unknown[]).map((v) => [...c, typeof v === 'object' ? JSON.stringify(v) : String(v)]));
  return combos.map((c) => `${name} (${c.join(', ')})`);
}

/** The workflows that run on pull requests, and their jobs' check names. */
export function detectWorkflows(dir: string, notes: string[] = []): Stack['workflows'] {
  const wf = join(dir, '.github', 'workflows');
  if (!existsSync(wf)) return [];
  const out: Stack['workflows'] = [];
  for (const f of readdirSync(wf).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    let doc: { on?: unknown; true?: unknown; jobs?: Record<string, Job> };
    try {
      doc = parseYaml(readFileSync(join(wf, f), 'utf8')) as typeof doc;
    } catch {
      notes.push(`.github/workflows/${f} is not valid YAML; skipped`);
      continue;
    }
    // YAML 1.1 readers turn a bare `on:` into true; the yaml package keeps "on", but be safe.
    const on = doc?.on ?? doc?.true;
    const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on : on && typeof on === 'object' ? Object.keys(on) : [];
    if (!events.some((e) => e === 'pull_request' || e === 'pull_request_target')) continue;
    const checks: string[] = [];
    for (const [id, job] of Object.entries(doc.jobs ?? {})) {
      const name = typeof job?.name === 'string' && !/\$\{\{/.test(job.name) ? job.name : id;
      checks.push(...matrixNames(name, job?.strategy?.matrix, notes, `.github/workflows/${f}`));
    }
    out.push({ file: `.github/workflows/${f}`, checks });
  }
  return out;
}

export interface ProjectValues {
  name: string;
  repo: string;
  defaultBranch: string;
  /** The owner's GitHub login: default owner, the one writer, and who gets reports. */
  owner: string;
  dailyBudgetUsd: number;
}

/**
 * Write the config folder from the engine's templates, with real values: the project, the owner, the
 * required checks, the test commands, the worktree setup, the budget. Comments in the templates are kept.
 * The result must load: a template change that breaks it fails here, not in the owner's PR.
 */
export function writeProjectConfig(dir: string, stack: Stack, v: ProjectValues): string[] {
  const cfgDir = join(dir, BRAND.configDir);
  if (existsSync(cfgDir)) throw new Error(`${BRAND.configDir}/ already exists in ${dir}`);
  cpSync(templatesDir(), cfgDir, { recursive: true });
  const edit = (file: string, f: (d: ReturnType<typeof parseDocument>) => void) => {
    const p = join(cfgDir, file);
    const text = readFileSync(p, 'utf8').replaceAll('{{name}}', v.name).replaceAll('{{repo}}', v.repo);
    const d = parseDocument(text);
    f(d);
    writeFileSync(p, d.toString());
  };
  edit('config.yaml', (d) => {
    d.setIn(['project', 'default_branch'], v.defaultBranch);
    d.setIn(['required_checks'], d.createNode(stack.checks, { flow: true }));
    d.setIn(['owners', 'default'], v.owner);
    d.setIn(['owners', 'writers'], d.createNode([v.owner], { flow: true }));
    d.setIn(['reports', 'to'], d.createNode([v.owner], { flow: true }));
  });
  edit('tests.yaml', (d) => {
    if (stack.commands.test) {
      d.setIn(['runner', 'changed'], stack.commands.test);
      d.setIn(['runner', 'full'], stack.commands.test);
    }
    if (stack.commands.one) d.setIn(['runner', 'one'], stack.commands.one);
    if (stack.testGlobs.length) d.setIn(['vacuity', 'test_globs'], d.createNode(stack.testGlobs, { flow: true }));
    if (stack.appPaths.length) d.setIn(['vacuity', 'app_paths'], d.createNode(stack.appPaths, { flow: true }));
    if (stack.commands.install) d.setIn(['worktree', 'setup'], d.createNode([stack.commands.install], { flow: true }));
  });
  edit('agents.yaml', (d) => {
    d.setIn(['daily_budget_usd'], v.dailyBudgetUsd);
  });
  loadConfig(dir);
  const notes = [...stack.notes];
  if (!stack.commands.test) notes.push('tests.yaml still runs `npm test`: set the project\'s own test commands');
  return notes;
}
