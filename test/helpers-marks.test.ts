// The cross-instance leak checks' markers (helpers.ts marksOf): a marker number matches only as a whole number.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marksOf } from './helpers.js';

const b = { project: 'beta-proj', actor: 'wl-beta@host', issue: 9201, pr: 9270, run: 'tr-beta-1', title: 'Beta-only' };

test("marksOf: a marker number inside a larger number (a byte count) isn't a leak; the number itself, and every text marker, is", () => {
  const leak = marksOf(b);
  assert.doesNotMatch('{"availableBytes":15381192704}', leak, 'b\'s PR 9270 inside a byte count');
  assert.doesNotMatch('{"pid":192013}', leak, 'b\'s issue 9201 inside a larger number');
  for (const hit of ['#9270', '"pr":9270,', 'issue 9201', '9202', '[9203]', 'tr-beta-1', 'beta-proj', 'wl-beta@host', 'Beta-only']) assert.match(hit, leak, hit);
});

test('exampleProject repos run no background git maintenance or auto-gc, so tree walks never race a vanishing lock file', async () => {
  const { exampleProject } = await import('./helpers.js');
  const { execFileSync } = await import('node:child_process');
  const { dir } = exampleProject();
  const get = (k: string) => execFileSync('git', ['config', '--get', k], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(get('maintenance.auto'), 'false');
  assert.equal(get('gc.auto'), '0');
});
