// scripts/ci/affected.mjs: on a pull request, the unit test files its change can affect (the import graph of
// src/testrun/affected.ts); the whole suite when it can't tell, when a shared or config file changes, on a deleted
// file, and on anything but a pull request.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGraph, lex, names, reach, selectTests } from '../src/testrun/affected.js';
import { repoRoot } from './helpers.js';

const script = join(repoRoot, 'scripts', 'ci', 'affected.mjs');
const ci = (await import(pathToFileURL(script).href)) as {
  HELPER_PATHS: Record<string, Record<string, string | string[]>>;
  isTest: (f: string) => boolean;
  forceAll: (f: string) => string | null;
  runtimePath: (f: string) => string;
  sourcePath: (p: string) => string;
  wholeRead: (dir: string) => (file: string) => readonly string[] | null;
};
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** A repo shaped like the engine: src/ and test/ built into dist/, test/helpers.ts, docs, templates, a script. */
const FIXTURE: Record<string, string> = {
  'package.json': '{ "name": "fixture", "files": ["dist/src", "templates"] }\n',
  'tsconfig.json': '{}\n',
  '.nvmrc': '24\n',
  '.github/workflows/ci.yml': 'name: ci\n',
  'scripts/ci/shard.mjs': 'export {};\n',
  'scripts/tool.mjs': "console.log('a tool nothing runs in the tests');\n",
  'test/helpers.ts': "import { join } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nexport const repoRoot = fileURLToPath(new URL('../../', import.meta.url));\nexport const engineCli = join(repoRoot, 'dist', 'src', 'cli.js');\n",
  'src/cli.ts': "import { a } from './a.js';\nconsole.log(a);\n",
  'src/a.ts': "import { b } from './b.js';\nexport const a = b + 1;\n",
  'src/b.ts': "// see docs/free.md, which no code reads\nexport const b = 1;\nexport const DOC = 'named.md';\n",
  'src/c.ts': 'export const c = 3;\n',
  'src/pack.ts': "import { spawnSync } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';\nconst ENGINE = fileURLToPath(new URL('../../', import.meta.url));\nexport const pack = (dir = ENGINE) => spawnSync('npm', ['pack', dir]);\n",
  'test/orphan.ts': 'export const nobody = 1;\n',
  'test/pack.test.ts': "import { pack } from '../src/pack.js';\npack();\n",
  'src/data.ts': "import { readFileSync } from 'node:fs';\nexport const t = () => readFileSync(new URL('../../templates/t.md', import.meta.url), 'utf8');\n",
  'test/a.test.ts': "import { a } from '../src/a.js';\nconsole.log(a);\n",
  'test/b.test.ts': "import { b } from '../src/b.js';\nconsole.log(b);\n",
  'test/cli.test.ts': "import { spawnSync } from 'node:child_process';\nimport { engineCli } from './helpers.js';\nspawnSync(process.execPath, [engineCli]);\n",
  'test/data.test.ts': "import { t } from '../src/data.js';\nconsole.log(t());\n",
  'test/doc.test.ts': "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { repoRoot } from './helpers.js';\nreadFileSync(join(repoRoot, 'docs', 'x.md'), 'utf8');\n",
  'test/dyn.test.ts': 'await import(process.env.SOME_MODULE!);\n',
  'test/list.test.ts': "import { execFileSync } from 'node:child_process';\nimport { repoRoot } from './helpers.js';\nexecFileSync('git', ['ls-files'], { cwd: repoRoot });\n",
  'docs/x.md': '# x\n',
  'docs/free.md': '# free\n',
  'docs/named.md': '# named\n',
  'templates/t.md': 'a template\n',
};

function fixture(): { dir: string; base: string; change: (edit: (dir: string) => void) => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'ci-affected-'));
  for (const [f, s] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), s);
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  const commit = (m: string) => git(dir, '-c', 'user.email=a@example.com', '-c', 'user.name=A', '-c', 'commit.gpgsign=false', 'commit', '-qm', m);
  commit('base');
  const base = git(dir, 'rev-parse', 'HEAD');
  /** The tests the CLI selects for a change made on a branch off the base (the whole list on a whole-suite plan). */
  const change = (edit: (dir: string) => void): string[] => {
    git(dir, 'checkout', '-q', '-B', 'pr', base);
    edit(dir);
    git(dir, 'add', '-A');
    commit('change');
    const r = spawnSync(process.execPath, [script, '--event', 'pull_request', '--base', base, '--root', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n').filter(Boolean);
  };
  return { dir, base, change };
}

const ALL = Object.keys(FIXTURE).filter((f) => f.endsWith('.test.ts')).sort();
const append = (f: string, s = '\n// changed\n') => (dir: string) => writeFileSync(join(dir, f), readFileSync(join(dir, f), 'utf8') + s);

test('the graph on the fixture: imports, the helpers\' names, built paths back to their sources, reads, the unfollowable', () => {
  const paths = ['package.json', 'README.md', 'src', 'templates'];
  const g = buildGraph({ files: Object.keys(FIXTURE), read: (f) => FIXTURE[f]!, pathModules: ci.HELPER_PATHS, runtimePath: ci.runtimePath, sourcePath: ci.sourcePath, wholeRead: (f) => (f.startsWith('src/') ? paths : null) });
  const facts = (f: string) => {
    const x = g.facts.get(f)!;
    return { edges: [...x.edges].sort(), reads: [...x.reads].sort(), opaque: x.opaque, lists: x.lists };
  };
  assert.deepEqual(facts('test/a.test.ts'), { edges: ['src/a.ts'], reads: [], opaque: [], lists: false });
  assert.deepEqual(facts('src/a.ts').edges, ['src/b.ts']);
  assert.deepEqual(facts('test/cli.test.ts'), { edges: ['src/cli.ts', 'test/helpers.ts'], reads: ['src/cli.ts'], opaque: [], lists: false }, 'engineCli runs src/cli.ts');
  assert.deepEqual(facts('src/data.ts').reads, ['templates/t.md'], 'new URL from dist/src/data.js');
  assert.deepEqual(facts('test/doc.test.ts').reads, ['docs/x.md']);
  assert.deepEqual(facts('test/dyn.test.ts').opaque, ['unresolved import(process.env.SOME_MODULE!)']);
  assert.equal(facts('test/list.test.ts').lists, true, 'git ls-files in the root lists names: no read of every file');
  assert.deepEqual(facts('test/helpers.ts'), { edges: [], reads: [], opaque: [], lists: false }, 'described, not scanned');
  assert.deepEqual(facts('src/pack.ts').reads, ['package.json', 'README.md', 'src', 'templates'].sort(), 'a src/ module reading its install directory reads the package\'s files');
  assert.deepEqual([...reach(g, 'test/cli.test.ts').files].sort(), ['src/a.ts', 'src/b.ts', 'src/cli.ts', 'test/cli.test.ts', 'test/helpers.ts']);
});

test('a pull request selects the tests that reach the change, and the unfollowable test; nothing else', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.change(append('src/b.ts')), ['test/a.test.ts', 'test/b.test.ts', 'test/cli.test.ts', 'test/dyn.test.ts', 'test/pack.test.ts'], 'through a.ts, the CLI a test runs, and the package src/pack.ts packs');
    assert.deepEqual(f.change(append('templates/t.md', 'more\n')), ['test/data.test.ts', 'test/dyn.test.ts', 'test/pack.test.ts'], 'read by src/data.ts at run time; in the package');
    assert.deepEqual(f.change(append('docs/x.md', 'more\n')), ['test/doc.test.ts', 'test/dyn.test.ts'], 'read by the test');
    assert.deepEqual(f.change(append('test/b.test.ts')), ['test/b.test.ts', 'test/dyn.test.ts'], 'a test file selects itself');
    assert.deepEqual(f.change(append('docs/free.md', 'more\n')), ['test/dyn.test.ts'], 'documentation nothing names or reads: only the always-run test');
    assert.deepEqual(f.change((d) => writeFileSync(join(d, 'docs', 'new.md'), '# new\n')), ['test/dyn.test.ts', 'test/list.test.ts'], 'a new file changes what git ls-files lists');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('unsure means all: a file named in a string no read reaches, a file nothing reaches, a script', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.change(append('docs/named.md', 'more\n')), ALL, "src/b.ts names 'named.md'");
    assert.deepEqual(f.change(append('test/orphan.ts')), ALL, 'imported by nothing: a module this can\'t place');
    assert.deepEqual(f.change(append('scripts/tool.mjs')), ALL);
    assert.deepEqual(f.change((d) => writeFileSync(join(d, 'scripts', 'setup.sh'), 'echo hi\n')), ALL, 'a shell script');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('config and shared files mean all: the manifest, tsconfig, the Node version, the test helpers, the CI scripts, the workflows', () => {
  const f = fixture();
  try {
    for (const file of ['package.json', 'tsconfig.json', '.nvmrc', 'test/helpers.ts', 'scripts/ci/shard.mjs', '.github/workflows/ci.yml']) {
      assert.deepEqual(f.change(append(file, '\n')), ALL, file);
      assert.ok(ci.forceAll(file), file);
    }
    for (const file of ['package-lock.json', 'web/tsconfig.json', 'scripts/ci/affected.mjs']) assert.ok(ci.forceAll(file), file);
    assert.equal(ci.forceAll('src/a.ts'), null);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a deleted or renamed file means all', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.change((d) => unlinkSync(join(d, 'src', 'c.ts'))), ALL);
    assert.deepEqual(f.change((d) => git(d, 'mv', 'docs/free.md', 'docs/moved.md')), ALL, 'a rename is a delete and an add');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('anything but a pull request (a push to main, a PR labelled full-ci) runs every test file', () => {
  const f = fixture();
  try {
    for (const event of ['push', 'workflow_dispatch', 'full-ci']) {
      const r = spawnSync(process.execPath, [script, '--event', event, '--root', f.dir], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.stdout.split('\n').filter(Boolean), ALL, event);
      assert.match(r.stderr, new RegExp(`the whole suite \\(${ALL.length} test files\\): ${event}, not a pull request's change: everything runs`));
    }
    assert.equal(spawnSync(process.execPath, [script, '--event', 'pull_request', '--root', f.dir], { encoding: 'utf8' }).status, 2, 'a pull request needs its base');
    assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('test/helpers.ts\'s description covers everything it imports and reads', () => {
  const files = git(repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n');
  const read = (f: string) => readFileSync(join(repoRoot, f), 'utf8');
  const opts = { files, read, runtimePath: ci.runtimePath, sourcePath: ci.sourcePath };
  const scanned = buildGraph(opts).facts.get('test/helpers.ts')!;
  // A test that uses every described name reaches at least what helpers.ts itself does.
  const described = ci.HELPER_PATHS['test/helpers.ts']!;
  const user = `import { ${Object.keys(described).join(', ')} } from './helpers.js';\n${Object.keys(described).map((n) => `use(${n});`).join('\n')}\n`;
  const g = buildGraph({ ...opts, files: [...files, 'test/zz-user.test.ts'], read: (f) => (f === 'test/zz-user.test.ts' ? user : read(f)), pathModules: ci.HELPER_PATHS });
  const r = reach(g, 'test/zz-user.test.ts');
  for (const e of scanned.edges) assert.ok(r.files.has(e), `helpers.ts imports or runs ${e}: describe it in HELPER_PATHS`);
  for (const p of scanned.reads) assert.ok(r.reads.has(p) || r.files.has(p) || r.reads.has(''), `helpers.ts reads ${p}: describe it in HELPER_PATHS`);
  // Every export that touches a path or an import is one the description names.
  const text = read('test/helpers.ts');
  const touches = /repoRoot|engineCli|agentSettings|cpSync|join\(repoRoot/;
  for (const m of text.matchAll(/^export (?:const|function) (\w+)[\s\S]*?(?=^export |(?![\s\S]))/gm)) {
    if (touches.test(m[0].split('\n').slice(1).join('\n')) || /=\s*join\(repoRoot/.test(m[0].split('\n')[0]!)) assert.ok(m[1]! in described, `${m[1]} reaches a path: describe it in HELPER_PATHS`);
  }
});

test('on the engine itself: a one-test change or a doc nothing names runs a small part of the suite, a src change what imports it', () => {
  const files = git(repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean);
  const g = buildGraph({ files, read: (f) => readFileSync(join(repoRoot, f), 'utf8'), pathModules: ci.HELPER_PATHS, runtimePath: ci.runtimePath, sourcePath: ci.sourcePath, wholeRead: ci.wholeRead(repoRoot) });
  const all = files.filter(ci.isTest);
  const plan = (...changed: string[]) => selectTests(g, changed, { isTest: ci.isTest, forceAll: ci.forceAll, added: new Set() });
  const one = plan('test/brand.test.ts');
  assert.equal(one.all, null);
  assert.ok(one.tests.includes('test/brand.test.ts'));
  assert.ok(one.tests.length < all.length / 5, `${one.tests.length} of ${all.length}`);
  assert.ok(!one.tests.includes('test/coordinator.test.ts'), 'the longest file runs only when the change reaches it');
  // Built, not written whole: a literal naming it here would make this file name it (and the plan the whole suite).
  const doc = plan('docs/test-' + 'runs.md');
  assert.equal(doc.all, null);
  assert.ok(doc.tests.every((t) => doc.why[t]!.every((w) => w.startsWith('always'))), 'only the tests that run on every change');
  assert.ok(doc.tests.length < all.length / 5, `${doc.tests.length} of ${all.length}`);
  const affected = plan('src/testrun/affected.ts');
  assert.ok(affected.tests.includes('test/ci-affected.test.ts') && affected.tests.includes('test/testrun-select.test.ts'));
  assert.equal(plan('test/helpers.ts').all, 'test/helpers.ts: the helpers every test uses');
});

test('the lexer: strings and templates read, comments and regular expressions skipped, code left searchable', () => {
  const src = "import x from './a.js'; // import y from './no.js'\nconst r = /['\"]/g; const t = `a${b('./c.js')}d`; /* 'not' */ const s = 'it\\'s';\nreturn /x'/.test(s);\n";
  const { strings, masked } = lex(src);
  assert.deepEqual(strings, ['./a.js', './c.js', 'ad', "it's"]);
  assert.equal(masked.length, src.length);
  assert.doesNotMatch(masked, /no\.js|not|x'/);
  assert.match(masked, /import x from '/);
  assert.match(masked, /\$\{b\('/, 'a template\'s ${…} stays code');
  assert.ok(names('docs/x.md', 'docs/x.md') && names('x.md', 'docs/x.md') && names('./src/a.js', 'src/a.ts') && names('/x.md', 'docs/x.md'));
  assert.ok(!names('see docs/x.md', 'docs/x.md') && !names('docs', 'docs/x.md') && !names('y/x.md', 'docs/x.md') && !names('', 'docs/x.md'));
});
