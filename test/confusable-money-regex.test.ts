// #763 round 4: an ASCII look-alike of a money-list regex literal waits whatever the regex's syntax: the `i` flag
// (both cases' skeletons), a dot or other one-character wildcard (one or two characters), a named group and its
// back-reference (copied, never mapped), a character class (its members' skeletons as alternatives); and a regex the
// look-alike check can't map holds every path it doesn't match.
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
import { lookalikeOf } from '../src/confusables.js';
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

test('#763: under the i flag a regex stands for both cases\' skeletons: an all-capitals payments regex holds r, n for m; a lower-case iban regex holds l or 1 for I', () => {
  const money = moneyFrom(['/PAYMENTS/i', '/iban/i']);
  held(money, ['src/payrnents/charge.ts', 'src/PAYRNENTS/charge.ts', `src/p${CYRILLIC_A}yrnents/charge.ts`, 'src/lBAN/x.ts', 'src/1BAN/x.ts', 'src/lban/x.ts'], ['src/payments/charge.ts', 'src/PAYMENTS/charge.ts', 'src/IBAN/x.ts', 'src/iban/x.ts']);
  assert.deepEqual(judge('src/other/x.ts', money), { level: 'L1', reason: undefined, auto: true });
});

test('#763: the i flag holds an all-capitals look-alike of a lower-case regex too (1 for L in billing)', () => {
  held(moneyFrom(['/billing/i']), ['src/BI1LING/x.ts', 'src/bi1ling/x.ts'], ['src/billing/x.ts', 'src/BILLING/x.ts']);
});

test('#763: a dot, a negated class and a class escape stand for one or two characters, so r, n for m under one waits too', () => {
  held(moneyFrom(['/pay.ents/']), ['src/payrnents/x.ts'], ['src/payments/x.ts']);
  held(moneyFrom(['/pay[^x]ents/']), ['src/payrnents/x.ts'], ['src/payments/x.ts']);
  held(moneyFrom(['/pay\\wents/']), ['src/payrnents/x.ts'], ['src/payments/x.ts']);
});

test('#763: a named group and its back-reference are copied, not mapped, so a regex holding one still holds the look-alike', () => {
  const money = moneyFrom(['/(?<money>payments)(?:-\\k<money>)?/']);
  held(money, ['src/payrnents/charge.ts', `src/p${CYRILLIC_A}yrnents/charge.ts`], ['src/payments/charge.ts']);
});

test('#763: a plain character class carries its members\' skeletons, a range spelled out; a negated class\'s own path is still its own', () => {
  const money = moneyFrom(['/pay[m]ents/', '/bil[a-z]ing/']);
  held(money, ['src/payrnents/charge.ts', 'src/bil1ing/x.ts'], ['src/payments/charge.ts', 'src/billing/x.ts']);
  const negated = moneyFrom(['/^lib\\/[^x]ay\\.ts$/']);
  assert.deepEqual(judge('lib/pay.ts', negated).reason, undefined);
});

test('#763: a money regex the look-alike check can\'t map holds every path it doesn\'t match, with a reason that says so (fails closed)', () => {
  /** A regex whose source, as the check reads it, is no regex: the rewrite can't compile it. */
  class Unmappable extends RegExp {
    override get source(): string {
      return '(';
    }
  }
  const money = [new Unmappable('payments')];
  assert.equal(lookalikeOf('src/payments/charge.ts', [{ re: money[0]!, what: 'm' }]), null);
  assert.deepEqual(lookalikeOf('src/other/x.ts', [{ re: money[0]!, what: 'm' }]), { unchecked: "a money-list regex the look-alike check can't map" });
  const level = computeLevel({ files: [{ path: 'src/other/x.ts', added: 1, removed: 0 }], labels: [], moneyPaths: money, scope: undefined }, REVIEW);
  assert.equal(level.level, 'L3');
  assert.ok(level.reasons.some((r) => r.includes("(not compared: a money-list regex the look-alike check can't map)")), level.reasons.join('\n'));
});
