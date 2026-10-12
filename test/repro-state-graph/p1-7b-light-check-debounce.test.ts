// P1 item 7b: light (combined-state) checks are debounced: main moving three times in a few seconds does not
// start three fast-tier runs for one PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { approve, changeOnMain, green, openPr, skip, waitForCount } from './harness.js';

test('combined check: three quick moves of main on a file the PR changes start at most two light checks, not one per move', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  const moves = 3;
  changeOnMain(t, join('src', 'price.js'), (s) => `${s}\n// note 1 from main\n`);
  await green(t);
  for (let k = 2; k <= moves; k++) {
    assert.equal(await waitForCount(t.f.log, 'light_check.finished', k - 1), k - 1, `light check ${k - 1} finished`);
    changeOnMain(t, join('src', 'price.js'), (s) => `${s}\n// note ${k} from main\n`);
    await t.c.tick();
  }
  await waitForCount(t.f.log, 'light_check.finished', moves);
  const started = t.f.log.read(0, ['light_check.started']).length;
  assert.ok(started < moves, `${moves} moves of main within seconds start fewer than ${moves} light checks (a debounce); got ${started}`);
});
