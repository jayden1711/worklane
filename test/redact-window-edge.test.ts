// #889 round 5 (the fourth adversarial review):
// - A cut site never shows the raw end of its read window. Redaction earlier in the window (an END line with no BEGIN,
//   or a closed key over 16 KB) can shrink the text so far that the window's cut lands inside what is shown; a token
//   cut there is too short for its rule. Each window now ends at its last whitespace (readWindow).
// - A JWT whose header is longer than 512 characters (an x5c chain), glued after a letter, a digit, `-` or `%3D`.
// - A run of millions of characters after a prefix overflows V8's backtracking stack: redactString fails closed.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as redactModule from '../src/events/redact.js';
import { redactString } from '../src/events/redact.js';
import { readServiceLog } from '../src/dashboard.js';
import { BRAND } from '../src/brand.js';
import { repoRoot } from './helpers.js';
import { leaks, run } from './token-standins.js';

const scratch = (p: string) => mkdtempSync(join(tmpdir(), p));
const updater = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', `${BRAND.cli}-update.cjs`)) as { redact(text: string): string };
const broad = { broad: true } as Parameters<typeof redactString>[1];
const MARGIN = 16 * 1024;
const BEGIN = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
const END = ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');

/**
 * Tokens to put at a window's edge, each just long enough for its rule, so that cut by one character it is too short
 * (or, for the URL password, loses its `@`); each with the part that must not be shown.
 */
const TOKENS: [string, string, string][] = [
  ['a dashboard key', `${'wld'}_${run(32, 'Wd9kQ2-x_')}`, run(32, 'Wd9kQ2-x_').slice(0, 30)],
  ['a GitHub token', `${'ghp'}_${run(30)}`, run(30).slice(0, 29)],
  ['a URL password', `https://app:${run(24, 'Pw7xQ2zL')}@`, run(24, 'Pw7xQ2zL')],
];

/** Text of `n` characters that shrinks when redacted: everything up to an END line with no BEGIN, or a closed key. */
const SHRINKERS: [string, (n: number, newline: string) => string][] = [
  ['an END line with no BEGIN', (n) => `${'x '.repeat(Math.ceil((n - END.length - 1) / 2)).slice(0, n - END.length - 1)}${END} `],
  [
    'a closed key',
    (n, nl) => {
      const lines = Math.floor((n - BEGIN.length - END.length - 4) / (64 + nl.length));
      const key = [BEGIN, ...Array.from({ length: lines }, (_, i) => run(64, `K${i}b0dy${i}`)), END].join(nl);
      return `${key}${' '.repeat(n - key.length)}`;
    },
  ],
];

/** A text whose read window (its first `end` characters) cuts `token` before its last character, after `shrinker`. */
function atEdge(end: number, shrink: string, token: string): string {
  const start = end - (token.length - 1);
  const filler = 'w '.repeat(Math.ceil((start - shrink.length) / 2)).slice(0, start - shrink.length - 1);
  return `${shrink}${filler} ${token} and the rest of the text`;
}

test('redactCut never shows a token cut by its window, after an END with no BEGIN or a closed key over 16 KB (2,000, 20,000, 512 KB)', () => {
  const missed: string[] = [];
  for (const max of [2_000, 20_000, 512 * 1024]) {
    for (const [how, shrinker] of SHRINKERS) {
      for (const [what, token, secret] of TOKENS) {
        const s = atEdge(max + MARGIN, shrinker(MARGIN + 600, '\n'), token);
        assert.ok(s.length > max + MARGIN, 'the text is longer than the window');
        const out = redactModule.redactCut(s, max);
        if (leaks(out, secret)) missed.push(`${what} after ${how}, max ${max}`);
      }
    }
  }
  assert.deepEqual(missed, []);
});

test('the log views never show a token cut by a record\'s read part, after an END with no BEGIN or a closed key (journal and file)', () => {
  const READ = 2000 + 4096;
  const missed: string[] = [];
  for (const [how, shrinker] of SHRINKERS) {
    for (const [what, token, secret] of TOKENS) {
      // The journal: one entry, a closed key with real line breaks in it.
      const entry = atEdge(READ, shrinker(4300, '\n'), token);
      const journal = () => ({ status: 0, stderr: '', stdout: JSON.stringify({ MESSAGE: entry, PRIORITY: '6', __REALTIME_TIMESTAMP: '1767225600000000' }) });
      if (leaks(JSON.stringify(readServiceLog({ unit: 'coordinator.service', file: null }, 10, journal).entries), secret)) missed.push(`${what} after ${how}, journal`);
      // The file: one line, a closed key with its line breaks written as `\n` (a JSON log line).
      const file = join(scratch('svc-log-'), 'c.log');
      writeFileSync(file, `${atEdge(READ, shrinker(4300, '\\n'), token)}\n`);
      if (leaks(JSON.stringify(readServiceLog({ unit: null, file }, 10).entries), secret)) missed.push(`${what} after ${how}, file`);
    }
  }
  assert.deepEqual(missed, []);
});

test('readWindow ends a window at its last whitespace, and drops a window with none', () => {
  assert.equal(typeof redactModule.readWindow, 'function');
  assert.equal(redactModule.readWindow('abc def ghi', 9), 'abc def ');
  assert.equal(redactModule.readWindow('abcdefghij', 5), '');
  assert.equal(redactModule.readWindow('short', 10), 'short');
});

test('a JWT with a long header (an x5c chain) is found glued after a letter, a digit, `-` or `%3D`, default and broad', () => {
  const missed: string[] = [];
  for (const len of [600, 3000]) {
    const sig = run(43, 'S1gn4tUr3');
    const jwt = `${'eyJ'}${run(len, 'hdrX5cChain9')}.${'eyJ'}${run(40, 'pAyL0ad')}.${sig}`;
    for (const before of ['x', '7', '-', '%3D', '_', ' ']) {
      for (const [mode, out] of [['default', redactString(`token ${before}${jwt} end`)], ['broad', redactString(`token ${before}${jwt} end`, broad)]] as const) {
        if (leaks(out, sig)) missed.push(`header ${len} after ${JSON.stringify(before)}, ${mode}`);
      }
    }
  }
  assert.deepEqual(missed, []);
  // A dotted run with no eyJ is left as it was.
  for (const s of ['config.settings.production.example', 'abcdefghijklmnop.qrstuvwxyz.abc']) assert.equal(redactString(s), s);
});

test('a run of millions of characters after a prefix fails closed instead of throwing (default, broad, the updater)', () => {
  const huge = `${'ghp'}_${'a'.repeat(6 * 1024 * 1024)}`;
  for (const [what, f] of [['default', () => redactString(huge)], ['broad', () => redactString(huge, broad)], ['updater', () => updater.redact(huge)]] as const) {
    let out = '';
    assert.doesNotThrow(() => {
      out = f();
    }, what);
    assert.ok(!out.includes('a'.repeat(100)), `${what}: nothing of it is shown`);
  }
});
