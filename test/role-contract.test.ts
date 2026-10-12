// Every role's instructions are a contract: Own, Sources, Output, Approval, Failure, Never.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_PARTS, contractProblems, FAILURE_RULE } from '../src/role-contract.js';
import { defaultRolePrompt, defaultRoles } from '../src/roles.js';
import { RESEARCH_PROMPT } from '../src/research.js';
import { INTAKE_PROMPT } from '../src/intake/run.js';

/**
 * Roles not rewritten yet; each later rewrite removes its entry. Never add one: a new role (the gardener, the
 * corrections agent) must follow the contract from the start.
 */
const NOT_YET = new Set(['chief_of_staff', 'investigator', 'evaluator-repro', 'intake']);

const prompts = (): [string, string][] => [...defaultRoles().map((r) => [r, defaultRolePrompt(r)] as [string, string]), ['researcher', RESEARCH_PROMPT], ['intake', INTAKE_PROMPT]];

test('every role prompt follows the contract (Own, Sources, Output, Approval, Failure, Never), except the ones still to rewrite', () => {
  for (const [role, prompt] of prompts()) {
    if (NOT_YET.has(role)) continue;
    assert.deepEqual(contractProblems(prompt), [], role);
  }
});

test('the list of roles still to rewrite only shrinks: each one in it exists and does not follow the contract yet', () => {
  const all = new Map(prompts());
  for (const role of NOT_YET) {
    assert.ok(all.has(role), `${role} is a role`);
    assert.notDeepEqual(contractProblems(all.get(role)!), [], `${role} follows the contract now: take it off the list`);
  }
});

test('contractProblems: each part named, in order, with text, and the failure rule word for word', () => {
  const good = (over: Partial<Record<(typeof CONTRACT_PARTS)[number], string>> = {}) =>
    ['You are a role.', ...CONTRACT_PARTS.map((p) => `${p}: ${over[p] ?? (p === 'Failure' ? FAILURE_RULE : `${p} text.`)}`)].join('\n');
  assert.deepEqual(contractProblems(good()), []);
  assert.deepEqual(contractProblems(good({ Output: '\n- a bullet under it' })), [], 'text on the lines under the label counts');
  assert.deepEqual(contractProblems(good().replace(/^Sources:.*\n/m, '')), ['missing "Sources:"']);
  assert.deepEqual(contractProblems(good({ Never: '' })), ['"Never:" is empty']);
  assert.deepEqual(contractProblems(good({ Failure: 'Ask someone.' })), [`"Failure:" must state: ${FAILURE_RULE}`]);
  const swapped = good().replace('Own: Own text.', 'TMP').replace('Never: Never text.', 'Own: Own text.').replace('TMP', 'Never: Never text.');
  assert.match(contractProblems(swapped).join(), /out of order/);
});
