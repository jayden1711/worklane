// lint-test
// #763 round 11 (the coordinator's decision): no money-list line is ever dropped. Lines were silently skipped two
// rounds running (round 9: a glob line whose comment held a regex token; round 10: in a list of regexes, any line with
// a blank, even one holding a regex). The reader (moneyListLines) now gives every line exactly one outcome: blank, a
// comment, read (with its globs) or refused (with a reason and a suggestion); there is no other. This test counts the
// lines that are neither blank nor a comment by the documented syntax, with its own code, and checks that read plus
// refused is that count, for every list of a seeded fuzz corpus and the reviewers' shapes, and that each read or
// refused line's entries are in what moneyListEntries returns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as review from '../src/review.js';

/** The no-break space: the first space separator past ASCII (found by its property: no code point number here). */
const NBSP = Array.from({ length: 128 }, (_, i) => String.fromCodePoint(128 + i)).find((c) => /^\p{Zs}$/u.test(c))!;

/**
 * The lines that are neither blank nor a comment, by the syntax doctor states (MONEY_COMMENT_SYNTAX), counted here:
 * a line by itself, with no state carried from one line to the next (round 12: no block comments, so an unclosed
 * `/*` can't turn the lines after it into comments; round 11's copy of the reader's block rule couldn't catch that).
 */
function contentLines(text: string): number {
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // A line holding a line or paragraph separator or a control character (a tab aside) counts whatever it is: it can
    // end a line in an editor's view, so it is refused, comment or not (round 12).
    const separator = [...line].some((c) => /\p{Zl}|\p{Zp}/u.test(c) || (/\p{Cc}/u.test(c) && c !== '\t'));
    if (!separator && (/^[\s[\](){},;]*$/.test(line) || line.startsWith('#') || line.startsWith('//'))) continue;
    n++;
  }
  return n;
}

function check(text: string): void {
  const lines = review.moneyListLines(text);
  const entries = review.moneyListEntries(text);
  const read = lines.filter((l) => l.kind === 'read');
  const refused = lines.filter((l) => l.kind === 'refused');
  assert.equal(read.length + refused.length, contentLines(text), JSON.stringify(text));
  assert.equal(lines.filter((l) => l.kind !== 'kept').length, text.split('\n').length, `one outcome a line: ${JSON.stringify(text)}`);
  const globs = new Set(entries.flatMap((e) => (e instanceof review.MoneyGlob ? [e.glob] : [])));
  const refusals = new Set(entries.flatMap((e) => (e instanceof review.RefusedMoneyLine ? [e.line] : [])));
  for (const l of lines) {
    assert.ok(['blank', 'comment', 'read', 'refused', 'kept'].includes(l.kind), l.kind);
    if (l.kind === 'read') {
      assert.ok(l.entries.length > 0, `read with no glob: ${JSON.stringify(l.line)}`);
      for (const e of l.entries) assert.ok(globs.has(e.glob), `a read glob missing from the entries: ${JSON.stringify(l.line)}`);
    }
    if (l.kind === 'refused') assert.ok(refusals.has(l.entry.line) && l.entry.suggestion.length > 0, `a refusal missing: ${JSON.stringify(l.line)}`);
  }
}

/** The reviewers' shapes, rounds 8 to 10. */
const SHAPES = [
  'billing/** # moved from /legacy/\n',
  'src/payments/** # moved from /legacy/\n',
  '"billing/**", /^payments\\//',
  "export const MONEY = ['src/billing/**', /^payments\\//];",
  '/* Money paths; the old ones were src/**/billing. */\nexport const MONEY = [\n  /^src\\/billing\\//,\n];\nexport const isLedger = (p: string) => /^src\\/ledger\\//.test(p);\n',
  'export const MONEY = [\n  /^src\\/billing\\//,\n];\nexport const isLedger = (p: string) => /^src\\/ledger\\//.test(p);\n',
  'src/**/billing/**\n/^src\\/payments\\//\nShared Ledger/**\n',
  '/^payments\\//\n"платежи/**",\n"**",\n"Billing Reports/**",\n',
  `billing/**${NBSP}# card\n`,
  'billing/**\rpayments/**',
  "docs/owner's guide/billing/**\n",
  '  /^src\\/billing\\//, /* card data */\n',
  'docs/Issue #12/**\nsrc/**/billing/**\n',
  '/^billing\\//.\n/^src\\/billing\\//.test(path)\n',
  'const MONEY = [\n//payments\n/^ledger\\//,\n];',
  './\n.\nsrc/./billing/**\n',
  '\n\n#\n# a comment\n   \n',
  // Round 12 (the round-11 reviews): an unclosed /*, a root glob that starts with /*, separators that end a line.
  'src/**/ledger/**\n/* old\nbilling/**\n',
  '/* card paths (see /[legacy/)\nsrc/payments/**\nbilling/**\n',
  '/*.sql\nsrc/billing/**\n',
  '/^payments\\//\n/* old\n/^billing\\//\n',
];

test('#763 round 11: every line of the reviewers\' shapes is read or refused, none dropped', () => {
  for (const text of SHAPES) check(text);
});

test('#763 round 11: every line of 3,000 seeded random lists is read or refused, none dropped', () => {
  const PIECES = [
    'billing/**', 'src/payments/**', '**/ledger.ts', 'Shared Ledger/**', "docs/owner's/**", '"lib/pay.ts"', "'a/**',", '`b/**`',
    '/^src\\/billing\\//', '/billing/i', '/^a[^/]*$/,', '/x/.test(p)', '=> /^l\\//', '[/^a\\//, /^b\\//]', '/(a|b)/',
    '# c', ' # c', ' // c', ' /* c */', '/* c', '*/', '//c', 'export const M = [', '];', ',', '', '   ', '- x/**', '{a,b}/**',
    `x${NBSP}# c`, 'a\rb', 'src/**/billing/**', '/', '//', './', '../x/**', 'Issue #12/**', '\t# t',
  ];
  let seed = 1011;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  for (let k = 0; k < 3_000; k++) {
    const lines: string[] = [];
    const count = 1 + rand(8);
    for (let j = 0; j < count; j++) {
      let line = PIECES[rand(PIECES.length)]!;
      if (rand(3) === 0) line += PIECES[rand(PIECES.length)]!;
      if (rand(4) === 0) line = ` ${line}`;
      lines.push(line);
    }
    check(lines.join('\n'));
  }
});
