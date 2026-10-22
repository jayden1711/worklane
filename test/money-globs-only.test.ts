// #763 round 6, the owner's call: money paths are globs only. Through loadMoneyPaths, as an existing install reads
// its list after the upgrade: a regex line with a mechanical glob form keeps its money protection; one without is
// refused and holds every change, naming the line (never dropped); a glob line with two slashes is read as a glob;
// an ASCII case variant isn't held for its case; and one change's look-alike work is bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewConfig } from '../src/config/schema.js';
import { mergeDecision, waitCategoriesOf } from '../src/merge-policy.js';
import { computeLevel, escapedPath, loadMoneyPaths, type ChangeFile } from '../src/review.js';

const LEVELS = { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] } };
const REVIEW = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['money-path'], over_lines: 800 } } });
const VERDICT = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };

/** A scratch repo whose money list (`money.txt`) holds `lines`, read as the engine reads it (loadMoneyPaths at HEAD). */
function moneyFrom(lines: string[]): RegExp[] {
  const dir = mkdtempSync(join(tmpdir(), 'money-globs-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'money.txt'), `${lines.join('\n')}\n`);
  git('add', '-A');
  git('-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'money');
  return loadMoneyPaths(dir, { file: 'money.txt' } as ReviewConfig['money_path_source'], 'HEAD');
}

/** One changed path as merge-flow judges it with an approving verdict. */
function judge(path: string, money: RegExp[]) {
  const files: ChangeFile[] = [{ path, added: 1, removed: 0 }];
  const level = computeLevel({ files, labels: [], moneyPaths: money, scope: undefined }, REVIEW);
  const merge = mergeDecision({ branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level, waitCategories: waitCategoriesOf(REVIEW), limits: { max_lines: 800, max_files: 20 }, lines: 1, files: 1, verdict: VERDICT, newTopLevel: [], ciFixRuns: 0, foreignPush: false, pushLimitHit: false });
  return { level: level.level, money: (level.categories['money-path'] ?? []).includes(path), reasons: level.reasons, auto: merge.auto };
}

test('#763: an existing install\'s regex lines with a glob form keep their money protection, look-alikes included', () => {
  const money = moneyFrom(['/^src\\/payments\\//', '/^lib\\/billing\\/[^\\/]+\\.ts$/', '/invoice/', '/^db\\/.*\\.sql$/']);
  for (const path of ['src/payments/charge.ts', 'lib/billing/x.ts', 'app/invoice/pdf.ts', 'db/schema/rates.sql']) assert.deepEqual([judge(path, money).money, judge(path, money).auto], [true, false], path);
  for (const path of ['src/payrnents/charge.ts', 'lib/bi1ling/x.ts', 'db/schema/rates.sqI']) {
    const r = judge(path, money);
    assert.deepEqual([r.level, r.auto], ['L3', false], path);
    assert.ok(r.reasons.includes(`path that looks like a protected one: ${escapedPath(path)} (like a money path)`), r.reasons.join('\n'));
  }
  assert.deepEqual([judge('src/other/x.ts', money).level, judge('src/other/x.ts', money).auto], ['L1', true]);
});

test('#763: an existing install\'s regex line with no glob form is refused, never dropped: every change waits, and the reason names the line', () => {
  const money = moneyFrom(['/^src\\/payments\\//', '/refund/i', '/migrations\\/\\d+_rates/']);
  for (const path of ['src/other/x.ts', 'docs/readme.md', 'src/refunds/x.ts']) {
    const r = judge(path, money);
    assert.deepEqual([r.level, r.auto], ['L3', false], path);
    assert.ok(r.reasons.some((x) => x.includes('not compared: the money list\'s line "/refund/i" isn\'t a glob')), r.reasons.join('\n'));
  }
});

test('#763: a glob line with two slashes is read as a glob, and the lines after it count too', () => {
  const money = moneyFrom(['src/pay/**', 'billing/**']);
  // On main the list read only the /pay/ inside the first line, as a regex, and dropped billing/**.
  assert.deepEqual([judge('billing/x.ts', money).money, judge('billing/x.ts', money).auto], [true, false]);
  assert.equal(judge('src/pay/x.ts', money).money, true);
});

test('#763: an ASCII case variant isn\'t held for its case: a lower-case money line doesn\'t hold Billing/', () => {
  const money = moneyFrom(['/billing/']);
  for (const path of ['src/components/Billing/BillingForm.tsx', 'src/Billing.ts']) assert.deepEqual([judge(path, money).level, judge(path, money).auto], ['L1', true], path);
});

test('#763: one change\'s look-alike work is bounded: past the budget, the remaining paths wait as not compared', () => {
  // A glob that keeps the walk alive on every character (round 7 charges the walk as it is done, so plain globs a
  // path's first character rules out cost little).
  const money = moneyFrom(['payments/**', 'billing/**', '**a**b**']);
  const crafted = (i: number) => `docs/${String.fromCodePoint(1072).repeat(450)}${String.fromCodePoint(160).repeat(450)}${i}.md`;
  const files: ChangeFile[] = Array.from({ length: 3000 }, (_, i) => ({ path: crafted(i), added: 1, removed: 0 }));
  const t = performance.now();
  const level = computeLevel({ files, labels: [], moneyPaths: money, scope: undefined }, REVIEW);
  const ms = performance.now() - t;
  assert.equal(level.level, 'L3');
  assert.ok(level.reasons.some((r) => r.includes('look-alike work budget')), level.reasons.join('\n').slice(0, 400));
  assert.ok(ms < 15_000, `${Math.round(ms)} ms`);
});
