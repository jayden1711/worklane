// #471: the evaluator's confidence is calibrated and always explained. A confidence other than high without a reason
// is refused (the evaluator is asked once more); the reason reaches the merge hold; a change to a protected surface
// gets the "compromised component" question for every actor, and a missing or unacceptable answer is a doubt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDecision, type MergeInput } from '../src/merge-policy.js';
import { computeLevel } from '../src/review.js';
import { COMPROMISED_ACTORS, rolePrompt, VERDICT_SCHEMA } from '../src/roles.js';
import { calibrated, compromisedDoubts, protectedBrief, verdictRefusal } from '../src/verdict-confidence.js';
import { loadConfig } from '../src/config/load.js';
import { BRAND } from '../src/brand.js';
import { exampleProject } from './helpers.js';

const every = (over: Partial<Record<string, { acceptable?: boolean; can_do?: string; why?: string }>> = {}) =>
  COMPROMISED_ACTORS.map(([actor]) => ({ actor, can_do: 'nothing: it cannot reach this file', acceptable: true, why: 'only the owner merges it', ...over[actor] }));

test('the schema requires confidence_reason and gives confidence its rubric; the prompt states it', () => {
  assert.ok((VERDICT_SCHEMA.required as readonly string[]).includes('confidence_reason'));
  const conf = VERDICT_SCHEMA.properties.confidence;
  assert.match(conf.description, /high: you read every changed file in full.*medium: one specific thing is unverified.*low: you found a likely problem/);
  const p = rolePrompt('/nonexistent', 'evaluator-verdict');
  assert.match(p, /A small, fully verified change is high/);
  assert.match(p, /confidence_reason: whenever confidence isn't high/);
  assert.match(p, /compromised_component, when the brief says the change touches a PROTECTED SURFACE/);
  assert.deepEqual(VERDICT_SCHEMA.properties.compromised_component.items.properties.actor.enum, [...COMPROMISED_ACTORS.map(([k]) => k), 'other']);
});

const claims = [{ claim: 'read the diff', label: 'measured', basis: 'git diff' }];

test('a confidence other than high without a reason is refused; with one, or high, it is accepted', () => {
  for (const confidence of ['medium', 'low']) {
    assert.match(verdictRefusal({ confidence, claims })!, new RegExp(`confidence ${confidence} needs confidence_reason`));
    assert.ok(verdictRefusal({ confidence, confidence_reason: '   ', claims }), 'blank is no reason');
    assert.equal(verdictRefusal({ confidence, confidence_reason: 'the zero-quantity case has no test', claims }), null);
  }
  assert.equal(verdictRefusal({ confidence: 'high', claims }), null);
  assert.equal(verdictRefusal({ confidence: 'high', confidence_reason: '', claims }), null);
});

test('the recorded confidence always has its reason when it is not high', () => {
  assert.deepEqual(calibrated({ confidence: 'high', unverified: 0, compromised: [] }), { confidence: 'high' });
  assert.deepEqual(calibrated({ confidence: 'high', reason: 'stray text', unverified: 0, compromised: [] }), { confidence: 'high' }, 'high keeps no reason');
  assert.deepEqual(calibrated({ confidence: 'medium', reason: 'the zero case is untested', unverified: 0, compromised: [] }), { confidence: 'medium', confidence_reason: 'the zero case is untested' });
  assert.deepEqual(calibrated({ confidence: 'medium', reason: '', unverified: 0, compromised: [] }), { confidence: 'medium', confidence_reason: 'the evaluator gave no reason for confidence medium, even when asked again' });
  assert.deepEqual(calibrated({ confidence: 'high', unverified: 2, compromised: [] }), { confidence: 'medium', confidence_reason: 'lowered: 2 unverified claim(s)' });
  assert.deepEqual(calibrated({ confidence: 'high', unverified: 0, compromised: ['compromised component: no answer for a hub viewer'] }), { confidence: 'medium', confidence_reason: 'compromised component: no answer for a hub viewer' });
  assert.deepEqual(calibrated({ confidence: 'low', reason: 'likely off by one', unverified: 1, compromised: ['c'] }), { confidence: 'low', confidence_reason: 'likely off by one; lowered: 1 unverified claim(s); c' });
});

test('compromised component: no question off a protected surface; every actor answered and acceptable passes; a missing or unacceptable answer is a doubt', () => {
  assert.deepEqual(compromisedDoubts(undefined, false), []);
  assert.deepEqual(compromisedDoubts(every(), true), []);
  const none = compromisedDoubts(undefined, true);
  assert.equal(none.length, 1);
  for (const [, words] of COMPROMISED_ACTORS) assert.ok(none[0]!.includes(words), `${words} named as unanswered`);
  assert.deepEqual(compromisedDoubts(every().filter((a) => a.actor !== 'hub-viewer'), true), ['compromised component: no answer for a hub viewer']);
  assert.deepEqual(compromisedDoubts(every({ 'local-os-user': { why: ' ' } }), true), ['compromised component: no answer for a local OS user'], 'an answer without its why is no answer');
  assert.deepEqual(compromisedDoubts(every({ 'agent-user': { acceptable: false, can_do: 'rewrite the merge rules', why: 'the file is writable by the agent' } }), true), [
    'compromised component: the agent user (the account agents run as) can rewrite the merge rules, which is not acceptable: the file is writable by the agent',
  ]);
  assert.deepEqual(compromisedDoubts([...every(), { actor: 'other', can_do: 'read the token from the URL', acceptable: false, why: 'a proxy logs it' }], true), ['compromised component: other can read the token from the URL, which is not acceptable: a proxy logs it']);
  const brief = protectedBrief(['changes the CI config: .github/workflows/ci.yml']);
  assert.match(brief, /^PROTECTED SURFACE: this change changes the CI config: \.github\/workflows\/ci\.yml\./);
  for (const [k, words] of COMPROMISED_ACTORS) assert.ok(brief.includes(`${k}: ${words}`), k);
});

const cfg = loadConfig(exampleProject().dir);
const review = cfg.review!;
function clean(over: Partial<MergeInput> = {}): MergeInput {
  return {
    branch: `${BRAND.cli}/issue-7`,
    openedByHarness: true,
    policyOn: true,
    repoOn: true,
    stopped: null,
    level: computeLevel({ files: [{ path: 'src/price.js', added: 1, removed: 0 }], labels: [], moneyPaths: [] }, review),
    waitCategories: [...review.levels.L3_human.when, 'ci-config'],
    limits: { max_lines: 400, max_files: 10 },
    lines: 2,
    files: 1,
    verdict: { patch_correct: true, test_correct: true, confidence: 'high', design_change: false, advice: '' },
    newTopLevel: [],
    ciFixRuns: 0,
    foreignPush: false,
    pushLimitHit: false,
    ...over,
  };
}

test("the merge hold says why the evaluator wasn't confident, and carries its advice", () => {
  const v = clean().verdict!;
  const held = mergeDecision(clean({ verdict: { ...v, confidence: 'medium', confidence_reason: 'the zero-quantity case has no test', advice: 'add a test for qty 0' } }));
  assert.deepEqual(held.reasons, ['doubt: evaluator confidence medium: the zero-quantity case has no test']);
  assert.equal(held.advice, 'add a test for qty 0');
  assert.deepEqual(mergeDecision(clean({ verdict: { ...v, confidence: 'low' } })).reasons, ['doubt: evaluator confidence low: no reason recorded'], 'an older verdict with no reason says so');
  const ok = mergeDecision(clean({ verdict: { ...v, advice: 'consider renaming qty' } }));
  assert.equal(ok.auto, true);
  assert.equal(ok.advice, undefined, 'advice only when the verdict is why it waits');
  assert.equal(mergeDecision(clean({ lines: 401, verdict: { ...v, advice: 'nit' } })).advice, undefined, 'nor when it waits for something else');
});
