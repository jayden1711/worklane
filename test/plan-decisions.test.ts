// Plans cite decisions: the plan contract's Decisions section, checked against the decision records that exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import type { StoredEvent } from '../src/events/types.js';
import { checkDecisions, decisionIndex, NOTHING_RECORDED, resolveRef } from '../src/plan-decisions.js';
import { decisionsMade, planHoldReasons, planReviewExtra, readPlan, readPlanReview, type Plan } from '../src/plan-mode.js';
import { loadConfig } from '../src/config/load.js';
import { exampleProject, repoRoot } from './helpers.js';

/**
 * Commits the checkout's files (or only the paths named) as its HEAD, the plan's base: the index reads only the records
 * git tracks there (#920 round 7).
 */
function commit(repo: string, ...paths: string[]): string {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!existsSync(join(repo, '.git'))) git('init', '-q', '-b', 'main');
  git('add', '-A', '--', ...(paths.length ? paths : ['.']));
  git('-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'records');
  return repo;
}

/** A checkout with a decisions file, a decisions folder and a design doc; and one decision made in the log. */
function records() {
  const repo = mkdtempSync(join(tmpdir(), 'records-'));
  writeFileSync(join(repo, 'decisions.md'), '# Decisions\n\n## D-1: Exports are CSV\nEvery export is CSV; no JSON exports.\n\n## D-2: Totals reject negative quantities\nAn order with a negative quantity is rejected, never silently dropped.\n\n```\n## not a heading (in a fence)\n```\n');
  mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'decisions', '0003-no-new-db.md'), '# No second database\nEverything stays in the one SQLite file.\n');
  writeFileSync(join(repo, 'docs', 'design.md'), '# Design\n\n## 8. Roles\nThe roles.\n\n### 12.1 Blocked (only these)\nWhat is blocked.\n');
  const events = [
    { id: 1, type: 'decision.asked', payload: { id: 'd-7-abc', kind: 'question', issue: 7, owner: 'o', question: 'Retry uploads with backoff?', options: ['yes', 'no'], recommendation: 'yes', receipts: [] } },
    { id: 2, type: 'decision.answered', payload: { id: 'd-7-abc', by: 'o', answer: 'yes' } },
    { id: 3, type: 'decision.asked', payload: { id: 'd-8-def', kind: 'question', issue: 8, owner: 'o', question: 'Unanswered?', options: ['a'], recommendation: 'a', receipts: [] } },
  ] as unknown as StoredEvent[];
  commit(repo);
  return { repo, index: decisionIndex(repo, events) };
}

const section = (rests: string[], against: string[] = []) => ['Rests on:', ...(rests.length ? rests : ['- none']), 'Argues against:', ...(against.length ? against : ['- none'])].join('\n');

test('the decisions index: decisions made (answered only), each heading of the decision files, each file of a decisions folder, docs/design.md', () => {
  const { index } = records();
  const refs = index.map((e) => e.ref);
  assert.ok(refs.includes('decision d-7-abc'));
  assert.ok(!refs.includes('decision d-8-def'), 'an unanswered question is no decision');
  assert.ok(refs.includes('decisions.md § D-2: Totals reject negative quantities'));
  assert.ok(!refs.some((r) => r.includes('not a heading')), 'headings in a code fence are not sections');
  assert.ok(refs.includes('docs/decisions/0003-no-new-db.md'));
  assert.ok(refs.includes('docs/design.md § 12.1 Blocked (only these)'));
  // Cited by id or by heading, in any of the ways a person would write it.
  for (const c of ['D-2', 'decisions.md § D-2', 'decisions.md#D-2: Totals reject negative quantities', 'decisions.md § Totals reject negative quantities', '**decisions.md § d-2**']) assert.equal(resolveRef(index, c)?.ref, 'decisions.md § D-2: Totals reject negative quantities', c);
  for (const c of ['docs/design.md § 8', 'docs/design.md §8. Roles', 'docs/design.md#8-roles', 'docs/design.md § Roles']) assert.equal(resolveRef(index, c)?.ref, 'docs/design.md § 8. Roles', c);
  assert.equal(resolveRef(index, 'd-7-abc')?.ref, 'decision d-7-abc');
  assert.equal(resolveRef(index, 'docs/decisions/0003')?.ref, 'docs/decisions/0003-no-new-db.md');
  assert.match(decisionsMade(index).join('\n'), /Decisions already made on this project[^\n]*\n- \[decision d-7-abc\] Retry uploads with backoff\? -> yes \(#7\)/);
  assert.match(decisionsMade(index).join('\n'), /Decision records in this checkout[^\n]*\n(- .*\n)*- \[decisions\.md § D-1: Exports are CSV\]/);
});

test('the contract check refuses a plan with no Decisions section', () => {
  const { index } = records();
  const plan = { approach: 'Reject negative quantities.', steps: ['Change the reducer'], files: ['src/price.js'], risks: [], design_change: false };
  for (const missing of [plan, { ...plan, decisions: '' }, { ...plan, decisions: '   ' }, { ...plan, decisions: 42 }]) {
    const r = readPlan(missing, index);
    assert.ok('invalid' in r && /Decisions section is missing/.test(r.invalid), JSON.stringify(r));
  }
  assert.ok(!('invalid' in readPlan({ ...plan, decisions: section(['- [D-2] it rejects negative quantities']) }, index)));
});

test('the contract check refuses a citation of an id or a section that does not exist in the files', () => {
  const { index } = records();
  for (const fake of ['D-9', 'decisions.md § D-9: Something nobody decided', 'docs/design.md § 99. Nowhere', 'docs/decisions/0004-made-up.md', 'decision d-404', 'NOTES.md § D-1', 'not a heading (in a fence)']) {
    const r = checkDecisions(section([`- [${fake}] relies on it`]), index);
    assert.ok('invalid' in r && r.invalid.includes(`cites what isn't recorded: [${fake}]`), `${fake}: ${JSON.stringify(r)}`);
  }
  // One fake among real ones still refuses the plan.
  const mixed = checkDecisions(section(['- [D-1] exports stay CSV', '- [D-77] a decision nobody made']), index);
  assert.ok('invalid' in mixed && /\[D-77\]/.test(mixed.invalid) && !/\[D-1\]/.test(mixed.invalid.split('Its format')[0]!));
  // An id that exists in another checkout but not this one: the check reads the actual files.
  assert.ok('invalid' in checkDecisions(section(['- [D-1] x']), decisionIndex(mkdtempSync(join(tmpdir(), 'empty-')), [])));
});

test('the contract check: real citations pass, argues-against needs a reason, and both parts are required', () => {
  const { index } = records();
  const ok = checkDecisions(section(['- [D-1] the export is CSV', '- [docs/design.md § 8] the roles stay as they are'], ['- [decision d-7-abc] uploads here are local; a retry would hide a disk error']), index);
  assert.deepEqual(ok, {
    nothing: false,
    restsOn: [
      { ref: 'decisions.md § D-1: Exports are CSV', note: 'the export is CSV' },
      { ref: 'docs/design.md § 8. Roles', note: 'the roles stay as they are' },
    ],
    arguesAgainst: [{ ref: 'decision d-7-abc', note: 'uploads here are local; a retry would hide a disk error' }],
  });
  const noReason = checkDecisions(section(['- [D-1] csv'], ['- [D-2]']), index);
  assert.ok('invalid' in noReason && /without saying why the plan goes ahead anyway/.test(noReason.invalid));
  const onlyRests = checkDecisions('Rests on:\n- [D-1] csv', index);
  assert.ok('invalid' in onlyRests && /no "Argues against:" part/.test(onlyRests.invalid));
  const empty = checkDecisions(section([], []), index);
  assert.ok('invalid' in empty && /cites nothing/.test(empty.invalid));
  const prose = checkDecisions(section(['- D-1 is about exports']), index);
  assert.ok('invalid' in prose && /isn't a citation/.test(prose.invalid));
});

test('"nothing recorded on this" passes only as the whole section', () => {
  const { index } = records();
  for (const alone of [NOTHING_RECORDED, `  ${NOTHING_RECORDED}.  `, 'Nothing recorded on this']) assert.deepEqual(checkDecisions(alone, index), { nothing: true }, alone);
  assert.deepEqual(checkDecisions(NOTHING_RECORDED, []), { nothing: true }, 'and when nothing at all is recorded');
  for (const beside of [`${NOTHING_RECORDED}\n${section(['- [D-1] csv'])}`, section([`- ${NOTHING_RECORDED}`]), `Rests on: ${NOTHING_RECORDED}\nArgues against: none`, `${NOTHING_RECORDED}, except D-1`]) {
    const r = checkDecisions(beside, index);
    assert.ok('invalid' in r && /beside other content/.test(r.invalid), `${beside}: ${JSON.stringify(r)}`);
  }
});

const PLAN: Plan = { approach: 'Drop orders with a negative quantity from totals.', steps: ['Filter them out in the reducer'], files: ['src/price.js'], risks: [], design_change: false, decisions: { nothing: false, restsOn: [{ ref: 'decisions.md § D-1: Exports are CSV', note: 'unrelated' }], arguesAgainst: [] } };

test('plan review gets the cited entries in full and the decisions index; what it sends back is a real entry the plan does not argue against', () => {
  const { index } = records();
  const brief = planReviewExtra(PLAN, index).join('\n');
  assert.match(brief, /### \[decisions\.md § D-1: Exports are CSV\]\nEvery export is CSV; no JSON exports\./, 'the cited entry, in full');
  assert.match(brief, /Decisions index[^\n]*\n(- .*\n)*- \[decisions\.md § D-2: Totals reject negative quantities\]/, 'the whole index, with what it did not cite');
  assert.match(brief, /- \[decision d-7-abc\] Retry uploads with backoff\? -> yes/);
  const contradiction = { contradictions: [{ ref: '[D-2]', why: 'the plan drops what D-2 says is rejected' }, { ref: 'D-404', why: 'invented' }], summary: '' };
  assert.deepEqual(readPlanReview(contradiction, PLAN, index), [{ ref: 'decisions.md § D-2: Totals reject negative quantities', why: 'the plan drops what D-2 says is rejected' }]);
  // Named under "Argues against" with a reason: not the reviewer's to send back (it waits for the owner instead).
  const argued: Plan = { ...PLAN, decisions: { nothing: false, restsOn: [], arguesAgainst: [{ ref: 'decisions.md § D-2: Totals reject negative quantities', note: 'the issue asks for dropping' }] } };
  assert.deepEqual(readPlanReview(contradiction, argued, index), []);
  assert.equal(readPlanReview({ summary: 'fine' }, PLAN, index), null, 'no verdict is no pass');
  const review = loadConfig(exampleProject().dir).review!;
  assert.deepEqual(planHoldReasons({ ...argued, files: ['src/price.js'] }, { review, moneyPaths: [], existsAtBase: () => true, scope: undefined }), ['decisions: the plan goes against decisions.md § D-2: Totals reject negative quantities']);
});

test('the config folder and the exact file name count: a decisions file is found only by its real name', () => {
  const repo = mkdtempSync(join(tmpdir(), 'records-'));
  mkdirSync(join(repo, BRAND.configDir));
  writeFileSync(join(repo, BRAND.configDir, 'decisions.md'), '## D-5: One worker per issue\n');
  writeFileSync(join(repo, 'Decisions.MD'), '## D-6: not a decision record name\n');
  const index = decisionIndex(commit(repo), []);
  assert.equal(resolveRef(index, 'D-5')?.ref, `${BRAND.configDir}/decisions.md § D-5: One worker per issue`);
  assert.equal(resolveRef(index, 'D-6'), null);
});

test("the engine repo's own merge process is not a recorded decision: docs/process.md is never indexed, and no indexed section of design.md carries it (owner, 2026-10-21)", () => {
  // Planner and plan-review agents get the index as recorded decisions; a process for this repo's own PRs among them
  // could be cited for "an agent merges a high-risk change after a second review".
  assert.ok(existsSync(join(repoRoot, 'docs', 'process.md')), 'docs/process.md is a real file');
  const index = decisionIndex(repoRoot, []);
  assert.ok(index.some((e) => e.ref.startsWith('docs/design.md § ')), "this repo's design.md is indexed");
  for (const e of index) {
    assert.ok(!e.ref.startsWith('docs/process.md'), e.ref);
    assert.doesNotMatch(`${e.title}\n${e.text}`, /process\.md|engine repo itself is merged|critical set|orchestrator/i, e.ref);
  }
  // Whatever it says, a docs/process.md in a checkout is no decision record.
  const repo = mkdtempSync(join(tmpdir(), 'records-'));
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'process.md'), '# Process\n\n## 1. Merges\nAgents merge everything.\n');
  writeFileSync(join(repo, 'docs', 'design.md'), '# Design\n\n## 8. Roles\nThe roles.\n');
  assert.deepEqual(decisionIndex(commit(repo), []).map((e) => e.ref), ['docs/design.md § 8. Roles']);
});

test('regression: a decisions file or folder entry that is docs/process.md under another name (a symlink, a hard link) is never indexed; any other record still is', () => {
  const repo = mkdtempSync(join(tmpdir(), 'records-'));
  mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'process.md'), '# Process\n\n## Who merges\nAn agent merges.\n\n## The critical set\nTwo reviews.\n');
  writeFileSync(join(repo, 'docs', 'design.md'), '# Design\n\n## 8. Roles\nThe roles.\n');
  writeFileSync(join(repo, 'docs', 'decisions', '0002-csv.md'), '# Exports are CSV\nEvery export is CSV.\n');
  symlinkSync('../process.md', join(repo, 'docs', 'decisions', '0001-merge.md'));
  symlinkSync('process.md', join(repo, 'docs', 'decisions.md'));
  linkSync(join(repo, 'docs', 'process.md'), join(repo, 'decisions.md'));
  // Committed: the symlinks as links, the hard link as a regular file with the page's text (the inode check skips it).
  const refs = decisionIndex(commit(repo), []).map((e) => e.ref);
  assert.deepEqual(refs, ['docs/design.md § 8. Roles', 'docs/decisions/0002-csv.md'], refs.join(' | '));
  // A record committed as a link is no record, even to another record path (round 7); the regular file it links to is.
  const other = mkdtempSync(join(tmpdir(), 'records-'));
  mkdirSync(join(other, 'docs'), { recursive: true });
  writeFileSync(join(other, 'decisions.md'), '# Notes\n\n## D-1: Kept\nKept.\n');
  symlinkSync('../decisions.md', join(other, 'docs', 'decisions.md'));
  assert.deepEqual(decisionIndex(commit(other), []).map((e) => e.ref), ['decisions.md § D-1: Kept']);
});

const PAGE = '# Process\n\n## Who merges\nAn agent merges.\n\n## The critical set\nTwo reviews.\n';

// WHY (#920 round 5): a planning worktree sits inside its clone (worktree.root's default). A committed record linking
// out of it, to the clone's own docs/process.md, is another inode than the worktree's page, and in CI it dangles, so
// neither the identity check nor the locked test saw it.
test("regression: a record whose real path leaves the checkout is never indexed (a planning worktree nested in its clone, linking to the clone's files)", () => {
  const clone = mkdtempSync(join(tmpdir(), 'clone-'));
  mkdirSync(join(clone, 'docs'), { recursive: true });
  writeFileSync(join(clone, 'docs', 'process.md'), PAGE);
  writeFileSync(join(clone, 'notes.md'), '# Notes\n\n## D-1: Agents merge\nAgents merge everything.\n');
  commit(clone);
  const wt = join(clone, '.claude', 'worktrees', 'plan-1');
  mkdirSync(join(wt, 'docs', 'adr'), { recursive: true });
  writeFileSync(join(wt, 'docs', 'process.md'), PAGE);
  writeFileSync(join(wt, 'docs', 'design.md'), '# Design\n\n## 8. Roles\nThe roles.\n');
  symlinkSync('../../../../docs/process.md', join(wt, 'docs', 'decisions.md'));
  symlinkSync('../../../notes.md', join(wt, 'decisions.md'));
  symlinkSync('../../../../../notes.md', join(wt, 'docs', 'adr', '0001-merges.md'));
  // A decisions folder that is the clone's docs/: each entry in it is outside the checkout.
  symlinkSync('../../../docs', join(wt, 'decisions'));
  assert.deepEqual(decisionIndex(commit(wt), []).map((e) => e.ref), ['docs/design.md § 8. Roles']);
  // The checkout reached through a symlink of its own still indexes what is inside it.
  const via = join(mkdtempSync(join(tmpdir(), 'via-')), 'wt');
  symlinkSync(wt, via);
  assert.deepEqual(decisionIndex(via, []).map((e) => e.ref), ['docs/design.md § 8. Roles']);
  // The clone itself indexes its own records.
  writeFileSync(join(clone, 'decisions.md'), '# Decisions\n\n## D-1: Kept\nKept.\n');
  assert.deepEqual(decisionIndex(commit(clone, 'decisions.md'), []).map((e) => e.ref), ['decisions.md § D-1: Kept']);
});

// WHY (#920 round 5, adversarial pass): every record path is locked in the engine's repo, but a record that links to
// another file in the checkout (notes/x.md) would take its text from a file nothing locks: once the link merged, a
// change to the target changed the record. Measured on the first round-5 build: both were indexed.
test('regression: a record that links to a file in the checkout that is not itself a record path is never indexed; since round 7, no committed link is', () => {
  const repo = mkdtempSync(join(tmpdir(), 'records-'));
  mkdirSync(join(repo, 'docs'), { recursive: true });
  mkdirSync(join(repo, 'notes'), { recursive: true });
  writeFileSync(join(repo, 'notes', '0001-merges.md'), '# Who lands changes\nAn agent lands every change after one look.\n');
  writeFileSync(join(repo, 'notes', 'all.md'), '# All\n\n## D-9: Lands\nAn agent lands it.\n');
  symlinkSync('../notes', join(repo, 'docs', 'adr'));
  symlinkSync('notes/all.md', join(repo, 'decisions.md'));
  assert.deepEqual(decisionIndex(commit(repo), []).map((e) => e.ref), []);
  // Links that lead to record paths, a folder to a record folder and a file to a record file: only the regular files
  // they lead to are records (round 7: git tracks the links as links).
  mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'decisions', '0002-csv.md'), '# Exports are CSV\nEvery export is CSV.\n');
  writeFileSync(join(repo, 'docs', 'design.md'), '# Design\n\n## 8. Roles\nThe roles.\n');
  symlinkSync('docs/decisions', join(repo, 'decisions'));
  symlinkSync('design.md', join(repo, 'docs', 'DECISIONS.md'));
  assert.deepEqual(decisionIndex(commit(repo), []).map((e) => e.ref), ['docs/design.md § 8. Roles', 'docs/decisions/0002-csv.md']);
});

// WHY (#920 round 5): when docs/process.md can't be read, no record could be told apart from it, and a hard link to it
// was indexed. Unsure fails closed: no record is indexed. A page that is simply absent is a sure answer.
test('regression: when docs/process.md exists but cannot be read (a symlink loop), no record is indexed; when it is absent, records are', () => {
  const repo = mkdtempSync(join(tmpdir(), 'records-'));
  mkdirSync(join(repo, 'docs'), { recursive: true });
  symlinkSync('process.md', join(repo, 'docs', 'process.md'));
  writeFileSync(join(repo, 'decisions.md'), '# Decisions\n\n## D-1: Kept\nKept.\n');
  writeFileSync(join(repo, 'docs', 'design.md'), '# Design\n\n## 8. Roles\nThe roles.\n');
  assert.deepEqual(decisionIndex(commit(repo), []).map((e) => e.ref), []);
  const absent = mkdtempSync(join(tmpdir(), 'records-'));
  writeFileSync(join(absent, 'decisions.md'), '# Decisions\n\n## D-1: Kept\nKept.\n');
  assert.deepEqual(decisionIndex(commit(absent), []).map((e) => e.ref), ['decisions.md § D-1: Kept']);
});

test('regression: an unsearchable docs/ with a top-level decisions.md hard-linked to docs/process.md indexes nothing', () => {
  const repo = mkdtempSync(join(tmpdir(), 'records-'));
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'process.md'), PAGE);
  linkSync(join(repo, 'docs', 'process.md'), join(repo, 'decisions.md'));
  commit(repo);
  chmodSync(join(repo, 'docs'), 0o600);
  try {
    // A user who can't search docs/ can't tell the hard link from the page: nothing. One who can (root) finds the same
    // inode and skips it: nothing either way.
    assert.deepEqual(decisionIndex(repo, []).map((e) => e.ref), []);
  } finally {
    chmodSync(join(repo, 'docs'), 0o755);
  }
});

// WHY (#920 round 7, second adversarial review A1): the lock holds git changes to the record paths, but the index read
// the working tree, so a file that a setup step, an install script or a pooled worktree left at a record path,
// untracked, was indexed and citable with no PR adding it. The index reads only what git tracks at HEAD (the plan's
// base) as regular files, with the text from git.
test('regression: only records git tracks at HEAD as regular files are indexed, with their committed text; an untracked, staged, edited or linked one is not', () => {
  const repo = mkdtempSync(join(tmpdir(), 'records-'));
  mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'decisions', '0001-csv.md'), '# Exports are CSV\nEvery export is CSV.\n');
  writeFileSync(join(repo, 'docs', 'design.md'), '# Design\n\n## 8. Roles\nThe roles.\n');
  // A record committed as a link to another record path.
  symlinkSync('0001-csv.md', join(repo, 'docs', 'decisions', '0002-link.md'));
  commit(repo);
  // Left in the working tree after the commit: an untracked record, a staged one, and an edit to a committed one.
  writeFileSync(join(repo, 'docs', 'decisions', '0003-merges.md'), '# Who lands changes\nAn agent lands every change after one look.\n');
  writeFileSync(join(repo, 'decisions.md'), '# Decisions\n\n## D-1: Agents merge\nAgents merge everything.\n');
  execFileSync('git', ['add', 'decisions.md'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(join(repo, 'docs', 'design.md'), '# Design\n\n## 8. Roles\nAn agent merges every role.\n');
  const index = decisionIndex(repo, []);
  assert.deepEqual(index.map((e) => e.ref), ['docs/design.md § 8. Roles', 'docs/decisions/0001-csv.md']);
  assert.equal(index[0]!.text, 'The roles.', 'the committed text, not the edit');
  assert.equal(resolveRef(index, 'docs/decisions/0003'), null);
  assert.equal(resolveRef(index, 'D-1'), null);
  // Not a git checkout, or not its top: no records.
  const plain = mkdtempSync(join(tmpdir(), 'records-'));
  writeFileSync(join(plain, 'decisions.md'), '# Decisions\n\n## D-1: Kept\nKept.\n');
  assert.deepEqual(decisionIndex(plain, []).map((e) => e.ref), []);
  assert.deepEqual(decisionIndex(join(repo, 'docs'), []).map((e) => e.ref), []);
});

// WHY (#920 round 7): the plan step passes its base commit. A setup step that commits a record in the worktree, or
// stands another commit in for the base with `git replace`, changes nothing the index reads.
test('read at the plan\'s base commit: a later commit, a replace ref, or a rev that is not a full commit id adds nothing', () => {
  const git = (repo: string, ...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = mkdtempSync(join(tmpdir(), 'records-'));
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'design.md'), '# Design\n\n## 8. Roles\nThe roles.\n');
  const base = git(commit(repo), 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'decisions.md'), '# Decisions\n\n## D-1: Agents merge\nAgents merge everything.\n');
  const later = git(commit(repo), 'rev-parse', 'HEAD');
  assert.deepEqual(decisionIndex(repo, [], base).map((e) => e.ref), ['docs/design.md § 8. Roles']);
  assert.deepEqual(decisionIndex(repo, [], later).map((e) => e.ref), ['decisions.md § D-1: Agents merge', 'docs/design.md § 8. Roles']);
  git(repo, 'replace', base, later);
  assert.deepEqual(decisionIndex(repo, [], base).map((e) => e.ref), ['docs/design.md § 8. Roles'], 'the replace ref is not read');
  for (const rev of ['main', base.slice(0, 8), '--output=x', `${base}^`]) assert.deepEqual(decisionIndex(repo, [], rev), [], rev);
});

test('an untracked record alone (no commit at all on top of it) is not indexed', () => {
  const repo = mkdtempSync(join(tmpdir(), 'records-'));
  writeFileSync(join(repo, 'README.md'), 'A project.\n');
  commit(repo);
  mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'decisions', '0001-merge.md'), '# Who lands changes\nAn agent lands every change after one look.\n');
  assert.deepEqual(decisionIndex(repo, []).map((e) => e.ref), []);
});
