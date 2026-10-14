// test_run.select (src/testrun/select.ts): repo keeps a project's own planner as it was, imports runs the engine's
// import graph over a JS/TS repo and hands {tests} only the test files the change can affect, off selects nothing.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { localHost } from '../src/testrun/host.js';
import { runTestRun, selectionFor, tierCommand, type TestRunDeps } from '../src/testrun/run.js';
import { importsPlan, isJsTest, jsForceAll, readAt, selectMode, testsArg } from '../src/testrun/select.js';
import { exampleProject } from './helpers.js';

const skip = process.platform === 'win32' && 'bash and a POSIX workspace';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const tier = (command: string, kind: 'fast' | 'full' = 'fast') => ({ name: kind === 'fast' ? 'unit' : 'suite', command, kind });
const issues = (c: unknown) => {
  const r = TestRunConfig.safeParse(c);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

test('the mode: a config\'s own, else repo when a tier passes {changed_files} (a project\'s own planner), else off', () => {
  const planner = TestRunConfig.parse({ tiers: [tier('node scripts/plan.js {changed_files}')] });
  assert.equal(selectMode(planner), 'repo');
  assert.equal(planner.select, undefined, 'nothing written into a config that had none');
  // The planner's command is filled exactly as before select existed.
  assert.equal(tierCommand(planner.tiers[0]!, { index: 1, total: 1 }, '/run/changed-files', null), "node scripts/plan.js '/run/changed-files'");
  assert.equal(selectionFor({ config: planner, repo: '/nowhere' }, { kind: 'fast', sha: 'a'.repeat(40), changedFiles: ['x'] }).line, '', 'repo mode: the engine selects nothing');
  assert.equal(selectMode(TestRunConfig.parse({ tiers: [tier('npm test')] })), 'off');
  assert.equal(selectMode(TestRunConfig.parse({ select: 'imports', tiers: [tier('node --test {tests}')] })), 'imports');
});

test('each mode needs its placeholder, and only it fills one', () => {
  assert.deepEqual(issues({ select: 'imports', tiers: [tier('node --test {tests}')] }), []);
  assert.match(issues({ tiers: [tier('node --test {tests}')] }).join(), /\{tests\} is filled only with select: imports \(this config's is off\)/);
  assert.match(issues({ select: 'repo', tiers: [tier('plan {changed_files}'), tier('node --test {tests}', 'full')] }).join(), /only with select: imports/);
  assert.match(issues({ select: 'off', tiers: [tier('plan {changed_files}')] }).join(), /select: off hands no tier the changed files/);
  assert.match(issues({ select: 'imports', tiers: [tier('npm test'), tier('node --test {tests}', 'full')] }).join(), /needs a fast tier that passes \{tests\}/);
  assert.deepEqual(issues({ select: 'imports', tiers: [tier('node --test {tests}'), tier('plan {changed_files}', 'full')] }), [], 'imports may still hand a tier the changed files');
  assert.match(issues({ select: 'some', tiers: [tier('npm test')] }).join(), /imports|repo|off/);
});

test('{tests}: the files shell-quoted, or nothing for the whole suite', () => {
  const t = TestRunConfig.parse({ select: 'imports', tiers: [tier('node --test {tests}')] }).tiers[0]!;
  assert.equal(tierCommand(t, { index: 1, total: 1 }, null, ['test/a.test.js', "test/it's.test.js"]), `node --test 'test/a.test.js' 'test/it'\\''s.test.js'`);
  assert.equal(tierCommand(t, { index: 1, total: 1 }, null, null), 'node --test ');
  assert.equal(testsArg([]), '');
});

test('the JS/TS rules: what a test file is, and what forces the whole suite', () => {
  for (const f of ['a.test.js', 'src/x.spec.ts', 'pkg/__tests__/y.tsx', 'test/z.test.mjs']) assert.ok(isJsTest(f), f);
  for (const f of ['src/test.js', 'test/helpers.ts', 'node_modules/x/a.test.js', 'a.test.py']) assert.ok(!isJsTest(f), f);
  for (const f of ['package.json', 'web/package.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.base.json', 'vitest.config.ts', 'jest.config.js', '.babelrc', '.nvmrc', '.github/workflows/ci.yml', '.worklane/tests.yaml']) {
    assert.ok(jsForceAll(f), f);
  }
  for (const f of ['src/a.ts', 'README.md', 'test/a.test.js']) assert.equal(jsForceAll(f), null, f);
});

/** A small JS repo: two modules, three tests (one through an alias the graph can't follow), a fixture, docs. */
function jsRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'select-repo-'));
  const w = (f: string, s: string) => {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), s);
  };
  w('package.json', JSON.stringify({ name: 'shop', type: 'module', devDependencies: { vitest: '1.0.0' } }));
  w('src/price.js', "import { round } from './round.js';\nexport const total = (x) => round(x);\n");
  w('src/round.js', 'export const round = (x) => Math.round(x);\n');
  w('src/cart.js', "export const cart = () => [];\n");
  w('test/price.test.js', "import { test } from 'vitest';\nimport { total } from '../src/price.js';\ntest('t', () => total(1));\n");
  w('test/cart.test.js', "import { cart } from '../src/cart.js';\nimport { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst data = readFileSync(join(import.meta.dirname, 'fixtures', 'cart.json'), 'utf8');\n");
  w('test/fixtures/cart.json', '[]\n');
  w('test/alias.test.js', "import { x } from '@/lib/x';\n");
  w('docs/notes.md', '# notes\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=a@example.com', '-c', 'user.name=A', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') };
}

test('imports: a change selects the tests that import it, through other modules, or read it; an unfollowable import always runs', () => {
  const r = jsRepo();
  try {
    assert.deepEqual(readAt(r.dir, r.sha, ['src/cart.js', 'nope.js']), new Map([['src/cart.js', 'export const cart = () => [];\n']]));
    const plan = (...changed: string[]) => importsPlan(r.dir, r.sha, changed);
    assert.deepEqual(plan('src/round.js').tests, ['test/alias.test.js', 'test/price.test.js'], 'price imports round through price.js; the alias test always runs');
    assert.deepEqual(plan('src/cart.js').tests, ['test/alias.test.js', 'test/cart.test.js']);
    assert.deepEqual(plan('test/fixtures/cart.json').tests, ['test/alias.test.js', 'test/cart.test.js'], 'a fixture the test reads from its own directory');
    assert.match(plan('test/alias.test.js').why['test/alias.test.js']!.join(), /always: unresolved import @\/lib\/x/);
    assert.deepEqual(plan('docs/notes.md').tests, ['test/alias.test.js'], 'documentation nothing names selects nothing more');
    assert.match(plan('package.json').all ?? '', /package manifest/);
    assert.match(plan('src/gone.js').all ?? '', /deleted or renamed/);
    assert.equal(plan('package.json').tests.length, 3, 'the whole suite is every test file');
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('imports: a repo without a package.json gets the whole suite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'select-py-'));
  try {
    writeFileSync(join(dir, 'app.py'), 'x = 1\n');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.email=a@example.com', '-c', 'user.name=A', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
    assert.match(importsPlan(dir, git(dir, 'rev-parse', 'HEAD'), ['app.py']).all ?? '', /not a JS\/TS repo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selection is never a failure: a full run, no changed files or a plan that throws run the whole suite', () => {
  const config = TestRunConfig.parse({ select: 'imports', tiers: [tier('node --test {tests}'), tier('node --test {tests}', 'full')] });
  const sha = 'a'.repeat(40);
  const plan = () => ({ all: null, tests: ['test/a.test.js'], why: {} });
  assert.deepEqual(selectionFor({ config, repo: '.', plan }, { kind: 'fast', sha, changedFiles: ['src/a.js'] }), { tests: ['test/a.test.js'], line: 'test selection (imports): 1 test file(s) this change can affect' });
  assert.deepEqual(selectionFor({ config, repo: '.', plan }, { kind: 'full', sha, changedFiles: ['src/a.js'] }), { tests: null, line: 'test selection (imports): the whole suite, a full run' });
  assert.equal(selectionFor({ config, repo: '.', plan }, { kind: 'fast', sha, changedFiles: ['x'], tiers: ['unit'] }).tests, null, 'named tiers (the deploy gate) run everything');
  assert.equal(selectionFor({ config, repo: '.', plan }, { kind: 'fast', sha }).tests, null);
  const boom = selectionFor({ config, repo: '.', plan: () => { throw new Error('git cat-file failed'); } }, { kind: 'fast', sha, changedFiles: ['x'] });
  assert.deepEqual(boom, { tests: null, line: 'test selection (imports): the whole suite, the plan failed: git cat-file failed' });
});

test('a fast run with select: imports runs only the selected tests, passes without running when none, and runs all on a manifest change', { skip }, async () => {
  const p = exampleProject();
  writeFileSync(join(p.dir, 'test', 'other.test.js'), "import { test } from 'node:test';\ntest('other runs', () => {});\n");
  git(p.dir, 'add', '.');
  git(p.dir, 'commit', '-qm', 'another test');
  const sha = git(p.dir, 'rev-parse', 'HEAD');
  const base = mkdtempSync(join(tmpdir(), 'select-run-'));
  const slots = join(base, 'slots');
  mkdirSync(slots);
  writeFileSync(join(slots, 'config.json'), JSON.stringify({ max_agents: 2, max_test_runs: 2 }));
  const deps: TestRunDeps = {
    config: TestRunConfig.parse({ select: 'imports', tiers: [{ name: 'unit', command: 'node --test {tests} 2>&1', kind: 'fast' }] }),
    host: localHost(join(base, 'host')),
    repo: p.dir,
    log: new EventLog(join(base, 'events.db')),
    actor: 'test',
    logDir: join(base, 'logs'),
    slotsDir: slots,
    lock: async () => ({ release: async () => {} }),
  };
  const run = (changedFiles: string[]) => runTestRun(deps, { repo: p.dir, sha, kind: 'fast', prs: [1], changedFiles });
  const log = (res: Awaited<ReturnType<typeof run>>) => (res.tiers[0]!.logRef ? readFileSync(join(deps.logDir, res.tiers[0]!.logRef), 'utf8') : '');

  const price = await run(['src/price.js']);
  assert.equal(price.ok, true, price.tiers[0]!.summary);
  assert.match(price.tiers[0]!.summary, /^test selection \(imports\): 1 test file\(s\) this change can affect\n/);
  assert.match(log(price), /totals integer cents/);
  assert.doesNotMatch(log(price), /other runs/, 'the test that imports nothing changed did not run');

  const docs = await run(['README.md']);
  assert.equal(docs.ok, true);
  assert.deepEqual([docs.tiers[0]!.summary, docs.tiers[0]!.durationMs, docs.tiers[0]!.logRef], ['test selection (imports): 0 test file(s) this change can affect: none, so nothing ran', 0, '']);

  const all = await run(['package.json']);
  assert.equal(all.ok, true, all.tiers[0]!.summary);
  assert.match(all.tiers[0]!.summary, /^test selection \(imports\): the whole suite, package\.json: a package manifest\n/);
  assert.match(log(all), /totals integer cents/);
  assert.match(log(all), /other runs/, 'no files given: node --test ran them all');
});
