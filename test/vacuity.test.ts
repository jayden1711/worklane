import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkVacuity, countAssertions } from '../src/vacuity.js';
import { exampleProject } from './helpers.js';

const opts = { assertionPattern: '\\b(assert|expect)\\b', appPaths: ['src/**'], dynamic: true, runOne: 'node --test {file}' };

test('counts assertions, ignoring commented-out ones', () => {
  assert.equal(countAssertions('// assert.equal(1, 1)\n/* expect(x) */\nassert.ok(true)', '\\bassert\\b'), 1);
});

test('a real test that asserts on app code passes', () => {
  const { dir } = exampleProject();
  const r = checkVacuity(dir, 'test/price.test.js', opts);
  assert.equal(r.vacuous, false, r.why.join('; '));
  assert.deepEqual(r.touched, ['src/price.js']);
});

test('a test with no assertions is vacuous', () => {
  const { dir } = exampleProject();
  writeFileSync(join(dir, 'test', 'empty.test.js'), "import { test } from 'node:test';\nimport { totalCents } from '../src/price.js';\ntest('runs', () => { totalCents([]); });\n");
  const r = checkVacuity(dir, 'test/empty.test.js', opts);
  assert.equal(r.vacuous, true);
  assert.match(r.why.join(), /no assertion calls/);
});

test('a test that asserts but never executes app code is vacuous, even if it imports it', () => {
  const { dir } = exampleProject();
  writeFileSync(
    join(dir, 'test', 'fixture-only.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport '../src/price.js';\nconst fake = (a) => a * 2;\ntest('checks a fixture', () => { assert.equal(fake(2), 4); });\n",
  );
  const r = checkVacuity(dir, 'test/fixture-only.test.js', opts);
  assert.equal(r.vacuous, true);
  assert.match(r.why.join(), /executed no function under src/);
});
