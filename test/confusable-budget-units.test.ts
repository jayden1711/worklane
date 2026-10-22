// #763 round 10: the look-alike check's time bound is held by its budget, counted in units, so these tests are
// deterministic (the coordinator's decision; round 9's wall-clock bound failed on CI at 7,460 ms against 6,000).
// - A path that normalized() refuses partway through a pass is charged what it did, and at least what comparing a path
//   of its length costs (RUN_HOLD_CHAR_COST), so the budget runs out after about as many of them as it did when they
//   were compared. At round 9 such a path was charged its first pass's input only (about 20,000 units for 150 to 230
//   microseconds), and 90,000 of them added 31.6 s to one computeLevel (measured by the round-9 delta check).
// - No work on a path once the budget is spent, and the run check is charged by the path's length.
// - Over 5,000 paths of each shape the review found, the budget is overdrawn by at most one path's work.
// One coarse wall-clock test runs the slowest compared shape found (30 marks of 30 classes, descending) against
// LOOKALIKE_BOUND_MS, which the budget is sized to stay under by half on the machine measured.
//
// WHY the characters are written as themselves with a name, or found by their properties: no committed file holds a
// code point number (#763).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { BRAND } from '../src/brand.js';
import * as confusables from '../src/confusables.js';
import { ReviewConfig } from '../src/config/schema.js';
import { repoRoot } from './helpers.js';

const { lookalikeOf, LOOKALIKE_BUDGET, FORM_CHAR_COST } = confusables;
const tail = (s: string) => s.normalize('NFD').slice(1);
const ACUTE = tail('é');
const DIAERESIS = tail('ä');
/** The combining dot below (class 220), from an a with a dot below. */
const DOT_BELOW = tail('ạ');
/** The combining ypogegrammeni (class 240, the highest), from an alpha with one. */
const YPOGEGRAMMENI = tail('ᾳ');
/** The combining Greek dialytika tonos: one mark that is the diaeresis and the acute under NFD. */
const TONOS = Array.from({ length: 112 }, (_, i) => String.fromCodePoint(768 + i)).find((c) => c.normalize('NFD') === DIAERESIS + ACUTE)!;
/** The Arabic ligature sallallahou alayhe wasallam, written as itself: one character, 18 in its compatibility form. */
const LIGATURE = 'ﷺ';
/** The halfwidth katakana voiced sound mark, written as itself. */
const HW_VOICED = 'ﾞ';
const swaps = (a: string, b: string) => `e${a}${b}`.normalize('NFD') === `e${b}${a}`;
const nonStarter = (m: string) => `e${YPOGEGRAMMENI}${m}`.normalize('NFD') !== `e${YPOGEGRAMMENI}${m}` || `e${m}${ACUTE}`.normalize('NFD') !== `e${m}${ACUTE}`;
/** 30 combining marks of 30 different classes, highest class first (the order canonical ordering reverses most). */
const DESC30 = (() => {
  const reps: string[] = [];
  for (let x = 768; x < 131072; x++) {
    const m = String.fromCodePoint(x);
    if (!/^\p{M}$/u.test(m) || m.normalize('NFD') !== m || !nonStarter(m)) continue;
    if (!reps.some((r) => !swaps(r, m) && !swaps(m, r))) reps.push(m);
  }
  reps.sort((a, b) => (swaps(a, b) ? -1 : swaps(b, a) ? 1 : 0));
  return reps.slice(0, 30).join('');
})();

const fit = (s: string) => s.slice(0, 1020);
/** The shapes the reviews found, each a path of up to 1,020 characters. */
const SHAPES: Record<string, (tag: string) => string> = {
  // The round-9 delta check's: 15 dialytika tonos (30 marks under NFD) then 15 dots below, then an e, repeated.
  'tonos and dots below': (t) => fit(`a/${t}e${(TONOS.repeat(15) + DOT_BELOW.repeat(15) + 'e').repeat(33)}`),
  '30 classes descending': (t) => fit(`a/${t}e${(DESC30 + 'e').repeat(40)}`),
  'ypogegrammeni and dots below': (t) => fit(`a/${t}e${(YPOGEGRAMMENI.repeat(15) + DOT_BELOW.repeat(15) + 'e').repeat(33)}`),
  'many short runs': (t) => fit(`docs/${t}${('e' + ACUTE).repeat(510)}`),
  'precomposed accents': (t) => fit(`docs/${t}${'é'.repeat(1010)}`),
  'halfwidth kana with marks': (t) => fit(`docs/${t}${('ｶ' + HW_VOICED).repeat(505)}`),
  'one long run as written': (t) => fit(`a/${t}e${ACUTE.repeat(1015)}`),
  'voiced-mark halves': (t) => fit(`a/${t}e${(TONOS.repeat(30) + HW_VOICED).repeat(16)}${HW_VOICED.repeat(600)}`),
  'blank-split halves': (t) => fit(`a/${t}e${(ACUTE.repeat(30) + ' ').repeat(16)}${(DOT_BELOW.repeat(30) + ' ').repeat(16)}`),
  'ascii long': (t) => fit(`a/${t}/${'abcdefghij/'.repeat(100)}`),
  'short outside ascii': (t) => `a/é${t}`,
  'long letters and accents': (t) => `docs/${'q'.repeat(450)}${'é'.repeat(450)}${t}.md`,
  'ligature 220': (t) => `a/${LIGATURE.repeat(220)}${t}`,
  'ligature 1000': (t) => `a/${LIGATURE.repeat(1000)}${t}`,
  'hangul 140': (t) => `a/${'가'.repeat(140)}${t}`,
};

const engineGlobs = (): { glob: string; what: string }[] => {
  const cfg = ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8')));
  return Object.values(cfg.categories ?? {}).flat().map((glob) => ({ glob, what: glob }));
};
const short400 = () => Array.from({ length: 400 }, (_, i) => ({ glob: `svc${i}/**`, what: 'svc' }));
const money200 = () => Array.from({ length: 200 }, (_, j) => ({ glob: `**${'q'.repeat(20)}${j}**`, what: 'money' }));
const SPENT = 'look-alike work budget';
const RUN = 'run of more than';

test('#763 round 10: the characters here are the ones their names say', () => {
  assert.ok(/^\p{M}$/u.test(TONOS) && TONOS.normalize('NFD') === DIAERESIS + ACUTE);
  assert.ok(/^\p{M}$/u.test(DOT_BELOW) && swaps(ACUTE, DOT_BELOW));
  assert.equal([...DESC30].length, 30);
  assert.ok(LIGATURE.length === 1 && /^\p{Script=Arabic}$/u.test(LIGATURE) && LIGATURE.normalize('NFKC').length === 18);
  for (let i = 1; i < 30; i++) assert.ok(swaps([...DESC30][i - 1]!, [...DESC30][i]!), 'each class higher than the next');
});

test('#763 round 10: paths held partway through a pass reach the budget after about as many paths as when they were compared', () => {
  // At 7fc5ed03 these paths were compared and charged about 1,580,000 units each (measured: 1,266 paths reached its
  // 2-billion budget). Held for their run since round 9, they were charged about 20,420 (eb1ba0a9: about 98,000).
  const UNITS_COMPARED = 1_580_000;
  const expected = LOOKALIKE_BUDGET / UNITS_COMPARED;
  const patterns = engineGlobs();
  const budget = { left: LOOKALIKE_BUDGET };
  let reached = -1;
  for (let i = 0; i < 3 * expected; i++) {
    const hit = lookalikeOf(SHAPES['tonos and dots below']!(i.toString(36)), patterns, budget);
    assert.ok(hit && 'unchecked' in hit, JSON.stringify(hit));
    if (hit.unchecked.includes(SPENT)) {
      reached = i;
      break;
    }
    assert.ok(hit.unchecked.includes(RUN), hit.unchecked);
  }
  assert.ok(reached >= 0.75 * expected && reached <= 1.25 * expected, `the budget was reached after ${reached} paths; about ${Math.round(expected)} expected`);
});

test('#763 round 10: no work on a path once the budget is spent: a path with a long run gets the budget\'s reason, not the run\'s', () => {
  for (const shape of ['one long run as written', 'many short runs', 'tonos and dots below']) {
    const budget = { left: 0 };
    const hit = lookalikeOf(SHAPES[shape]!('0'), engineGlobs(), budget);
    assert.ok(hit && 'unchecked' in hit && hit.unchecked.includes(SPENT), `${shape}: ${JSON.stringify(hit)}`);
    assert.equal(budget.left, 0, `${shape}: nothing charged, so nothing done`);
  }
});

test('#763 round 10: every path is charged at least by its length, a path held for its run at least RUN_HOLD_CHAR_COST a character', () => {
  const patterns = engineGlobs();
  for (const [shape, mk] of Object.entries(SHAPES)) {
    const path = mk('0');
    const budget = { left: LOOKALIKE_BUDGET };
    const hit = lookalikeOf(path, patterns, budget);
    const charged = LOOKALIKE_BUDGET - budget.left;
    assert.ok(charged >= FORM_CHAR_COST * path.length, `${shape}: ${charged} units for ${path.length} characters`);
    if (hit && 'unchecked' in hit && hit.unchecked.includes(RUN)) assert.ok(charged >= confusables.RUN_HOLD_CHAR_COST * (path.length + 1), `${shape}: ${charged} units, held for its run`);
  }
});

test('#763 round 10: over 5,000 paths of each shape, under each config, the budget is overdrawn by at most one path\'s work, and every path after it is held for it', () => {
  for (const [cname, patterns] of [['the engine\'s review.yaml', engineGlobs()], ['400 short globs', short400()], ['200 money globs alive on every character', money200()]] as const) {
    for (const [shape, mk] of Object.entries(SHAPES)) {
      const budget = { left: LOOKALIKE_BUDGET };
      let spentAt = -1;
      for (let i = 0; i < 5_000; i++) {
        const hit = lookalikeOf(mk(i.toString(36)), patterns, budget);
        const spent = !!hit && 'unchecked' in hit && hit.unchecked.includes(SPENT);
        if (spentAt >= 0) assert.ok(spent, `${shape}, ${cname}: path ${i} after the budget was spent at ${spentAt}`);
        else if (spent) spentAt = i;
        // Once spent, the rest cost nothing: stop here (the check above ran on one more path).
        if (spentAt >= 0 && i > spentAt) break;
      }
      assert.ok(-budget.left <= LOOKALIKE_BUDGET / 100, `${shape}, ${cname}: overdrawn by ${-budget.left} units`);
    }
  }
});

test('#763 round 10: one coarse wall-clock check: 5,000 paths of 30 classes descending under the engine\'s review.yaml, one computeLevel within LOOKALIKE_BOUND_MS', () => {
  const url = (p: string) => pathToFileURL(join(repoRoot, 'dist', 'src', p)).href;
  const paths = Array.from({ length: 5_000 }, (_, i) => SHAPES['30 classes descending']!(i.toString(36)));
  const body = `const { computeLevel } = await import(${JSON.stringify(url('review.js'))});
const { ReviewConfig } = await import(${JSON.stringify(url('config/schema.js'))});
const { readFileSync } = await import('node:fs');
const input = JSON.parse(readFileSync(0, 'utf8'));
const cfg = ReviewConfig.parse(input.cfg);
const files = input.paths.map((path) => ({ path, added: 1, removed: 0 }));
const t = performance.now();
const r = computeLevel({ files, labels: [], moneyPaths: [], scope: undefined }, cfg);
console.log(JSON.stringify({ ms: performance.now() - t, level: r.level }));`;
  const cfg = ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8')));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', body], { input: JSON.stringify({ cfg, paths }), encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 0, `the run didn't finish in 60 s (signal ${r.signal}): ${r.stderr.slice(0, 300)}`);
  const out = JSON.parse(r.stdout.trim()) as { ms: number; level: string };
  assert.equal(out.level, 'L3');
  assert.ok(out.ms < confusables.LOOKALIKE_BOUND_MS, `${Math.round(out.ms)} ms`);
});
