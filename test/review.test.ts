import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewConfig } from '../src/config/schema.js';
import { computeLevel, loadMoneyPaths, type ChangeFile } from '../src/review.js';

const cfg = ReviewConfig.parse({
  version: 1,
  levels: {
    L0_auto: { when: ['docs-only', 'tests-only', 'comments', 'copy'], max_lines: 200 },
    L1_evaluator: { when: ['ui', 'app-non-money'], max_lines: 400, max_files: 10 },
    L2_notify: { when: ['app-non-money-large', 'dependency', 'test-machinery'] },
    L3_human: { when: ['money-path', 'migration', 'auth', 'secrets', 'deploy-config', 'release-config', 'harness-config', 'guardrail-config', 'deletes-data'], over_lines: 800 },
  },
});
const money = [/^server\/(ledger|escrow)\//, /^shared\//];
const f = (path: string, added = 10, removed = 0, addedLines?: string[]): ChangeFile => ({ path, added, removed, ...(addedLines ? { addedLines } : {}) });
const level = (files: ChangeFile[], extra: Partial<Parameters<typeof computeLevel>[0]> = {}) => computeLevel({ files, labels: [], moneyPaths: money, ...extra }, cfg);

test('docs and tests only, small: L0; large: L1', () => {
  assert.equal(level([f('docs/a.md'), f('test/a.test.js')]).level, 'L0');
  assert.equal(level([f('docs/a.md', 300)]).level, 'L1');
});

test('non-money app code: L1; large: L2', () => {
  assert.equal(level([f('web/page.jsx'), f('test/page.test.js')]).level, 'L1');
  assert.equal(level([f('web/page.jsx', 500)]).level, 'L2');
  assert.equal(level(Array.from({ length: 11 }, (_, i) => f(`web/c${i}.jsx`, 1))).level, 'L2');
});

test('money path, migrations, deploy and harness config: L3, with reasons', () => {
  const r = level([f('server/escrow/settle.js', 3)]);
  assert.equal(r.level, 'L3');
  assert.ok(r.reasons.some((x) => x.startsWith('money-path: server/escrow/settle.js')));
  assert.equal(level([f('prisma/migrations/2026_x/migration.sql')]).level, 'L3');
  assert.equal(level([f('.github/workflows/ci.yml')]).level, 'L3');
  assert.equal(level([f('.worklane/guardrails.yaml')]).level, 'L3');
  assert.equal(level([f('web/a.jsx', 900)]).level, 'L3', 'over 800 lines');
});

test('data deletion in added lines is L3 wherever it appears', () => {
  assert.equal(level([f('scripts/cleanup.js', 2, 0, ["await db.$executeRaw`DELETE FROM sessions`"])]).level, 'L3');
});

test('dependency bumps and test machinery: L2', () => {
  assert.equal(level([f('package.json', 1, 1), f('package-lock.json', 40, 30)]).level, 'L2');
  assert.equal(level([f('scripts/build.mjs')]).level, 'L2');
});

test('a failed or low-confidence verdict bumps one level; an agent can raise but not lower', () => {
  const ok = { patch_correct: true, test_correct: true, confidence: 'high' as const };
  assert.equal(level([f('web/a.jsx')], { verdict: ok }).level, 'L1');
  assert.equal(level([f('web/a.jsx')], { verdict: { ...ok, confidence: 'low' } }).level, 'L2');
  assert.equal(level([f('web/a.jsx')], { verdict: { ...ok, patch_correct: false } }).level, 'L2');
  assert.equal(level([f('server/escrow/a.js')], { verdict: { ...ok, patch_correct: false } }).level, 'L3', 'capped at L3');
  assert.equal(level([f('web/a.jsx')], { requested: 'L3' }).level, 'L3');
  assert.equal(level([f('server/escrow/a.js')], { requested: 'L0' }).level, 'L3', 'cannot lower');
});

test('money paths load from the project source of truth (regex literals in a JS list)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-'));
  writeFileSync(join(dir, 'plan.js'), "const OTHER = [/^nope\\//];\nconst MONEY = [\n  /^server\\/(ledger|sweep)\\//,\n  /^shared\\//,\n];\n");
  const res = loadMoneyPaths(dir, { file: 'plan.js', pattern: 'const MONEY = \\[([\\s\\S]*?)\\];' });
  assert.equal(res.length, 2);
  assert.ok(res[0]!.test('server/sweep/x.js') && !res[0]!.test('server/games/x.js'));
  assert.ok(!res.some((r) => r.test('nope/x')), 'only the MONEY list');
});
