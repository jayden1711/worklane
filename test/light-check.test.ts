import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importsOf, lightCheckPlan, lightOutcome } from '../src/light-check.js';

const files = new Set(['src/price.ts', 'src/money/round.ts', 'src/money/index.ts', 'src/orders.js', 'lib/util.mjs', 'pkg/__init__.py', 'pkg/tax.py', 'pkg/sub/rates.py', 'app/main.py']);

test('no move on main, or the check off: merge at once', () => {
  assert.equal(lightCheckPlan({ enabled: true, mainChanged: [], prFiles: ['src/price.ts'], imports: {} }).action, 'merge-now');
  assert.equal(lightCheckPlan({ enabled: false, mainChanged: ['src/price.ts'], prFiles: ['src/price.ts'], imports: {} }).action, 'merge-now');
});

test('main moved on unrelated files: merge at once (no extra test run)', () => {
  const r = lightCheckPlan({ enabled: true, mainChanged: ['docs/a.md', 'src/orders.js'], prFiles: ['src/price.ts'], imports: { 'src/price.ts': ['src/money/round.ts'] } });
  assert.equal(r.action, 'merge-now');
  assert.match(r.why, /don't touch/);
});

test('main changed a file the PR changes, or one the PR\'s files import: verify the combined state', () => {
  const same = lightCheckPlan({ enabled: true, mainChanged: ['src/price.ts'], prFiles: ['src/price.ts'], imports: {} });
  assert.deepEqual(same.action === 'verify-combined' && same.overlap, ['src/price.ts']);
  const imported = lightCheckPlan({ enabled: true, mainChanged: ['src/money/round.ts', 'docs/x.md'], prFiles: ['src/price.ts'], imports: { 'src/price.ts': ['src/money/round.ts'] } });
  assert.deepEqual(imported.action === 'verify-combined' && imported.overlap, ['src/money/round.ts']);
});

test('JS/TS imports resolve relative specifiers, .js to .ts sources and index files; packages are ignored', () => {
  const src = `import { round } from './money/round.js';\nimport * as m from "./money";\nexport { x } from '../lib/util.mjs';\nconst o = require('./orders');\nimport 'react';\nconst lazy = await import('./money/round');`;
  assert.deepEqual(importsOf('src/price.ts', src, files), ['lib/util.mjs', 'src/money/index.ts', 'src/money/round.ts', 'src/orders.js']);
});

test('Python imports resolve relative and in-repo absolute modules; the standard library is ignored', () => {
  const src = 'import os\nfrom . import tax\nfrom .sub.rates import TABLE\nfrom pkg import tax as t\nimport pkg.sub.rates\n';
  assert.deepEqual(importsOf('pkg/__init__.py', src, files), ['pkg/sub/rates.py', 'pkg/tax.py']);
  assert.deepEqual(importsOf('app/main.py', 'from pkg.tax import rate\n', files), ['pkg/__init__.py', 'pkg/tax.py']);
  assert.deepEqual(importsOf('README.md', 'import x from "./y"', files), [], 'other languages import nothing');
});

test('the combined check merges the unchanged head when the fast tier passes; a conflicting merge is a conflict', () => {
  assert.equal(lightOutcome({ merged: true, fastPassed: true }), 'merge');
  assert.equal(lightOutcome({ merged: true, fastPassed: false }), 'hold');
  assert.equal(lightOutcome({ merged: false, fastPassed: null }), 'conflict');
});
