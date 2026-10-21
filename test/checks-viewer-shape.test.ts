// Issue #837: a viewer's check runs are built field by field from a per-role shape (src/checks-viewer.ts), so a
// field added to a check run later stays the owners' and writers' until someone adds it to the viewer's shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CheckRunView } from '../src/projection.js';
import { checkRunForViewer, checksFor, viewerCheckName, viewerStage, viewerStatus } from '../src/checks-viewer.js';

const run: CheckRunView = {
  id: 7,
  at: '2026-10-20T10:00:00.000Z',
  stage: 'verify',
  head: 'c'.repeat(40),
  checks: [{ check: 'npm test', status: 'fail', exitCode: 1, tail: 'TAIL-MARKER' }],
};

test("a viewer's check run is built field by field: a field added later stays the writers'", () => {
  const extra = { ...run, secretAddedLater: 'TAIL-MARKER', checks: [{ ...run.checks[0]!, alsoLater: 'TAIL-MARKER' }] } as unknown as CheckRunView;
  const v = checkRunForViewer(extra);
  assert.deepEqual(v, { id: 7, at: run.at, stage: 'verify', checks: [{ check: 'npm test', status: 'fail' }], forViewer: true });
  assert.doesNotMatch(JSON.stringify(v), /TAIL-MARKER|cccccccc/);
});

test('the shape is chosen by role: the owner and writers get the runs as they are; a viewer, an unknown role or none gets the least', () => {
  for (const role of ['owner', 'writer'] as const) assert.deepEqual(checksFor(role, [run]), [run], role);
  for (const role of ['viewer', 'auditor', null, undefined] as const) {
    const got = checksFor(role as Parameters<typeof checksFor>[0], [run]);
    assert.deepEqual(got, [checkRunForViewer(run)], String(role));
  }
});

test('stages, results and land-gate names a viewer gets: from a fixed list, anything else as the least it can say', () => {
  assert.deepEqual(['verify', 'land', 'no change', 'something-new', ''].map(viewerStage), ['verify', 'land', 'no change', 'check', 'check']);
  assert.deepEqual(['pass', 'fail', 'unavailable', 'skipped', 'exploded: /secret/path'].map(viewerStatus), ['pass', 'fail', 'unavailable', 'skipped', 'unknown']);
  // A land gate's name is "<tier>: <its verdict note>"; the note (counts, main's baseline commit) is the writers'.
  assert.equal(viewerCheckName('land', 'unit: no new failures; 2 already failing on main (deadbee1)'), 'unit');
  assert.equal(viewerCheckName('land', 'no colon here'), 'land gate', 'a land name not in the known form: no part of it');
  assert.equal(viewerCheckName('land', ': leading'), 'land gate');
  assert.equal(viewerCheckName('verify', 'npm test'), 'npm test');
  assert.equal(viewerCheckName('no change', 'npm run unit (baseline gate)'), 'npm run unit (baseline gate)');
  // A stage this code doesn't know: no part of its names either.
  assert.equal(viewerCheckName('something-new', 'unit: TAIL-MARKER'), 'check');
  assert.deepEqual(checkRunForViewer({ ...run, stage: 'something-new', checks: [{ check: 'x: TAIL-MARKER', status: 'pass', exitCode: 0, tail: null }] }).checks, [{ check: 'check', status: 'pass' }]);
});
