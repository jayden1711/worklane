#!/usr/bin/env node
// The unit test files a pull request can affect, from the import graph of the engine's code (src/testrun/affected.ts,
// built: run after `npm run build`). A test runs when it imports a changed file (directly or not), or reads one
// (join(repoRoot, …), new URL('…', import.meta.url)). The whole suite runs on anything but a pull request, and when
// the change touches a file everything depends on (below), deletes or renames a file, changes a script, or names a
// file in a way the graph can't follow. docs/test-runs.md, "Test selection".
//
//   node scripts/ci/affected.mjs --event pull_request --base <rev>   the selected test files (test/x.test.ts), one per line
//   node scripts/ci/affected.mjs --event push                        every test file (any event but pull_request)
//   add --explain for why each one was selected (on stderr)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Changed files that force the whole suite: what every test depends on without importing it. */
export const FORCE_ALL = [
  [/^package(-lock)?\.json$/, 'the dependencies'],
  [/(^|\/)tsconfig[^/]*\.json$/, 'the compiler settings'],
  [/^\.nvmrc$/, 'the Node version'],
  [/^test\/helpers\.ts$/, 'the helpers every test uses'],
  // Every test process runs it first (--import), and it wraps how each one starts its children (#991).
  [/^test\/isolate\.ts$/, 'the preload every test process runs'],
  [/^scripts\/ci\//, 'the CI scripts'],
  [/^\.github\//, 'the workflows'],
];

/**
 * test/helpers.ts, described per export instead of scanned (nearly every test imports it, most for repoRoot alone):
 * a test that uses one of these names reaches these paths (repoRoot is the whole repo; engineCli runs src/cli.ts and
 * all it imports). test/ci-affected.test.ts checks this covers everything helpers.ts imports and reads.
 */
export const HELPER_PATHS = {
  'test/helpers.ts': {
    repoRoot: '',
    engineCli: 'dist/src/cli.js',
    agentIsSelf: ['dist/src/cli.js', 'src/install.ts', 'src/agent-settings.ts'],
    exampleProject: 'examples/basic',
    loopbackGitHub: 'scripts/ci/loopback-github.mjs',
  },
};

export const isTest = (f) => /^test\/.+\.test\.ts$/.test(f);
export const forceAll = (f) => FORCE_ALL.find(([re]) => re.test(f))?.[1] ?? null;

const escape = (s) => s.replace(/[.*+?^$()[\]{}|\\/]/g, '\\$&');
// What tsc builds, read from the tree's tsconfig.json: with rootDir '.' and an outDir inside the tree, each `include`
// entry of the form <dir>/**/*.ts builds <dir>/x.ts into <outDir>/<dir>/x.js. Anything else there is left unmapped,
// so a test importing its built file has an unresolved import and runs on every change. A tsconfig.json that isn't
// JSON fails the plan (CI goes red) rather than guess. A change to any tsconfig runs the whole suite (FORCE_ALL).
export function compiledPaths(dir) {
  const ts = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'));
  const out = ts.compilerOptions?.outDir;
  const ok = ts.compilerOptions?.rootDir === '.' && typeof out === 'string' && /^[\w.-]+(\/[\w.-]+)*$/.test(out) && !/(^|\/)\.\.?(\/|$)/.test(out);
  const dirs = !ok ? [] : (Array.isArray(ts.include) ? ts.include : []).map((i) => /^([\w-][\w.-]*(?:\/[\w-][\w.-]*)*)\/\*\*\/\*\.ts$/.exec(i)?.[1]).filter(Boolean);
  if (!dirs.length) return { runtimePath: (f) => f, sourcePath: (p) => p };
  const alt = dirs.map(escape).join('|');
  const built = new RegExp(`^(?:${alt})/.+\\.ts$`);
  const back = new RegExp(`^${escape(out)}/(?:${alt})(?:/|$)`);
  return {
    /** Where a source runs from: src/x.ts -> dist/src/x.js. */
    runtimePath: (f) => (built.test(f) ? `${out}/${f.replace(/\.ts$/, '.js')}` : f),
    /**
     * A built path back to its source: dist/src/x.js -> src/x.js. dist/web (the dashboard's build of web/) stays as
     * it is: a test that opens the built UI (test/browser-helpers.ts's webUiSkip) does so through the dashboard, whose
     * src/ module reads the package (packagePaths: dist/web is web/), so a web/ change picks it that way; web/'s own
     * tests read web/ directly (join(repoRoot, 'web', …)).
     */
    sourcePath: (p) => (back.test(p) ? p.slice(out.length + 1) : p),
  };
}
/** The engine's own (this checkout's tsconfig.json): src/, test/ and scripts/bench/ build into dist/. */
export const { runtimePath, sourcePath } = compiledPaths(root);

/**
 * The engine's package: what a src/ module reads when it reads the directory it runs from as a whole (npm pack of
 * the engine, an install's root): package.json and its `files`, built paths back to their sources. A test's own
 * whole-repo read (cwd: repoRoot, git archive) stays the whole repo.
 */
export function packagePaths(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const { sourcePath } = compiledPaths(dir);
  const files = (pkg.files ?? []).filter((f) => !f.startsWith('!')).map((f) => (f === 'dist/web' ? 'web' : sourcePath(f)));
  return [...new Set(['package.json', 'README.md', ...files])];
}
export const wholeRead = (dir) => {
  const paths = packagePaths(dir);
  return (file) => (file.startsWith('src/') ? paths : null);
};

/** The plan for a change to the repo at `dir` (its working tree is the change's head): `changed` and `added` paths. */
export async function plan(dir, changed, added = new Set()) {
  const a = await import(pathToFileURL(join(root, 'dist', 'src', 'testrun', 'affected.js')).href);
  const files = git(dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard');
  const g = a.buildGraph({ files, read: (f) => readFileSync(join(dir, f), 'utf8'), pathModules: HELPER_PATHS, ...compiledPaths(dir), wholeRead: wholeRead(dir) });
  return a.selectTests(g, changed, { isTest, forceAll, added });
}

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean);

function arg(args, name) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

async function main(args) {
  const event = arg(args, '--event');
  const base = arg(args, '--base');
  const dir = arg(args, '--root') ?? root;
  if (!event) throw new Error('usage: affected.mjs --event <github event> [--base <rev>] [--explain]');
  const every = git(dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', 'test').filter(isTest).sort();
  let p;
  if (event !== 'pull_request') p = { all: `${event}, not a pull request's change: everything runs`, tests: every, why: {} };
  else {
    if (!base) throw new Error('a pull request needs --base <rev>');
    const changed = git(dir, 'diff', '--name-only', '--no-renames', '-z', base, 'HEAD');
    const added = new Set(git(dir, 'diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', base, 'HEAD'));
    p = await plan(dir, changed, added);
    console.error(`changed: ${changed.length} file(s)${changed.length ? `: ${changed.slice(0, 20).join(', ')}${changed.length > 20 ? ', …' : ''}` : ''}`);
  }
  console.error(p.all ? `the whole suite (${p.tests.length} test files): ${p.all}` : `selected ${p.tests.length} of ${every.length} test files`);
  if (args.includes('--explain') && !p.all) for (const t of p.tests) console.error(`  ${t}: ${p.why[t].join(', ')}`);
  for (const t of p.tests) console.log(t);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`affected: ${e.message}`);
    process.exit(2);
  });
}
