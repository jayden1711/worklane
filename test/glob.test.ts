import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { globRegExp, globToRegExp, type GlobStyle } from '../src/guardrails/glob.js';
import { repoRoot } from './helpers.js';

const KEY = '\u{1F511}';

test('a deny ? matches one character outside the BMP, as it does one inside it (#966)', () => {
  assert.ok(globRegExp('keys/?.pem', 'deny').test(`keys/${KEY}.pem`));
  assert.ok(globRegExp('keys/?.pem', 'deny').test('keys/k.pem'));
  assert.ok(globRegExp('a?c', 'deny').test(`a${KEY}c`));
  assert.ok(!globRegExp('keys/?.pem', 'deny').test(`keys/${KEY}${KEY}.pem`), 'one ? is not two characters');
  assert.ok(!globRegExp('a?c', 'deny').test('a/c'), '? never matches a slash');
});

test('an allow ? matches only what both readings do: never an astral character it did not match before (#966)', () => {
  assert.ok(!globRegExp('keys/?.pem', 'allow').test(`keys/${KEY}.pem`));
  assert.ok(!globRegExp('keys/??.pem', 'allow').test(`keys/${KEY}.pem`));
  assert.ok(globRegExp('keys/?.pem', 'allow').test('keys/k.pem'));
});

/** globToRegExp as it was before #966: `?` was one UTF-16 unit. */
function before(glob: string): RegExp {
  let g = glob.replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's');
}

const GLOBS = ['?', '??', '???', 'k/?', 'k/??', 'k/?.p', 'k/??.p', '?/?', '*?', '?*', '**/?', 'k/**/??', 'k/', `${KEY}?`, '\uD83D?', '?\uDD11', '\uD83D*'];
const CHARS = ['a', '/', '.', 'p', 'k', KEY, '\uD83D', '\uDD11', 'e\u0301', '\u00e9'];
function paths(): string[] {
  const out = new Set<string>();
  const grow = (s: string, n: number) => {
    out.add(s);
    if (n) for (const c of CHARS) grow(s + c, n - 1);
  };
  grow('', 4);
  for (const p of [...out]) out.add(`k/${p}`);
  return [...out];
}

test('deny never matches less than before #966, allow never more; each is exactly the union or intersection of the readings', () => {
  let widened = 0;
  let narrowed = 0;
  for (const g of GLOBS) {
    const old = before(g);
    const point = new RegExp(before(g).source, 'su');
    const deny = globRegExp(g, 'deny');
    const allow = globRegExp(g, 'allow');
    for (const p of paths()) {
      const was = old.test(p);
      const u = point.test(p);
      assert.equal(deny.test(p), was || u, `deny ${JSON.stringify(g)} on ${JSON.stringify(p)}`);
      assert.equal(allow.test(p), was && u, `allow ${JSON.stringify(g)} on ${JSON.stringify(p)}`);
      if (deny.test(p) && !was) widened++;
      if (!allow.test(p) && was) narrowed++;
    }
  }
  assert.ok(widened > 0 && narrowed > 0, `the corpus reaches both differences (${widened} wider, ${narrowed} narrower)`);
});

test('globToRegExp is the reading before #966, and a glob both readings read alike compiles exactly as before in each style', () => {
  for (const g of [...GLOBS, 'src/**', '**/*.ckpt', '.github/workflows/', './a/b.ts', 'a+b(c)[d]{e}|f^$\\.md', '**/', `keys/${KEY}.pem`]) assert.equal(globToRegExp(g).source, before(g).source, g);
  for (const g of ['src/**', '**/*.ckpt', '.github/workflows/', './a/b.ts', 'a+b(c)[d]{e}|f^$\\.md', '**/', `keys/${KEY}.pem`]) {
    for (const style of ['deny', 'allow'] as GlobStyle[]) {
      const re = globRegExp(g, style);
      assert.equal(re.source, before(g).source, `${style} ${g}`);
      assert.equal(re.flags, 's');
    }
  }
});

test('a deny glob\'s source without its anchors is a pattern of its own (the hook splices it into a shell word\'s pattern)', () => {
  for (const g of ['keys/?.pem', '?', 'a*?b']) {
    const src = globRegExp(g, 'deny').source;
    assert.ok(src.startsWith('^') && src.endsWith('$'), src);
    const inner = new RegExp(`^x${src.slice(1, -1)}$`, 's');
    for (const p of [`keys/${KEY}.pem`, 'keys/k.pem', KEY, 'a', `a${KEY}b`, 'ab']) assert.equal(inner.test(`x${p}`), globRegExp(g, 'deny').test(p), `${g} on ${p}`);
  }
});

/**
 * The only files that read a glob as before #966 instead of choosing a style. Each must say why; a new matcher picks
 * globRegExp(glob, 'deny' | 'allow') (or globMatcher). The three owned by other open PRs move in a follow-up.
 */
// check-table: never-grow
const LEGACY_READERS: Record<string, string> = {
  'src/review.ts': "earlier versions' money readings (KeptMoneyReading, a money glob's `before`) count what main counted",
  'src/guardrails/engine.ts': 'protected, agent-editable and AGENTS.md paths: not yet moved (follow-up)',
  'src/merge-policy-vacuity.ts': 'vacuity test and app globs: not yet moved (follow-up)',
  'src/vacuity.ts': 'vacuity app paths: not yet moved (follow-up)',
};

test('#966: no file outside the listed ones compiles a glob without choosing deny or allow', () => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && /\bglobToRegExp\s*\(/.test(readFileSync(p, 'utf8').replace(/^\s*(\/\/|\/?\*).*$/gm, ''))) found.push(relative(repoRoot, p).split(sep).join('/'));
    }
  };
  for (const d of ['src', 'scripts', 'web/src']) walk(join(repoRoot, d));
  const extra = found.filter((f) => f !== 'src/guardrails/glob.ts' && !(f in LEGACY_READERS));
  assert.deepEqual(extra, [], 'call globRegExp(glob, style) instead: deny when a match refuses or protects, allow when it exempts or permits');
});
