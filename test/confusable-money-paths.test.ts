// #763 round 3: an ASCII look-alike of a money-list glob waits like one of a locked glob; the Angstrom sign (a twin
// of an accented letter that isn't its own NFC form) shows escaped; and the plan comment's file list and the
// reproduction summary show a path as every reason does.
//
// WHY each character here is written as itself with a name, or found by its properties: no committed file holds a
// code point number (#763).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewConfig } from '../src/config/schema.js';
import type { StoredEvent } from '../src/events/types.js';
import { mergeDecision, waitCategoriesOf } from '../src/merge-policy.js';
import { planComment } from '../src/plan-mode.js';
import { summarize } from '../src/projection.js';
import { computeLevel, escapedPath, loadMoneyPaths, shownPath, type ChangeFile } from '../src/review.js';

const CYRILLIC_A = 'а';
const CYRILLIC_E = 'е';

test('#763: the look-alike characters here are the ones their names say', () => {
  assert.ok([CYRILLIC_A, CYRILLIC_E].every((c) => /^\p{Script=Cyrillic}$/u.test(c)));
  assert.deepEqual([CYRILLIC_A, CYRILLIC_E].map((c) => c.toUpperCase() !== c), [true, true]);
});

const LEVELS = {
  L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 },
  L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 },
  L2_notify: { when: ['dependency'] },
};
/** A review.yaml where money paths wait (L3), and one with no L3 category at all. */
const REVIEWS = [
  ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['money-path'], over_lines: 800 } } }),
  ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } }),
];
const VERDICT = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };

/** A scratch repo whose money list (`money.txt`) holds `lines`, read as the engine reads it (loadMoneyPaths at HEAD). */
function moneyFrom(lines: string[]): RegExp[] {
  const dir = mkdtempSync(join(tmpdir(), 'money-paths-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'money.txt'), `${lines.join('\n')}\n`);
  git('add', '-A');
  git('-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'money');
  return loadMoneyPaths(dir, { file: 'money.txt' } as ReviewConfig['money_path_source'], 'HEAD');
}

/** One changed path judged under each review above: level, look-alike reason, whether it merges itself. */
function judge(path: string, money: RegExp[]) {
  return REVIEWS.map((c) => {
    const files: ChangeFile[] = [{ path, added: 1, removed: 0 }];
    const level = computeLevel({ files, labels: [], moneyPaths: money, scope: undefined }, c);
    const merge = mergeDecision({ branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level, waitCategories: waitCategoriesOf(c), limits: { max_lines: 800, max_files: 20 }, lines: 1, files: 1, verdict: VERDICT, newTopLevel: [], ciFixRuns: 0, foreignPush: false, pushLimitHit: false });
    return { level: level.level, reason: level.reasons.find((r) => r.startsWith('path that looks like')), auto: merge.auto };
  });
}

/** Each path is held as a look-alike of a money path under both reviews; each real one is its own; an unrelated one is as before. */
function heldAsMoneyLookalikes(money: RegExp[], lookalikes: string[], real: string[], unrelated: string) {
  for (const path of lookalikes) {
    assert.deepEqual(judge(path, money), Array(2).fill({ level: 'L3', reason: `path that looks like a protected one: ${escapedPath(path)} (like a money path)`, auto: false }), path);
  }
  for (const path of real) {
    const r = judge(path, money);
    assert.deepEqual(r.map((x) => x.reason), [undefined, undefined], path);
    assert.deepEqual([r[0]!.level, r[0]!.auto], ['L3', false], path);
  }
  assert.deepEqual(judge(unrelated, money).map((r) => [r.level, r.reason, r.auto]), Array(2).fill(['L1', undefined, true]));
}

test('#763: an ASCII look-alike of a money-list glob (r, n for m; 1 or capital I for l), or of the list file itself, waits like one of a locked glob', () => {
  const money = moneyFrom(['payments/**', 'billing/**']);
  // (A mixed look-alike here would be a top-level name outside ASCII, which its own floor holds; the regex case below has one.)
  heldAsMoneyLookalikes(money, ['payrnents/charge.ts', 'bi1ling/charge.ts', 'biIling/charge.ts', 'rnoney.txt'], ['payments/charge.ts', 'billing/charge.ts', 'money.txt'], 'other/charge.ts');
});

test('#763: an ASCII or mixed look-alike of a money-list regex line converted to a glob (round 6) waits like one of any glob', () => {
  const money = moneyFrom(['/payments/', '/billing/']);
  heldAsMoneyLookalikes(money, ['src/payrnents/charge.ts', 'src/bi1ling/charge.ts', 'src/biIling/charge.ts', `src/p${CYRILLIC_A}yrnents/charge.ts`], ['src/payments/charge.ts', 'src/billing/charge.ts'], 'src/other/charge.ts');
  // A line with no mechanical glob form (a class, \d) is refused: every path waits, the look-alike as much as the rest.
  const exact = moneyFrom(['/^lib\\/p[a]y\\d{1}\\.ts$/']);
  assert.deepEqual(judge(`lib/p${CYRILLIC_A}y1.ts`, exact).map((r) => [r.level, r.auto]), Array(2).fill(['L3', false]));
  assert.ok(judge('src/other/charge.ts', exact).every((r) => r.level === 'L3' && !r.auto && r.reason?.includes("isn't a glob")));
});

/** The characters shaped like an accented ASCII letter (NFD: a letter and marks) that aren't their own NFC form. */
function nonNfcAccentTwins(): string[] {
  const out: string[] = [];
  for (let cp = 128; cp <= 1114111; cp++) {
    const c = String.fromCodePoint(cp);
    if (c !== c.normalize('NFC') && /^[A-Za-z]\p{M}+$/u.test(c.normalize('NFD'))) out.push(c);
  }
  return out;
}

test('#763: a twin of an accented letter that isn\'t its own NFC form (the Angstrom sign) shows escaped, and its high-risk line too', () => {
  const twins = nonNfcAccentTwins();
  // Measured here: exactly one, the Angstrom sign, whose NFC is the capital A with a ring above.
  assert.equal(twins.length, 1);
  const angstrom = twins[0]!;
  const aRing = angstrom.normalize('NFC');
  assert.ok(aRing !== angstrom && aRing.length === 1 && /^\p{Lu}$/u.test(aRing) && aRing.normalize('NFD').startsWith('A'));
  assert.equal(shownPath(`docs/${angstrom}rea.md`), escapedPath(`docs/${angstrom}rea.md`));
  assert.equal(shownPath(`docs/${aRing}rea.md`), `docs/${aRing}rea.md`);
  // A review.yaml whose own L3 category names the accented spelling: the Angstrom spelling is held, and no reason or
  // high-risk line prints it raw.
  const nordic = ReviewConfig.parse({ version: 1, categories: { nordic: [`docs/${aRing}rea.md`] }, levels: { ...LEVELS, L3_human: { when: ['nordic'], over_lines: 800 } } });
  const path = `docs/${angstrom}rea.md`;
  const level = computeLevel({ files: [{ path, added: 1, removed: 0 }], labels: [], moneyPaths: [], scope: undefined }, nordic);
  assert.equal(level.level, 'L3');
  const merge = mergeDecision({ branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level, waitCategories: waitCategoriesOf(nordic), limits: { max_lines: 800, max_files: 20 }, lines: 1, files: 1, verdict: VERDICT, newTopLevel: [], ciFixRuns: 0, foreignPush: false, pushLimitHit: false });
  assert.equal(merge.auto, false);
  assert.deepEqual(merge.reasons.filter((r) => r.startsWith('high-risk: confusable-path')), [`high-risk: confusable-path (${escapedPath(path)})`]);
  assert.ok([...level.reasons, ...merge.reasons].every((r) => !r.includes(path)), 'no reason holds the path raw');
});

test('#763: the plan comment\'s file list and the reproduction summary show a look-alike path escaped', () => {
  const releasing = `docs/r${CYRILLIC_E}leasing.md`;
  const plan = { approach: 'Fix the notes.', steps: ['Edit them'], files: [releasing, 'src/x.ts'], risks: [], decisions: { nothing: true as const } };
  const comment = planComment(plan as Parameters<typeof planComment>[0], 'example-owner');
  assert.ok(comment.includes(`- \`${escapedPath(releasing)}\``), comment);
  assert.ok(comment.includes('- `src/x.ts`'));
  assert.ok(!comment.includes(releasing));
  const event = { id: 1, ts: '2026-10-20T00:00:00Z', type: 'repro.frozen', actor: 'coordinator', source: 'coordinator', payload: { issue: 1, path: releasing } } as unknown as StoredEvent;
  assert.equal(summarize(event), `reproduction test frozen: ${escapedPath(releasing)}`);
});
