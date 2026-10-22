// A changed path that reads as a locked or protected one waits for the owner (#763): its UTS #39 skeleton, its
// caseless and NFKC forms, and its reading without blank-looking characters are compared with every glob that waits
// for a person and every money path. The skeleton and the Unicode table on their own are in test/confusables.test.ts.
//
// WHY each look-alike character below is written as itself, with a name: no committed file holds a code point
// number (#763); the first test checks each one is the character its name says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { BRAND } from '../src/brand.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { loosenedProblems } from '../src/delegation.js';
import { mergeDecision, waitCategoriesOf, whyHighRisk } from '../src/merge-policy.js';
import { riskClassOf } from '../src/pr-rules.js';
import { computeLevel, escapedPath, selfModificationPart, shownPath, type ChangeFile, type LevelInput } from '../src/review.js';
import { repoRoot } from './helpers.js';

/**
 * The no-break space, found by its properties (an editor may save it as a plain space): the first White_Space
 * character after ASCII that isn't a control character.
 */
function firstBlankOutsideAscii(): string {
  for (let cp = 128; ; cp++) {
    const c = String.fromCodePoint(cp);
    if (/^\p{White_Space}$/u.test(c) && !/^\p{Cc}$/u.test(c)) return c;
  }
}

/** The look-alike characters these tests use, each written as itself (the first test checks what each one is). */
const C = {
  cyrillicE: 'е',
  cyrillicCapitalE: 'Е',
  cyrillicO: 'о',
  cyrillicA: 'а',
  cyrillicI: 'і',
  cyrillicDze: 'ѕ',
  longS: 'ſ',
  fullwidthR: 'ｒ',
  mathBoldR: '𝐫',
  iDiaeresis: 'ï',
  eAcute: 'é',
  eGrave: 'è',
  noBreakSpace: firstBlankOutsideAscii(),
  brailleBlank: '⠀',
  arabicLigature: 'ﷺ',
};

test('#763: each look-alike character these tests use is the character its name says', () => {
  const cyrillic = (s: string) => /^\p{Script=Cyrillic}$/u.test(s);
  assert.ok([C.cyrillicE, C.cyrillicCapitalE, C.cyrillicO, C.cyrillicA, C.cyrillicI, C.cyrillicDze].every(cyrillic));
  assert.deepEqual([C.cyrillicE, C.cyrillicO, C.cyrillicA, C.cyrillicI, C.cyrillicDze].map((c) => c.toUpperCase() !== c), [true, true, true, true, true]);
  assert.equal(C.cyrillicCapitalE.toLowerCase(), C.cyrillicE);
  // The long s: a Latin letter whose capital is S. The fullwidth and mathematical bold r: r in their NFKC form.
  assert.ok(/^\p{Script=Latin}$/u.test(C.longS) && C.longS !== 's' && C.longS.toUpperCase() === 'S');
  assert.deepEqual([C.fullwidthR, C.mathBoldR].map((c) => [c !== 'r', c.normalize('NFKC')]), [[true, 'r'], [true, 'r']]);
  // Accents: an i, an e and an e, each with a combining mark in NFD.
  assert.deepEqual([C.iDiaeresis, C.eAcute, C.eGrave].map((c) => [...c.normalize('NFD')][0]), ['i', 'e', 'e']);
  // The blanks: a White_Space character that isn't the ASCII space, and the first character of the Braille script
  // (the pattern with no dots), which is neither White_Space nor a format or default-ignorable character.
  assert.ok(/^\p{White_Space}$/u.test(C.noBreakSpace) && C.noBreakSpace !== ' ' && C.noBreakSpace.normalize('NFKC') === ' ');
  const braille = C.brailleBlank.codePointAt(0)!;
  assert.ok(/^\p{Script=Braille}$/u.test(C.brailleBlank) && !/^\p{Script=Braille}$/u.test(String.fromCodePoint(braille - 1)));
  assert.ok(!/[\p{White_Space}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(C.brailleBlank));
  // An Arabic ligature whose NFKC form (and UTS #39 prototype) is a long phrase.
  assert.ok(/^\p{Script=Arabic}$/u.test(C.arabicLigature) && C.arabicLigature.normalize('NFKC').length >= 18);
});

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A scratch repo with `files` committed, then `add` committed on top; returns it and both commits. */
function repoWith(files: Record<string, string>, add: Record<string, string>): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'confusable-paths-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'ada@example.com'], ['user.name', 'Ada'], ['commit.gpgsign', 'false']]) git(dir, 'config', k!, v!);
  const commit = (set: Record<string, string>, msg: string) => {
    for (const [p, text] of Object.entries(set)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', msg);
    return git(dir, 'rev-parse', 'HEAD');
  };
  const base = commit(files, 'init');
  return { dir, base, head: commit(add, 'add') };
}

/** The coordinator's own reader (CoordinatorBase.changeFiles), as merge-flow calls it. */
const changeFiles = (dir: string, base: string, head: string): ChangeFile[] =>
  (Coordinator.prototype as unknown as { changeFiles(cwd: string, base: string, head: string): ChangeFile[] }).changeFiles.call(Object.create(Coordinator.prototype), dir, base, head);

const LEVELS = {
  L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 },
  L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 },
  L2_notify: { when: ['dependency'] },
  L3_human: { when: ['engine-guards', 'deletes-data'], over_lines: 800 },
};
const cfg = ReviewConfig.parse({ version: 1, levels: LEVELS });
const level = (files: ChangeFile[], c = cfg) => computeLevel({ files, labels: [] as string[], moneyPaths: [] as RegExp[] } as LevelInput, c);

/**
 * Review.yaml files that would let a change through if anything could: the engine's own, one with no L3 category,
 * and one that empties the odd-path categories and calls every path docs.
 */
const lenientReviews = () => [
  ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8'))),
  ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } }),
  ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } }, categories: { 'invisible-character-path': [], 'non-ascii-top-level-path': [], 'confusable-path': [], docs: ['**'] } }),
];

const VERDICT = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };

/** One change judged as merge-flow judges it, with an approving verdict: level, look-alike reason, risk class, whether it merges itself, its look-alike high-risk line. */
function judge(files: ChangeFile[], moneyPaths: RegExp[], c: ReviewConfig) {
  const paths = files.map((f) => f.path);
  const lvl = computeLevel({ files, labels: [], moneyPaths, scope: undefined }, c);
  const waitCategories = waitCategoriesOf(c);
  const merge = mergeDecision({ branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level: lvl, waitCategories, limits: { max_lines: 800, max_files: 20 }, lines: 1, files: files.length, verdict: VERDICT, newTopLevel: [], ciFixRuns: 0, foreignPush: false, pushLimitHit: false });
  const reason = lvl.reasons.find((r) => r.startsWith('path that looks like'));
  return { level: lvl.level, reason, cls: riskClassOf({ paths, level: lvl, waitCategories }).cls, auto: merge.auto, highRisk: merge.reasons.filter((r) => r.startsWith('high-risk: confusable-path')) };
}

/** One changed path judged under each review.yaml above. */
const judgePath = (path: string, moneyPaths: RegExp[] = [], reviews = lenientReviews()) => reviews.map((c) => judge([{ path, added: 1, removed: 0, addedLines: ['x'] }], moneyPaths, c));

/** What judgePath gives for a look-alike held under every review.yaml: `like[i]` is what the reason says it reads as under review i. */
const heldAsLookalike = (path: string, like: string[]) =>
  like.map((l) => ({ level: 'L3', reason: `path that looks like a protected one: ${escapedPath(path)} (like ${l})`, cls: 'protected', auto: false, highRisk: [`high-risk: confusable-path (${escapedPath(path)})`] }));

/** The three ways the engine's review.yaml and the two lenient ones name the locked docs/releasing.md. */
const RELEASING = ['docs/releasing.md (engine-guards)', 'docs/releasing.md (self-modification)', 'docs/releasing.md (self-modification)'];

/** A real scratch repo: `add` committed beside a few ordinary files and `base`, read by changeFiles, judged. */
function judgeAdd(add: Record<string, string>, base: Record<string, string> = {}) {
  const r = repoWith({ 'README.md': '# x\n', 'docs/guide.md': '# guide\n', 'web/app.ts': 'export const app = 1;\n', ...base }, add);
  const files = changeFiles(r.dir, r.base, r.head);
  return lenientReviews().map((c) => {
    const j = judge(files, [], c);
    return [j.level, j.cls, j.auto];
  });
}

test('#763: a look-alike of a locked file (docs/releasing.md with a Cyrillic e) is L3 "path that looks like a protected one" and never merges itself; the real file is as before', () => {
  const releasing = `docs/r${C.cyrillicE}leasing.md`;
  assert.deepEqual(judgePath(releasing), heldAsLookalike(releasing, RELEASING));
  const design = `docs/d${C.cyrillicE}sign.md`;
  assert.deepEqual(judgePath(design), heldAsLookalike(design, ['docs/design.md (engine-guards)', 'docs/design.md (self-modification)', 'docs/design.md (self-modification)']));
  // The real file: locked as before, and not a look-alike of itself.
  assert.deepEqual(judgePath('docs/releasing.md').map((r) => [r.level, r.reason, r.cls, r.auto]), Array(3).fill(['L3', undefined, 'protected', false]));
  // And through a real repo and changeFiles: the look-alike added beside the real file.
  assert.deepEqual(judgeAdd({ [releasing]: '# steps\n' }, { 'docs/releasing.md': '# steps\n' }), Array(3).fill(['L3', 'protected', false]));
});

test('#763: look-alikes of other locked files (src/review.ts, a locked test, CLAUDE.md in any folder) are held at L3; so is a case-insensitive one (a long s) and a fullwidth or mathematical letter', () => {
  // src/review.ts: in the engine's review.yaml src/** is engine (L3) already; the look-alike holds it in the other two too.
  const review = `src/r${C.cyrillicE}view.ts`;
  const src = judgePath(review);
  assert.deepEqual(src.map((r) => [r.level, r.cls, r.auto]), Array(3).fill(['L3', 'protected', false]));
  assert.deepEqual(src.map((r) => r.reason), Array(3).fill(`path that looks like a protected one: ${escapedPath(review)} (like src/review.ts (self-modification))`));
  const reviewTest = `test/r${C.cyrillicE}view.test.ts`;
  assert.deepEqual(judgePath(reviewTest), heldAsLookalike(reviewTest, ['test/review.test.ts (engine-guards)', 'test/review.test.ts (self-modification)', 'test/review.test.ts (self-modification)']));
  // Siblings of **/CLAUDE.md (an agent-instructions file): a Cyrillic capital E for the E.
  for (const p of [`docs/CLAUD${C.cyrillicCapitalE}.md`, `web/CLAUD${C.cyrillicCapitalE}.md`]) assert.deepEqual(judgePath(p), heldAsLookalike(p, Array(3).fill('**/CLAUDE.md (agent-instructions)')), p);
  // UTS #39 maps a long s to f; a case-insensitive file system may open it as s (#688's case-folding note).
  const longS = `docs/relea${C.longS}ing.md`;
  assert.deepEqual(judgePath(longS), heldAsLookalike(longS, RELEASING));
  // A fullwidth r and a mathematical bold r: UTS #39's table leaves them to NFKC, so the compatibility form counts too.
  for (const p of [`docs/${C.fullwidthR}eleasing.md`, `docs/${C.mathBoldR}eleasing.md`]) assert.deepEqual(judgePath(p), heldAsLookalike(p, RELEASING), escapedPath(p));
});

test('#763: a folder look-alike of .worklane/roles/, scripts/setup/ or .github/workflows/ is held at L3, whatever review.yaml lists', () => {
  const roles = `${BRAND.configDir}/r${C.cyrillicO}les/a.md`;
  assert.deepEqual(judgePath(roles), heldAsLookalike(roles, Array(3).fill(`${BRAND.configDir}/roles/** (agent-instructions)`)));
  const setupPath = `scripts/s${C.cyrillicE}tup/x.sh`;
  const setup = judgePath(setupPath);
  assert.deepEqual(setup.map((r) => [r.level, r.cls, r.auto]), Array(3).fill(['L3', 'protected', false]));
  assert.ok(setup.every((r) => r.reason === `path that looks like a protected one: ${escapedPath(setupPath)} (like scripts/setup/** (self-modification))`), JSON.stringify(setup));
  // Under .github/ every path waits already (ci-config); the look-alike of workflows/ is named as one too (the engine's
  // review.yaml lists deploy-config at L3, and it comes first).
  const workflow = `.github/w${C.cyrillicO}rkflows/ci.yml`;
  const like = ['.github/workflows/** (deploy-config)', '.github/workflows/** (self-modification)', '.github/workflows/** (self-modification)'];
  assert.deepEqual(judgePath(workflow).map((r) => [r.level, r.cls, r.auto, r.reason]), like.map((l) => ['L3', 'protected', false, `path that looks like a protected one: ${escapedPath(workflow)} (like ${l})`]));
});

test('#763: an ASCII look-alike (rn for m, 1 for l) of a locked file is held too: UTS #39 skeletons, not only scripts', () => {
  assert.deepEqual(judgePath('src/rnerge-policy.ts').map((r) => [r.level, r.auto, r.reason]), Array(3).fill(['L3', false, 'path that looks like a protected one: "src/rnerge-policy.ts" (like src/merge-policy* (self-modification))']));
  assert.deepEqual(judgePath('docs/re1easing.md').map((r) => [r.level, r.auto]), Array(3).fill(['L3', false]));
});

test('#763: a name with a blank-looking character (a trailing space, a no-break space, the braille blank) that reads as a locked file is held; one that reads as no protected path keeps normal review, shown escaped', () => {
  // #688's round-4 finding: the braille blank is neither a format nor a default-ignorable character, so no other
  // check saw it. Each of these reads as docs/releasing.md in a file list.
  for (const p of ['docs/releasing.md ', `docs/releasing.md${C.noBreakSpace}`, `docs/releasing.md${C.brailleBlank}`, `docs/releasing${C.brailleBlank}.md`, `docs/re${C.brailleBlank}leasing.md`]) {
    assert.deepEqual(judgePath(p), heldAsLookalike(p, RELEASING), escapedPath(p));
  }
  // A blank in a name that reads as nothing protected: normal review, as on main.
  for (const p of ['docs/my notes.md', `docs/my${C.brailleBlank}notes.md`, `docs/my${C.noBreakSpace}notes.md`]) {
    assert.deepEqual(judgePath(p).map((r) => [r.level, r.reason, r.auto]), Array(3).fill(['L0', undefined, true]), escapedPath(p));
  }
  // Text shows a name with a braille blank or a no-break space escaped, so it can't read as one with a space.
  for (const p of [`docs/my${C.brailleBlank}notes.md`, `docs/my${C.noBreakSpace}notes.md`]) assert.equal(shownPath(p), escapedPath(p));
  assert.equal(shownPath('docs/my notes.md'), 'docs/my notes.md');
  // A space at the start or end of a segment is escaped too: text can't show it.
  assert.deepEqual(['docs/releasing.md ', ' docs/x.md', 'docs /x.md', 'docs/ x.md'].map(shownPath), ['"docs/releasing.md "', '" docs/x.md"', '"docs /x.md"', '"docs/ x.md"']);
  // And through a real repo and changeFiles: a trailing braille blank beside the real file.
  assert.deepEqual(judgeAdd({ [`docs/releasing.md${C.brailleBlank}`]: '# steps\n' }, { 'docs/releasing.md': '# steps\n' }), Array(3).fill(['L3', 'protected', false]));
});

test('#763: a look-alike of a review.yaml category that waits (L3 or merge.wait_categories) or of a money path is held; the real paths are as before', () => {
  const billing = ReviewConfig.parse({ version: 1, categories: { billing: ['app/billing/**'] }, levels: { ...LEVELS, L3_human: { when: ['billing'], over_lines: 800 } } });
  const waits = ReviewConfig.parse({ version: 1, categories: { billing: ['app/billing/**'] }, levels: LEVELS, merge: { wait_categories: ['billing'] } });
  const charge = `app/b${C.cyrillicI}lling/charge.ts`;
  assert.deepEqual(judgePath(charge, [], [billing, waits]), heldAsLookalike(charge, Array(2).fill('app/billing/** (billing)')));
  assert.deepEqual(judgePath('app/billing/charge.ts', [], [billing, waits]).map((r) => [r.reason, r.auto]), [[undefined, false], [undefined, false]]);
  // A money path (a regex, read with each look-alike character as the ASCII it reads as): a Cyrillic a in pay.
  const pay = `lib/p${C.cyrillicA}y.ts`;
  assert.deepEqual(judgePath(pay, [/^lib\/pay\.ts$/], [cfg]), heldAsLookalike(pay, ['a money path']));
  assert.deepEqual(judgePath(`lib/pay.ts${C.brailleBlank}`, [/^lib\/pay\.ts$/], [cfg]).map((r) => [r.level, r.auto]), [['L3', false]]);
  assert.deepEqual(judgePath('lib/pay.ts', [/^lib\/pay\.ts$/], [cfg]).map((r) => r.reason), [undefined]);
});

test('#763: a mixed-script name that reads as no protected path, and an ordinary accented one, keep normal review', () => {
  const normal = (p: string) => judgePath(p).map((r) => [r.level, r.reason, r.auto]);
  // web/: app code, L1 under the first two and L0 under the third (docs: **), each merging itself as on main.
  assert.deepEqual(normal(`web/c${C.cyrillicA}t.ts`), [['L1', undefined, true], ['L1', undefined, true], ['L0', undefined, true]]);
  // Accents (on a locked name too), a Cyrillic dze below the top level, and an ASCII case variant (case counts only for
  // a name outside ASCII: a visible capital is told apart by a reader).
  for (const p of [`docs/na${C.iDiaeresis}ve.md`, `docs/caf${C.eAcute}.md`, `docs/d${C.eGrave}sign.md`, `docs/${C.cyrillicDze}rc.md`, 'docs/Releasing.md']) assert.deepEqual(normal(p), Array(3).fill(['L0', undefined, true]), p);
  // And through a real repo: an accented sibling of a locked file.
  assert.deepEqual(judgeAdd({ [`docs/d${C.eGrave}sign.md`]: '# notes\n' }), Array(3).fill(['L0', 'docs-only', true]));
});

test('#763: a path too long to compare is held, not passed: bounded and fail closed', () => {
  // Over 1024 characters, or a skeleton over 4096 (an Arabic ligature whose prototype is 18 characters).
  const long = `docs/${'a'.repeat(1100)}.md`;
  const wide = `docs/${C.arabicLigature.repeat(300)}.md`;
  for (const p of [long, wide]) {
    const r = judgePath(p);
    assert.deepEqual(r.map((x) => [x.level, x.auto]), Array(3).fill(['L3', false]), p.slice(0, 20));
    assert.ok(r.every((x) => x.reason?.includes('(not compared: ')), r[0]!.reason);
  }
  // Just under the bound: compared, and normal.
  assert.deepEqual(judgePath(`docs/${'a'.repeat(1000)}.md`).map((x) => [x.level, x.reason]), Array(3).fill(['L0', undefined]));
});

test('#763: the look-alike category is a floor: no review.yaml can loosen it, and its check is locked with the review levels', () => {
  assert.deepEqual(loosenedProblems({ levels: { L3_human: { when: [] } }, merge: { loosened: ['confusable-path'] } }), ['merge.loosened: confusable-path is high-risk or a safety floor and can never be loosened']);
  for (const p of ['src/confusables.ts', 'src/confusables-data.ts']) assert.equal(selfModificationPart(p), 'the review levels', p);
  // A review.yaml with no L3 category: the lock alone makes a change to the check L3.
  const plain = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
  assert.equal(level([{ path: 'src/confusables-data.ts', added: 1, removed: 0 }], plain).level, 'L3');
  // Every reason and high-risk line shows a look-alike escaped (printable ASCII), so it can't read as the path it looks like.
  const releasing = `docs/r${C.cyrillicE}leasing.md`;
  assert.equal(shownPath(releasing), escapedPath(releasing));
  assert.match(shownPath(releasing), /^"[ -~]+"$/);
  assert.equal(shownPath(`docs/na${C.iDiaeresis}ve.md`), `docs/na${C.iDiaeresis}ve.md`);
  const lvl = level([{ path: releasing, added: 1, removed: 0 }]);
  assert.deepEqual(whyHighRisk({ level: lvl, waitCategories: [] }).map((w) => w.text).filter((t) => t.startsWith('has a path that looks')), [`has a path that looks like a protected one: ${escapedPath(releasing)}`]);
});
