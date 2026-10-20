// The changelog step's own refusals, checked independently of the code they guard: a fragment line the tag step
// would strip is refused, and the check on the built notes doesn't reuse the builder's grouping or sorting, so a
// mistake there makes the step throw rather than write the notes in the wrong order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers.js';

type Fragment = { name: string; text: string };
type Lib = {
  parseFragment(name: string, text: string): unknown;
  fragmentNotes(fragments: Fragment[]): string;
  withFragments(existing: string, version: string, section: string, fragments: Fragment[]): string;
  changelogSection(version: string, date: string, prs: { number: number; title: string }[]): string;
  tagNotes(changelog: string, version: string): { notes?: string; problem?: string };
  NOTES_END: string;
};
const path = join(repoRoot, 'scripts', 'lib', 'changelog.mjs');
const c = (await import(pathToFileURL(path).href)) as Lib;

const INTRO = '# Changelog\n\nEvery release, newest first: the PRs merged since the previous one, and what changed in guardrails.\n\n';
const OLDER = '## v9.9.8 (2026-01-01)\n\n### Features\n\n- old (#1)\n\n### Guardrail changes\n\n- none in this release\n';
const build = (lib: Lib, frags: Fragment[]) => lib.withFragments(`${INTRO}${OLDER}`, '9.9.9', lib.changelogSection('9.9.9', '2026-12-31', [{ number: 5, title: 'A PR' }]), frags);
const TAB = String.fromCharCode(9);

test('a fragment line the tag step would strip is refused: the end-of-notes comment, exact or with trailing spaces or a tab', () => {
  // WHY (#870 review): only the exact comment was refused. With trailing whitespace it was built, CHANGELOG.md kept
  // it, and the tag's notes dropped it, after the step had deleted the fragment.
  for (const tail of ['', '  ', TAB, ` ${TAB} `]) {
    const text = `### Removals\n\n- before\n\n${c.NOTES_END}${tail}\n\n- after\n`;
    const what = JSON.stringify(tail);
    assert.throws(() => c.parseFragment('900-x.md', text), /the end-of-notes line/, `parseFragment ${what}`);
    assert.throws(() => c.fragmentNotes([{ name: '1-a.md', text: '### Removals\n\n- a\n' }, { name: '900-x.md', text }]), /the end-of-notes line/, `fragmentNotes ${what}`);
    assert.throws(() => build(c, [{ name: '900-x.md', text }]), /the end-of-notes line/, `withFragments ${what}`);
  }
});

/** The module with one piece of its source replaced, imported from memory (a data: URL): no file is written. */
async function mutant(from: string, to: string): Promise<Lib> {
  const src = readFileSync(path, 'utf8');
  assert.equal(src.split(from).length, 2, `the mutation point is in the module exactly once: ${from}`);
  return (await import(`data:text/javascript,${encodeURIComponent(src.replace(from, to))}`)) as Lib;
}

test("the step's check on what it built doesn't reuse the builder's grouping or sorting: a mutant of either is refused", async () => {
  // WHY (#870 review): the check read the notes back through the same grouping and sorting code that built them, so
  // a mutant that reversed the headings, the fragments under a heading or the number sort was built, not refused.
  const frags = [
    { name: '12-b.md', text: '### Upgrading\n\n- twelve\n' },
    { name: '9-a.md', text: '### Upgrading\n\n- nine\n\n### Removals\n\n- nine removed\n' },
  ];
  assert.doesNotThrow(() => build(c, frags), 'the real module builds them');
  const mutants: [string, string, string][] = [
    ['the headings in reverse order', 'FRAGMENT_HEADINGS.map((key) =>', '[...FRAGMENT_HEADINGS].reverse().map((key) =>'],
    ['the fragments under a heading reversed', 'blocks.map((b) => b.text).join(', 'blocks.map((b) => b.text).reverse().join('],
    ['the number sort reversed', 'const byNumber = (a, b) => a.number - b.number', 'const byNumber = (a, b) => b.number - a.number'],
  ];
  for (const [what, from, to] of mutants) {
    const m = await mutant(from, to);
    assert.notEqual(m.fragmentNotes(frags), c.fragmentNotes(frags), `${what}: the mutant builds other notes`);
    assert.throws(() => build(m, frags), /would drop or move fragment lines/, `${what}: refused`);
  }
});
