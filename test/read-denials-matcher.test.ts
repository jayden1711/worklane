// #890 round 8: read-denials matches agent-written globs in linear time (globMatcher), and must read every glob
// exactly as the guard hook (src/guardrails/access.ts, globRegExp) does, in each style (#966). A fixed corpus and a
// seeded random one, compared both ways, and against the readings themselves: `?` one UTF-16 unit, or one character
// as the u flag reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globMatcher, globRegExp, globToRegExp, type GlobStyle } from '../src/guardrails/glob.js';
import { repoRoot } from './helpers.js';

const KEY = '\u{1F511}';
// The equivalence corpus (#890): a pattern taken out is a case no longer checked.
// check-table: never-shrink
const PATTERNS = ['**', '**/', '*', '?', 'a', 'a/', './a', '.env', '.env.*', '**/.env*', '**.env', 'secrets**', 'a/**/k', 'a/**', '**/k', 'cfg/*/prod.yaml', 'a?c.txt', '*.pem', '**/*.pem', 'x/**/y/**/z', 'a**b', 'a*/b', '*/', '+(){}$^|.[]', 'sp ace', 'back\\slash', 'é*', 'a\nb', '**/**', '***', 'a/***/b', 'keys/?.pem', 'keys/??.pem', '**/?', '?/**', '[ab]?', `${KEY}*`, `*${KEY}`, `?${KEY}`, '\uD83D*', '*\uDD11', '\uD83D?', '?\uDD11', '*?', '?*'];
// check-table: never-shrink
const PATHS = ['', 'a', 'a/', 'a/b', 'a/k', 'a/x/k', 'a/x/y/k', 'k', '.env', '.env.local', 'x/.env', 'x/y/.env.prod', 'secrets', 'secrets/x', 'secretsx/y', 'cfg/dev/prod.yaml', 'cfg/a/b/prod.yaml', 'abc.txt', 'a/c.txt', 'key.pem', 'd/key.pem', 'x/y/z', 'x/1/y/2/z', 'ab', 'a/b/b', 'axb', 'a//b', '+(){}$^|.[]', 'sp ace', 'back\\slash', 'é', 'éé/x', 'a\nb', 'aa/bb', '/', 'x/', `keys/${KEY}.pem`, `keys/${KEY}${KEY}.pem`, `keys/k${KEY}.pem`, KEY, `${KEY}/x`, `x/${KEY}`, `[ab]${KEY}`, '[ab]x', '\uD83D', '\uDD11', '\uDD11\uD83D', `\uD83D${KEY}`, `${KEY}\uDD11`, `a${KEY}c.txt`];

const STYLES: GlobStyle[] = ['deny', 'allow'];

/** What a style means, from the two readings: `?` a unit (no u flag) or a character (the u flag). */
function oracle(p: string, s: string, style: GlobStyle): boolean {
  const unit = globToRegExp(p).test(s);
  const point = new RegExp(globToRegExp(p).source, 'su').test(s);
  return style === 'deny' ? unit || point : unit && point;
}

function agree(p: string, s: string) {
  for (const style of STYLES) {
    const want = oracle(p, s, style);
    const what = `${style} ${JSON.stringify(p)} on ${JSON.stringify(s)}`;
    assert.equal(globMatcher(p, style).test(s), want, `globMatcher ${what}`);
    assert.equal(globRegExp(p, style).test(s), want, `globRegExp ${what}`);
  }
}

test('#890: globMatcher reads every glob in the corpus exactly as globRegExp does, in each style (#966)', () => {
  for (const p of PATTERNS) for (const s of PATHS) agree(p, s);
});

test('#890: globMatcher agrees with globRegExp on random globs and paths, astral and lone surrogates among them (#966)', () => {
  let seed = 890;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  const atoms = ['a', 'b', '/', '*', '**', '?', '.', '**/', 'é', '\n', KEY, '\uD83D', '\uDD11'];
  const chars = ['a', 'b', '/', '.', 'é', '\n', KEY, '\uD83D', '\uDD11'];
  for (let i = 0; i < 4000; i++) {
    const p = Array.from({ length: 1 + rnd(6) }, () => atoms[rnd(atoms.length)]).join('');
    const s = Array.from({ length: rnd(9) }, () => chars[rnd(chars.length)]).join('');
    agree(p, s);
  }
});

test('#966: R123b probes: a deny ? takes one astral character, an allow ? only what one unit and one character both take', () => {
  for (const [p, s] of [['keys/?.pem', `keys/${KEY}.pem`], ['**/?', `x/${KEY}`], ['?/**', `${KEY}/x`], ['[ab]?', `[ab]${KEY}`]]) {
    assert.ok(globMatcher(p!, 'deny').test(s!), `deny ${p} on ${s}`);
    assert.ok(!globMatcher(p!, 'allow').test(s!), `allow ${p} on ${s}`);
  }
  assert.ok(globMatcher('keys/??.pem', 'deny').test(`keys/${KEY}.pem`), 'two units, as before #966');
  assert.ok(!globMatcher('keys/??.pem', 'allow').test(`keys/${KEY}.pem`), 'one character is not two');
});

test('#890: globMatcher stays linear on "*a*a…*b" against a long name, in each style', () => {
  const p = `${'*a'.repeat(30)}*b?`;
  for (const style of STYLES) {
    const t = performance.now();
    assert.equal(globMatcher(p, style).test('a'.repeat(200)), false);
    const ms = performance.now() - t;
    assert.ok(ms < 1_000, `${style}: ${ms} ms`);
  }
});

test('#966: read-denials has no glob matcher of its own: it reads globs through src/guardrails/glob.ts, as the hook does', () => {
  const rd = readFileSync(join(repoRoot, 'src/read-denials.ts'), 'utf8');
  assert.match(rd, /import \{[^}]*\bglobMatcher\b[^}]*\} from '\.\/guardrails\/glob\.js'/);
  assert.doesNotMatch(rd, /function globMatcher|Thompson|new RegExp\([^)]*glob/);
  const hook = readFileSync(join(repoRoot, 'src/guardrails/access.ts'), 'utf8');
  assert.match(hook, /import \{[^}]*\bglobRegExp\b[^}]*\} from '\.\/glob\.js'/);
  assert.doesNotMatch(hook, /\bglobToRegExp\b/);
});
