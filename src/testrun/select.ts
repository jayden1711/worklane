// test_run.select: which test files a PR's fast run hands its tiers (docs/test-runs.md, "Test selection").
//
//   repo     the repo's own planner: a tier passes {changed_files} to it (the default when a tier does)
//   imports  the engine's import graph (./affected.ts), for a JS/TS repo: a tier gets the test files the change can
//            affect in {tests}, or nothing (the whole suite) when the graph can't tell
//   off      no selection (the default otherwise)
//
// The graph is read from the coordinator's clone at the run's commit (git ls-tree, git cat-file), never from the
// workspace: the sandboxed test user owns that.
import { builtinModules } from 'node:module';
import { BRAND } from '../brand.js';
import { gitSpawnSync } from '../os/git.js';
import { buildGraph, CODE_EXT, selectTests, type Plan } from './affected.js';
import type { TestRunConfig } from './config.js';

export type SelectMode = 'imports' | 'repo' | 'off';

/** The mode a config runs: its own, else `repo` when a tier passes {changed_files} (a planner of the repo's), else off. */
export function selectMode(c: Pick<TestRunConfig, 'tiers'> & { select?: SelectMode | undefined }): SelectMode {
  return c.select ?? (c.tiers.some((t) => t.command.includes('{changed_files}')) ? 'repo' : 'off');
}

/** A JS/TS test file: *.test.* or *.spec.*, or anything under __tests__/. */
export const isJsTest = (f: string) => CODE_EXT.test(f) && (/(?:^|\/)__tests__\//.test(f) || /\.(?:test|spec)\.[^/.]+$/.test(f)) && !/(?:^|\/)node_modules\//.test(f);

/** Changed files every test may depend on without importing them: the whole suite runs. */
export function jsForceAll(f: string): string | null {
  if (/(?:^|\/)package\.json$/.test(f)) return 'a package manifest';
  if (/(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?)$/.test(f)) return 'the dependencies';
  if (/(?:^|\/)(?:tsconfig|jsconfig)[^/]*\.json$/.test(f)) return 'the compiler settings';
  if (/(?:^|\/)[^/]+\.config\.[cm]?[jt]s$/.test(f) || /(?:^|\/)\.(?:babelrc|swcrc|mocharc|c8rc|nycrc)[^/]*$/.test(f)) return 'a tool config (test setup files are named there)';
  if (/^(?:\.nvmrc|\.node-version|\.tool-versions)$/.test(f)) return 'the Node version';
  if (f.startsWith('.github/') || f.startsWith(`${BRAND.configDir}/`)) return 'CI or the project config';
  return null;
}

/** Bare imports that are packages: Node's builtins, and the root package.json's dependencies of every kind. */
function packageCheck(pkgJson: string | null): (spec: string) => boolean {
  const deps = new Set<string>();
  try {
    const pkg = JSON.parse(pkgJson ?? '{}') as Record<string, unknown>;
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) for (const d of Object.keys((pkg[k] as object | undefined) ?? {})) deps.add(d);
  } catch {
    // no dependencies known: every bare import that isn't a builtin is one this can't follow
  }
  const builtins = new Set(builtinModules);
  return (spec) => {
    if (spec.startsWith('.') || spec.startsWith('/')) return false;
    if (spec.startsWith('node:') || builtins.has(spec.split('/')[0]!)) return true;
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
    return deps.has(name);
  };
}

const git = (repo: string, args: string[], input?: string) => gitSpawnSync(['-C', repo, ...args], { input, maxBuffer: 512 * 1024 * 1024, timeout: 120_000 });

/** Each file's contents at `sha`, through one git cat-file --batch. A file over 1 MB reads as empty (built output). */
export function readAt(repo: string, sha: string, files: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!files.length) return out;
  const r = git(repo, ['cat-file', '--batch'], files.map((f) => `${sha}:${f}\n`).join(''));
  if (r.status !== 0) throw new Error(`git cat-file at ${sha.slice(0, 10)}: ${r.stderr.toString().trim().slice(0, 300)}`);
  const buf = r.stdout;
  let at = 0;
  for (const f of files) {
    const nl = buf.indexOf(0x0a, at);
    const head = buf.subarray(at, nl).toString();
    at = nl + 1;
    const m = /^\S+ blob (\d+)$/.exec(head);
    if (!m) continue; // missing, or not a blob
    const size = Number(m[1]);
    out.set(f, size > 1024 * 1024 ? '' : buf.subarray(at, at + size).toString('utf8'));
    at += size + 1;
  }
  return out;
}

/** The plan for a change at `sha` in the clone at `repo`: the JS/TS test files it can affect, or the whole suite. */
export function importsPlan(repo: string, sha: string, changed: readonly string[]): Plan {
  const ls = git(repo, ['ls-tree', '-r', '-z', '--name-only', sha]);
  if (ls.status !== 0) throw new Error(`git ls-tree ${sha.slice(0, 10)}: ${ls.stderr.toString().trim().slice(0, 300)}`);
  const files = ls.stdout.toString().split('\0').filter((f) => f && !/(?:^|\/)node_modules\//.test(f));
  if (!files.includes('package.json')) return { all: 'not a JS/TS repo (no package.json at its root)', tests: files.filter(isJsTest).sort(), why: {} };
  const code = files.filter((f) => CODE_EXT.test(f));
  const text = readAt(repo, sha, [...code, 'package.json']);
  const g = buildGraph({ files, read: (f) => text.get(f) ?? '', isPackage: packageCheck(text.get('package.json') ?? null) });
  return selectTests(g, changed, { isTest: isJsTest, forceAll: jsForceAll });
}

/** A tier's {tests}: the test files, shell-quoted and space-separated; '' for the whole suite (a runner given no files runs them all). */
export function testsArg(tests: readonly string[] | null): string {
  return tests === null ? '' : tests.map((t) => `'${t.replace(/'/g, `'\\''`)}'`).join(' ');
}
