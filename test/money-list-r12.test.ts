// #763 round 12, from the round-11 reviews:
// - an unclosed /* turned every line after it into a comment, so a list's globs were dropped with doctor ok (a list
//   main threw on: L1 where main gave L3; a list main loads: look-alikes of the money paths at L1). Block comments are
//   not read now: a line with /* at its start or after a blank, or any line holding /* that isn't a valid glob, is
//   refused, and the lines after it are read as they are;
// - a /* after a no-break space, a line or paragraph separator, or a C1 control joining two globs, read silently;
// - a comment cut that left a glob not covering the line as written (`docs/Issue #12/[id]/**`), read as the cut alone,
//   and a cut line read as two entries;
// - suggestions narrower than their regex: an escape with a payload (`\x2f`, `b`, `\cJ`, `\k<p>`), and, under the
//   i flag, letters outside ASCII (`é`, `σ`, `ß`, `ǆ`).
//
// WHY the letters and separators are written as themselves or found by their properties: no committed file holds a
// code point number (#763).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewConfig } from '../src/config/schema.js';
import { globToRegExp } from '../src/guardrails/glob.js';
import * as review from '../src/review.js';

const { computeLevel, loadMoneyPaths, moneyListCheck, moneyListEntries, moneyListProblems, MoneyGlob } = review;
/** The Cyrillic small a, written as itself. */
const CYRILLIC_A = 'а';
/** The first character of each kind past ASCII, found by its property. */
const first = (re: RegExp) => Array.from({ length: 65536 - 128 }, (_, i) => String.fromCodePoint(128 + i)).find((c) => re.test(c))!;
const NBSP = first(/^\p{Zs}$/u);
const LINE_SEPARATOR = first(/^\p{Zl}$/u);
const PARAGRAPH_SEPARATOR = first(/^\p{Zp}$/u);
const C1 = first(/^\p{Cc}$/u);
const LEVELS = { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] } };
const MONEY_L3 = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['money-path'], over_lines: 800 } } });
const level = (money: RegExp[], path: string) => computeLevel({ files: [{ path, added: 1, removed: 0 }], labels: [], moneyPaths: money, scope: undefined }, MONEY_L3).level;

function doctorOf(text: string): { level: string; detail: string } {
  const dir = mkdtempSync(join(tmpdir(), 'money-r12-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'money.txt'), text);
  git('add', '-A');
  git('commit', '-q', '-m', 'money');
  const src = { file: 'money.txt' } as Parameters<typeof moneyListCheck>[1];
  assert.ok(loadMoneyPaths(dir, src, 'HEAD').length > 0);
  return moneyListCheck(dir, src, 'HEAD');
}

test('#763 round 12: the characters here are the ones their names say', () => {
  assert.ok(/^\p{Script=Cyrillic}$/u.test(CYRILLIC_A) && !/[a-z]/.test(CYRILLIC_A));
  assert.equal(NBSP.normalize('NFKC'), ' ');
  assert.ok(LINE_SEPARATOR !== PARAGRAPH_SEPARATOR && /\p{Cc}/u.test(C1) && C1 !== '\t');
});

test('#763 round 12: an unclosed /* hides nothing: on a list main threw on, the globs after it are read and the line itself is refused', () => {
  // `src/**/ledger/**`'s `/**/` made main throw: every change was L3 there.
  for (const [text, paths] of [
    ['src/**/ledger/**\n/* old\nbilling/**\n', ['billing/x.ts']],
    ['/* card paths (see /[legacy/)\nsrc/payments/**\nbilling/**\n', ['src/payments/x.ts', 'billing/x.ts']],
  ] as const) {
    const money = moneyListEntries(text);
    for (const p of paths) assert.equal(level(money, p), 'L3', `${JSON.stringify(text)}: ${p}`);
    assert.ok(moneyListProblems(money).some((x) => x.line.startsWith('/*') && x.suggestion === '**'), JSON.stringify(text));
    assert.equal(doctorOf(text).level, 'fail', JSON.stringify(text));
  }
});

test('#763 round 12: an unclosed /* on a glob list and a regex list main loads: the look-alikes of the money paths after it are held', () => {
  for (const [text, lookalike] of [
    ['/*.sql\nsrc/billing/**\nsrc/payments/**\n', `src/p${CYRILLIC_A}yments/x.ts`],
    ['/^billing\\//\n/* old\n/^src\\/payments\\//\n', `src/p${CYRILLIC_A}yments/x.ts`],
  ] as const) {
    const money = moneyListEntries(text);
    assert.equal(level(money, lookalike), 'L3', `${JSON.stringify(text)}: ${lookalike}`);
    assert.ok(moneyListProblems(money).length >= 1, JSON.stringify(text));
    // The lines after the /* line are read as globs (compared for look-alikes), not only kept as main's reading.
    assert.ok(money.some((e) => e instanceof MoneyGlob && e.glob === 'src/payments/**'), JSON.stringify(text));
  }
});

test('#763 round 12: a /* after a no-break space, and a line or paragraph separator or a C1 control in a line, are refused', () => {
  for (const text of [`billing/**${NBSP}/* card data`, `billing/**${LINE_SEPARATOR}payments/**`, `billing/**${PARAGRAPH_SEPARATOR}payments/**`, `billing/**${C1}payments/**`, `# note${LINE_SEPARATOR}payments/**`]) {
    const money = moneyListEntries(text);
    assert.equal(moneyListProblems(money).length, 1, JSON.stringify(text));
    for (const p of ['billing/charge.ts', 'payments/pay.ts']) assert.equal(level(money, p), 'L3', `${JSON.stringify(text)}: ${p}`);
  }
});

test('#763 round 12: a comment cut never narrows and gives one entry a line', () => {
  // The line as written isn't a valid glob: refused (it was read as `docs/Issue` alone), on a list main threw on.
  const invalid = moneyListEntries('docs/Issue #12/[id]/**\nsrc/**/billing/**\n');
  assert.equal(level(invalid, 'docs/Issue #12/[id]/x.ts'), 'L3');
  assert.deepEqual(moneyListProblems(invalid).map((p) => p.line), ['docs/Issue #12/[id]/**']);
  // The line as written is a valid glob the cut doesn't cover: one entry, covering both readings.
  const lines = 'docs/Issue #12/**\nbilling.ts # card data\nsrc/billing/** # card data\n';
  const money = moneyListEntries(lines);
  assert.deepEqual(moneyListProblems(money), []);
  assert.equal(money.filter((e) => e instanceof MoneyGlob).length, 3, money.map(String).join(' '));
  for (const p of ['docs/Issue #12/x.ts', 'docs/Issue', 'billing.ts', 'src/billing/x.ts']) assert.ok(money.some((e) => e instanceof MoneyGlob && e.test(p)), p);
  // 200 commented four-`**` globs: 200 entries, as main has 200 RegExps (round 11 had 400).
  const many = Array.from({ length: 200 }, (_, i) => `**x**y**z${i}q** # card`).join('\n');
  assert.equal(moneyListEntries(many).filter((e) => e instanceof MoneyGlob).length, 200);
});

test('#763 round 12: suggestions are never narrower: escapes with a payload, and letters outside ASCII under the i flag', () => {
  const covers = (line: string, paths: string[]) => {
    const problems = moneyListProblems(moneyListEntries(line));
    assert.equal(problems.length, 1, line);
    const g = globToRegExp(problems[0]!.suggestion);
    for (const p of paths) {
      const re = /^\/(.*)\/([a-z]*)$/.exec(line)!;
      assert.ok(new RegExp(re[1]!, re[2]!).test(p), `the regex itself matches ${p}`);
      assert.ok(g.test(p), `${line} -> ${problems[0]!.suggestion} misses ${JSON.stringify(p)}`);
    }
  };
  covers('/^billing\\x2f/', ['billing/x.ts']);
  covers('/^\\x62illing\\//', ['billing/x.ts']);
  covers('/^\\u0062illing\\//', ['billing/x.ts']);
  covers('/^(?<p>bill)ing\\/\\k<p>\\//', ['billing/bill/x.ts']);
  covers('/^a\\cJ/', ['a\nx']);
  covers('/^café\\//i', ['café/x.ts', 'CAFÉ/x.ts']);
  covers('/^straße\\//iu', ['straße/x.ts', 'STRAẞE/x.ts']);
  covers('/^σ/i', ['σ/x', 'Σ/x', 'ς/x']);
  covers('/^ǆ/i', ['ǆ/x', 'ǅ/x', 'Ǆ/x']);
});

test('#763 round 12: a whole-line fuzz with escapes and letters outside ASCII, with and without the i flag: no suggestion or read glob narrower than its regex', () => {
  const ALPHABET = ['b', 'B', '/', '.', 'é', 'É', 'σ', 'Σ', 'ς', 'ß', 'ẞ', 'ǆ', 'ǅ'];
  const paths: string[] = [''];
  for (let n = 1; n <= 3; n++) for (const p of paths.filter((q) => q.length === n - 1)) for (const c of ALPHABET) paths.push(p + c);
  const PIECES = ['b', 'B', '\\/', '\\.', '[^/]', '.*', '?', '*', '+', '{0,2}', 'é', 'σ', 'ß', 'ǆ', '\\x62', '\\x2f', '\\u00e9', '\\u{e9}', '(b)', '\\1', '(?<p>b)', '\\k<p>', '\\cJ', '\\p{L}', '\\b', '$'];
  const FLAGS = ['', 'i', 'u', 'iu'];
  const TEMPLATES = [(r: string) => r, (r: string) => `${r},`, (r: string) => `x ${r}`, (r: string) => `${r} # c`];
  let seed = 1212;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  let tried = 0;
  const misses: string[] = [];
  for (let k = 0; k < 3_000; k++) {
    let body = rand(2) ? '^' : '';
    for (let j = 0, len = 1 + rand(4); j < len; j++) body += PIECES[rand(PIECES.length)]!;
    const flags = FLAGS[rand(FLAGS.length)]!;
    let re: RegExp;
    try {
      re = new RegExp(body, flags);
    } catch {
      continue;
    }
    if (body.includes('/') && !body.includes('\\/')) continue;
    const line = TEMPLATES[rand(TEMPLATES.length)]!(`/${body}/${flags}`);
    tried++;
    const entries = moneyListEntries(line);
    const globs = [...entries.flatMap((e) => (e instanceof MoneyGlob ? [globToRegExp(e.glob)] : [])), ...moneyListProblems(entries).map((p) => globToRegExp(p.suggestion))];
    if (!globs.length) {
      misses.push(`neither read nor refused: ${line}`);
      continue;
    }
    const missed = paths.find((p) => re.test(p) && !globs.some((g) => g.test(p)));
    if (missed !== undefined) misses.push(`${line} misses ${JSON.stringify(missed)}`);
  }
  assert.ok(tried > 1_000, `${tried} lines`);
  assert.deepEqual(misses.slice(0, 5), []);
});
