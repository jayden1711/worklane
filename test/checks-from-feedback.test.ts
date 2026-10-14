import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { astGrepConfig, checkDraft, clusterSightings, constraintsView, constraintTerms, pathsIn, planProposals, proposalHistory, proposalPrBody, sameConstraint, sightingsFromEvents, type CheckMode } from '../src/checks-from-feedback.js';
import { ProjectConfig } from '../src/config/schema.js';
import { chatCorrections, correctionsFromEvents, correctionWords, prRejection, reviewCorrections } from '../src/corrections.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { FEEDBACK_CHECK_BRANCH_PREFIX, neverAutoMerge } from '../src/merge-policy.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

const WRITERS = ['example-owner', 'example-collaborator'];
const sha = (c: string) => c.repeat(40);
let id = 0;
const ev = (type: string, payload: object, ts = '2026-10-01T10:00:00Z') => ({ id: ++id, ts, type, payload });
/** A writer's review requesting changes, as the corrections pipeline records it. */
const review = (pr: number, body: string, ts = '2026-10-01T10:00:00Z', by = 'example-owner') => {
  const c = reviewCorrections({ pr, issue: pr - 10, title: `Task ${pr - 10}`, reviews: [{ id: pr * 100, author: by, state: 'CHANGES_REQUESTED', body, at: ts }], writers: WRITERS })[0]!;
  return ev('correction.recorded', { key: c.key, kind: c.kind, issue: c.issue, pr: c.pr, by: c.by, text: c.text }, ts);
};
const opened = (pr: number) => ev('pr.opened', { issue: pr - 10, number: pr, url: `https://github.com/acme/app/pull/${pr}`, head: sha('a'), draft: false });

test('correctionWords: only what the person said, from every kind of correction the pipeline records', () => {
  const r = reviewCorrections({ pr: 12, issue: 2, title: 'T', reviews: [{ id: 1, author: 'example-owner', state: 'CHANGES_REQUESTED', body: 'Don\'t call the payments client from a handler.', at: 'x' }], writers: WRITERS })[0]!;
  assert.equal(correctionWords(r), "Don't call the payments client from a handler.");
  const p = prRejection({ pr: 3, issue: 1, title: 'T', by: 'example-owner', comments: [{ author: 'example-owner', body: 'No raw SQL in handlers.' }, { author: 'example-owner', body: 'Use the query builder.' }], writers: WRITERS, at: 'x' })!;
  assert.equal(correctionWords(p), 'No raw SQL in handlers.\nUse the query builder.');
  const plan = correctionsFromEvents([ev('plan.decided', { issue: 4, decision: 'd1', answer: 'revise', by: 'example-owner', note: 'keep the old endpoint' }), ev('decision.asked', { id: 'q', kind: 'land', issue: 5, question: 'Land?' }), ev('decision.answered', { id: 'q', by: 'example-owner', answer: 'reject' })], WRITERS);
  assert.deepEqual(plan.map(correctionWords), ['keep the old endpoint', '']);
  const chat = chatCorrections([{ at: 'a', by: 'example-owner', question: 'what?', answer: 'x' }, { at: 'b', by: 'example-owner', question: 'correction: the cap is two', answer: 'ok' }], WRITERS)[0]!;
  assert.equal(correctionWords(chat), 'the cap is two');
  assert.equal(correctionWords({ kind: 'review_changes', text: '@x requested changes on PR #1 (issue #2: T).' }), '', 'a review with no body says nothing');
});

test('two similar review comments make one constraint with 2 sightings; a different one makes its own', () => {
  const events = [
    opened(11),
    opened(12),
    review(11, "Don't call the payments client from a request handler; go through the queue.", '2026-10-01T10:00:00Z'),
    review(12, 'Never call the payments client directly in a handler. Use the queue.', '2026-10-02T10:00:00Z'),
    review(13, 'Add a test for the rounding helper before changing it.', '2026-10-03T10:00:00Z'),
  ];
  const cs = clusterSightings(sightingsFromEvents(events, WRITERS));
  assert.equal(cs.length, 2);
  assert.deepEqual(cs[0]!.sightings.map((s) => s.pr), [11, 12]);
  assert.deepEqual(cs[0]!.sightings.map((s) => s.url), ['https://github.com/acme/app/pull/11', 'https://github.com/acme/app/pull/12']);
  assert.ok(cs[0]!.terms.includes('payment') && cs[0]!.terms.includes('handler'), cs[0]!.terms.join());
  assert.equal(cs[1]!.sightings.length, 1);
  // Stable: the same log gives the same ids.
  assert.deepEqual(clusterSightings(sightingsFromEvents(events, WRITERS)).map((c) => c.id), cs.map((c) => c.id));
});

test('constraintTerms and sameConstraint: no mentions, refs, links or stop words; stems meet; unrelated words never group', () => {
  assert.deepEqual([...constraintTerms('@bob please don\'t log the request bodies (#12, https://x.y/z)')].sort(), ['body', 'log', 'request'].sort());
  assert.equal(sameConstraint(constraintTerms('payments client in handlers'), constraintTerms('rounding helper needs tests')), false);
  assert.equal(sameConstraint(constraintTerms('no payments client in the handler'), constraintTerms('the handler must not import the payments client')), true);
});

test('reverts are evidence of the same work, never a sighting of their own; a short "no" is too little to group', () => {
  const events = [
    opened(11),
    review(11, 'Do not write migrations by hand; generate them with the schema tool.'),
    ev('merge.stopped', { reason: "main's required checks failed (test) after auto-merging #11", number: 11, sha: sha('b'), revert: 'https://github.com/acme/app/pull/30' }),
    ev('main_watch.unaccounted', { sha: sha('c'), url: 'u', reason: 'pushed directly', number: null, revert: 'https://github.com/acme/app/pull/31' }),
    review(14, 'No.'),
  ];
  const s = sightingsFromEvents(events, WRITERS);
  assert.deepEqual(s.filter((x) => x.source === 'revert').map((x) => x.url), ['https://github.com/acme/app/pull/30', 'https://github.com/acme/app/pull/31']);
  const cs = clusterSightings(s);
  assert.equal(cs.length, 1, 'the "No." groups with nothing and starts nothing; reverts start nothing');
  assert.equal(cs[0]!.sightings.length, 1);
  assert.deepEqual(cs[0]!.reverts.map((r) => r.url), ['https://github.com/acme/app/pull/30'], 'the revert of the same PR is attached');
});

test('plan objections and plan notes count straight from the log, with the corrections pipeline off; only writers', () => {
  const events = [
    ev('plan.decided', { issue: 4, decision: 'd1', answer: 'revise', by: 'example-owner', note: 'keep the public endpoint names stable' }),
    ev('plan.objected', { issue: 5, by: 'example-owner', why: 'public endpoint names must stay stable' }, '2026-10-02T10:00:00Z'),
    ev('plan.decided', { issue: 6, decision: 'd2', answer: 'reject', by: 'someone-else', note: 'public endpoint names stable' }),
  ];
  const cs = clusterSightings(sightingsFromEvents(events, WRITERS));
  assert.equal(cs.length, 1);
  assert.deepEqual(cs[0]!.sightings.map((s) => s.source), ['plan_revised', 'plan_objected']);
});

test('planProposals: 2+ sightings and not proposed before; one sighting waits; the weekly cap counts every attempt in 7 days', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const events = [review(11, 'Never call the payments client from a handler.'), review(12, 'Handlers must not call the payments client.'), review(13, 'Rounding goes through the money helper only.'), review(14, 'Use the money helper for rounding, not Math.round.'), review(15, 'Feature flags need an owner field.')];
  const cs = clusterSightings(sightingsFromEvents(events, WRITERS));
  assert.equal(cs.length, 3);
  const all = planProposals(cs, [], { minSightings: 2, maxPerWeek: 3, now });
  assert.equal(all.propose.length, 2);
  assert.match(all.held.find((h) => h.constraint === cs[2]!.id)!.why, /seen 1 time\(s\); a check is proposed from 2/);
  const capped = planProposals(cs, [], { minSightings: 2, maxPerWeek: 1, now });
  assert.deepEqual(capped.propose.map((c) => c.id), [cs[0]!.id]);
  assert.match(capped.held.find((h) => h.constraint === cs[1]!.id)!.why, /over the weekly cap of 1/);
  const history = proposalHistory([ev('feedback_check.dropped', { constraint: 'c-other', keys: ['x'], why: 'run failed', failed: true }, '2026-10-05T00:00:00Z')]);
  assert.equal(planProposals(cs, history, { minSightings: 2, maxPerWeek: 1, now }).propose.length, 0, 'a failed attempt this week counts too');
  assert.equal(planProposals(cs, history, { minSightings: 2, maxPerWeek: 1, now: new Date('2026-10-13T00:00:00Z') }).propose.length, 1, 'it ages out after 7 days');
  const done = proposalHistory([ev('feedback_check.proposed', { constraint: cs[0]!.id, keys: cs[0]!.sightings.map((s) => s.key), kind: 'pr', number: 40, url: 'u', mode: 'test', why: '' }, '2026-09-01T00:00:00Z')]);
  const again = planProposals(cs, done, { minSightings: 2, maxPerWeek: 3, now });
  assert.deepEqual(again.propose.map((c) => c.id), [cs[1]!.id], 'one proposal per constraint');
  assert.match(again.held.find((h) => h.constraint === cs[0]!.id)!.why, /already proposed as PR #40/);
  const dropped = proposalHistory([ev('feedback_check.dropped', { constraint: cs[0]!.id, keys: cs[0]!.sightings.map((s) => s.key), why: 'no check fits', failed: false }, '2026-09-01T00:00:00Z')]);
  assert.equal(planProposals(cs, dropped, { minSightings: 2, maxPerWeek: 3, now }).propose.some((c) => c.id === cs[0]!.id), false, 'dropped: not tried again on the same sightings');
  const third = clusterSightings(sightingsFromEvents([...events, review(16, 'The payments client is never called from a handler.')], WRITERS));
  assert.equal(planProposals(third, dropped, { minSightings: 2, maxPerWeek: 3, now }).propose.some((c) => c.id === cs[0]!.id), true, 'a new sighting tries again');
});

test('checkDraft: an ast-grep rule needs its fields and test cases, in the rule and test dirs only; a test proposal changes test files only', () => {
  const sg: CheckMode = { kind: 'ast-grep', ruleDir: 'rules', testDir: 'rule-tests', sgconfig: 'sgconfig.yml', addTestDir: false };
  const rule = { path: 'rules/no-pay.yml', status: 'A', content: 'id: no-pay\nlanguage: typescript\nrule:\n  pattern: payments.charge($$$)\nmessage: go through the queue\n' };
  const cases = { path: 'rule-tests/no-pay-test.yml', status: 'A', content: 'id: no-pay\nvalid:\n  - queue.push(x)\ninvalid:\n  - payments.charge(x)\n' };
  assert.deepEqual(checkDraft(sg, [rule, cases]), { ok: true });
  assert.match((checkDraft(sg, [rule]) as { why: string }).why, /no test cases for rule no-pay/);
  assert.match((checkDraft(sg, [rule, { ...cases, content: 'id: no-pay\nvalid: []\ninvalid:\n  - x\n' }]) as { why: string }).why, /no test cases/);
  assert.match((checkDraft(sg, [{ ...rule, content: 'id: no-pay\n' }, cases]) as { why: string }).why, /isn't an ast-grep rule/);
  assert.match((checkDraft(sg, [rule, cases, { path: 'src/pay.ts', status: 'M', content: '' }]) as { why: string }).why, /only rules\/ and rule-tests\/ may change/);
  assert.match((checkDraft(sg, [rule, { ...cases, status: 'D' }]) as { why: string }).why, /only adds or edits/);
  const add: CheckMode = { ...sg, addTestDir: true } as CheckMode;
  assert.match((checkDraft(add, [rule, cases]) as { why: string }).why, /names no test dir/);
  assert.deepEqual(checkDraft(add, [rule, cases, { path: 'sgconfig.yml', status: 'M', content: 'ruleDirs: [rules]\ntestConfigs:\n  - testDir: rule-tests\n' }]), { ok: true });
  assert.deepEqual(checkDraft({ kind: 'test' }, [{ path: 'test/no-pay.test.ts', status: 'A', content: 'x' }]), { ok: true });
  assert.match((checkDraft({ kind: 'test' }, [{ path: 'test/a.test.ts', status: 'A', content: '' }, { path: 'src/pay.ts', status: 'M', content: '' }]) as { why: string }).why, /only test files/);
  assert.match((checkDraft({ kind: 'test' }, []) as { why: string }).why, /no files/);
});

test('astGrepConfig and pathsIn', () => {
  assert.deepEqual(astGrepConfig('ruleDirs:\n  - ./rules/\ntestConfigs:\n  - testDir: rule-tests\n'), { ruleDir: 'rules', testDir: 'rule-tests' });
  assert.deepEqual(astGrepConfig('ruleDirs: [lint/rules]\n'), { ruleDir: 'lint/rules', testDir: null });
  assert.equal(astGrepConfig('utilDirs: [x]\n'), null);
  assert.equal(astGrepConfig(': : bad'), null);
  assert.deepEqual(pathsIn('Never edit `migrations/001_init.sql` or src/db/schema.ts, see config.yaml.'), ['migrations/001_init.sql', 'src/db/schema.ts', 'config.yaml']);
});

test('the PR body quotes every sighting and links the reverts; a check branch is never auto-merged', () => {
  const events = [opened(11), opened(12), review(11, 'Never call the payments client from a handler.'), review(12, 'Handlers must not call the payments client.'), ev('merge.stopped', { reason: 'checks failed after #12', number: 12, sha: sha('b'), revert: 'https://github.com/acme/app/pull/30' })];
  const c = clusterSightings(sightingsFromEvents(events, WRITERS))[0]!;
  const body = proposalPrBody({ c, mode: { kind: 'test' }, summary: 'A test that fails on it.', brand: 'Crew' });
  assert.match(body, /came up 2 times/);
  assert.match(body, /review requesting changes on \[PR #11\]\(https:\/\/github.com\/acme\/app\/pull\/11\), by @example-owner[\s\S]*> Never call the payments client from a handler\./);
  assert.match(body, /> Handlers must not call the payments client\./);
  assert.match(body, /Reverts of the same work[\s\S]*https:\/\/github.com\/acme\/app\/pull\/30.*checks failed after #12/);
  assert.match(body, /never merges this/);
  assert.match(neverAutoMerge({ branch: `${FEEDBACK_CHECK_BRANCH_PREFIX}${c.id}`, openedByHarness: true }).join(), /proposed from repeated feedback/);
  assert.deepEqual(neverAutoMerge({ branch: 'crew/issue-1', openedByHarness: true }), []);
});

test('config: off by default, twice, three a week', () => {
  const d = ProjectConfig.shape.checks_from_feedback.parse(undefined);
  assert.deepEqual(d, { enabled: false, min_sightings: 2, max_proposals_per_week: 3 });
  assert.throws(() => ProjectConfig.shape.checks_from_feedback.parse({ min_sightings: 1 }), 'a single sighting is never enough');
});

test('constraintsView: counts, links and state, sorted by count; off is said', () => {
  const events = [opened(11), opened(12), review(11, 'Never call the payments client from a handler.'), review(12, 'Handlers must not call the payments client.'), review(15, 'Feature flags need an owner field.')];
  const v = constraintsView(events, { writers: WRITERS, enabled: true, minSightings: 2, maxPerWeek: 3, now: new Date('2026-10-02T00:00:00Z') });
  assert.deepEqual(v.constraints.map((c) => [c.count, c.status]), [[2, 'due'], [1, 'watching']]);
  assert.deepEqual(v.constraints[0]!.sightings.map((s) => [s.ref, s.url]), [['PR #11', 'https://github.com/acme/app/pull/11'], ['PR #12', 'https://github.com/acme/app/pull/12']]);
  const proposed = [...events, ev('feedback_check.proposed', { constraint: v.constraints[0]!.id, keys: [], kind: 'pr', number: 40, url: 'https://github.com/acme/app/pull/40', mode: 'test', why: 'w' }, '2026-10-01T12:00:00Z')];
  const p = constraintsView(proposed, { writers: WRITERS, enabled: true, minSightings: 2, maxPerWeek: 3, now: new Date('2026-10-02T00:00:00Z') });
  assert.deepEqual([p.constraints[0]!.status, p.constraints[0]!.proposal, p.usedThisWeek], ['proposed_pr', { kind: 'pr', number: 40, url: 'https://github.com/acme/app/pull/40' }, 1]);
  const off = constraintsView(events, { writers: WRITERS, enabled: false, minSightings: 2, maxPerWeek: 3, now: new Date() });
  assert.match(off.constraints[0]!.detail, /checks from feedback is off/);
});

test('GET /api/constraints: the owner\'s and the writers\', anyone else is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-constraints-'));
  const log = new EventLog(join(dir, 'events.db'));
  for (const e of [opened(11), review(11, 'Never call the payments client from a handler.'), review(12, 'Handlers must not call the payments client.')]) log.append(e.type as Parameters<EventLog['append']>[0], e.payload as never, 'coordinator');
  log.close();
  const { dir: root } = exampleProject();
  for (const [user, status] of [['example-collaborator', 200], ['someone-else', 403]] as const) {
    const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots') });
    try {
      const r = await fetch(`${d.url.split('/?')[0]!}/api/constraints`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(user) } });
      assert.equal(r.status, status, user);
      const body = (await r.json()) as { constraints?: { count: number }[]; enabled?: boolean; error?: string };
      if (status === 200) assert.deepEqual([body.enabled, body.constraints!.map((c) => c.count)], [false, [2]]);
      else assert.match(body.error!, /^repeated feedback is for the instance's owners and writers/);
    } finally {
      await d.close();
    }
  }
});
