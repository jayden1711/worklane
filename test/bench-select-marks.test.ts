// The bench command's output backstop, round 5 of #884: combining marks used as an id's separators (`̲` drawn as `_`,
// `̶` as `-`) are withheld too: the loose reading reads a mark, and a character carrying marks, as a placeholder, as
// well as dropping it. Every case goes through main(), as an unknown command and as `select <arg>`. Synthetic ids only.
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
