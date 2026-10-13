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
  },
};

export const isTest = (f) => /^test\/.+\.test\.ts$/.test(f);
export const forceAll = (f) => FORCE_ALL.find(([re]) => re.test(f))?.[1] ?? null;
/** Where a source runs from: tsc builds src/ and test/ into dist/. */
export const runtimePath = (f) => (/^(src|test)\/.+\.ts$/.test(f) ? `dist/${f.replace(/\.ts$/, '.js')}` : f);
/**
 * A built path back to its source: dist/src and dist/test are tsc's. dist/web (the dashboard's build of web/) stays
 * as it is: the unit tests run before anything builds it, so no test reaches web/ through the dashboard; web/'s own
 * tests read web/ directly (join(repoRoot, 'web', …)), and those are what a web/ change picks.
 */
export const sourcePath = (p) => (/^dist\/(src|test)(\/|$)/.test(p) ? p.slice(5) : p);

/** The plan for a change to the repo at `dir` (its working tree is the change's head): `changed` and `added` paths. */
export async function plan(dir, changed, added = new Set()) {
  const a = await import(pathToFileURL(join(root, 'dist', 'src', 'testrun', 'affected.js')).href);
  const files = git(dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard');
  const g = a.buildGraph({ files, read: (f) => readFileSync(join(dir, f), 'utf8'), pathModules: HELPER_PATHS, runtimePath, sourcePath });
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
