// #890 round 8: read-denials matches agent-written globs in linear time (globMatcher), and must read every glob
// exactly as the guard hook's globToRegExp does. A fixed corpus and a seeded random one, compared both ways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp } from '../src/guardrails/glob.js';
import { globMatcher } from '../src/read-denials.js';

const PATTERNS = ['**', '**/', '*', '?', 'a', 'a/', './a', '.env', '.env.*', '**/.env*', '**.env', 'secrets**', 'a/**/k', 'a/**', '**/k', 'cfg/*/prod.yaml', 'a?c.txt', '*.pem', '**/*.pem', 'x/**/y/**/z', 'a**b', 'a*/b', '*/', '+(){}$^|.[]', 'sp ace', 'back\\slash', 'é*', 'a\nb', '**/**', '***', 'a/***/b'];
const PATHS = ['', 'a', 'a/', 'a/b', 'a/k', 'a/x/k', 'a/x/y/k', 'k', '.env', '.env.local', 'x/.env', 'x/y/.env.prod', 'secrets', 'secrets/x', 'secretsx/y', 'cfg/dev/prod.yaml', 'cfg/a/b/prod.yaml', 'abc.txt', 'a/c.txt', 'key.pem', 'd/key.pem', 'x/y/z', 'x/1/y/2/z', 'ab', 'a/b/b', 'axb', 'a//b', '+(){}$^|.[]', 'sp ace', 'back\\slash', 'é', 'éé/x', 'a\nb', 'aa/bb', '/', 'x/'];

function agree(p: string, s: string) {
  assert.equal(globMatcher(p).test(s), globToRegExp(p).test(s), `${JSON.stringify(p)} on ${JSON.stringify(s)}`);
}

test('#890: globMatcher reads every glob in the corpus exactly as globToRegExp does', () => {
  for (const p of PATTERNS) for (const s of PATHS) agree(p, s);
});

test('#890: globMatcher agrees with globToRegExp on random globs and paths', () => {
  let seed = 890;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  const atoms = ['a', 'b', '/', '*', '**', '?', '.', '**/', 'é', '\n'];
  const chars = ['a', 'b', '/', '.', 'é', '\n'];
  for (let i = 0; i < 3000; i++) {
    const p = Array.from({ length: 1 + rnd(6) }, () => atoms[rnd(atoms.length)]).join('');
    const s = Array.from({ length: rnd(9) }, () => chars[rnd(chars.length)]).join('');
    agree(p, s);
  }
});

test('#890: globMatcher stays linear on "*a*a…*b" against a long name', () => {
  const p = `${'*a'.repeat(30)}*b`;
  const t = performance.now();
  assert.equal(globMatcher(p).test('a'.repeat(200)), false);
  const ms = performance.now() - t;
  assert.ok(ms < 1_000, `${ms} ms`);
});
