// Plans cite decisions: the plan contract's Decisions section, checked against the decision records that exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import type { StoredEvent } from '../src/events/types.js';
import { checkDecisions, decisionIndex, NOTHING_RECORDED, resolveRef } from '../src/plan-decisions.js';
import { decisionsMade, planHoldReasons, planReviewExtra, readPlan, readPlanReview, type Plan } from '../src/plan-mode.js';
import { loadConfig } from '../src/config/load.js';
import { exampleProject, repoRoot } from './helpers.js';

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
  const index = decisionIndex(repo, []);
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
  assert.deepEqual(decisionIndex(repo, []).map((e) => e.ref), ['docs/design.md § 8. Roles']);
});
