// The tool guard's resolver (src/guardrails/reach.ts, #972): where a written path really leads, and null, never a
// guess, when that can't be told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asWritten, MAX_LINKS, Reach, STEP_LIMIT } from '../src/guardrails/reach.js';

function dir() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'reach-')));
  mkdirSync(join(d, 'a/b'), { recursive: true });
  return d;
}

test('reach: parts are taken in order, from where the path has really got to', () => {
  const d = dir();
  symlinkSync('a/b', join(d, 'down'));
  symlinkSync('a/missing/file', join(d, 'pending'));
  const r = new Reach();
  assert.equal(r.of(asWritten(d, 'down/../x')), join(d, 'a/x'));
  assert.equal(r.of(asWritten(d, 'pending')), join(d, 'a/missing/file'));
  assert.equal(r.of(asWritten(d, 'new/dir/../f')), join(d, 'new/f'));
  assert.equal(r.of(join(d, 'a/./b/')), join(d, 'a/b'));
  assert.equal(r.of('relative/path'), null, 'only an absolute path is resolved');
});

test('reach: too many links, or a spent budget, can not be told', () => {
  const d = dir();
  for (let i = 0; i <= MAX_LINKS; i++) symlinkSync(i === MAX_LINKS ? 'a' : `n${i + 1}`, join(d, `n${i}`));
  assert.equal(new Reach().of(join(d, 'n0/b')), null);
  assert.equal(new Reach().of(join(d, 'n1/b')), join(d, 'a/b'), 'exactly the limit still resolves');
  let t = 0;
  const late = new Reach(() => t, 10);
  t = 11;
  assert.equal(late.of(join(d, 'a/b')), null, 'past the time budget');
  const deep = new Reach();
  assert.equal(deep.of(`/${'x/'.repeat(STEP_LIMIT + 1)}`), null, 'past the step budget');
});
