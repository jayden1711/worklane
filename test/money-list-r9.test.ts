// #763 round 9, from the round-8 delta check:
// - what main counted is recorded for every line, not only for a glob's first line: `billing/** # card data` (read as
//   `billing/**`) then `billing/**` lost the second line's reading, so 11 files main counted as money were app code
//   again and the change went from L1 (main) to L2;
// - a glob line with a `.` or `..` segment matched no git path, silently: it is refused with a suggested glob.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewConfig } from '../src/config/schema.js';
import { computeLevel, moneyBefore, moneyListEntries, moneyListProblems, RefusedMoneyLine, type ChangeFile } from '../src/review.js';

const LEVELS = { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] } };
const MONEY_L3 = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['money-path'], over_lines: 800 } } });
const isMoney = (path: string, money: RegExp[]) => (computeLevel({ files: [{ path, added: 1, removed: 0 }], labels: [], moneyPaths: money, scope: undefined }, MONEY_L3).categories['money-path'] ?? []).includes(path);

test('#763 round 9: a commented glob line then the same glob bare: main\'s reading of the bare line is kept, and the level is main\'s (L1)', () => {
  // The round-8 delta check's dup.mjs: this review.yaml doesn't list money-path, so money paths aren't app code.
  const cfg = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['auth'], over_lines: 800 } } });
  const money = moneyListEntries('billing/** # card data\nbilling/**\n');
  assert.ok(moneyBefore(money).some((re) => re.test('billing/f0.ts')), 'main counted billing/** (its second line, as written)');
  const files: ChangeFile[] = Array.from({ length: 11 }, (_, i) => ({ path: `billing/f${i}.ts`, added: 1, removed: 0 }));
  const level = computeLevel({ files, labels: [], moneyPaths: money, scope: undefined }, cfg);
  assert.equal(level.level, 'L1', level.reasons.join('\n'));
  assert.equal(level.categories['app-non-money'], undefined);
  assert.equal((level.categories['money-path'] ?? []).length, 11);
  // The other order, and the glob twice bare, as before.
  for (const list of ['billing/**\nbilling/** # card data\n', 'billing/**\nbilling/**\n']) {
    assert.equal(computeLevel({ files, labels: [], moneyPaths: moneyListEntries(list), scope: undefined }, cfg).level, 'L1', list);
  }
});

test('#763 round 9: a glob line with a . or .. segment is refused naming it, and its suggestion is accepted and covers the meant paths', () => {
  const cases: [string, string][] = [
    ['src/./billing/**', 'src/billing/x.ts'],
    ['src/../billing/**', 'billing/x.ts'],
    ['src/billing/**/.', 'src/billing/x.ts'],
    ['src/billing/.', 'src/billing/x.ts'],
    ['../billing/**', 'billing/x.ts'],
    ['./src/./billing/**', 'src/billing/x.ts'],
    ['.', 'src/billing/x.ts'],
  ];
  for (const [line, meant] of cases) {
    const entries = moneyListEntries(`${line}\npayments/**`);
    const problems = moneyListProblems(entries);
    assert.deepEqual(problems.map((p) => p.line), [line], line);
    assert.match(problems[0]!.why, /never has a \. or \.\. segment/, line);
    const refused = entries.find((e): e is RefusedMoneyLine => e instanceof RefusedMoneyLine)!;
    assert.ok(refused.reason.includes(JSON.stringify(line)) && refused.reason.includes(problems[0]!.suggestion), refused.reason);
    const back = moneyListEntries(problems[0]!.suggestion);
    assert.deepEqual(moneyListProblems(back), [], `${line} -> ${problems[0]!.suggestion}`);
    assert.equal(isMoney(meant, back), true, `${line} -> ${problems[0]!.suggestion}: ${meant}`);
  }
});

test('#763 round 9: a leading ./ (which the matcher drops) and names with dots stay plain globs', () => {
  for (const line of ['./billing/**', '.github/**', 'src/.env', 'src/..hidden/**', 'src/a.../**', 'docs/v1.2/**']) {
    assert.deepEqual(moneyListProblems(moneyListEntries(line)), [], line);
  }
  assert.equal(isMoney('billing/x.ts', moneyListEntries('./billing/**')), true);
});
