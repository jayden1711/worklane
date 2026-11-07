// #1077 rounds 2 and 3: while GitHub is still computing whether a PR can merge (the first poll after every merge), a
// PR held only by a conflict with the tip on where a check's file goes (the tip-conflict reason) waits: GitHub's
// `dirty` on a later poll sends it to the conflict fix, as on main. Only a GitHub that says clean, or never says, hands
// it to the owner. A conflict on a file's lines holds nothing in the decision, as on main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approve, changeOnMain, git, green, openPr, skip, type OpenPr } from './repro-state-graph/harness.js';
import { MERGEABLE_CAP } from '../src/coordinator/wait-caps.js';

const pollNow = (t: OpenPr) => (t.c as unknown as { prPolled: Map<number, number> }).prPolled.clear();
const decided = (t: OpenPr) => t.f.log.read(0, ['merge.decided']).map((e) => e.payload as { number: number; auto: boolean; reasons: string[] }).filter((p) => p.number === t.opened.number);
const TIP_CONFLICT = /conflicts with the default branch's current tip on where a test.*repro-qty\.test\.js/;

/** Main moves the PR's base test folder: the test file the PR adds there conflicts on where it goes (file location). */
function moveTestsOnMain(t: OpenPr) {
  const dir = join(mkdtempSync(join(tmpdir(), 'other-')), 'c');
  git(t.f.base, 'clone', '-q', t.f.remote, dir);
  git(dir, 'mv', 'test', 'spec');
  git(dir, '-c', 'user.email=o@example.com', '-c', 'user.name=Other', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Move the tests');
  git(dir, 'push', '-q', 'origin', 'main');
}

async function stale(shape: 'lines' | 'location', state: 'unknown' | 'clean', design = false, before?: (t: OpenPr) => void) {
  const t = await openPr({ 'evaluator-verdict': approve(design) }, { autoMerge: () => true });
  // The PR adds test/repro-qty.test.js. `lines`: main adds a different file there (add/add, on its lines).
  if (shape === 'lines') changeOnMain(t, join('test', 'repro-qty.test.js'), () => "import { test } from 'node:test';\ntest('another', () => {});\n");
  else moveTestsOnMain(t);
  t.f.backlog.setPr(t.opened.number, { mergeableState: state });
  before?.(t);
  await green(t);
  return t;
}

test('mergeability unknown, a conflict on a test file\'s lines: no decision, and the conflict fix once GitHub says dirty, as on main', { skip }, async () => {
  const t = await stale('lines', 'unknown');
  assert.deepEqual(decided(t), [], 'no merge decision while GitHub is still computing');
  assert.ok(!t.pr().labels.includes('needs-owner'), `no owner label: ${t.pr().labels.join(', ')}`);
  assert.equal(t.pr().comments.length, 0, 'no owner comment');
  t.f.backlog.setPr(t.opened.number, { mergeableState: 'dirty' });
  pollNow(t);
  await t.c.tick();
  assert.ok(t.f.log.read(0, ['conflict_fix.started']).length >= 1, 'the conflict fix starts');
  assert.deepEqual(decided(t), [], 'the conflict fix, not a merge decision');
});

test('mergeability unknown, a conflict on where a test file goes: no decision, and the conflict fix once GitHub says dirty', { skip }, async () => {
  const t = await stale('location', 'unknown');
  assert.deepEqual(decided(t), [], 'no merge decision while GitHub is still computing');
  assert.equal(t.pr().comments.length, 0, 'no owner comment');
  t.f.backlog.setPr(t.opened.number, { mergeableState: 'dirty' });
  pollNow(t);
  await t.c.tick();
  assert.ok(t.f.log.read(0, ['conflict_fix.started']).length >= 1, 'the conflict fix starts');
});

test('mergeability unknown for good: the tip-conflict hold reaches the owner on poll MERGEABLE_CAP, recorded as a capped wait', { skip }, async () => {
  const t = await stale('location', 'unknown');
  for (let i = 0; i < MERGEABLE_CAP + 2 && !decided(t).length; i++) {
    pollNow(t);
    await t.c.tick();
  }
  const d = decided(t).at(-1);
  assert.ok(d && !d.auto && d.reasons.some((r) => TIP_CONFLICT.test(r)), `held for the owner: ${JSON.stringify(d)}`);
  assert.ok(d.reasons.includes(`GitHub was still computing whether it can merge after ${MERGEABLE_CAP} polls`), d.reasons.join(' | '));
  assert.ok(t.f.log.read(0, ['wait.capped']).some((e) => (e.payload as { kind: string }).kind === 'mergeable_recheck'));
});

test("mergeability unknown: polls counted under the PR's number alone (another head's) don't count toward this head's cap", { skip }, async () => {
  const t = await stale('location', 'unknown', false, (t) => {
    const polls = (t.c as unknown as { waitPolls: { bump(k: string): number } }).waitPolls;
    for (let i = 0; i < MERGEABLE_CAP; i++) polls.bump(`mergeable:${t.opened.number}`);
  });
  assert.deepEqual(decided(t), []);
});

test('mergeability unknown, a tip-conflict hold beside another (a design change): decided for the owner at once, as main decides the other', { skip }, async () => {
  const t = await stale('location', 'unknown', true);
  const d = decided(t).at(-1);
  assert.ok(d && !d.auto && d.reasons.some((r) => TIP_CONFLICT.test(r)) && d.reasons.some((r) => !TIP_CONFLICT.test(r)), `decided: ${JSON.stringify(d)}`);
});

test('GitHub says clean while the merge into the tip conflicts on where a test file goes: held for the owner on that poll', { skip }, async () => {
  const t = await stale('location', 'clean');
  const d = decided(t).at(-1);
  assert.ok(d && !d.auto && d.reasons.some((r) => TIP_CONFLICT.test(r)), `held: ${JSON.stringify(d)}`);
});
