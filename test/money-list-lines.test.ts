// #763 round 7: how each line of a money list is read, through loadMoneyPaths as an existing install reads it.
// - A glob line is read as the glob it is, never refused for what earlier versions made of its /.../ fragments
//   (`src/**/billing/**` made the whole list fail to load before; the owner's decision of 2026-10-21 reads its globs).
// - A glob line the matcher would read literally (a brace set, a class, an extglob, a leading ! or list marker, a
//   quote, a backslash) is refused with a suggested glob, and doctor fails naming it; a trailing comment and quotes
//   around the whole glob are taken off. Each suggestion, written back, is accepted and matches what it names.
// - Earlier versions' own reading of a line is kept for money-path membership only: nothing they counted stops
//   counting, and it is never compared for look-alikes.
// - A regex line that isn't a valid regex is refused; under the u flag, a lone [^/] (one code point, maybe two UTF-16
//   units) converts to ?*, not ?.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewConfig } from '../src/config/schema.js';
import { mergeDecision, waitCategoriesOf } from '../src/merge-policy.js';
import { computeLevel, loadMoneyPaths, moneyListCheck, moneyListProblems, type ChangeFile } from '../src/review.js';

const LEVELS = { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] } };
const REVIEW = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['money-path'], over_lines: 800 } } });
const VERDICT = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };
const SRC = { file: 'money.txt' } as ReviewConfig['money_path_source'];

/** A scratch repo whose money list (`money.txt`) is `text`, committed; its directory. */
function repoWith(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'money-lines-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'money.txt'), text);
  git('add', '-A');
  git('-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'money');
  return dir;
}
/** The list `text` as the engine reads it (loadMoneyPaths at HEAD). */
const moneyFrom = (text: string): RegExp[] => loadMoneyPaths(repoWith(text), SRC, 'HEAD');

/** One changed path as merge-flow judges it with an approving verdict. */
function judge(path: string, money: RegExp[]) {
  const files: ChangeFile[] = [{ path, added: 1, removed: 0 }];
  const level = computeLevel({ files, labels: [], moneyPaths: money, scope: undefined }, REVIEW);
  const merge = mergeDecision({ branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level, waitCategories: waitCategoriesOf(REVIEW), limits: { max_lines: 800, max_files: 20 }, lines: 1, files: 1, verdict: VERDICT, newTopLevel: [], ciFixRuns: 0, foreignPush: false, pushLimitHit: false });
  return { level: level.level, money: (level.categories['money-path'] ?? []).includes(path), reasons: level.reasons, auto: merge.auto };
}

/** Each glob line, the paths it names (money), and an unrelated path (normal review, L1 and merges itself). */
const ORDINARY: [string, string[]][] = [
  ['src/**/billing/**', ['src/billing/x.ts', 'src/a/b/billing/x.ts']],
  ['src/*/billing/**', ['src/api/billing/x.ts']],
  ['src/payments/invoices/**', ['src/payments/invoices/x.ts']],
  ['src/images/icons/**', ['src/images/icons/a.svg']],
  ['src/v1.2/payments/**', ['src/v1.2/payments/x.ts']],
  ['packages/billing.core/src/**', ['packages/billing.core/src/x.ts']],
  ['apps/(shop)/checkout/**', ['apps/(shop)/checkout/x.ts']],
  ['src/payments+refunds/**', ['src/payments+refunds/x.ts']],
  ['src/billing/**/*.ts', ['src/billing/a/x.ts']],
];

test('#763 round 7: an ordinary glob line is read as the glob it is: never refused, its paths are money, an unrelated path levels normally', () => {
  for (const [line, named] of ORDINARY) {
    const money = moneyFrom(`${line}\n`);
    assert.deepEqual(moneyListProblems(money), [], line);
    for (const path of named) assert.deepEqual([judge(path, money).money, judge(path, money).auto], [true, false], `${line}: ${path}`);
    assert.deepEqual([judge('lib/other/x.ts', money).level, judge('lib/other/x.ts', money).auto], ['L1', true], line);
  }
});

test('#763 round 7 (the owner\'s decision): a list whose glob lines hold /**/ or /*/, which failed to load before, is read as its globs', () => {
  const money = moneyFrom('src/**/billing/**\nlib/*/ledger/**\n');
  assert.deepEqual(moneyListProblems(money), []);
  for (const path of ['src/a/billing/x.ts', 'lib/core/ledger/y.ts']) assert.equal(judge(path, money).money, true, path);
  assert.deepEqual([judge('src/other/x.ts', money).level, judge('src/other/x.ts', money).auto], ['L1', true]);
  assert.equal(moneyListCheck(repoWith('src/**/billing/**\n'), SRC, 'HEAD').level, 'ok');
});

test('#763 round 7: earlier versions\' reading of a glob line\'s /.../ is kept for membership only: what they counted still counts, and it is never compared for look-alikes', () => {
  // Earlier versions read src/payments/invoices/** as the regex /payments/i.
  const money = moneyFrom('src/payments/invoices/**\n');
  assert.equal(judge('lib/PAYMENTS/x.ts', money).money, true);
  // Not a look-alike of that reading (it isn't compared): a payrnents path levels normally.
  assert.deepEqual([judge('lib/payrnents/x.ts', money).level, judge('lib/payrnents/x.ts', money).auto], ['L1', true]);
});

/** Each glob line the matcher would read literally, a path it means, and a path its suggestion must also match. */
const LITERAL: [string, string[]][] = [
  ['- billing/**', ['billing/x.ts']],
  ['* billing/**', ['billing/x.ts']],
  ['{billing,payments}/**', ['billing/x.ts', 'payments/x.ts']],
  ['src/pay.{ts,js}', ['src/pay.ts', 'src/pay.js']],
  ['src/[bB]illing.ts', ['src/billing.ts', 'src/Billing.ts']],
  ['app/[slug]/billing/**', ['app/[slug]/billing/x.ts', 'app/shop/billing/x.ts']],
  ['src/@(pay|bill)/**', ['src/pay/x.ts', 'src/bill/x.ts']],
  ['src/+(pay)/**', ['src/pay/x.ts']],
  ['!src/legacy/**', ['src/legacy/x.ts']],
  ['src\\billing\\**', ['src/billing/x.ts']],
  ["'lib/pay.ts", ['lib/pay.ts']],
  ['lib/"pay".ts', ['lib/pay.ts']],
];

test('#763 round 7: a glob line the matcher would read literally is refused, never silently matching nothing: every PR waits naming it, and doctor fails', () => {
  for (const [line, meant] of LITERAL) {
    const money = moneyFrom(`${line}\npayments/**\n`);
    const problems = moneyListProblems(money);
    assert.deepEqual(problems.map((p) => p.line), [line], line);
    const r = judge('docs/readme.md', money);
    assert.deepEqual([r.level, r.auto], ['L3', false], line);
    assert.ok(r.reasons.some((x) => x.includes(`the money list's line ${JSON.stringify(line)} would be read literally`)), r.reasons.join('\n'));
    const doctor = moneyListCheck(repoWith(`${line}\n`), SRC, 'HEAD');
    assert.equal(doctor.level, 'fail', line);
    assert.ok(doctor.detail.startsWith(`${line} would be read literally`), doctor.detail);
    // The suggestion, written back, is accepted, and matches what the line means.
    const back = moneyFrom(`${problems[0]!.suggestion}\n`);
    assert.deepEqual(moneyListProblems(back), [], `${line} -> ${problems[0]!.suggestion}`);
    for (const path of meant) assert.equal(judge(path, back).money, true, `${line} -> ${problems[0]!.suggestion}: ${path}`);
  }
});

test('#763 round 7: a trailing comment, and quotes around the whole glob, are taken off; in a list of regexes too', () => {
  for (const text of ['billing.ts # card data\n"lib/pay.ts"\n', "/^src\\/payments\\//\nbilling.ts # card data\n'lib/pay.ts',\n"]) {
    const money = moneyFrom(text);
    assert.deepEqual(moneyListProblems(money), [], text);
    for (const path of ['billing.ts', 'lib/pay.ts']) assert.equal(judge(path, money).money, true, `${JSON.stringify(text)}: ${path}`);
    assert.deepEqual([judge('lib/other.ts', money).level, judge('lib/other.ts', money).auto], ['L1', true], text);
  }
  // Round 11 (the coordinator's decision: no line is dropped): code around a list of regexes (a whole JS file) is
  // refused, never skipped; its brackets alone are blank. A list selected by money_path_source.pattern holds no code.
  assert.deepEqual(moneyListProblems(moneyFrom('export const MONEY = [\n  /^src\\/payments\\//,\n];\n')).map((p) => p.line), ['export const MONEY = [']);
  assert.deepEqual(moneyListProblems(moneyFrom('\n  /^src\\/payments\\//,\n')), []);
});

test('#763 round 7: each suggestion for a refused regex line, written back, is accepted and matches the paths the regex did', () => {
  const cases: [string, string[]][] = [
    ['/^src\\/\\w+\\/billing\\//', ['src/api/billing/x.ts']],
    ['/^apps\\/[a-z]+\\/payments\\//', ['apps/shop/payments/x.ts']],
    ['/^src\\/(?:api|web)\\/billing/', ['src/web/billing.ts']],
    // Under the i flag too (round 11: each ASCII letter is `?` in the suggestion, so every case is matched).
    ['/invoice/i', ['lib/invoice.ts', 'lib/Invoice.ts', 'lib/INVOICE.ts']],
    ['/^db\\/migrations\\/\\d+_\\w+\\.sql$/', ['db/migrations/0001_rates.sql']],
    ['/^app\\/\\[slug\\]\\/x\\d/', ['app/[slug]/x1.ts']],
    ['/^lib\\/"pay"\\d/', ['lib/"pay"1.ts']],
  ];
  for (const [line, matched] of cases) {
    const problems = moneyListProblems(moneyFrom(`${line}\n`));
    assert.equal(problems.length, 1, line);
    const back = moneyFrom(`${problems[0]!.suggestion}\n`);
    assert.deepEqual(moneyListProblems(back), [], `${line} -> ${problems[0]!.suggestion}`);
    for (const path of matched) assert.equal(judge(path, back).money, true, `${line} -> ${problems[0]!.suggestion}: ${path}`);
  }
});

test('#763 round 7: under the u flag a lone [^/] keeps an emoji in its slot a money path; a regex line that isn\'t valid is refused', () => {
  const money = moneyFrom('/^src\\/pay[^\\/]ents\\//u\n');
  assert.deepEqual([judge('src/pay💰ents/a.ts', money).money, judge('src/pay💰ents/a.ts', money).auto], [true, false]);
  assert.deepEqual([judge('src/payXents/a.ts', money).money, judge('src/other/a.ts', money).money], [true, false]);
  for (const line of ['/a\\-b/u', '/\\é/u']) assert.deepEqual(moneyListProblems(moneyFrom(`${line}\n`)).map((p) => p.line), [line], line);
});
