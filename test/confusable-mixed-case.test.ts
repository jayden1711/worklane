// #763 round 7: a path outside ASCII is compared caseless, and case is folded after the skeleton as well as before
// it. Folded first, a capital I becomes an i before the skeleton can read it as an l, so a Cyrillic letter beside a
// capital I standing in for an l got through: a docs/Releasing.md look-alike merged itself at L0 (the round-6
// adversarial review, measured). ASCII paths keep their case as written.
//
// WHY each look-alike character here is written as itself, with a name: no committed file holds a code point
// number; the first test checks each one is the character its name says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { BRAND } from '../src/brand.js';
import { ReviewConfig } from '../src/config/schema.js';
import { mergeDecision, waitCategoriesOf } from '../src/merge-policy.js';
import { skeleton } from '../src/confusables.js';
import { computeLevel, escapedPath, moneyListEntries, type ChangeFile } from '../src/review.js';
import { repoRoot } from './helpers.js';

const CYRILLIC_IE = 'е';
const CYRILLIC_I = 'і';
const FULLWIDTH_R = 'Ｒ';

test('#763 round 7: the look-alike characters here are a Cyrillic small ie, a Cyrillic small i and a fullwidth capital R', () => {
  assert.ok(/^\p{Script=Cyrillic}$/u.test(CYRILLIC_IE) && CYRILLIC_IE.normalize('NFKC') === CYRILLIC_IE && CYRILLIC_IE.toUpperCase() !== CYRILLIC_IE);
  assert.ok(/^\p{Script=Cyrillic}$/u.test(CYRILLIC_I) && CYRILLIC_I.normalize('NFKC') === CYRILLIC_I && CYRILLIC_I.toUpperCase() !== CYRILLIC_I);
  assert.notEqual(skeleton(CYRILLIC_IE), CYRILLIC_IE);
  assert.notEqual(skeleton(CYRILLIC_I), CYRILLIC_I);
  assert.equal(FULLWIDTH_R.normalize('NFKC'), 'R');
});

const ENGINE = () => ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8')));
const LEVELS = { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] } };
const MONEY_REVIEW = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['money-path'], over_lines: 800 } } });
const VERDICT = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };

/** One changed path as merge-flow judges it with an approving verdict: level, whether it is held as a look-alike, whether it merges itself. */
function judge(path: string, cfg: ReviewConfig, money: RegExp[] = []) {
  const files: ChangeFile[] = [{ path, added: 1, removed: 0 }];
  const level = computeLevel({ files, labels: [], moneyPaths: money, scope: undefined }, cfg);
  const merge = mergeDecision({ branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level, waitCategories: waitCategoriesOf(cfg), limits: { max_lines: 800, max_files: 20 }, lines: 1, files: 1, verdict: VERDICT, newTopLevel: [], ciFixRuns: 0, foreignPush: false, pushLimitHit: false });
  return { level: level.level, lookalike: (level.categories['confusable-path'] ?? []).includes(path), reason: level.reasons.find((r) => r.startsWith('path that looks like')), auto: merge.auto };
}

test('#763 round 7: a capital R, a Cyrillic e and a capital I for the l of docs/releasing.md: held, not L0 with auto-merge', () => {
  for (const path of [`docs/R${CYRILLIC_IE}Ieasing.md`, `docs/${FULLWIDTH_R}eIeasing.md`]) {
    const r = judge(path, ENGINE());
    assert.deepEqual([r.level, r.lookalike, r.auto], ['L3', true, false], escapedPath(path));
    assert.ok(r.reason?.startsWith(`path that looks like a protected one: ${escapedPath(path)} (like docs/releasing.md`), r.reason);
  }
});

test('#763 round 7: a capital B, a Cyrillic i and two capital I for the l\'s of a money glob src/billing/**: held', () => {
  const money = moneyListEntries('src/billing/**');
  const path = `src/B${CYRILLIC_I}IIing/x.ts`;
  assert.deepEqual(judge(path, MONEY_REVIEW, money), { level: 'L3', lookalike: true, reason: `path that looks like a protected one: ${escapedPath(path)} (like a money path)`, auto: false });
});

test('#763 round 7: ASCII paths keep their case as written: the same spellings in ASCII are no look-alikes', () => {
  assert.equal(judge('docs/ReIeasing.md', ENGINE()).lookalike, false);
  const money = moneyListEntries('src/billing/**');
  assert.deepEqual(judge('src/BIIling/x.ts', MONEY_REVIEW, money), { level: 'L1', lookalike: false, reason: undefined, auto: true });
});
