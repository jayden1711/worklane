// #763 round 10 (the coordinator's decision): every money-list line is read whole, with no regex read out of a part
// of it. A trailing comment is taken off first, by one syntax (withoutComment: a # or // after a blank, outside
// quotes); what is left is exactly one glob or exactly one regex that converts mechanically, or the line is refused
// with a suggested glob. From the round-9 reviews:
// - a glob line whose comment names a path between slashes (`billing/** # moved from /legacy/`) was read as that
//   regex only, its glob dropped, with doctor saying ok: a list main threw on leveled below main (L1), and a list main
//   loaded let a look-alike of the money path through (L1);
// - a quoted glob and a regex on one line were read as the regex only;
// - `./` alone was the empty glob, which matches no path;
// - a suggestion could be narrower than its regex: `[^/]` followed by a quantifier that allows none (`?`, `{0,2}`).
//
// WHY the look-alike letter is written as itself with a name: no committed file holds a code point number (#763).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewConfig } from '../src/config/schema.js';
import { globToRegExp } from '../src/guardrails/glob.js';
import * as review from '../src/review.js';

const { computeLevel, loadMoneyPaths, moneyListCheck, moneyListEntries, moneyListProblems, regexToGlob, RefusedMoneyLine } = review;
/** The Cyrillic small a, written as itself. */
const CYRILLIC_A = 'а';
const LEVELS = { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] } };
const MONEY_L3 = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['money-path'], over_lines: 800 } } });
const level = (money: RegExp[], path: string) => computeLevel({ files: [{ path, added: 1, removed: 0 }], labels: [], moneyPaths: money, scope: undefined }, MONEY_L3);

/** doctor's check and the loaded list, from a scratch repo holding `text` as its money list. */
function fromRepo(text: string): { doctor: { level: string; detail: string }; money: RegExp[] } {
  const dir = mkdtempSync(join(tmpdir(), 'money-r10-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'money.txt'), text);
  git('add', '-A');
  git('commit', '-q', '-m', 'money');
  const src = { file: 'money.txt' } as Parameters<typeof moneyListCheck>[1];
  return { doctor: moneyListCheck(dir, src, 'HEAD'), money: loadMoneyPaths(dir, src, 'HEAD') };
}

test('#763 round 10: the look-alike letter here is the one its name says', () => {
  assert.ok(/^\p{Script=Cyrillic}$/u.test(CYRILLIC_A) && !/[a-z]/.test(CYRILLIC_A));
});

test('#763 round 10: a glob line whose comment names a path between slashes, on a list main threw on: its glob is read, and the change is held as money', () => {
  const { doctor, money } = fromRepo('billing/** # moved from /legacy/\n');
  assert.equal(level(money, 'billing/charge.ts').level, 'L3');
  assert.ok((level(money, 'billing/charge.ts').categories['money-path'] ?? []).includes('billing/charge.ts'));
  // doctor's ok is true now: the line is one glob, read whole once its comment is off; it names the comment syntax.
  assert.equal(doctor.level, 'ok');
  assert.ok(doctor.detail.includes(review.MONEY_COMMENT_SYNTAX), doctor.detail);
});

test('#763 round 10: the same on a list main loaded: a look-alike of the money path is held', () => {
  const { money } = fromRepo('src/payments/** # moved from /legacy/\n');
  const lookalike = `src/p${CYRILLIC_A}yments/x.ts`;
  const r = level(money, lookalike);
  assert.equal(r.level, 'L3', r.reasons.join('\n'));
  assert.ok((r.categories['confusable-path'] ?? []).includes(lookalike));
  // The control the review used: a comment without slashes was held already.
  assert.equal(level(moneyListEntries('src/payments/** # moved from legacy'), lookalike).level, 'L3');
});

test('#763 round 10: a glob and a regex on one line, quoted or not, in any order, are refused naming the line, never read in part', () => {
  for (const line of ['"billing/**", /^payments\\//', '[/^payments\\//, "billing/**"]', 'billing/x.ts /^payments\\//', "export const MONEY = ['src/billing/**', /^payments\\//];"]) {
    const entries = moneyListEntries(line);
    const problems = moneyListProblems(entries);
    assert.deepEqual(problems.map((p) => p.line), [line], line);
    assert.match(problems[0]!.why, /regex beside other text/, line);
    // Refused, so every path counts as money and every change waits, naming the line (fails closed).
    for (const path of ['billing/charge.ts', 'payments/x.ts', 'src/billing/x.ts']) assert.equal(level(entries, path).level, 'L3', `${line}: ${path}`);
    assert.ok(entries.some((e) => e instanceof RefusedMoneyLine));
  }
});

test('#763 round 10: the one comment syntax: a # or // after a blank, outside quotes', () => {
  const cases: [string, string][] = [
    ['billing/** # card data', 'billing/**'],
    ['billing/**\t// card data', 'billing/**'],
    ['billing/**#card', 'billing/**#card'],
    ['billing/**//card', 'billing/**//card'],
    ["'billing # x/**' # y", "'billing # x/**'"],
    ['"a // b" // c', '"a // b"'],
    ['/^billing\\// # card', '/^billing\\//'],
  ];
  for (const [line, rest] of cases) assert.equal(review.withoutComment(line), rest, line);
  // A regex line with a comment is read as the regex.
  assert.deepEqual(moneyListProblems(moneyListEntries('/^billing\\// # card data')), []);
});

test('#763 round 10: ./ alone is refused with a suggested glob that is accepted', () => {
  const problems = moneyListProblems(moneyListEntries('./\npayments/**'));
  assert.deepEqual(problems.map((p) => p.line), ['./']);
  assert.deepEqual(moneyListProblems(moneyListEntries(problems[0]!.suggestion)), []);
});

test('#763 round 10: a suggestion is never narrower than its regex: the review\'s cases and a fuzz', () => {
  const ALPHABET = ['a', 'b', '/', '.', 'x'];
  const paths: string[] = [''];
  for (let n = 1; n <= 4; n++) for (const p of paths.filter((q) => q.length === n - 1)) for (const c of ALPHABET) paths.push(p + c);
  const covers = (body: string, flags: string): string | null => {
    const re = new RegExp(body, flags);
    const r = regexToGlob(body, flags);
    const glob = 'glob' in r ? r.glob : r.suggestion;
    const g = globToRegExp(glob);
    const missed = paths.find((p) => re.test(p) && !g.test(p));
    return missed === undefined ? null : `${body}/${flags} -> ${glob} misses ${JSON.stringify(missed)}`;
  };
  for (const body of ['^a[^/]?b$', '^a[^/]{0,2}b$', '^a[^/]{0}b$', '^src\\/x[^/]?\\.ts$', '^a[^/]*?b$']) assert.equal(covers(body, ''), null);
  // A fuzz over pieces a mechanical conversion meets, and the quantifiers that follow them (seeded, so it is the same
  // run every time).
  const PIECES = ['a', 'b', 'x', '\\/', '\\.', '[^/]', '[^\\/]', '.*', '.', '?', '*', '+', '{0}', '{0,2}', '{1,2}', '[ab]', '(a|b)', '\\d', '$'];
  let seed = 763;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  let tried = 0;
  const misses: string[] = [];
  for (let k = 0; k < 4_000; k++) {
    let body = rand(2) ? '^' : '';
    const len = 1 + rand(6);
    for (let j = 0; j < len; j++) body += PIECES[rand(PIECES.length)]!;
    try {
      new RegExp(body);
    } catch {
      continue;
    }
    tried++;
    const miss = covers(body, '');
    if (miss) misses.push(miss);
  }
  assert.ok(tried > 2_000, `${tried} valid regexes`);
  assert.deepEqual(misses.slice(0, 5), []);
});
