// P1 item 8b: the projection must not show a PR-mode task whose PR was opened as "blocked".
import '../isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../../src/projection.js';
import { openPr, skip } from './harness.js';

test('projection: a PR-mode task whose PR is open is not shown as blocked', { skip }, async () => {
  const t = await openPr();
  const task = project(t.f.log.read()).tasks.find((x) => x.issue === t.n);
  assert.ok(task, 'the task is projected');
  assert.ok(task.status !== 'blocked', `a task whose PR was opened is not "blocked"; got status=${task.status}, blockedReason=${JSON.stringify(task.blockedReason)}`);
});
