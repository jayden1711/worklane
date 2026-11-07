// How text shows a path with a character outside ASCII (#763 round 2): only an accent on an ASCII letter (a character
// whose canonical decomposition is an ASCII letter and at least one combining mark) shows as itself; every other one
// is escaped, so a look-alike can never print raw in a reason or a high-risk line.
//
// WHY the characters here are found by their properties: no committed file holds a code point number (#763).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewConfig } from '../src/config/schema.js';
import { mergeDecision, waitCategoriesOf, whyHighRisk } from '../src/merge-policy.js';
import { computeLevel, escapedPath, shownPath } from '../src/review.js';

/** The last code point Unicode has. */
const LAST = 1114111;

/** Each character outside ASCII whose canonical decomposition (NFD) is one bare ASCII character, no mark. */
function bareSingletons(): string[] {
  const out: string[] = [];
  for (let cp = 128; cp <= LAST; cp++) {
    const c = String.fromCodePoint(cp);
    const d = c.normalize('NFD');
    if (d.length === 1 && /^\p{ASCII}$/u.test(d)) out.push(c);
  }
  return out;
}

/**
 * The rule: an accent on an ASCII letter is its own NFC form, its NFD is an ASCII letter then at least one combining
 * mark, and its lower case is one NFC character (round 7).
 */
const isAccent = (c: string) => c === c.normalize('NFC') && /^[A-Za-z]\p{M}+$/u.test(c.normalize('NFD')) && [...c.toLowerCase().normalize('NFC')].length === 1;

test('#763: the characters outside ASCII that decompose to a bare ASCII character (the Kelvin sign, the Greek question mark, the Greek varia) show escaped, never raw', () => {
  const singles = bareSingletons();
  // Measured here, not assumed: exactly three, decomposing to K, a semicolon and a backquote.
  assert.deepEqual(singles.map((c) => c.normalize('NFD')).sort(), [';', 'K', '`']);
  for (const c of singles) {
    const p = `docs/a${c}b.md`;
    assert.equal(shownPath(p), escapedPath(p), escapedPath(p));
  }
});

test('#763: every character outside ASCII shows raw in a path only if it is an accent on an ASCII letter', () => {
  const raw: string[] = [];
  for (let cp = 128; cp <= LAST; cp++) {
    const c = String.fromCodePoint(cp);
    const p = `docs/a${c}b.md`;
    if (shownPath(p) === p && !isAccent(c)) raw.push(escapedPath(c));
  }
  assert.deepEqual(raw, [], 'shown raw, though not an accent on an ASCII letter');
  // And an accent does show as itself (an e composed with the first mark that composes with it).
  const accented = 'e'.concat(firstMark()).normalize('NFC');
  assert.ok(isAccent(accented) && accented.length === 1);
  assert.equal(shownPath(`docs/caf${accented}.md`), `docs/caf${accented}.md`);
});

/** The first combining mark after ASCII that composes with e into one character. */
function firstMark(): string {
  for (let cp = 128; cp <= LAST; cp++) {
    const m = String.fromCodePoint(cp);
    if (/^\p{Mn}$/u.test(m) && 'e'.concat(m).normalize('NFC').length === 1) return m;
  }
  throw new Error('no mark');
}

test('#763: a Kelvin-sign look-alike of src/hook.ts is held, and its high-risk line shows it escaped, not as the ASCII name it reads as', () => {
  const kelvin = bareSingletons().find((c) => c.normalize('NFD') === 'K')!;
  const path = `src/hoo${kelvin}.ts`;
  const cfg = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] }, L3_human: { when: [], over_lines: 800 } } });
  const level = computeLevel({ files: [{ path, added: 1, removed: 0 }], labels: [], moneyPaths: [], scope: undefined }, cfg);
  assert.equal(level.level, 'L3');
  const verdict = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };
  const merge = mergeDecision({ branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level, waitCategories: waitCategoriesOf(cfg), limits: { max_lines: 800, max_files: 20 }, lines: 1, files: 1, verdict, newTopLevel: [], ciFixRuns: 0, foreignPush: false, pushLimitHit: false });
  assert.equal(merge.auto, false);
  assert.deepEqual(merge.reasons.filter((r) => r.startsWith('high-risk: confusable-path')), [`high-risk: confusable-path (${escapedPath(path)})`]);
  assert.ok(merge.reasons.every((r) => !r.includes(path)), 'no reason holds the path raw');
});

test('#763 round 7: the capital I with a dot above (its lower case is an i and a combining dot above) shows escaped, in a held look-alike\'s high-risk line too', () => {
  const dotted = 'I'.concat('ė'.normalize('NFD').slice(1)).normalize('NFC');
  assert.ok(dotted.length === 1 && [...dotted.toLowerCase()].length === 2, escapedPath(dotted));
  const path = `docs/releas${dotted}ng.md`;
  assert.equal(shownPath(path), escapedPath(path));
  const cfg = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] }, L3_human: { when: [], over_lines: 800 } } });
  const level = computeLevel({ files: [{ path, added: 1, removed: 0 }], labels: [], moneyPaths: [], scope: undefined }, cfg);
  assert.equal(level.level, 'L3');
  const lines = whyHighRisk({ level, waitCategories: waitCategoriesOf(cfg) }).map((w) => w.text);
  assert.ok(lines.includes(`has a path that looks like a protected one: ${escapedPath(path)}`), lines.join('\n'));
  assert.ok(lines.every((t) => !t.includes(path)), 'no high-risk line holds the path raw');
  // The lower-case clause excludes this one character and no other (measured here).
  const excluded: string[] = [];
  for (let cp = 128; cp <= LAST; cp++) {
    const c = String.fromCodePoint(cp);
    if (c === c.normalize('NFC') && /^[A-Za-z]\p{M}+$/u.test(c.normalize('NFD')) && !isAccent(c)) excluded.push(c);
  }
  assert.deepEqual(excluded, [dotted]);
});
