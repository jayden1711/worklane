// #889 round 7 (the round-6 second review, A1): a match a rule's function declines (no secret) must not hide a token
// that starts inside it. An unsigned JWT (`alg: none`, an empty third part) or one whose signature starts with `+` or
// `/`, written right after a dotted name (`a.<jwt>.`), was shown: the JWT rule's match stopped before the empty part,
// its function declined the match, and the next search started 64 characters before the match's end, past the
// JWT's own start. Now the JWT rule declines nothing (a plain replacement), and a declined match of any rule restarts
// at its next character. Every function-backed rule is held here to a reference that tries every start.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTION_PATTERNS, redactCut, redactString, secretKinds } from '../src/events/redact.js';
import { run } from './token-standins.js';

const KEY_BEGIN = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
const KEY_END = ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
const broad = { broad: true } as Parameters<typeof redactString>[1];

test('an unsigned or `+`-led JWT after a dotted name is found: default, broad, redactCut and secretKinds', () => {
  const missed: string[] = [];
  for (const pre of ['a.', 'x.', 'a.b.', 'x.y.z.', 'api.example-service.', ['sess', '0123456789.'].join('_'), 'id=a.', '"a.']) {
    for (const [h, p] of [[8, 8], [8, 40], [8, 70], [30, 40], [60, 20], [100, 100]] as const) {
      for (const tail of ['.', '. ', '.\n', '..x', '."', '.!', '.+Sg4Qe9Ja2Wz7', './Sg4Qe9Ja2Wz7']) {
        const payload = `P${run(p - 1, 'Ab3Kq7Zx')}`;
        const s = `${pre}${'eyJ'}${run(h, 'Hd3Rz7Kq')}.${payload}${tail}`;
        const where = `${JSON.stringify(pre)} h=${h} p=${p} ${JSON.stringify(tail)}`;
        if (redactString(s).includes(payload)) missed.push(`default ${where}`);
        if (redactString(s, broad).includes(payload)) missed.push(`broad ${where}`);
        if (redactCut(s, 100_000).includes(payload)) missed.push(`redactCut ${where}`);
        if (!secretKinds(s).includes('JWT')) missed.push(`secretKinds ${where}`);
      }
    }
  }
  assert.deepEqual(missed.slice(0, 20), []);
});

/**
 * Where `rule` finds a secret in `s` from any start: the text each accepted match's replacement takes out, with where
 * it is, as `taken@position` (each once).
 */
function everyStart(s: string, re: RegExp, rep: (m: string, ...g: string[]) => string): Set<string> {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out = new Set<string>();
  for (let p = 0; p < s.length; p++) {
    g.lastIndex = p;
    const m = g.exec(s);
    if (!m || m.index !== p) continue;
    const r = rep(m[0], ...m.slice(1).map((x) => x ?? ''));
    if (r === m[0]) continue;
    let a = 0;
    while (a < m[0].length && a < r.length && m[0][a] === r[a]) a++;
    let b = 0;
    while (b < m[0].length - a && b < r.length - a && m[0][m[0].length - 1 - b] === r[r.length - 1 - b]) b++;
    const taken = m[0].slice(a, m[0].length - b);
    if (taken.length >= 8) out.add(`${taken}@${p + a}`);
  }
  return out;
}

const occurrences = (t: string, x: string) => t.split(x).length - 1;

/** Pieces each function-backed rule declines or accepts, by the rule's kind. */
const PIECES: Record<string, string[]> = {
  'Stripe key': [`${'sk'}_live_`, `${'rk'}_test_`, 'abcdefghijklmnopqrst', run(18, 'Q7rZ4kX2m9TbW3pL'), ' ', '-', '.', '_', 'x'],
  'secret under a JSON key': ['"', '\\"', "'", 'key', 'cacheKey', 'token', 'api_key', ':', ': ', ' => ', 'issue-644-aaaaaaaaaaaa', run(20, 'Q7rZ4kX2m9TbW3pL'), ','],
  // A Basic value (base64 of `u:` and a password), put together at run time.
  'Basic credential': ['Basic ', 'basic ', 'Authentication', Buffer.from(['u', 'Ch8641A7E2'].join(':')).toString('base64'), '==', '=', ' ', 'x', '+'],
  'private key': [KEY_BEGIN, KEY_END, '\n', 'body', ' '],
};

test('every function-backed rule is covered here, and nothing it accepts from any start is shown', () => {
  const rules = REDACTION_PATTERNS.filter((p) => p.group === 'secret' && typeof p.rep === 'function');
  // A new function-backed rule must be added to PIECES: its declined matches are where a token can hide.
  assert.deepEqual([...new Set(rules.map((p) => p.kind))].sort(), Object.keys(PIECES).sort());
  const missed: string[] = [];
  let seed = 7;
  const rnd = (k: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % k;
  };
  for (const rule of rules) {
    const pieces = [...PIECES[rule.kind]!, ...PIECES['Basic credential']!.slice(0, 2), '"', ' '];
    for (let i = 0; i < 4000; i++) {
      let s = '';
      for (let j = 2 + rnd(7); j > 0; j--) s += pieces[rnd(pieces.length)];
      const out = redactString(s);
      // Each place a match is accepted from some start is one occurrence the output must have lost (redaction never
      // makes a new one).
      const hidden = new Map<string, number>();
      for (const at of everyStart(s, rule.re, rule.rep as (m: string, ...g: string[]) => string)) {
        const taken = at.slice(0, at.lastIndexOf('@'));
        hidden.set(taken, (hidden.get(taken) ?? 0) + 1);
      }
      for (const [taken, n] of hidden) {
        if (occurrences(out, taken) > occurrences(s, taken) - n && missed.length < 20) missed.push(`${rule.kind}: ${JSON.stringify(s)} shows ${JSON.stringify(taken)}`);
      }
    }
  }
  assert.deepEqual(missed, []);
});

test('declined matches restart cheaply: 1 MB of each rule\'s declined text in under 2 s (default and broad)', () => {
  const declined = ['"key":"issue-644-aaaaaaaaaaaa",', '"a":"', `${'sk'}_live_abcdefghijklmnopqrst `, 'Basic Authentication ', `${KEY_END}\n`, 'a.b.c.', `${'eyJ'}aaaaaaaa.x.`];
  const slow: string[] = [];
  for (const unit of declined) {
    const s = unit.repeat(Math.ceil(1_000_000 / unit.length));
    for (const [mode, o] of [['default', {}], ['broad', broad]] as const) {
      const t0 = performance.now();
      redactString(s, o);
      const ms = performance.now() - t0;
      if (ms > 2000) slow.push(`${mode} ${JSON.stringify(unit)}: ${Math.round(ms)} ms`);
    }
  }
  assert.deepEqual(slow, []);
});
