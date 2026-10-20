// changelog.d: each change's release notes in a file of its own, so two PRs never edit the same lines of CHANGELOG.md.
// The changelog step builds the release's notes from them, under the fixed headings in their fixed order, writes the
// generated lists after them, and deletes the fragments it used. It never drops or moves a line: it throws first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { childEnv } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

type Fragment = { name: string; text: string };
type Pr = { number: number; title: string };
const c = (await import(pathToFileURL(join(repoRoot, 'scripts', 'lib', 'changelog.mjs')).href)) as {
  FRAGMENT_HEADINGS: string[];
  parseFragment(name: string, text: string): { number: number; blocks: { heading: string; key: string; text: string }[] };
  fragmentNotes(fragments: Fragment[]): string;
  fragmentProblems(fragments: Fragment[], notes: string): string[];
  withFragments(existing: string, version: string, section: string, fragments: Fragment[]): string;
  readFragments(dir: string): Fragment[];
  withSection(existing: string, version: string, section: string): string;
  changelogSection(version: string, date: string, prs: Pr[]): string;
  sectionFor(changelog: string, version: string): string | null;
  notesOf(section: string | undefined): string;
  tagNotes(changelog: string, version: string): { notes?: string; problem?: string };
  NOTES_END: string;
};

const INTRO = '# Changelog\n\nEvery release, newest first: the PRs merged since the previous one, and what changed in guardrails.\n\n';
const OLDER = '## v9.9.8 (2026-01-01)\n\n### Features\n\n- old (#1)\n\n### Guardrail changes\n\n- none in this release\n';
const gen = (prs: Pr[] = [{ number: 5, title: 'A PR' }]) => c.changelogSection('9.9.9', '2026-12-31', prs);
const ok = '### Removals\n\n- a removal\n';
// Written by code point, so the source holds no invisible character.
const NBSP = String.fromCharCode(0xa0);
const BOM = String.fromCharCode(0xfeff);

/** Every non-blank line of the fragments that isn't one of their `### ` headings, counted. */
function bodyLines(frags: Fragment[]) {
  const n = new Map<string, number>();
  for (const f of frags) for (const l of f.text.split('\n')) if (l.trim() && !/^### /.test(l)) n.set(l, (n.get(l) ?? 0) + 1);
  return n;
}
const count = (text: string, line: string) => text.split('\n').filter((l) => l === line).length;

test('the release notes: the fixed headings in their fixed order, each fragment in file-number order, verbatim, and the generated lists after them', () => {
  assert.deepEqual(c.FRAGMENT_HEADINGS, ['Upgrading', 'After install', 'Guardrail changes: what each one does', 'Release tooling', 'Removals']);
  const frags: Fragment[] = [
    { name: '12-queue.md', text: '### Release tooling\n\n- twelve tooling\n\n### Upgrading (from v9.9.8)\n\n- twelve upgrade\n  - nested\n\n  a continued paragraph\n' },
    { name: '9-auth.md', text: '\n### Upgrading (from v9.9.8)\n\n- nine upgrade **bold** `code`  \n' },
    { name: '100-x.md', text: '### Removals\n\n- hundred removal\n' },
    { name: '12-another.md', text: '### After install\n- twelve-b after, no blank line under its heading\n\n\n' },
  ];
  const out = c.withFragments(`${INTRO}${OLDER}`, '9.9.9', gen(), frags);
  const sec = c.sectionFor(out, '9.9.9')!;
  const notes = [
    '### Upgrading (from v9.9.8)',
    '',
    '- nine upgrade **bold** `code`  ',
    '',
    '- twelve upgrade',
    '  - nested',
    '',
    '  a continued paragraph',
    '',
    '### After install',
    '',
    '- twelve-b after, no blank line under its heading',
    '',
    '### Release tooling',
    '',
    '- twelve tooling',
    '',
    '### Removals',
    '',
    '- hundred removal',
  ].join('\n');
  assert.equal(sec, `## v9.9.9 (2026-12-31)\n\n${notes}\n\n${gen().split('\n').slice(2).join('\n')}`.trimEnd(), sec);
  assert.equal(c.fragmentNotes(frags), notes, 'the same notes, whatever order the files are listed in');
  assert.equal(c.fragmentNotes([...frags].reverse()), notes);
  assert.equal(out, `${INTRO}${sec}\n\n${OLDER}`, 'the older section is untouched, after the new one');
  for (const [line, n] of bodyLines(frags)) assert.equal(count(sec, line), n, `once each: ${line}`);
  assert.deepEqual(c.tagNotes(out, '9.9.9'), { notes: sec }, 'the tag step takes the section as written');
  assert.equal(c.notesOf(sec), notes, 'a rerun reads the same notes back');
});

test('a rerun after the fragments are deleted keeps the notes and rewrites only the lists', () => {
  const frags = [{ name: '7-a.md', text: '### After install\n\n- rerun me\n' }];
  const once = c.withFragments(`${INTRO}${OLDER}`, '9.9.9', gen(), frags);
  const twice = c.withFragments(once, '9.9.9', gen([{ number: 5, title: 'A PR' }, { number: 6, title: 'Fix a thing' }]), []);
  const sec = c.sectionFor(twice, '9.9.9')!;
  assert.ok(sec.startsWith('## v9.9.9 (2026-12-31)\n\n### After install\n\n- rerun me\n\n### Features\n\n- A PR (#5)'), sec);
  assert.match(sec, /### Fixes\n\n- Fix a thing \(#6\)/);
});

test('notes the tool would read as its own lines still read back whole: an end-of-notes line is written, and the tag keeps them', () => {
  // A hand-written line shaped like a generated one ("- no merged PRs ...", "- x (#5)") sits above the lists.
  const frags = [{ name: '3-odd.md', text: '### Release tooling\n\n- no merged PRs since the previous release\n- none in this release\n- shaped like a list line (#5)\n' }];
  const out = c.withFragments(`${INTRO}${OLDER}`, '9.9.9', gen([]), frags);
  const sec = c.sectionFor(out, '9.9.9')!;
  assert.equal(c.notesOf(sec), c.fragmentNotes(frags));
  const tag = c.tagNotes(out, '9.9.9').notes!;
  for (const [line, n] of bodyLines(frags)) assert.ok(count(tag, line) >= n, `the tag's notes keep: ${line}`);
  const again = c.withFragments(out, '9.9.9', gen([{ number: 8, title: 'Later' }]), []);
  assert.equal(c.notesOf(c.sectionFor(again, '9.9.9')!), c.fragmentNotes(frags), 'and a rerun keeps them');
});

test('a fragment that would lose or move a line is refused, naming the file and the fix; nothing is built', () => {
  const refused: [string, string, RegExp][] = [
    ['5-a.md', '### Features\n\n- x\n', /changelog\.d\/5-a\.md: "### Features" is not one of the headings/],
    ['5-a.md', '### Highlights\n\n- x\n', /not one of the headings/],
    ['5-a.md', '### upgrading\n\n- x\n', /not one of the headings/],
    ['5-a.md', '### After install \n\n- x\n', /not one of the headings/],
    ['5-a.md', '###  After install\n\n- x\n', /not one of the headings/],
    ['5-a.md', '### Upgrading (from 9.9.8)\n\n- x\n', /not one of the headings/],
    ['5-a.md', '### Guardrail changes\n\n- x\n', /not one of the headings/],
    ['5-a.md', '### After install\n\n- x\n\n## v9.9.9 (unreleased)\n\n- y\n', /line 5 is a heading other than the fixed `### ` ones/],
    ['5-a.md', '### After install\n\n- x\n## Notes\n', /a heading other than the fixed/],
    ['5-a.md', '# Title\n\n### After install\n\n- x\n', /a heading other than the fixed/],
    ['5-a.md', '### After install\n\n- x\n\n#### Deeper\n', /a heading other than the fixed/],
    ['5-a.md', '### After install\n\n#\n', /a heading other than the fixed/],
    ['5-a.md', `### After install\n\n- x\n##${NBSP}v9.9.9 (unreleased)\n`, /line 4 is a heading other than the fixed/],
    ['5-a.md', '### After install\n\n- x\n##v9.9.9\n', /a heading other than the fixed/],
    ['5-a.md', '### After install\n\n- x\n   ## indented three\n', /a heading other than the fixed/],
    ['5-a.md', '### After install\n\n- x\n#unreleased\n', /a heading other than the fixed/],
    ['5-a.md', '###\tAfter install\n\n- x\n', /a heading other than the fixed/],
    ['5-a.md', '', /changelog\.d\/5-a\.md is empty/],
    ['5-a.md', '\n  \n\t\n', /is empty/],
    ['5-a.md', '- a note first\n\n### After install\n\n- x\n', /line 1 is before the first heading/],
    ['5-a.md', `${BOM}### After install\n\n- x\n`, /line 1 is before the first heading/],
    ['5-a.md', '### After install\n\n### Removals\n\n- x\n', /"### After install" has nothing under it/],
    ['5-a.md', '### Removals\n\n- x\n\n### After install\n', /"### After install" has nothing under it/],
    ['5-a.md', '### Removals\n\n- a\n\n### Removals\n\n- b\n', /"### Removals" twice/],
    ['5-a.md', '### Removals\r\n\r\n- a\r\n', /a carriage return/],
    ['5-a.md', `### Removals\n\n- a\n\n${'<!-- The lists below are written by the release script. Everything above this line is kept. -->'}\n`, /the end-of-notes line/],
  ];
  for (const [name, text, why] of refused) {
    assert.throws(() => c.parseFragment(name, text), why, JSON.stringify(text));
    assert.throws(() => c.fragmentNotes([{ name: '1-fine.md', text: ok }, { name, text }]), why, `fragmentNotes: ${JSON.stringify(text)}`);
    assert.throws(() => c.withFragments(`${INTRO}${OLDER}`, '9.9.9', gen(), [{ name, text }]), why, `withFragments: ${JSON.stringify(text)}`);
  }
  for (const name of ['notes.md', '12_x.md', '12-X.md', '012-x.md', '0-x.md', '12-x.txt', '12-x.md.bak', '12-.md', '-x.md', '12-x-.md', '12-a b.md', 'README.md']) {
    assert.throws(() => c.fragmentNotes([{ name, text: ok }]), /not a fragment name: name it changelog\.d\/<issue or PR number>-<short-slug>\.md/, name);
  }
  assert.throws(
    () => c.fragmentNotes([{ name: '1-a.md', text: '### Upgrading (from v9.9.8)\n\n- a\n' }, { name: '2-b.md', text: '### Upgrading\n\n- b\n' }]),
    /two spellings of the Upgrading heading \("### Upgrading \(from v9\.9\.8\)" in changelog\.d\/1-a\.md, "### Upgrading" in changelog\.d\/2-b\.md\)/,
  );
  assert.throws(() => c.fragmentNotes([{ name: '3-x.md', text: ok }, { name: '3-x.md', text: ok }]), /changelog\.d\/3-x\.md is given twice/);
  assert.equal(c.parseFragment('5-fine.md', '### Upgrading\n\n- plain is fine too\n').blocks[0]!.key, 'Upgrading');
  // The message tells the author what to do.
  assert.throws(() => c.parseFragment('5-a.md', '### Features\n\n- x\n'), /use one of: ### Upgrading \(or ### Upgrading \(from vX\.Y\.Z\)\), ### After install, ### Guardrail changes: what each one does, ### Release tooling, ### Removals \(changelog\.d\/README\.md\)/);
});

test("the step's own check on what it built: a notes text that lacks a fragment line, holds one under another heading, or loses a heading is caught", () => {
  const frags = [
    { name: '1-a.md', text: '### Upgrading\n\n- one\n- two\n\n### Removals\n\n- gone\n' },
    { name: '2-b.md', text: '### Upgrading\n\n- two\n  - nested\n' },
  ];
  const notes = c.fragmentNotes(frags);
  assert.deepEqual(c.fragmentProblems(frags, notes), []);
  const tampered: [string, string][] = [
    ['an indent trimmed (checked against the raw text, not the block reader)', notes.replace('  - nested', '- nested')],
    ['a line dropped', notes.replace('- one\n', '')],
    ['a repeated line dropped once', notes.replace('\n\n- two', '')],
    ['a line under another heading', notes.replace('- gone', '- gone\n- one').replace('- one\n', '')],
    ['a heading dropped', notes.replace('### Removals\n\n', '')],
    ['a heading renamed', notes.replace('### Removals', '### Removal')],
    ['the headings swapped', '### Removals\n\n- gone\n\n### Upgrading\n\n- one\n- two\n\n- two\n  - nested'],
    ['nothing at all', ''],
  ];
  for (const [what, text] of tampered) assert.notDeepEqual(c.fragmentProblems(frags, text), [], what);
});

test('fragments for a version CHANGELOG.md already has a section for are refused: which notes are meant is never guessed', () => {
  const frags = [{ name: '4-a.md', text: ok }];
  const dated = c.withSection(`${INTRO}${OLDER}`, '9.9.9', gen());
  assert.throws(() => c.withFragments(dated, '9.9.9', gen(), frags), /CHANGELOG\.md already has a section for v9\.9\.9 \("## v9\.9\.9 \(2026-12-31\)"\), and changelog\.d has 1 fragment\(s\)/);
  assert.throws(() => c.withFragments(`${INTRO}## v9.9.9 (unreleased)\n\n### Removals\n\n- old way\n\n${OLDER}`, '9.9.9', gen(), frags), /already has a section for v9\.9\.9 \("## v9\.9\.9 \(unreleased\)"\)/);
  assert.throws(() => c.withFragments(`${INTRO}## Unreleased\n\n- old way\n\n${OLDER}`, '9.9.9', gen(), frags), /already has a section for v9\.9\.9 \("## Unreleased"\)/);
  assert.throws(() => c.withFragments(`${INTRO}${OLDER}`, '9.9.8', c.changelogSection('9.9.8', '2026-12-31', []), frags), /already has a section for v9\.9\.8/, 'an older release is never given them');
  // The lines the step can't place in CHANGELOG.md itself are still refused (withSection's check), fragments or not.
  assert.throws(() => c.withFragments(`# Changelog\n\nOur own intro.\n\n${OLDER}`, '9.9.9', gen(), frags), /would drop[\s\S]*Our own intro\./);
});

test("the repo's released sections regenerate byte for byte as before: with no fragments the step is withSection, and a section rebuilt from itself is itself", () => {
  const text = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const dated = [...text.matchAll(/^## v(\d+\.\d+\.\d+) \(\d{4}-\d{2}-\d{2}\)/gm)].map((m) => m[1]!);
  assert.ok(dated.length >= 3, 'CHANGELOG.md has its released sections');
  for (const v of dated) {
    const lists = c.changelogSection(v, '2026-12-31', [{ number: 1, title: 'A PR' }]);
    assert.equal(c.withFragments(text, v, lists, []), c.withSection(text, v, lists), `v${v}`);
    const own = c.sectionFor(text, v)!;
    assert.equal(c.sectionFor(c.withFragments(text, v, own, []), v), own, `v${v}: rebuilt from itself, byte for byte`);
  }
});

test('readFragments: every <n>-<slug>.md file in the folder; README.md is the format, not a fragment; anything else is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-d-'));
  assert.deepEqual(c.readFragments(join(dir, 'missing')), [], 'no folder: no fragments');
  writeFileSync(join(dir, 'README.md'), '# How\n');
  writeFileSync(join(dir, '20-b.md'), ok);
  writeFileSync(join(dir, '3-a.md'), ok);
  assert.deepEqual(c.readFragments(dir).map((f) => f.name), ['3-a.md', '20-b.md']);
  writeFileSync(join(dir, 'notes.md'), ok);
  assert.throws(() => c.readFragments(dir), /changelog\.d\/notes\.md: not a fragment name/);
  const sub = mkdtempSync(join(tmpdir(), 'changelog-d-'));
  mkdirSync(join(sub, '4-dir.md'));
  assert.throws(() => c.readFragments(sub), /changelog\.d\/4-dir\.md: not a regular file/);
  const link = mkdtempSync(join(tmpdir(), 'changelog-d-'));
  writeFileSync(join(link, 'target'), ok);
  symlinkSync(join(link, 'target'), join(link, '5-link.md'));
  assert.throws(() => c.readFragments(link), /changelog\.d\/5-link\.md: not a regular file/, 'a symlink is never followed');
  const bytes = mkdtempSync(join(tmpdir(), 'changelog-d-'));
  writeFileSync(join(bytes, '6-latin1.md'), Buffer.from([...Buffer.from('### Removals\n\n- caf'), 0xe9, 0x0a]));
  assert.throws(() => c.readFragments(bytes), /changelog\.d\/6-latin1\.md is not UTF-8 text/, 'never decoded into replacement characters');
  // Indented 4 spaces, a # line is code, not a heading: kept as written.
  assert.match(c.fragmentNotes([{ name: '7-code.md', text: '### Release tooling\n\n- run:\n\n    # a comment in a code block\n' }]), /\n {4}# a comment in a code block$/);
});

const script = fileURLToPath(new URL('../../scripts/release.mjs', import.meta.url));

/** A repo with one commit and no PRs (so the step lists nothing from GitHub), a released section and changelog.d. */
function releaseRepo(fragments: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'release-fragments-'));
  const env = { ...childEnv(), GIT_CONFIG_GLOBAL: join(dir, '.no-global'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env }).trim();
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Ada'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false']]) git('config', k!, v!);
  writeFileSync(join(dir, '.denylist.json'), JSON.stringify({ hashed: [], patterns: ['forbiddenword[0-9]+'] }));
  writeFileSync(join(dir, 'CHANGELOG.md'), `${INTRO}${OLDER}`);
  mkdirSync(join(dir, 'changelog.d'));
  writeFileSync(join(dir, 'changelog.d', 'README.md'), '# changelog.d\n');
  for (const [name, text] of Object.entries(fragments)) writeFileSync(join(dir, 'changelog.d', name), text);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const run = () => spawnSync('node', [script, 'changelog', '9.9.9', '--repo', 'acme/widgets'], { cwd: dir, encoding: 'utf8', env });
  return { dir, run };
}

test('release.mjs changelog: the notes go into the dated section and the fragments it used are deleted, README.md kept', () => {
  const { dir, run } = releaseRepo({ '8-b.md': '### After install\n\n- eight\n', '2-a.md': '### Upgrading\n\n- two\n' });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const sec = c.sectionFor(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), '9.9.9')!;
  assert.match(sec, /^## v9\.9\.9 \(\d{4}-\d{2}-\d{2}\)\n\n### Upgrading\n\n- two\n\n### After install\n\n- eight\n\n- no merged PRs since the previous release\n/);
  assert.deepEqual(readdirSync(join(dir, 'changelog.d')), ['README.md'], 'the fragments it used are gone; the format stays');
  assert.match(r.stdout, /2 changelog\.d fragment\(s\)/);
});

test('release.mjs changelog: a bad fragment, or notes the denylist refuses, write nothing and delete nothing', () => {
  for (const frags of [{ '2-a.md': '### Upgrading\n\n- two\n', '3-b.md': '### Features\n\n- wrong heading\n' }, { '2-a.md': '### Upgrading\n\n- names forbiddenword42\n' }]) {
    const { dir, run } = releaseRepo(frags);
    const r = run();
    assert.notEqual(r.status, 0, JSON.stringify(frags));
    assert.match(r.stderr, /changelog\.d\/3-b\.md: "### Features" is not one of the headings|would fail the denylist[\s\S]*forbiddenword42/);
    assert.equal(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), `${INTRO}${OLDER}`, 'CHANGELOG.md is as it was');
    for (const [name, text] of Object.entries(frags)) assert.equal(readFileSync(join(dir, 'changelog.d', name), 'utf8'), text, `${name} is kept`);
    assert.ok(existsSync(join(dir, 'changelog.d', 'README.md')));
  }
});
