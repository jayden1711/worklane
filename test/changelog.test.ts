// CHANGELOG.md from the PRs merged between releases: grouped as features, fixes, security and guardrails, with a
// separate "Guardrail changes" section listing every PR that changed a guardrail file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

type Pr = { number: number; title: string; body?: string; labels?: string[]; files?: string[] };
const c = (await import(pathToFileURL(join(repoRoot, 'scripts', 'lib', 'changelog.mjs')).href)) as {
  prNumbers(subjects: string[]): number[];
  groupOf(pr: Pr): string;
  revertOf(pr: Pr, repo?: string): number | null;
  tagNotes(changelog: string, version: string): { notes?: string; problem?: string };
  changelogSection(version: string, date: string, prs: Pr[], repo?: string): string;
  withSection(existing: string, version: string, section: string): string;
  sectionFor(changelog: string, version: string): string | null;
  handWritten(section: string | undefined): string;
  notesOf(section: string | undefined): string;
  NOTES_END: string;
  scrubTitle(title: string, denied: (word: string) => boolean): string;
};
const s = (await import(pathToFileURL(join(repoRoot, 'scripts', 'lib', 'signing.mjs')).href)) as {
  signingProblem(cfg: Record<string, string>, exists?: (f: string) => boolean): string | null;
};

test('the PRs between two releases, from first-parent subjects: squash merges and each PR a batch merged, never a merge of main', () => {
  assert.deepEqual(
    c.prNumbers([
      'Denylist: allow the owner handle (#177)',
      'Batch 4: #170 #156 #158 (#184)',
      "Merge branch 'main' into feat/x",
      'A commit with no PR',
      'Guardrail hooks for an instance (#175)',
      'Denylist: allow the owner handle again (#177)',
    ]),
    [177, 170, 156, 158, 175],
  );
});

test('regression: merge commits name their PR ("Merge #N:", "Merge pull request #N", a reviewed range); a title starting "Merge" is still a PR', () => {
  assert.deepEqual(
    c.prNumbers([
      'Merge stages 1-5 (reviewed PRs #8-#11) into main',
      'Merge pull request #274 from someone/feat/usage-limit-pause',
      'Merge train: up to land.parallel_merges green PRs merge in one pass (#296)',
      'Batch 7 (final): #220 #223 (#229)',
      "Merge #381: GitHub's hosts are constants (#377)",
      "Merge branch 'main' into feat/x",
      'Merge remote-tracking branch origin/main',
      'Merge #427: docs: a short, current README',
    ]),
    [8, 9, 10, 11, 274, 296, 220, 223, 381, 427],
  );
});

test('a PR reverted in the same release is listed once, with its revert, and in no group; its reland is listed as usual', () => {
  const sec = c.changelogSection('0.5.0', '2026-10-14', [
    { number: 416, title: 'CI: build the dashboard UI before the tests', files: ['.github/workflows/ci.yml'] },
    { number: 421, title: 'Revert #416 (web UI built before the tests): main red' },
    { number: 422, title: 'Reland #416 with Chrome started through the engine' },
    { number: 430, title: 'Revert #12: an older change' },
  ]);
  assert.match(sec, /### Reverted in this release\n\n- CI: build the dashboard UI before the tests \(#416\): reverted by #421\n/);
  assert.equal((sec.match(/#416\)/g) ?? []).length, 1, '#416 is listed once');
  assert.doesNotMatch(sec, /\(#421\)/, 'the revert is named beside what it reverted, not listed on its own');
  assert.match(sec, /### Features\n\n- Reland #416 with Chrome started through the engine \(#422\)\n- Revert #12: an older change \(#430\)/, 'the reland, and a revert of an earlier release, are ordinary entries');
});

test("regression (#712): a GitHub-button revert is read from its body's \"Reverts owner/repo#N\", not the first #N of its title", () => {
  // GitHub titles it 'Revert "<original title>"': here the original title names #330, which is in the release too.
  const original = 'Docs: pin the release notes, as #330 asked';
  const prs: Pr[] = [
    { number: 330, title: 'Docs: a release checklist', files: ['docs/releasing.md'] },
    { number: 651, title: original, files: ['docs/releasing.md'] },
    { number: 700, title: `Revert "${original}"`, body: 'Reverts acme/widgets#651\n\nmain went red.' },
  ];
  const sec = c.changelogSection('9.9.9', '2026-12-31', prs, 'acme/widgets');
  assert.match(sec, /### Reverted in this release\n\n- Docs: pin the release notes, as #330 asked \(#651\): reverted by #700\n/);
  assert.match(sec, /### Features\n\n- Docs: a release checklist \(#330\)\n\n/, '#330 shipped, and is listed as shipped');
  assert.doesNotMatch(sec, /\(#330\): reverted/);
  assert.doesNotMatch(sec, /\(#700\)/, 'the revert is named beside what it reverted, not listed on its own');
});

test('revertOf: only a PR titled "Revert..." is a revert; its body names it (this repo only, when given), else its title', () => {
  const t = 'Revert "Queue: retry after #12"';
  assert.equal(c.revertOf({ number: 1, title: t, body: 'Reverts acme/widgets#40' }, 'acme/widgets'), 40);
  assert.equal(c.revertOf({ number: 1, title: t, body: 'Reverts ACME/Widgets#40' }, 'acme/widgets'), 40, 'owner and repo in any case');
  assert.equal(c.revertOf({ number: 1, title: t, body: 'Reverts #41' }, 'acme/widgets'), 41);
  assert.equal(c.revertOf({ number: 1, title: t, body: 'Reverts other/repo#40\nReverts acme/widgets#42' }, 'acme/widgets'), 42, "another repo's PR is never this one");
  assert.equal(c.revertOf({ number: 1, title: t, body: 'Reverts other/repo#40' }, 'acme/widgets'), 12, 'no line for this repo: the title');
  assert.equal(c.revertOf({ number: 1, title: t }), 12, 'no body: the title, as before');
  assert.equal(c.revertOf({ number: 1, title: 'Revert #416: main red', body: 'see #9' }), 416);
  assert.equal(c.revertOf({ number: 1, title: 'Queue: retry', body: 'Reverts acme/widgets#40' }, 'acme/widgets'), null, 'a body alone never makes a PR a revert');
  assert.equal(c.revertOf({ number: 1, title: 'Revert "x"', body: 'This PR Reverts acme/widgets#40' }, 'acme/widgets'), null, 'only a line that starts "Reverts"');
  assert.equal(c.revertOf({ number: 9, title: 'Revert "x"', body: 'Reverts acme/widgets#9' }, 'acme/widgets'), null, 'a PR never reverts itself');
  assert.equal(c.revertOf({ number: 9, title: 'Revert #9' }), null, 'a PR never reverts itself');
  assert.match(c.changelogSection('9.9.9', '2026-12-31', [{ number: 9, title: 'Revert "x"', body: 'Reverts acme/widgets#9' }], 'acme/widgets'), /### Features\n\n- Revert "x" \(#9\)\n/, 'so it stays listed');
});

test('regression (#712): the tag step refuses a section the changelog step did not date: (unreleased), a hand heading, no lists, a second section', () => {
  const lists = '### Features\n\n- A PR (#5)\n\n### Guardrail changes\n\n- none in this release';
  const older = '## v9.9.8 (2026-01-01)\n\n### Features\n\n- old (#1)\n\n### Guardrail changes\n\n- none in this release\n';
  const doc = (sections: string) => `# Changelog\n\n${sections}\n\n${older}`;
  const refused = (text: string) => c.tagNotes(text, '9.9.9').problem ?? '';
  assert.match(refused(doc(`## v9.9.9 (unreleased)\n\n${lists}`)), /"## v9\.9\.9 \(unreleased\)", not the dated heading "## v9\.9\.9 \(YYYY-MM-DD\)".*run `node scripts\/release\.mjs changelog 9\.9\.9`/);
  for (const h of ['## v9.9.9 (Unreleased)', '## v9.9.9 (draft)', '## v9.9.9', '## v9.9.9 (2026-02-30)', '## v9.9.9 (2026-13-01)', '## v9.9.9 (2026-12-31) final', '##  v9.9.9 (2026-12-31)', '## V9.9.9 (2026-12-31)']) {
    assert.match(refused(doc(`${h}\n\n${lists}`)), /not the dated heading/, h);
  }
  assert.match(refused(doc('## v9.9.9 (2026-12-31)\n\n### Highlights\n\n- only notes')), /has no generated lists/);
  assert.match(refused(`# Changelog\r\n\r\n## v9.9.9 (2026-12-31)\r\n\r\n${lists.replace(/\n/g, '\r\n')}\r\n`), /has "## v9\.9\.9 \(2026-12-31\)\\r", not the dated heading/, 'CRLF: refused, and the message shows the \\r');
  assert.match(refused(doc(`## Unreleased\n\n- notes\n\n## v9.9.9 (2026-12-31)\n\n${lists}`)), /more than one section for v9\.9\.9 \("## Unreleased", "## v9\.9\.9 \(2026-12-31\)"\)/);
  assert.match(refused(doc('')), /has no v9\.9\.9 section: run `node scripts\/release\.mjs changelog 9\.9\.9`/);
  assert.match(refused(''), /has no v9\.9\.9 section/);
  assert.deepEqual(c.tagNotes(doc(`## v9.9.9 (2026-12-31)\n\n${lists}`), '9.9.9'), { notes: `## v9.9.9 (2026-12-31)\n\n${lists}` });
  assert.ok(c.tagNotes(doc(`## v9.9.10 (unreleased)\n\n- later\n\n## v9.9.9 (2026-12-31)\n\n${lists}`), '9.9.9').notes, "another version's unreleased section doesn't block this one");
});

test("the changelog step's output always passes the tag step, with its end-of-notes line left out of the tag's notes", () => {
  const text = `# Changelog\n\n## v9.9.9 (unreleased)\n\n### Guardrail changes\n\n- a hand-written guardrail note\n`;
  const out = c.withSection(text, '9.9.9', c.changelogSection('9.9.9', '2026-12-31', [{ number: 5, title: 'A PR' }]));
  assert.ok(out.includes(c.NOTES_END), 'the fixture needs the end-of-notes line');
  const { notes, problem } = c.tagNotes(out, '9.9.9');
  assert.equal(problem, undefined);
  assert.equal(notes, c.sectionFor(out, '9.9.9')!.replace(`\n\n${c.NOTES_END}`, ''));
  assert.ok(!notes!.includes('<!--'));
});

test("the repo's CHANGELOG.md: a released section's tag notes are what they were (sectionFor); an unreleased one can't be tagged", () => {
  const text = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const versions = [...text.matchAll(/^## v(\d+\.\d+\.\d+) (.*)$/gm)];
  assert.ok(versions.length > 0);
  for (const [, v, rest] of versions) {
    if (/unreleased/i.test(rest!)) assert.match(c.tagNotes(text, v!).problem ?? '', /not the dated heading/, `v${v}`);
    else assert.deepEqual(c.tagNotes(text, v!), { notes: c.sectionFor(text, v!) }, `v${v}`);
  }
});

test('regenerating a section keeps what is written by hand above the generated lists; the lists are replaced', () => {
  const lead = '### Highlights\n\nOne command, one URL.\n\n### Upgrade notes (from v0.4.1)\n\n- Remove `every_minutes`.';
  const first = c.withSection('', '0.5.0', c.changelogSection('0.5.0', '2026-10-13', [{ number: 10, title: 'Dashboard: a chat panel' }]));
  const edited = first.replace('## v0.5.0 (2026-10-13)\n\n', `## v0.5.0 (2026-10-13)\n\n${lead}\n\n`);
  assert.equal(c.handWritten(c.sectionFor(edited, '0.5.0')!), lead);
  const again = c.withSection(edited, '0.5.0', c.changelogSection('0.5.0', '2026-10-14', [{ number: 10, title: 'Dashboard: a chat panel' }, { number: 11, title: 'Fix the queue' }]));
  assert.ok(again.includes(`## v0.5.0 (2026-10-14)\n\n${lead}\n\n### Features\n\n- Dashboard: a chat panel (#10)`), again);
  assert.match(again, /### Fixes\n\n- Fix the queue \(#11\)/);
  assert.equal(c.withSection(again, '0.5.0', c.sectionFor(again, '0.5.0')!), again, 'a rerun with nothing new changes nothing');
  assert.equal(c.handWritten(c.changelogSection('0.5.1', '2026-10-20', [])), '', 'a generated section, even an empty one, has no hand-written top');
  const other = c.withSection(again, '0.6.0', c.changelogSection('0.6.0', '2026-10-20', [{ number: 20, title: 'Releases' }]));
  assert.equal(c.handWritten(c.sectionFor(other, '0.6.0')!), '', "another version's highlights are never carried over");
  assert.equal(c.handWritten(c.sectionFor(other, '0.5.0')!), lead);
});

test('a PR title loses the words the denylist refuses, so a regenerated changelog passes it with no hand edit', () => {
  const denied = (w: string) => /\binternal-key-[0-9]+\b/.test(w);
  assert.equal(c.scrubTitle('Dashboard: the chat panel (internal-key-11) — merge after #82', denied), 'Dashboard: the chat panel — merge after #82');
  assert.equal(c.scrubTitle('Dashboard: a chat panel', denied), 'Dashboard: a chat panel');
});

test('groups: guardrail files or words go to security, fixes by label or title, the rest are features', () => {
  assert.equal(c.groupOf({ number: 1, title: 'Dashboard: a chat panel', files: ['web/src/pages/Chat.tsx'] }), 'features');
  assert.equal(c.groupOf({ number: 2, title: 'Fix the queue deadline under load', files: ['src/queue.ts'] }), 'fixes');
  assert.equal(c.groupOf({ number: 3, title: 'Queue: wait for the job', labels: ['bug'] }), 'fixes');
  assert.equal(c.groupOf({ number: 4, title: 'Prod reads: one role', files: ['src/guardrails/rules.ts'] }), 'security', 'a guardrail file');
  assert.equal(c.groupOf({ number: 5, title: 'Sandbox: deny reads of the task files', files: ['src/instance.ts'] }), 'security');
});

test("every section of the repo's CHANGELOG.md keeps its hand-written text when the release regenerates it", () => {
  // The release keeps only what sits above a generated heading (#671): notes in a section with none are dropped.
  const text = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const generated = /^### (?:Features|Fixes|Security and guardrails|Reverted in this release|Guardrail changes)[ \t]*$/;
  const versions = [...text.matchAll(/^## v(\d+\.\d+\.\d+) /gm)].map((m) => m[1]!);
  assert.ok(versions.length > 0, 'CHANGELOG.md has sections');
  for (const v of versions) {
    const lines = c.sectionFor(text, v)!.split('\n').slice(1);
    const end = lines.findIndex((l) => generated.test(l));
    const byHand = (end < 0 ? lines : lines.slice(0, end)).filter((l) => l.trim());
    const after = c.sectionFor(c.withSection(text, v, c.changelogSection(v, '2026-12-31', [])), v)!;
    for (const l of byHand) assert.ok(after.includes(l), `v${v}: the release would drop ${JSON.stringify(l.slice(0, 80))}; end the hand-written notes with a generated heading such as "### Guardrail changes"`);
  }
});

/** The lines of a CHANGELOG's v<version> section that `release.mjs changelog` (withSection) would drop. */
function droppedByRelease(text: string, version: string): string[] {
  const after = c.sectionFor(c.withSection(text, version, c.changelogSection(version, '2026-12-31', [{ number: 1, title: 'A PR' }])), version)!.split('\n');
  return c.sectionFor(text, version)!.split('\n').slice(1).filter((l) => l.trim() && !after.includes(l));
}

test('an unreleased section is all hand-written, so the release keeps every line of it, under any heading', () => {
  // WHY: the check above reads only the lines above the first generated heading. Notes written by hand under a
  // heading the tool also writes ("### Guardrail changes") sat below it, unchecked, and the release dropped them
  // (#809). Since #811 the release keeps an unreleased section whole, so no layout is needed.
  const unreleased = '# Changelog\n\n## v9.9.9 (unreleased)\n\n### Upgrading\n\n- a step\n\n### Guardrail changes\n\n- a hand-written guardrail note\n\n## v9.9.8 (2026-01-01)\n\n### Features\n\n- old (#1)\n';
  assert.deepEqual(droppedByRelease(unreleased, '9.9.9'), [], 'notes under a heading the tool also writes are kept (#811)');
  const fixed = unreleased.replace('### Guardrail changes\n', '### Guardrail changes: what each one does\n').replace('note\n\n## v9.9.8', 'note\n\n### Guardrail changes\n\n## v9.9.8');
  assert.deepEqual(droppedByRelease(fixed, '9.9.9'), [], 'notes under a heading the tool never writes, ended by an empty generated heading, are all kept');
  const text = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
  for (const [, v] of text.matchAll(/^## v(\d+\.\d+\.\d+) \(unreleased\)/gm)) {
    assert.deepEqual(droppedByRelease(text, v!), [], `v${v} (unreleased): the release would drop these lines`);
  }
});

/** The notes of a section, one line each, as a fixture writes them: every generated heading, and the tool's own lines. */
const NOTES = [
  '### Upgrading',
  '',
  '- a step',
  '',
  '### Features',
  '',
  '- a hand-written feature note',
  '',
  '### Fixes',
  '',
  '- a hand-written fix note',
  '',
  '### Security and guardrails',
  '',
  '- a hand-written security note',
  '',
  '### Reverted in this release',
  '',
  '- a hand-written revert note',
  '',
  '### Guardrail changes',
  '',
  '- a hand-written guardrail note',
  '- none in this release',
  '- no merged PRs since the previous release',
  '',
  '### Guardrail changes',
].join('\n');

test('an unreleased section, under any spelling of its heading, keeps every line in order; the lists come after it, and reruns keep it', () => {
  // Any heading for the version that isn't the dated one the tool writes counts as unreleased: fail safe.
  const headings = ['## v9.9.9 (unreleased)', '## V9.9.9 (Unreleased)', '##   v9.9.9   (UNRELEASED)', '## Unreleased', '## [Unreleased]', '## [9.9.9] - unreleased', '##\tunreleased (9.9.9)', '## v9.9.9 (draft)', '## v9.9.9'];
  const older = '## v9.9.8 (2026-01-01)\n\n### Features\n\n- old (#1)';
  for (const h of headings) {
    const text = `# Changelog\n\nEvery release, newest first.\n\n${h}\n\n${NOTES}\n\n${older}\n`;
    const once = c.withSection(text, '9.9.9', c.changelogSection('9.9.9', '2026-12-31', [{ number: 5, title: 'A PR' }]));
    const sec = c.sectionFor(once, '9.9.9')!;
    assert.ok(sec.startsWith(`## v9.9.9 (2026-12-31)\n\n${NOTES}\n`), `${h}: the dated heading, then every line of the notes, in order:\n${sec}`);
    const lists = sec.indexOf('### Features\n\n- A PR (#5)');
    assert.ok(lists > sec.indexOf('- a hand-written guardrail note'), `${h}: the generated lists come after the notes`);
    assert.match(sec.slice(lists), /### Guardrail changes\n\n- none in this release$/, `${h}: the generated lists end the section`);
    assert.equal((once.match(/^## /gm) ?? []).length, 2, `${h}: one section for v9.9.9 and the older one, nothing else`);
    assert.ok(once.endsWith(`${older}\n`), `${h}: the older section is untouched`);
    // A rerun, with a PR more, keeps every note and rewrites only the lists.
    const twice = c.withSection(once, '9.9.9', c.changelogSection('9.9.9', '2027-01-02', [{ number: 5, title: 'A PR' }, { number: 6, title: 'Fix a thing' }]));
    const sec2 = c.sectionFor(twice, '9.9.9')!;
    assert.ok(sec2.startsWith(`## v9.9.9 (2027-01-02)\n\n${NOTES}\n`), `${h}: a rerun keeps every line of the notes:\n${sec2}`);
    assert.equal((sec2.match(/\(#5\)/g) ?? []).length, 1, `${h}: a rerun replaces the lists, never repeats them`);
    assert.match(sec2, /### Fixes\n\n- Fix a thing \(#6\)/);
    assert.equal(c.withSection(twice, '9.9.9', c.changelogSection('9.9.9', '2027-01-02', [{ number: 5, title: 'A PR' }, { number: 6, title: 'Fix a thing' }])), twice, `${h}: a rerun with nothing new changes nothing`);
  }
});

test("an unreleased section's notes that hold the tool's own end-of-notes line still read back whole", () => {
  const notes = `- before\n\n${c.NOTES_END}\n\n### Guardrail changes\n\n- after`;
  const text = `# Changelog\n\n## v9.9.9 (unreleased)\n\n${notes}\n`;
  const once = c.withSection(text, '9.9.9', c.changelogSection('9.9.9', '2026-12-31', []));
  assert.equal(c.notesOf(c.sectionFor(once, '9.9.9')!), notes);
  const twice = c.withSection(once, '9.9.9', c.changelogSection('9.9.9', '2027-01-02', [{ number: 7, title: 'A PR' }]));
  assert.equal(c.notesOf(c.sectionFor(twice, '9.9.9')!), notes, 'a rerun keeps the notes whole');
});

test('which notes are meant is never guessed: two unreleased sections for the version, or one beside a dated one, are refused; another version is left alone', () => {
  const gen = c.changelogSection('9.9.9', '2026-12-31', []);
  assert.throws(() => c.withSection('# Changelog\n\n## Unreleased\n\n- a\n\n## v9.9.9 (unreleased)\n\n- b\n', '9.9.9', gen), /more than one section for v9\.9\.9/);
  assert.throws(() => c.withSection('# Changelog\n\n## v9.9.9 (unreleased)\n\n- a\n\n## v9.9.9 (2026-12-01)\n\n- b\n', '9.9.9', gen), /more than one section for v9\.9\.9/);
  const other = '# Changelog\n\n## v9.9.10 (unreleased)\n\n### Guardrail changes\n\n- for later\n';
  const out = c.withSection(other, '9.9.9', gen);
  assert.ok(out.includes('## v9.9.10 (unreleased)\n\n### Guardrail changes\n\n- for later'), 'an unreleased section for another version is kept whole, where it was');
  assert.equal(c.notesOf(c.sectionFor(out, '9.9.9')!), '', "another version's notes are never carried over");
});

test('a section dated by hand that the tool never wrote lists for is kept whole too', () => {
  const text = '# Changelog\n\n## v9.9.9 (2026-12-01)\n\n### Highlights\n\n- a highlight\n\n## v9.9.8 (2026-01-01)\n\n### Features\n\n- old (#1)\n';
  assert.deepEqual(droppedByRelease(text, '9.9.9'), []);
  assert.ok(c.sectionFor(c.withSection(text, '9.9.9', c.changelogSection('9.9.9', '2026-12-31', [])), '9.9.9')!.startsWith('## v9.9.9 (2026-12-31)\n\n### Highlights\n\n- a highlight\n\n'));
});

test("the repo's released sections regenerate exactly as before: no end-of-notes line is added to any of them", () => {
  const text = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
  for (const [, v] of text.matchAll(/^## v(\d+\.\d+\.\d+) \(\d{4}-\d{2}-\d{2}\)/gm)) {
    const after = c.sectionFor(c.withSection(text, v!, c.changelogSection(v!, '2026-12-31', [{ number: 1, title: 'A PR' }])), v!)!;
    assert.ok(!after.includes(c.NOTES_END), `v${v}: a released section gets no end-of-notes line`);
    assert.equal(c.notesOf(after), c.handWritten(c.sectionFor(text, v!)!), `v${v}: its notes are what the release kept before`);
  }
});

test('a release section: each group, then guardrail changes with their files; written first in CHANGELOG.md, replacing a section of the same version', () => {
  const prs: Pr[] = [
    { number: 10, title: 'Dashboard: a chat panel (#10)', files: ['web/src/x.tsx'] },
    { number: 11, title: 'Fix the queue deadline', files: ['src/queue.ts'] },
    { number: 12, title: 'Hooks: refuse writes to frozen tests', files: ['src/hook.ts', 'test/hook.test.ts'] },
  ];
  const sec = c.changelogSection('0.5.0', '2026-10-12', prs);
  assert.equal(
    sec,
    [
      '## v0.5.0 (2026-10-12)',
      '',
      '### Features',
      '',
      '- Dashboard: a chat panel (#10)',
      '',
      '### Fixes',
      '',
      '- Fix the queue deadline (#11)',
      '',
      '### Security and guardrails',
      '',
      '- Hooks: refuse writes to frozen tests (#12)',
      '',
      '### Guardrail changes',
      '',
      '- Hooks: refuse writes to frozen tests (#12): src/hook.ts',
      '',
    ].join('\n'),
  );
  assert.match(c.changelogSection('0.5.1', '2026-10-13', [{ number: 13, title: 'Docs', files: ['docs/a.md'] }]), /### Guardrail changes\n\n- none in this release/);
  const one = c.withSection('', '0.5.0', sec);
  assert.match(one, /^# Changelog\n\nEvery release, newest first/);
  const two = c.withSection(one, '0.6.0', c.changelogSection('0.6.0', '2026-10-20', [{ number: 20, title: 'Releases: signed tags' }]));
  assert.ok(two.indexOf('## v0.6.0') < two.indexOf('## v0.5.0'), 'newest first');
  const again = c.withSection(two, '0.6.0', c.changelogSection('0.6.0', '2026-10-21', [{ number: 21, title: 'Releases: the changelog' }]));
  assert.equal((again.match(/## v0\.6\.0/g) ?? []).length, 1, 'the same version is replaced, not repeated');
  assert.match(again, /Releases: the changelog \(#21\)/);
  assert.match(c.sectionFor(again, '0.5.0')!, /^## v0\.5\.0[\s\S]*src\/hook\.ts$/);
  assert.equal(c.sectionFor(again, '0.4.0'), null);
});

test('signing: refused without a key, or with an SSH key file that is missing; an existing SSH key, an inline key or a GPG key id is fine', () => {
  assert.match(s.signingProblem({})!, /no signing key configured[\s\S]*git config --global gpg\.format ssh/);
  assert.match(s.signingProblem({ 'gpg.format': 'ssh', 'user.signingkey': '/nope/key.pub' }, () => false)!, /\/nope\/key\.pub, which doesn't exist/);
  assert.equal(s.signingProblem({ 'gpg.format': 'ssh', 'user.signingkey': '/k.pub' }, () => true), null);
  assert.equal(s.signingProblem({ 'gpg.format': 'ssh', 'user.signingkey': 'key::ssh-ed25519 AAAA' }, () => false), null);
  assert.equal(s.signingProblem({ 'user.signingkey': 'owner@example.com' }), null);
  assert.match(s.signingProblem({ 'gpg.format': 'x509', 'user.signingkey': 'k' })!, /isn't supported/);
});
