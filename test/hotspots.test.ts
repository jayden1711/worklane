import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOTSPOTS, estimateFiles, holdReason, hotspotsIn, pickDispatch } from '../src/hotspots.js';

const repo = ['package.json', 'package-lock.json', 'web/package-lock.json', 'src/price.ts', 'src/orders.ts', 'src/plugins/registry.ts', 'test/helpers.ts', 'tests/conftest.py', 'CHANGELOG.md', 'docs/guide.md', 'README.md'];

test('default hotspots: lockfiles, registries and changelogs, shared test helpers; ordinary code is not one', () => {
  assert.deepEqual(hotspotsIn(repo), ['CHANGELOG.md', 'package-lock.json', 'src/plugins/registry.ts', 'test/helpers.ts', 'tests/conftest.py', 'web/package-lock.json']);
  assert.ok(DEFAULT_HOTSPOTS.length > 0);
  assert.deepEqual(hotspotsIn(['src/price.ts', 'docs/guide.md', 'package.json']), []);
  assert.deepEqual(hotspotsIn(['src/price.ts'], ['src/**']), ['src/price.ts'], "a repo's own globs replace the defaults");
});

test('estimate: paths an issue names, by full path or a unique file name, matched against the repo', () => {
  const text = 'Totals in `src/price.ts` round wrong; also update registry.ts and the CHANGELOG.md. See docs/guide.md, not nonexistent/file.ts.';
  assert.deepEqual(estimateFiles(text, repo), ['CHANGELOG.md', 'docs/guide.md', 'src/plugins/registry.ts', 'src/price.ts']);
});

test('estimate: dependency work touches the lockfiles even when the issue never names them', () => {
  assert.deepEqual(estimateFiles('Upgrade the date library to v4.', repo), ['package-lock.json', 'web/package-lock.json']);
  assert.deepEqual(estimateFiles('Run npm install left-pad and use it.', repo), ['package-lock.json', 'web/package-lock.json']);
  assert.deepEqual(estimateFiles('Fix the rounding in totals.', repo), [], 'unknown: nothing guessed');
});

test('dispatch: a task sharing a hotspot with a running one waits, and the next ready task takes the free slot', () => {
  const running = [{ issue: 1, hotspots: ['package-lock.json'] }];
  const ready = [
    { issue: 2, hotspots: ['package-lock.json'] },
    { issue: 3, hotspots: [] },
    { issue: 4, hotspots: ['CHANGELOG.md'] },
  ];
  const r = pickDispatch(ready, running, 2);
  assert.deepEqual(r.start, [3, 4], 'no slot left idle');
  assert.deepEqual(r.held, [{ issue: 2, by: 1, files: ['package-lock.json'] }]);
  assert.equal(holdReason(r.held[0]!), 'waits for #1: both change package-lock.json');
});

test('dispatch: two ready tasks on the same hotspot never start together; unrelated work runs in parallel as before', () => {
  const r = pickDispatch(
    [
      { issue: 5, hotspots: ['test/helpers.ts'] },
      { issue: 6, hotspots: ['test/helpers.ts'] },
      { issue: 7, hotspots: [] },
    ],
    [],
    3,
  );
  assert.deepEqual(r.start, [5, 7]);
  assert.deepEqual(r.held.map((h) => [h.issue, h.by]), [[6, 5]]);
  assert.deepEqual(pickDispatch([{ issue: 8, hotspots: [] }, { issue: 9, hotspots: [] }], [{ issue: 1, hotspots: [] }], 2).start, [8, 9]);
  assert.deepEqual(pickDispatch([{ issue: 8, hotspots: [] }, { issue: 9, hotspots: [] }], [], 1).start, [8], 'the slot count still caps');
});
