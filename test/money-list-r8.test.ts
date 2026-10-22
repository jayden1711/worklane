// #763 round 8, from the round-7 delta check:
// - a regex line is read as JS reads a regex literal: a `/` inside a class doesn't end it, so a line is refused or
//   converted whole, never cut at the class into a fragment with a narrower suggestion;
// - no level drops below main's: what only this version counts as money (a glob line beside a regex, which main
//   didn't read) gets money-path, which only raises, and still counts as app code for the large-change L2;
// - lines that matched no git path, silently: a trailing ` // comment` is taken off; a trailing `,` or `;`, a
//   leading `/` and a `//` are refused with a suggested glob.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewConfig } from '../src/config/schema.js';
import { computeLevel, MoneyGlob, moneyListEntries, moneyListProblems, RefusedMoneyLine, type ChangeFile } from '../src/review.js';

const LEVELS = { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] } };
const MONEY_L3 = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['money-path'], over_lines: 800 } } });
const isMoney = (path: string, money: RegExp[]) => (computeLevel({ files: [{ path, added: 1, removed: 0 }], labels: [], moneyPaths: money, scope: undefined }, MONEY_L3).categories['money-path'] ?? []).includes(path);

test('#763 round 8: a regex line with a / inside a class is read whole: refused naming the line, and its suggestion covers every alternative', () => {
  const line = '/^billing\\/[^/]*$|^payments\\//';
  const problems = moneyListProblems(moneyListEntries(line));
  assert.deepEqual(problems.map((p) => p.line), [line]);
  const back = moneyListEntries(problems[0]!.suggestion);
  assert.deepEqual(moneyListProblems(back), []);
  for (const path of ['billing/a.ts', 'payments/a.ts']) assert.equal(isMoney(path, back), true, `${problems[0]!.suggestion}: ${path}`);
});

test('#763 round 8: a mechanical regex line with a / inside a class converts whole', () => {
  const entries = moneyListEntries('/^src\\/[^/]*\\.ts$/');
  assert.deepEqual(entries.map((e) => (e instanceof MoneyGlob ? e.glob : e instanceof RefusedMoneyLine ? `refused ${e.line}` : String(e))), ['src/*.ts']);
  assert.deepEqual([isMoney('src/a.ts', entries), isMoney('src/x/a.ts', entries)], [true, false]);
});

test('#763 round 8: what only this version counts as money doesn\'t lower a level: a large change under a glob line beside a regex stays L2', () => {
  // Main read only the regex here; the glob line is read since round 6. This review.yaml doesn't list money-path.
  const cfg = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['auth'], over_lines: 800 } } });
  // (Round 11: the list's code line `export const MONEY = [` is refused now, which holds everything at L3; the list
  // here is the array's body, as money_path_source.pattern selects it, so the level shows what this test is about.)
  const money = moneyListEntries('  /^ledger\\//,\n  billing/**\n');
  const files: ChangeFile[] = Array.from({ length: 11 }, (_, i) => ({ path: `billing/f${i}.ts`, added: 1, removed: 0 }));
  const level = computeLevel({ files, labels: [], moneyPaths: money, scope: undefined }, cfg);
  assert.equal(level.level, 'L2');
  assert.ok(level.reasons.includes('large app change: 11 lines, 11 files'), level.reasons.join('\n'));
  assert.equal((level.categories['money-path'] ?? []).length, 11);
  // A path main counted (the regex) is money and not app-non-money, as on main.
  const ledger = computeLevel({ files: [{ path: 'ledger/a.ts', added: 1, removed: 0 }], labels: [], moneyPaths: money, scope: undefined }, cfg);
  assert.deepEqual([ledger.categories['money-path'], ledger.categories['app-non-money']], [['ledger/a.ts'], undefined]);
});

test('#763 round 8: a trailing // comment is taken off; a trailing , or ;, a leading / and a // are refused, each suggestion accepted and covering the line', () => {
  const commented = moneyListEntries('src/billing/** // card data');
  assert.deepEqual(moneyListProblems(commented), []);
  assert.equal(isMoney('src/billing/x.ts', commented), true);
  for (const line of ['src/billing/**;', 'src/billing/**,', '`/billing/`', '/src/billing/**', 'src//billing/**']) {
    const problems = moneyListProblems(moneyListEntries(`${line}\npayments/**`));
    assert.deepEqual(problems.map((p) => p.line), [line], line);
    const back = moneyListEntries(problems[0]!.suggestion);
    assert.deepEqual(moneyListProblems(back), [], `${line} -> ${problems[0]!.suggestion}`);
    assert.equal(isMoney('src/billing/x.ts', back), true, `${line} -> ${problems[0]!.suggestion}`);
  }
  // A line that starts with // is a comment line (round 11: in every list), not refused; a code line is (round 11).
  assert.deepEqual(moneyListProblems(moneyListEntries('const MONEY = [\n//payments\n/^ledger\\//,\n];')).map((p) => p.line), ['const MONEY = [']);
});
