// The bench command's output backstop, round 4 of #884: look-alikes of `_`, `-` and the repo's letters are withheld by
// construction (the loose reading lets any non-ASCII character that isn't a digit fill any of those places), not by a
// list of characters. Every case goes through main(), as an unknown command and as `select <arg>`. Synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// WHY: the isolation-preload guard: this file's process stops unless test/isolate.ts made its machine.
import './helpers.js';

// WHY: loaded when a test runs, so the fail-without run fails on the behaviour, not at import.
const cli = async () => (await import('../scripts/bench/cli.js')) as unknown as {
  main: (argv: string[], deps: { out: (l: string) => void }) => number;
  withholdTasks: (s: string) => string;
  WITHHELD: string;
};

/** Runs `arg` through main() both ways; the lines printed. */
async function printed(arg: string): Promise<string[]> {
  const { main } = await cli();
  const lines: string[] = [];
  for (const argv of [[arg], ['select', arg]]) {
    const out: string[] = [];
    assert.equal(main(argv, { out: (l) => out.push(l) }), 2, JSON.stringify(arg));
    lines.push(...out);
  }
  return lines;
}

test('look-alikes in mixed roles are withheld through main(): any non-ASCII non-digit may stand for `_`, `-` or a letter', async () => {
  const { withholdTasks, WITHHELD } = await cli();
  const cases: [string, string][] = [
    ['example‿‿proj−4242', 'undertie x2, minus sign'],
    ['example‗‗proj−4242', 'double low line x2, minus sign'],
    ['example‿‿proj─4242', 'undertie x2, box-drawing horizontal'],
    ['example‐‐proj‐4242', 'hyphens in the underscores\' places'],
    ['example−−proj‿4242', 'minus signs as underscores, an undertie as the hyphen'],
    ['example‗‗proj一4242', 'a CJK letter drawn like a dash as the hyphen'],
    ['exampleーーprojー4242', 'the prolonged sound mark in every place'],
    ['example‿‿prоj−٤242', 'a Cyrillic o and an Arabic-Indic digit too'],
    ['example\u{E005F}\u{E005F}proj-4242', 'invisible tag characters as the underscores'],
    ['sweb.eval.x86_64.example‿1776−proj-4242', 'an image name, 1776 between look-alikes'],
    ['sweb.eval.x86_64.example‗١٧٧٦‗proj-4242', 'an image name, 1776 in Arabic-Indic digits'],
  ];
  for (const [arg, why] of cases) {
    assert.equal(withholdTasks(arg), WITHHELD, why);
    const text = (await printed(arg)).join('\n');
    assert.doesNotMatch(text, /proj|prоj/, `${why}: ${text.split('\n')[0]}`);
  }
});

test('a visible extra character after the hyphen is withheld too, next to look-alike underscores', async () => {
  const { withholdTasks, WITHHELD } = await cli();
  for (const [arg, why] of [
    ['example‗‗proj-ʹ4242', 'a modifier prime'],
    ['exampleˍˍproj-ʹ4242', 'a modifier prime, modifier macrons as underscores'],
    ['example‗‗proj-★4242', 'a star'],
    // Built from code points: the joiner (U+200D) is never raw in this source.
    [`example‗‗proj-${String.fromCodePoint(0x1f468, 0x200d, 0x1f469)}4242`, 'an emoji ZWJ sequence'],
    ['example‿‿proj−★★4242', 'two stars after a minus sign'],
  ] as const) {
    assert.equal(withholdTasks(arg), WITHHELD, why);
    assert.doesNotMatch((await printed(arg)).join('\n'), /proj/, why);
  }
});

test('ordinary words the bench prints, and ordinary non-ASCII text, stay as they are', async () => {
  const { withholdTasks } = await cli();
  const keep = [
    'PASS', 'FAIL', 'SKIP', 'rows', 'selection', 'images', 'sha256-rank-v1,', 'seed', '20261018:', 't01..t50;', 't01', 't04',
    '23e4727dfa4a514f5dc8bbd33d950ebe19715668b92a2f52896fbf6cf0090ea6', '(0600,', '$40', '$15', '$8', '--spend', 'ENOENT:',
    "'/home/example/bench/state/evals/held-out/swebench/manifest.json'", 'https://data.example.org/datasets/fixture/resolve/',
    'test-00000-of-00001.parquet', 'rows.jsonl', 'x86_64', '__init__', '__pycache__', '__main__.py', 'my_var__x',
    'node_modules/.bin', 'v1.2.3-rc1', 'foo%20bar', '&amp;', '2026-10-20', 'sha256:00ff', '…', '→', '—', '–',
    '“quoted”', '©2026', '℃', '½', '×2', '±1', '✔', '✖', '⚠', '\u{1F44D}',
    'pre‑release‑2', 'über_2', 'naïve_x-1', 'é__x', 'café-1', 'naïve', 'résumé—2024',
    'Zürich-2', '10–20', 'São_Paulo-3', '2026‑10‑20', '日本語の文章',
    '2026年10月20日', '第1章', 'Straße', 'Ångström', 'a—b', '« ', '•',
  ];
  const changed = keep.filter((s) => withholdTasks(s) !== s);
  assert.deepEqual(changed, [], `kept ${keep.length - changed.length} of ${keep.length}`);
});

// Round 5 (folded in from its own file in round 6, unchanged: a new test file tipped test/ci-affected.test.ts's
// "a one-test change selects < 1/5" guard): combining marks used as an id's separators (`̲` drawn as `_`, `̶` as `-`)
// are withheld too: the loose reading reads a mark, and a character carrying marks, as a placeholder, as well as
// dropping it.

test('combining marks as the separators are withheld through main()', async () => {
  const { main, withholdTasks, WITHHELD } = await cli();
  const cases: [string, string][] = [
    ['example̲̲proj−4242', 'combining low lines as underscores, a minus sign'],
    ['example̲̲proj‐4242', 'combining low lines as underscores, a Unicode hyphen'],
    ['example̠̠proj−4242', 'combining minus signs below as underscores'],
    ['example‗‗proj̶4242', 'a combining long stroke as the hyphen'],
    ['example̲̲proj̶4242', 'combining low lines and a combining long stroke'],
    ['exampl̲e̲proj−4242', 'underlined letters as underscores'],
    ['sweb.eval.x86_64.example̲1776̲proj-4242', 'an image name, combining low lines around 1776'],
    ['example٠٠proj٠4242', 'Arabic-Indic zeros as the separators'],
  ];
  for (const [arg, why] of cases) {
    assert.equal(withholdTasks(arg), WITHHELD, why);
    for (const argv of [[arg], ['select', arg]]) {
      const out: string[] = [];
      assert.equal(main(argv, { out: (l) => out.push(l) }), 2, why);
      assert.doesNotMatch(out.join('\n'), /proj/, `${why}: ${out[0]}`);
    }
  }
});

test('words with ordinary accents, composed or decomposed, stay as they are', async () => {
  const { withholdTasks } = await cli();
  const keep = ['naïve', 'naïve', 'résumé—2024', 'résumé—2024', 'café-1', 'Ångström', 'Zürich-2', 'Zürich-2', 'São_Paulo-3', 'São_Paulo-3', 'piña_colada', 'é__x', 'mañana-10', '٢٠٢٦-١٠', '२०२०'];
  assert.deepEqual(keep.filter((s) => withholdTasks(s) !== s), []);
});

// Round 6: an image name whose `1776` carries a mark on one digit, with marks as its underscores.

test('marks inside 1776 in an image name are withheld through main()', async () => {
  const { main, withholdTasks, WITHHELD } = await cli();
  for (const [arg, why] of [
    ['sweb.eval.x86_64.example̲17́76̲proj-4242', 'low lines around 1776, an acute on one 7'],
    ['sweb.eval.x86_64.example̲1́7́7́6̲́proj-4242', 'an acute on every digit'],
    ['sweb.eval.x86_64.example‿1‗7‗7‗6‿proj-4242', 'look-alikes between the digits'],
  ] as const) {
    assert.equal(withholdTasks(arg), WITHHELD, why);
    for (const argv of [[arg], ['select', arg]]) {
      const out: string[] = [];
      assert.equal(main(argv, { out: (l) => out.push(l) }), 2, why);
      assert.doesNotMatch(out.join('\n'), /proj/, `${why}: ${out[0]}`);
    }
  }
});
