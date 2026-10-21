// Issue #798: harness-config (the config folder, where tests.yaml says what a project command runs and with what
// environment; .claude/**; CLAUDE.md) was L3 only because the default review.yaml lists it. A repo's review.yaml could
// drop it from L3_human, or redefine its globs to nothing, and a change to tests.yaml would merge without a human.
// Now it is locked in code like self-modification: always L3, always waits, its built-in globs always hold, and a
// repo may only add to them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from '../src/brand.js';
import { ReviewConfig } from '../src/config/schema.js';
import { computeLevel, type ChangeFile } from '../src/review.js';
import { waitCategoriesOf, whyHighRisk } from '../src/merge-policy.js';

const loosened = (categories: Record<string, string[]>) =>
  ReviewConfig.parse({
    version: 1,
    levels: {
      L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 },
      L1_evaluator: { when: ['ui', 'app-non-money'], max_lines: 400, max_files: 10 },
      L2_notify: { when: ['app-non-money-large'] },
      // harness-config left out of L3, and (below) its globs redefined.
      L3_human: { when: ['money-path'], over_lines: 800 },
    },
    categories,
    merge: { auto: true, wait_categories: [] },
  });
const f = (path: string): ChangeFile => ({ path, added: 3, removed: 1 });
const level = (path: string, cfg: ReviewConfig, scope: 'engine' | 'managed-app' | undefined = undefined) => computeLevel({ files: [f(path)], labels: [], moneyPaths: [], scope }, cfg);

for (const scope of [undefined, 'managed-app'] as const) {
  test(`a repo's review.yaml can't lower harness-config: tests.yaml, .claude/ and CLAUDE.md stay L3 and wait (${scope ?? 'engine'})`, () => {
    for (const categories of [{}, { 'harness-config': [] }, { 'harness-config': ['nothing/**'] }]) {
      const cfg = loosened(categories);
      for (const path of [`${BRAND.configDir}/tests.yaml`, '.claude/settings.json', 'CLAUDE.md']) {
        const r = level(path, cfg, scope);
        assert.equal(r.level, 'L3', `${path} with ${JSON.stringify(categories)}: ${r.reasons.join('; ')}`);
        assert.ok(r.categories['harness-config']?.includes(path), `${path} not harness-config`);
        const waits = waitCategoriesOf(cfg);
        assert.ok(waits.includes('harness-config'), `harness-config doesn't wait: ${waits.join(', ')}`);
        assert.ok(whyHighRisk({ level: r, waitCategories: waits }).some((w) => w.category === 'harness-config'), `${path}: not named high-risk`);
      }
    }
  });
}

test('a repo may still add its own paths to harness-config; they are L3 too', () => {
  const r = level('ops/harness/runner.yaml', loosened({ 'harness-config': ['ops/harness/**'] }));
  assert.equal(r.level, 'L3', r.reasons.join('; '));
  assert.ok(r.categories['harness-config']?.includes('ops/harness/runner.yaml'));
  assert.ok(level(`${BRAND.configDir}/tests.yaml`, loosened({ 'harness-config': ['ops/harness/**'] })).categories['harness-config']?.length, 'the built-in globs still hold beside them');
});
