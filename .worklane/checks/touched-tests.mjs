#!/usr/bin/env node
// The fast test tier: build, then run only the tests a change touches. A touched test is every test file that
// imports a changed module directly or through one intermediate module, plus every changed test file. The change
// is everything since the merge base with origin/main, committed or not. Anything it can't work out (no merge
// base, a changed build or test setup) runs the whole suite instead: never fewer tests than it should.
//   node .worklane/checks/touched-tests.mjs            the touched tests
//   node .worklane/checks/touched-tests.mjs --one F    one test file (test/x.test.ts or dist/test/x.test.js)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1;
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
const posix = (p) => p.split(sep).join('/');
const distOf = (t) => posix(t).replace(/^test\//, 'dist/test/').replace(/\.ts$/, '.js');

if (run(npm, ['run', 'build']) !== 0) process.exit(1);

const one = process.argv.indexOf('--one');
if (one >= 0) {
  const f = process.argv[one + 1];
  if (!f) {
    console.error('usage: touched-tests.mjs --one <test file>');
    process.exit(2);
  }
  process.exit(run(process.execPath, ['--test', f.startsWith('dist/') ? f : distOf(f)]));
}

const full = (why) => {
  console.log(`touched-tests: running every test (${why})`);
  process.exit(run(process.execPath, ['--test', 'dist/test/**/*.test.js']));
};

let changed;
try {
  const base = git('merge-base', 'origin/main', 'HEAD').trim();
  changed = [...git('diff', '--name-only', base).split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')].map((s) => s.trim()).filter(Boolean);
} catch (e) {
  full(`no merge base with origin/main: ${String(e.message).split('\n')[0]}`);
}
// A change to how everything builds or runs: no import graph can say which tests it touches.
const everything = changed.find((f) => ['package.json', 'package-lock.json', 'tsconfig.json'].includes(f));
if (everything) full(`${everything} changed`);

const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : [])) : []);
const noExt = (p) => p.replace(/\.(ts|js)$/, '');
const imports = (file) => [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)].map((m) => noExt(resolve(dirname(file), m[1])));
const modules = [...walk(join(root, 'src')), ...walk(join(root, 'test'))];
const changedSet = new Set(changed.filter((f) => /\.ts$/.test(f)).map((f) => noExt(resolve(root, f))));
const once = new Set(modules.filter((m) => imports(m).some((i) => changedSet.has(i))).map(noExt));
const hit = new Set([...changedSet, ...once]);
const tests = modules.filter((m) => m.endsWith('.test.ts') && (hit.has(noExt(m)) || imports(m).some((i) => hit.has(i))));
const files = [...new Set(tests.map((t) => distOf(relative(root, t))))].filter((f) => existsSync(join(root, f))).sort();
if (!files.length) {
  console.log('touched-tests: no test touches this change');
  process.exit(0);
}
console.log(`touched-tests: ${files.length} file(s): ${files.join(' ')}`);
process.exit(run(process.execPath, ['--test', ...files]));
