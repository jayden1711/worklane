// #763 rounds 5 and 6: the look-alike check is bounded, and some forms of a name it reads. A bare RegExp (a caller's
// own, as tests pass) runs as written on a bounded set of the path's forms, in linear time; a money list's regex
// lines are converted to globs or refused (test/confusable-money-regex.test.ts). Also: a glob's `?` stands for an m
// spelled r, n; a combining dot above that a letter's own dot hides is dropped; a character that reaches ASCII only
// through its skeleton's NFKC form is caught.
//
// WHY the look-alike characters here are written as themselves with a name, or found by their properties: no
// committed file holds a code point number (#763).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReviewConfig } from '../src/config/schema.js';
import { lookalikeOf, skeleton } from '../src/confusables.js';
import { mergeDecision, waitCategoriesOf } from '../src/merge-policy.js';
import { computeLevel, escapedPath, moneyListEntries, type ChangeFile } from '../src/review.js';
import { repoRoot } from './helpers.js';

const DOTLESS_I: string = 'ı';
/** The combining dot above: the mark in an e with a dot above, decomposed. */
const DOT_ABOVE = 'ė'.normalize('NFD').slice(1);

test('#763: the characters here are the ones their names say', () => {
  assert.ok(/^\p{Ll}$/u.test(DOTLESS_I) && DOTLESS_I !== 'i' && DOTLESS_I.toUpperCase() === 'I');
  assert.ok(/^\p{Mn}$/u.test(DOT_ABOVE) && 'e'.concat(DOT_ABOVE).normalize('NFC').length === 1);
});

const LEVELS = { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] } };
const MONEY = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['money-path'], over_lines: 800 } } });
const PLAIN = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
const VERDICT = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };

/** One changed path as merge-flow judges it with an approving verdict: level, look-alike reason, whether it merges itself. */
function judge(path: string, money: RegExp[], review = MONEY) {
  const files: ChangeFile[] = [{ path, added: 1, removed: 0 }];
  const level = computeLevel({ files, labels: [], moneyPaths: money, scope: undefined }, review);
  const merge = mergeDecision({ branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level, waitCategories: waitCategoriesOf(review), limits: { max_lines: 800, max_files: 20 }, lines: 1, files: 1, verdict: VERDICT, newTopLevel: [], ciFixRuns: 0, foreignPush: false, pushLimitHit: false });
  return { level: level.level, reason: level.reasons.find((r) => r.startsWith('path that looks like')), auto: merge.auto };
}

/** Each look-alike waits as one of a money path; each real path is a money path, not a look-alike of itself. */
function held(list: string, lookalikes: string[], real: string[]) {
  const money = moneyListEntries(list);
  for (const path of lookalikes) assert.deepEqual(judge(path, money), { level: 'L3', reason: `path that looks like a protected one: ${escapedPath(path)} (like a money path)`, auto: false }, `${list} ${path}`);
  for (const path of real) assert.deepEqual(judge(path, money), { level: 'L3', reason: undefined, auto: false }, `${list} ${path}`);
}

test('#763: a bare money RegExp and money globs run in linear time: ordinary and crafted paths of 60 to 900 characters take under 50 ms each', () => {
  // Run in a child process with a timeout, so a regression that backtracks fails here instead of hanging the run.
  const regexes = ['^src\\/billing\\/[^\\/]+\\.ts$', '^src\\/.*\\/billing\\.ts$', '^src\\/.*\\/billing\\.sql$', '^src\\/billing\\/\\w+\\.ts$', '^src\\/[a-z]+\\/billinx', '.+billing$', 'pay.+ents\\/x$'];
  const globs = ['src/billing/*.ts', 'src/**/billing.ts', '**billing**', 'pay?ents/**', 'src/*/billinx/**'];
  const paths = ['src/billing/a-rather-ordinary-name-for-a-billing-file.tsx', 'src/components/dashboard/widgets/charts/line-chart.tsx', `src/${'rn'.repeat(100)}/billinx-no`, `src/${'a'.repeat(900)}`, `src/${'m'.repeat(120)}/payrnents/y`];
  const module = pathToFileURL(join(repoRoot, 'dist', 'src', 'confusables.js')).href;
  const script = `const { lookalikeOf } = await import(${JSON.stringify(module)});
let worst = 0;
const patterns = [...${JSON.stringify(regexes)}.map((src) => ({ re: new RegExp(src), what: 'm' })), ...${JSON.stringify(globs)}.map((glob) => ({ glob, what: 'm' }))];
for (const p of patterns) for (const path of ${JSON.stringify(paths)}) {
  const t = performance.now();
  lookalikeOf(path, [p]);
  worst = Math.max(worst, performance.now() - t);
}
console.log(worst);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, `the timing run didn't finish in 20 s (signal ${r.signal}): ${r.stderr.slice(0, 300)}`);
  assert.ok(Number(r.stdout.trim()) < 50, `slowest lookalikeOf call: ${r.stdout.trim()} ms`);
});

test('#763: a combining dot above that a letter\'s own dot hides is dropped: after an i, or a dotless i, in a money glob or a locked name', () => {
  held('**billing**', [`src/bi${DOT_ABOVE}lling/x.ts`, `src/b${DOTLESS_I}${DOT_ABOVE}lling/x.ts`], ['src/billing/x.ts']);
  const locked = `docs/releasi${DOT_ABOVE}ng.md`;
  const r = judge(locked, [], PLAIN);
  assert.deepEqual([r.level, r.auto, r.reason], ['L3', false, `path that looks like a protected one: ${escapedPath(locked)} (like docs/releasing.md (self-modification))`]);
  // A visible accent (a dot above an e) still keeps normal review.
  assert.equal(judge(`docs/note${DOT_ABOVE}s.md`, [], PLAIN).auto, true);
});

test('#763: a money glob\'s ? stands for an m spelled r, n', () => {
  held('pay?ents/**', ['payrnents/charge.ts'], ['payments/charge.ts']);
});

test('#763: a character that reaches an ASCII letter only through its skeleton\'s NFKC form is held as that letter', () => {
  const ascii = (s: string) => /^[A-Za-z]$/.test(s);
  const found: string[] = [];
  for (let cp = 128; cp <= 1114111; cp++) {
    const c = String.fromCodePoint(cp);
    const sk = skeleton(c);
    const later = sk.normalize('NFKC');
    if (later === sk || ascii(sk) || ascii(skeleton(c.normalize('NFKC')))) continue;
    if (ascii(skeleton(later))) found.push(c);
  }
  // Measured here: at least one (the modifier Cyrillic en, read as H).
  assert.ok(found.length > 0);
  for (const c of found) {
    const letter = skeleton(skeleton(c).normalize('NFKC'));
    assert.ok(lookalikeOf(`docs/x${c}y.md`, [{ glob: `docs/x${letter}y.md`, what: 't' }]), escapedPath(c));
  }
});
