import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp } from '../src/guardrails/glob.js';

const KEY = '\u{1F511}';

test('? matches one character outside the BMP, as it does one inside it (#966)', () => {
  assert.ok(globToRegExp('keys/?.pem').test(`keys/${KEY}.pem`));
  assert.ok(globToRegExp('keys/?.pem').test('keys/k.pem'));
  assert.ok(globToRegExp('a?c').test(`a${KEY}c`));
  assert.ok(!globToRegExp('keys/?.pem').test(`keys/${KEY}${KEY}.pem`), 'one ? is not two characters');
  assert.ok(!globToRegExp('a?c').test('a/c'), '? never matches a slash');
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

test('no glob matches less than before #966: every path the old ? matched, the new one matches', () => {
  const globs = ['?', '??', '???', 'k/?', 'k/??', 'k/?.p', 'k/??.p', '?/?', '*?', '?*', '**/?', 'k/**/??', 'k/'];
  const chars = ['a', '/', '.', 'p', 'k', KEY, '\uD83D', '\uDD11', 'e\u0301', '\u00e9'];
  const paths = new Set<string>();
  const grow = (s: string, n: number) => {
    paths.add(s);
    if (n) for (const c of chars) grow(s + c, n - 1);
  };
  grow('', 4);
  for (const p of [...paths]) paths.add(`k/${p}`);
  let compared = 0;
  for (const g of globs) {
    const old = before(g);
    const now = globToRegExp(g);
    for (const p of paths) {
      if (!old.test(p)) continue;
      compared++;
      assert.ok(now.test(p), `${JSON.stringify(g)} matched ${JSON.stringify(p)} before and must still`);
    }
  }
  assert.ok(compared > 1000, `compared ${compared}`);
});

test('a glob without ? compiles exactly as before #966', () => {
  for (const g of ['src/**', '**/*.ckpt', '.github/workflows/', './a/b.ts', 'a+b(c)[d]{e}|f^$\\.md', '**/']) assert.equal(globToRegExp(g).source, before(g).source, g);
});
