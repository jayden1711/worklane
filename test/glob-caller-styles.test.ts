// lint-test
// #1129 item 1 (R123c/R123d on #1123): flipping the glob style at these callers survived every test. Each caller's
// style is pinned here: by what a `?` slot does with a character outside the BMP where a project's glob can carry
// one, and by the call itself where the globs are the engine's own and hold no `?`.
// - allow (a match exempts, permits or lowers): the size skip, a study's editable paths, docs-only, read-denials'
//   `!` exceptions; a `?` matches only what both a UTF-16 unit and a character do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkChange, type Change } from '../src/experiments/proposal.js';
import { Study } from '../src/experiments/study.js';
import { sizeVerdict } from '../src/pr-rules.js';
import { repoRoot } from './helpers.js';

const ASTRAL = '\u{1F600}';

test('#1129: a generated-file glob with ? skips a one-character name only, never a two-unit one (allow)', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `l${i}`);
  const v = (path: string) => sizeVerdict([{ path, added: lines, removed: [] }], { maxLines: 10, generated: ['gen/?.js'] });
  assert.equal(v('gen/a.js').ok, true, 'a one-unit name is skipped');
  assert.equal(v(`gen/${ASTRAL}.js`).ok, false, 'a character outside the BMP in the ? slot is counted, as before #966');
});

test('#1129: a study editable glob with ? never lets a two-unit name in (allow)', () => {
  const study = Study.parse({
    id: 's',
    goal: 'g',
    metric: { name: 'm', direction: 'min', min_delta: 0.01 },
    eval: { predict: 'p', score: 's', files: ['eval/score.py'], predict_files: [], inputs: 'i', labels: 'l' },
    train: { command: 't', data: ['d'], env: { lockfile: 'uv.lock', build: 'b' } },
    editable: ['model/?.py'],
    config_schema: { lr: { type: 'number', min: 0, max: 1 } },
    budget: { gpu_hours_per_day: 1, agent_usd_per_day: 1, agent_usd_total: 1, max_jobs: 1 },
  });
  const ch = (path: string): Change => ({ path, oldMode: '100644', newMode: '100644', status: 'M' });
  assert.equal(checkChange([ch('model/a.py')], study).ok, true);
  assert.equal(checkChange([ch(`model/${ASTRAL}.py`)], study).ok, false);
});

test('#1129: docs-only and read-denials\' exceptions compile their globs as allow (their globs carry no ? to show it)', () => {
  const src = (f: string) => readFileSync(join(repoRoot, 'src', f), 'utf8');
  assert.match(src('pr-rules.ts'), /const DOCS_RES = DOCS_ONLY_GLOBS\.map\(\(g\) => globRegExp\(g, 'allow'\)\);/);
  const rd = src('read-denials.ts');
  assert.match(rd, /const negRes = neg\.map\(\(n\) => absRe\(n, 'allow'\)\);/);
  assert.match(rd, /const lateNegRes = lateNeg\.map\(\(n\) => absRe\(n, 'allow'\)\);/);
  // And nothing else in read-denials compiles an exception: every absRe call is one of these or a deny.
  const calls = [...rd.matchAll(/absRe\([^,]+, '(deny|allow)'\)/g)].map((m) => m[1]);
  assert.deepEqual(calls.filter((s) => s === 'allow').length, 2, calls.join(','));
});
