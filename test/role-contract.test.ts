// Every role's instructions are a contract: Own, Sources, Output, Approval, Failure, Never.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_PARTS, contractProblems, FAILURE_RULE } from '../src/role-contract.js';
import { defaultRolePrompt, defaultRoles } from '../src/roles.js';
import { RESEARCH_PROMPT } from '../src/research.js';
import { INTAKE_PROMPT } from '../src/intake/run.js';

// The prompts the runs actually get, besides the role table: the researcher's and intake's are read from it.
const prompts = (): [string, string][] => [...defaultRoles().map((r) => [r, defaultRolePrompt(r)] as [string, string]), ['researcher', RESEARCH_PROMPT], ['intake', INTAKE_PROMPT]];

test('every role prompt follows the contract (Own, Sources, Output, Approval, Failure, Never), with no exceptions', () => {
  // A new role (the gardener, the corrections agent) follows it from the start.
  for (const [role, prompt] of prompts()) assert.deepEqual(contractProblems(prompt), [], role);
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
