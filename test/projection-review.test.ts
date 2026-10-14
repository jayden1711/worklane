// A PR-mode task: in review while its PR is open, done once the merge closes the issue; never "blocked".
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { project } from '../src/projection.js';

const SHA = 'a'.repeat(40);

test('projection: an open PR is in review, stays so when the claim is released, and is done when the merge closes the issue', () => {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'proj-')), 'events.db'));
  const status = () => project(log.read()).tasks.find((t) => t.issue === 7)!;
  log.append('issue.seen', { issue: 7, title: 'Totals', labels: ['ready'], author: 'o', owner: null, actionable: true, why: 'w' }, 't');
  log.append('issue.claimed', { issue: 7, instance: 'i', lease: SHA, base: SHA, owner: 'o' }, 't');
  log.append('land.result', { issue: 7, outcome: 'pr_opened', landed: null, detail: 'https://example.invalid/pr/1' }, 't');
  assert.deepEqual([status().status, status().blockedReason], ['in_review', null]);
  log.append('issue.released', { issue: 7, instance: 'i', why: 'pr opened' }, 't');
  assert.equal(status().status, 'in_review');
  log.append('issue.released', { issue: 7, instance: 'i', why: 'issue closed on GitHub' }, 't');
  assert.equal(status().status, 'done');
  log.close();
});
