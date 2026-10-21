// #763 round 6, the owner's call: money paths are globs only. A regex line of the money list is converted to a glob
// where that is mechanical (regexToGlob) and refused otherwise (RefusedMoneyLine: every change waits, and doctor's
// moneyListProblems names the line with a suggested glob). The routes rounds 3 to 5 found, against glob money lists.
//
// WHY the one look-alike character here is written as itself with a name: no committed file holds a code point
// number (#763).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewConfig } from '../src/config/schema.js';
import { mergeDecision, waitCategoriesOf } from '../src/merge-policy.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeLevel, escapedPath, MONEY_COMMENT_SYNTAX, MoneyGlob, moneyListCheck, moneyListEntries,moneyListProblems, RefusedMoneyLine, regexToGlob, type ChangeFile } from '../src/review.js';

const CYRILLIC_A = 'а';

test('#763: the look-alike character here is a Cyrillic small a', () => {
  assert.ok(/^\p{Script=Cyrillic}$/u.test(CYRILLIC_A) && CYRILLIC_A.toUpperCase() !== CYRILLIC_A);
});

test('#763: regexToGlob converts only the mechanical forms: literals, escaped punctuation, .*, [^/]*, [^/]+, [^/], anchors', () => {
  const ok = (body: string, flags = '') => {
    const r = regexToGlob(body, flags);
    assert.ok('glob' in r, `${body}: ${JSON.stringify(r)}`);
    return r.glob;
  };
  assert.equal(ok('payments'), '**payments**');
  assert.equal(ok('^src\\/payments\\/'), 'src/payments/**');
  assert.equal(ok('^lib\\/pay\\.ts$'), 'lib/pay.ts');
  assert.equal(ok('^src\\/billing\\/.*\\.ts$'), 'src/billing/**.ts');
  assert.equal(ok('^src\\/billing\\/[^\\/]+\\.ts$'), 'src/billing/?*.ts');
  assert.equal(ok('^src\\/[^/]*\\/ledger$'), 'src/*/ledger');
  assert.equal(ok('\\/v1\\/payments\\/', 'gu'), '**/v1/payments/**');
  // Not mechanical: the i flag, a class, \d, alternation, a group, a lone dot, a quantified literal, an escaped * or a letter escape.
  for (const [body, flags] of [['billing', 'i'], ['pay[m]ents', ''], ['migrations\\/\\d+_', ''], ['(a|b)', ''], ['pay.ents', ''], ['bil+ing', ''], ['a\\*b', ''], ['pay\\qents', '']] as const) {
    const r = regexToGlob(body, flags);
    assert.ok('why' in r && r.suggestion.length > 0, `${body}/${flags}: ${JSON.stringify(r)}`);
  }
  // The suggestion reads each part it can't convert as **.
  assert.deepEqual(regexToGlob('migrations\\/\\d+_rates', ''), { why: '"\\d+_rates" has no mechanical glob form', suggestion: '**migrations/**_rates**' });
});

test('#763: a line is a regex only as a /.../flags token; src/payments/** is a glob; main\'s reading of every /.../ in the text is kept beside it', () => {
  const read = (text: string) => moneyListEntries(text).map((r) => (r instanceof RefusedMoneyLine ? `refused ${r.line}` : r instanceof MoneyGlob ? r.glob : String(r)));
  // A list of globs: each line a glob. Main read the /payments/ inside the first line as a regex, so that stays too,
  // as main's own RegExp for money-path membership only (round 7: never refused, never compared for look-alikes).
  assert.deepEqual(read('src/payments/**\nbilling/**\n**/ledger.ts'), ['src/payments/**', 'billing/**', '**/ledger.ts', '/payments/']);
  // A list of regexes, one a line (a trailing comma allowed): each converted or refused.
  assert.deepEqual(read('/^lib\\/pay\\.ts$/,\n/billing/i'), ['lib/pay.ts', 'refused /billing/i']);
  // Round 10 (the coordinator's decision: every line read whole): a code line holding regexes beside other text is
  // refused, never read in part (it was read as its two regexes); main's readings of it stay for membership.
  assert.deepEqual(read('const MONEY = [/^src\\/payments\\//, /invoice/];'), ['refused const MONEY = [/^src\\/payments\\//, /invoice/];', '/^src\\/payments\\//', '/invoice/']);
  // Beside a regex line, a glob line without a space is read as a glob too (main read only the regex).
  assert.deepEqual(read('/invoice/\nbilling/**'), ['**invoice**', 'billing/**']);
  // There, a list item is refused rather than skipped as code (round 7). Round 11 (the coordinator's decision: no line
  // is dropped): a code line with a blank is refused too, never skipped; a line of only brackets is blank.
  assert.deepEqual(read('const MONEY = [\n/invoice/,\n- billing/**\n];'), ['refused const MONEY = [', '**invoice**', 'refused - billing/**']);
});

test('#763: doctor\'s list names each refused line with a suggested glob; a converted list has none', () => {
  assert.deepEqual(moneyListProblems(moneyListEntries('/billing/i\npayments/**\n/migrations\\/\\d+_rates/')), [
    // Round 11: under the i flag each ASCII letter is `?`, so the suggestion matches every case the regex does (it
    // was `**billing**`, which missed `src/Billing/x.ts`: the round-10 review).
    { line: '/billing/i', why: 'its flags (i) ask for more than a glob says (a glob matches case as written)', suggestion: '**???????**' },
    { line: '/migrations\\/\\d+_rates/', why: '"\\d+_rates" has no mechanical glob form', suggestion: '**migrations/**_rates**' },
  ]);
  assert.deepEqual(moneyListProblems(moneyListEntries('/^src\\/payments\\//\nbilling/**')), []);
});

test('#763: doctor\'s money-list check fails on each refused line with its suggested glob, passes a list of globs, and warns when it can\'t read the list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-doctor-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  const commit = (text: string) => {
    writeFileSync(join(dir, 'money.txt'), text);
    git('add', '-A');
    git('-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'money');
  };
  const src = { file: 'money.txt' } as Parameters<typeof moneyListCheck>[1];
  commit('/billing/i\npayments/**\n');
  assert.deepEqual(moneyListCheck(dir, src, 'HEAD'), {
    level: 'fail',
    detail: `/billing/i isn't a glob (its flags (i) ask for more than a glob says (a glob matches case as written)): every PR waits until it is rewritten as globs, for example **???????**\neach line is read whole (a comment is ${MONEY_COMMENT_SYNTAX})`,
  });
  commit('/^src\\/payments\\//\nbilling/**\n');
  assert.equal(moneyListCheck(dir, src, 'HEAD').level, 'ok');
  assert.equal(moneyListCheck(dir, src, 'origin/main').level, 'warn');
});

const LEVELS = { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] } };
const REVIEW = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['money-path'], over_lines: 800 } } });
const VERDICT = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };

/** One changed path as merge-flow judges it with an approving verdict: level, look-alike reason, whether it merges itself. */
function judge(path: string, money: RegExp[]) {
  const files: ChangeFile[] = [{ path, added: 1, removed: 0 }];
  const level = computeLevel({ files, labels: [], moneyPaths: money, scope: undefined }, REVIEW);
  const merge = mergeDecision({ branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level, waitCategories: waitCategoriesOf(REVIEW), limits: { max_lines: 800, max_files: 20 }, lines: 1, files: 1, verdict: VERDICT, newTopLevel: [], ciFixRuns: 0, foreignPush: false, pushLimitHit: false });
  return { level: level.level, reason: level.reasons.find((r) => r.startsWith('path that looks like')), auto: merge.auto };
}

test('#763: the look-alike routes of rounds 3 to 5, against glob money lists: each waits', () => {
  const money = moneyListEntries(['src/payments/**', 'src/billing/**', 'pay?ents/**', 'src/IBAN/**', 'api/v1/billing/**', 'billing/migrations/0001_rates.sql'].join('\n'));
  for (const path of [
    'src/payrnents/charge.ts', // r, n for m
    'src/bi1ling/x.ts', // 1 for l
    'src/biIling/x.ts', // I for l
    `src/p${CYRILLIC_A}yrnents/x.ts`, // a Cyrillic a and r, n
    'payrnents/x.ts', // r, n under a glob's ?
    'src/lBAN/x.ts', // l for I
    'src/1BAN/x.ts', // 1 for I
    'api/vl/biIIing/x.ts', // two spellings of one group, each read one way (round-5 delta)
    'billing/migrations/OOO1_rates.sql', // O for 0, l-group for 1
  ]) assert.deepEqual(judge(path, money), { level: 'L3', reason: `path that looks like a protected one: ${escapedPath(path)} (like a money path)`, auto: false }, path);
});

test('#763: case counts only as the glob writes it: an ASCII case variant isn\'t held for its case (the round-5 over-hold is gone)', () => {
  const money = moneyListEntries('**/billing/**\n**/payments/**');
  for (const path of ['src/components/Billing/BillingForm.tsx', 'src/Payments/x.ts']) assert.deepEqual(judge(path, money), { level: 'L1', reason: undefined, auto: true }, path);
});

test('#763: a refused line holds every change as not compared, naming the line, and counts every path as a money path', () => {
  const money = moneyListEntries('/billing/i\nsrc/payments/**');
  for (const path of ['src/other/x.ts', 'docs/readme.md']) {
    const files: ChangeFile[] = [{ path, added: 1, removed: 0 }];
    const level = computeLevel({ files, labels: [], moneyPaths: money, scope: undefined }, REVIEW);
    assert.equal(level.level, 'L3');
    assert.ok(level.categories['money-path']?.includes(path), path);
    assert.ok(level.reasons.some((r) => r.includes('not compared: the money list\'s line "/billing/i" isn\'t a glob') && r.includes('for example **???????**')), level.reasons.join('\n'));
  }
});
