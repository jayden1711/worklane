// lint-test
// #763 round 9: the limit on a run of combining marks (MAX_MARK_RUN, 30) applies to every string the look-alike check
// normalizes, not only to the path as written. At round 8 two shapes got a long run, out of canonical order, into a
// normalization anyway (sorting it is quadratic in V8), and one computeLevel took 4.8 to 5.2 s (measured by the
// round-8 delta check):
// - runs of 30 marks split by blanks, which join into one run in the path's blank-free variant;
// - the halfwidth katakana voiced sound mark, a letter modifier (so it split a run as written) whose NFKC form is a
//   combining mark (so under NFKC the marks around it join).
// Every normalization now goes through one helper (normalized in src/confusables.ts) that refuses a longer run in the
// exact string it is handed, and the halfwidth sound marks count as marks. The last test reads that module's source
// to check no other line normalizes (a backstop beside the helper).
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

const { lookalikeOf } = confusables;
const tail = (s: string) => s.normalize('NFD').slice(1);
/** The combining acute accent (class 230), from an e with an acute. */
const ACUTE = tail('é');
/** The combining diaeresis (class 230), from an a with a diaeresis. */
const DIAERESIS = tail('ä');
/** The combining ypogegrammeni (class 240, the highest), from an alpha with one. */
const YPOGEGRAMMENI = tail('ᾳ');
/** The Combining Diacritical Marks block, as characters. */
const BLOCK = Array.from({ length: 112 }, (_, i) => String.fromCodePoint(768 + i));
/** The combining Greek dialytika tonos: one mark that is the diaeresis and the acute under NFD. */
const TONOS = BLOCK.find((c) => c.normalize('NFD') === DIAERESIS + ACUTE && c.length === 1)!;
/** The combining grave accent below (class 220): the block's first mark canonical ordering puts before the acute. */
const GRAVE_BELOW = BLOCK.find((c) => (`a${ACUTE}${c}`).normalize('NFD') === `a${c}${ACUTE}`)!;
/** The halfwidth katakana voiced and semi-voiced sound marks, written as themselves. */
const HW_VOICED = 'ﾞ';
const HW_SEMI_VOICED = 'ﾟ';
/** The no-break space: the first space separator past ASCII. */
const NBSP = Array.from({ length: 128 }, (_, i) => String.fromCodePoint(128 + i)).find((c) => /^\p{Zs}$/u.test(c))!;

/** The reviewer's shapes (round-8 delta check, time8.mjs and calib8.mjs), each cut to 1,020 characters. */
const fit = (s: string) => s.slice(0, 1020);
const SHAPES: Record<string, (tag: string) => string> = {
  // 16 runs of 30 two-mark characters, each ended by a voiced mark, then 600 voiced marks.
  'voiced-mark halves': (tag) => fit(`a/${tag}e${(TONOS.repeat(30) + HW_VOICED).repeat(16)}${HW_VOICED.repeat(600)}`),
  'voiced marks between acutes': (tag) => fit(`a/${tag}e${(HW_VOICED + ACUTE).repeat(510)}`),
  // 16 runs of 30 acutes then 16 of 30 graves below, each ended by a space (or a no-break space).
  'blank-split halves': (tag) => fit(`a/${tag}e${(ACUTE.repeat(30) + ' ').repeat(16)}${(GRAVE_BELOW.repeat(30) + ' ').repeat(16)}`),
  'no-break-space-split halves': (tag) => fit(`a/${tag}e${(ACUTE.repeat(30) + NBSP).repeat(16)}${(GRAVE_BELOW.repeat(30) + NBSP).repeat(16)}`),
  'blank-split then voiced marks': (tag) => fit(`a/${tag}e${(TONOS.repeat(30) + ' ').repeat(16)}${HW_VOICED.repeat(600)}`),
};

test('#763 round 9: the characters here are the ones their names say', () => {
  assert.ok(/^\p{M}$/u.test(TONOS) && TONOS.normalize('NFD') === DIAERESIS + ACUTE);
  assert.ok(/^\p{M}$/u.test(GRAVE_BELOW) && GRAVE_BELOW.normalize('NFD') === GRAVE_BELOW);
  for (const [c, kana] of [[HW_VOICED, 'が'], [HW_SEMI_VOICED, 'ぱ']] as const) {
    // A letter modifier, not a mark; its NFKC form is the combining sound mark (the tail of a voiced kana's NFD).
    assert.ok(/^\p{Lm}$/u.test(c) && !/\p{M}/u.test(c) && c.normalize('NFKC') === tail(kana), c);
  }
  assert.equal(NBSP.normalize('NFKC'), ' ');
});

/** Whether a single code point that is its own NFD has a nonzero combining class (canonical ordering moves it). */
const nonStarter = (c: string): boolean => `a${YPOGEGRAMMENI}${c}`.normalize('NFD') !== `a${YPOGEGRAMMENI}${c}` || `a${c}${ACUTE}`.normalize('NFD') !== `a${c}${ACUTE}`;

test('#763 round 9: every code point: the halfwidth sound marks are the only characters outside \\p{M} whose NFKC form starts with a non-starter, and every non-starter is \\p{M}', () => {
  const found: string[] = [];
  const notMarks: string[] = [];
  for (let cp = 128; cp <= 1114111; cp++) {
    if (cp >= 55296 && cp <= 57343) continue;
    const c = String.fromCodePoint(cp);
    const mark = /^\p{M}$/u.test(c);
    if (!mark && c.normalize('NFD') === c && nonStarter(c)) notMarks.push(c);
    if (mark) continue;
    const first = String.fromCodePoint(c.normalize('NFKC').normalize('NFD').codePointAt(0)!);
    if (nonStarter(first)) found.push(c);
  }
  assert.deepEqual(notMarks, []);
  assert.deepEqual(found, [HW_VOICED, HW_SEMI_VOICED]);
  assert.equal(confusables.HALFWIDTH_SOUND_MARKS, HW_VOICED + HW_SEMI_VOICED);
});

const RUN = `run of more than ${confusables.MAX_MARK_RUN} combining marks`;

test('#763 round 9: each shape is held as not compared, for its run of marks, whichever variant or pass forms the run', () => {
  const patterns = [{ glob: 'svc0/**', what: 'x' }];
  for (const [name, mk] of Object.entries(SHAPES)) {
    const hit = lookalikeOf(mk('0'), patterns, { left: confusables.LOOKALIKE_BUDGET });
    assert.ok(hit && 'unchecked' in hit && hit.unchecked.includes(RUN), `${name}: ${JSON.stringify(hit)}`);
  }
});

test('#763 round 9: a run of 30 is still compared, as written, without its blanks and under NFKC; 31 is held', () => {
  const patterns = [{ glob: 'docs/**', what: 'x' }];
  const docs = (s: string) => lookalikeOf(`docs/e${s}.md`, patterns);
  // A name of its own (docs/**), so null: compared, no look-alike.
  assert.equal(docs(`${ACUTE.repeat(15)} ${ACUTE.repeat(15)}`), null);
  assert.equal(docs(`${ACUTE.repeat(29)}${HW_VOICED}`), null);
  for (const s of [`${ACUTE.repeat(16)} ${ACUTE.repeat(15)}`, `${ACUTE.repeat(16)}${NBSP}${ACUTE.repeat(15)}`, `${ACUTE.repeat(30)}${HW_VOICED}`, `${ACUTE.repeat(15)}${HW_SEMI_VOICED}${ACUTE.repeat(15)}`]) {
    const hit = docs(s);
    assert.ok(hit && 'unchecked' in hit && hit.unchecked.includes(RUN), JSON.stringify(hit));
  }
  // Ordinary halfwidth katakana with sound marks, and a pointed name, are compared as usual.
  for (const name of ['docs/ｶﾞｲﾄﾞ.md', 'docs/ﾊﾟｽﾜｰﾄﾞ.md', `docs/vie${tail('ệ')}t.md`]) assert.equal(lookalikeOf(name, patterns), null, name);
});

test('#763 round 9: a protected glob with a long run of marks holds every path compared to it, naming the glob, not the path', () => {
  const hit = lookalikeOf('docs/é.md', [{ glob: `x${ACUTE.repeat(31)}/**`, what: 'odd glob' }]);
  assert.ok(hit && 'unchecked' in hit && hit.unchecked.includes('a protected glob (odd glob) has a run'), JSON.stringify(hit));
});

const LEVELS = { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] } };
const SHORT400 = { version: 1, categories: { crit: Array.from({ length: 400 }, (_, i) => `svc${i}/**`) }, levels: { ...LEVELS, L3_human: { when: ['crit'], over_lines: 100_000_000 } } };
const engine = () => ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8')));

/** One computeLevel over 5,000 paths of a shape, in a child process: its wall time, level, and the look-alike reason. */
function timed(cfg: unknown, shape: string): { ms: number; level: string; held: string } {
  const url = (p: string) => pathToFileURL(join(repoRoot, 'dist', 'src', p)).href;
  const paths = Array.from({ length: 5_000 }, (_, i) => SHAPES[shape]!(i.toString(36)));
  // The paths and config go in on stdin (5,000 paths of 1,020 characters are too long for an argument).
  const body = `const { computeLevel } = await import(${JSON.stringify(url('review.js'))});
const { ReviewConfig } = await import(${JSON.stringify(url('config/schema.js'))});
const { readFileSync } = await import('node:fs');
const input = JSON.parse(readFileSync(0, 'utf8'));
const cfg = ReviewConfig.parse(input.cfg);
const files = input.paths.map((path) => ({ path, added: 1, removed: 0 }));
const t = performance.now();
const r = computeLevel({ files, labels: [], moneyPaths: [], scope: undefined }, cfg);
const ms = performance.now() - t;
const held = r.reasons.find((x) => x.startsWith('path that looks like')) ?? '';
// The reason with the paths it names (escaped and quoted, each over 1,000 characters) cut out: what each was held for.
console.log(JSON.stringify({ ms, level: r.level, held: held.replace(/"(?:[^"\\\\]|\\\\.)*"/g, '<path>') }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', body], { input: JSON.stringify({ cfg, paths }), encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 0, `the timing run didn't finish in 60 s (signal ${r.signal}): ${r.stderr.slice(0, 300)}`);
  return JSON.parse(r.stdout.trim()) as { ms: number; level: string; held: string };
}

for (const [shape, config] of [
  ['voiced-mark halves', 'short400'],
  ['voiced-mark halves', 'engine'],
  ['blank-split halves', 'engine'],
  ['no-break-space-split halves', 'engine'],
  ['blank-split then voiced marks', 'short400'],
] as const) {
  test(`#763 round 9: 5,000 paths, ${shape}, under ${config === 'engine' ? "the engine's review.yaml" : '400 short globs'}: held for the run, one computeLevel within LOOKALIKE_BOUND_MS`, () => {
    const r = timed(config === 'engine' ? engine() : ReviewConfig.parse(SHORT400), shape);
    assert.equal(r.level, 'L3');
    // Held for the run of marks, not because the work budget ran out on them.
    assert.ok(r.held.includes(RUN) && !r.held.includes('budget'), `${Math.round(r.ms)} ms: ${r.held.slice(0, 400)}`);
    assert.ok(r.ms < confusables.LOOKALIKE_BOUND_MS, `${Math.round(r.ms)} ms`);
  });
}

test('#763 round 9: src/confusables.ts normalizes only in normalized(), which checks the run first', () => {
  const src = readFileSync(join(repoRoot, 'src', 'confusables.ts'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l));
  const calls = code.filter((l) => /normalize(?!d)/.test(l));
  assert.deepEqual(calls.map((l) => l.trim()), ['return s.normalize(form);']);
  const helper = /function normalized\(s: string, form: 'NFD' \| 'NFKC'\): string \{\n\s*if \(overMarkRun\(s\)\) throw new MarkRunOver\([^\n]*\);\n\s*return s\.normalize\(form\);\n\}/;
  assert.match(src, helper);
});
