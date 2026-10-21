// #763 rounds 4 and 5: an ASCII look-alike of a money-list regex literal waits under the `i` flag, a dot or other
// one-character wildcard, a named group and its back-reference, and a character class. Since round 5 the regex isn't
// rewritten: it runs as written on readings of the path (test/confusable-readings.test.ts has the rest).
//
// WHY the one look-alike character here is written as itself with a name: no committed file holds a code point
// number (#763).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewConfig } from '../src/config/schema.js';
import { mergeDecision, waitCategoriesOf } from '../src/merge-policy.js';
import { computeLevel, escapedPath, loadMoneyPaths, type ChangeFile } from '../src/review.js';

const CYRILLIC_A = 'а';

test('#763: the look-alike character here is a Cyrillic small a', () => {
  assert.ok(/^\p{Script=Cyrillic}$/u.test(CYRILLIC_A) && CYRILLIC_A.toUpperCase() !== CYRILLIC_A);
});

const LEVELS = { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] } };
const REVIEW = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['money-path'], over_lines: 800 } } });
const VERDICT = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };

/** A scratch repo whose money list (`money.txt`) holds `lines`, read as the engine reads it (loadMoneyPaths at HEAD). */
function moneyFrom(lines: string[]): RegExp[] {
  const dir = mkdtempSync(join(tmpdir(), 'money-regex-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'money.txt'), `${lines.join('\n')}\n`);
  git('add', '-A');
  git('-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'money');
  return loadMoneyPaths(dir, { file: 'money.txt' } as ReviewConfig['money_path_source'], 'HEAD');
}

/** One changed path as merge-flow judges it with an approving verdict: level, look-alike reason, whether it merges itself. */
function judge(path: string, money: RegExp[]) {
  const files: ChangeFile[] = [{ path, added: 1, removed: 0 }];
  const level = computeLevel({ files, labels: [], moneyPaths: money, scope: undefined }, REVIEW);
  const merge = mergeDecision({ branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level, waitCategories: waitCategoriesOf(REVIEW), limits: { max_lines: 800, max_files: 20 }, lines: 1, files: 1, verdict: VERDICT, newTopLevel: [], ciFixRuns: 0, foreignPush: false, pushLimitHit: false });
  return { level: level.level, reason: level.reasons.find((r) => r.startsWith('path that looks like')), auto: merge.auto };
}

/** Each look-alike is held as one of a money path; each real path is a money path and no look-alike of itself. */
function held(money: RegExp[], lookalikes: string[], real: string[]) {
  for (const path of lookalikes) assert.deepEqual(judge(path, money), { level: 'L3', reason: `path that looks like a protected one: ${escapedPath(path)} (like a money path)`, auto: false }, path);
  for (const path of real) assert.deepEqual(judge(path, money), { level: 'L3', reason: undefined, auto: false }, path);
}

test('#763: under the i flag an all-capitals payments regex holds r, n for m; a lower-case iban regex holds l or 1 for I', () => {
  const money = moneyFrom(['/PAYMENTS/i', '/iban/i']);
  held(money, ['src/payrnents/charge.ts', 'src/PAYRNENTS/charge.ts', `src/p${CYRILLIC_A}yrnents/charge.ts`, 'src/lBAN/x.ts', 'src/1BAN/x.ts', 'src/lban/x.ts'], ['src/payments/charge.ts', 'src/PAYMENTS/charge.ts', 'src/IBAN/x.ts', 'src/iban/x.ts']);
  assert.deepEqual(judge('src/other/x.ts', money), { level: 'L1', reason: undefined, auto: true });
});

test('#763: the i flag holds an all-capitals look-alike of a lower-case regex too (1 for L in billing)', () => {
  held(moneyFrom(['/billing/i']), ['src/BI1LING/x.ts', 'src/bi1ling/x.ts'], ['src/billing/x.ts', 'src/BILLING/x.ts']);
});

test('#763: r, n for m under a dot, a negated class or a class escape waits too', () => {
  held(moneyFrom(['/pay.ents/']), ['src/payrnents/x.ts'], ['src/payments/x.ts']);
  held(moneyFrom(['/pay[^x]ents/']), ['src/payrnents/x.ts'], ['src/payments/x.ts']);
  held(moneyFrom(['/pay\\wents/']), ['src/payrnents/x.ts'], ['src/payments/x.ts']);
});

test('#763: a regex with a named group and its back-reference holds the look-alike', () => {
  const money = moneyFrom(['/(?<money>payments)(?:-\\k<money>)?/']);
  held(money, ['src/payrnents/charge.ts', `src/p${CYRILLIC_A}yrnents/charge.ts`], ['src/payments/charge.ts']);
});

test('#763: a regex with a character class holds the look-alike; a negated class\'s own path is still its own', () => {
  const money = moneyFrom(['/pay[m]ents/', '/bil[a-z]ing/']);
  held(money, ['src/payrnents/charge.ts', 'src/bil1ing/x.ts'], ['src/payments/charge.ts', 'src/billing/x.ts']);
  const negated = moneyFrom(['/^lib\\/[^x]ay\\.ts$/']);
  assert.deepEqual(judge('lib/pay.ts', negated).reason, undefined);
});
