import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/load.js';
import type { StoredEvent } from '../src/events/types.js';
import { PolicyFile } from '../src/instance.js';
import { mergeDecision, type MergeInput } from '../src/merge-policy.js';
import { buildReport } from '../src/reports.js';
import { computeLevel } from '../src/review.js';
import { rolePrompt, VERDICT_SCHEMA } from '../src/roles.js';
import { exampleProject } from './helpers.js';

const cfg = loadConfig(exampleProject().dir);
const review = cfg.review!;
const level = (paths: string[]) => computeLevel({ files: paths.map((path) => ({ path, added: 1, removed: 0 })), labels: [], moneyPaths: [] }, review);

/** A change the policy merges: everything clean. Each test turns one thing. */
function clean(over: Partial<MergeInput> = {}): MergeInput {
  return {
    policyOn: true,
    repoOn: true,
    stopped: null,
    level: level(['src/price.js']),
    waitCategories: [...review.levels.L3_human.when, 'ci-config'],
    limits: { max_lines: 400, max_files: 10 },
    lines: 12,
    files: 1,
    verdict: { patch_correct: true, test_correct: true, confidence: 'high', design_change: false },
    newTopLevel: [],
    ciFixRuns: 0,
    foreignPush: false,
    pushLimitHit: false,
    ...over,
  };
}

test('merge policy: a clean change merges', () => {
  assert.deepEqual(mergeDecision(clean()), { auto: true, reasons: [] });
});

test('merge policy: the kill switch, the repo switch and a stop each make every PR wait', () => {
  assert.deepEqual(mergeDecision(clean({ policyOn: false })).reasons, ['auto-merge is off for this instance (policy.yaml auto_merge)']);
  assert.deepEqual(mergeDecision(clean({ repoOn: false })).reasons, ['auto-merge is off for this repo (review.yaml merge.auto)']);
  assert.match(mergeDecision(clean({ stopped: 'main went red after #4' })).reasons.join(), /auto-merge is stopped: main went red after #4/);
});

test('merge policy: high-risk paths wait (L3 categories, CI config, and the repo’s own categories)', () => {
  for (const [path, cat] of [
    ['.worklane/config.yaml', 'harness-config'],
    ['.claude/settings.json', 'harness-config'],
    ['.github/dependabot.yml', 'ci-config'],
    ['.github/workflows/ci.yml', 'deploy-config'],
    ['src/auth/login.js', 'auth'],
    ['db/migrations/002.sql', 'migration'],
    ['config/credentials.json', 'secrets'],
  ] as const) {
    const d = mergeDecision(clean({ level: level([path]) }));
    assert.equal(d.auto, false, path);
    assert.match(d.reasons.join(), new RegExp(`high-risk: ${cat} \\(${path.replace(/\./g, '\\.')}`), path);
  }
  const custom = computeLevel({ files: [{ path: 'src/price.js', added: 1, removed: 0 }], labels: [], moneyPaths: [] }, { ...review, categories: { pricing: ['src/price.js'] } });
  assert.match(mergeDecision(clean({ level: custom, waitCategories: ['pricing'] })).reasons.join(), /high-risk: pricing \(src\/price\.js\)/);
});

test('merge policy: anything deleting data waits', () => {
  const l = computeLevel({ files: [{ path: 'src/cleanup.js', added: 1, removed: 0, addedLines: ['db.exec("DELETE FROM orders")'] }], labels: [], moneyPaths: [] }, review);
  assert.match(mergeDecision(clean({ level: l })).reasons.join(), /high-risk: deletes-data/);
});

test("merge policy: design-level waits: the evaluator's flag is binding, dependencies and new top-level modules are seen in code", () => {
  assert.match(mergeDecision(clean({ verdict: { patch_correct: true, test_correct: true, confidence: 'high', design_change: true, design_reason: 'new CLI flag' } })).reasons.join(), /design: the evaluator flagged a design change: new CLI flag/);
  for (const p of ['package.json', 'pyproject.toml', 'requirements-dev.txt', 'sub/Cargo.toml']) assert.match(mergeDecision(clean({ level: level([p]) })).reasons.join(), /design: dependency manifests change/, p);
  assert.match(mergeDecision(clean({ newTopLevel: ['plugins/'] })).reasons.join(), /design: new top-level module \(plugins\/\)/);
});

test('merge policy: big changes wait, by lines or files; at the limit they merge', () => {
  assert.equal(mergeDecision(clean({ lines: 400, files: 10 })).auto, true);
  assert.deepEqual(mergeDecision(clean({ lines: 401 })).reasons, ['big: 401 changed lines (over 400)']);
  assert.deepEqual(mergeDecision(clean({ files: 11 })).reasons, ['big: 11 files (over 10)']);
});

test('merge policy: any doubt waits', () => {
  const v = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };
  const cases: [Partial<MergeInput>, RegExp][] = [
    [{ verdict: null }, /no evaluator verdict/],
    [{ verdict: { ...v, confidence: 'medium' } }, /evaluator confidence medium/],
    [{ verdict: { ...v, patch_correct: false } }, /did not approve the patch/],
    [{ verdict: { ...v, test_correct: false } }, /doubts the test/],
    [{ verdict: { ...v, unread: ['src/a.js'] } }, /did not read src\/a\.js/],
    [{ verdict: { patch_correct: true, test_correct: true, confidence: 'high' } }, /gave no design-change answer/],
    [{ ciFixRuns: 1 }, /1 CI fix run\(s\) on this PR/],
    [{ foreignPush: true }, /someone other than the harness pushed/],
    [{ pushLimitHit: true }, /hit a push limit/],
  ];
  for (const [over, re] of cases) {
    const d = mergeDecision(clean(over));
    assert.equal(d.auto, false, String(re));
    assert.match(d.reasons.join(), re);
  }
});

test('the kill switch defaults to off in an instance policy', () => {
  assert.equal(PolicyFile.parse({ version: 1, budget: { daily_usd: 5 } }).auto_merge, false);
});

test("the evaluator must answer design_change, and is told it's binding", () => {
  assert.ok((VERDICT_SCHEMA.required as readonly string[]).includes('design_change'));
  assert.match(rolePrompt('/nonexistent', 'evaluator-verdict'), /design_change: .*binding/);
});

const ev = (id: number, type: string, payload: object, ts: string): StoredEvent => ({ id, ts, type, payload, instance: 'i', source: 'coordinator' }) as unknown as StoredEvent;

test("report: the spend line is labelled as the CLI's estimate, not billed money", () => {
  const now = new Date('2026-10-10T18:05:00Z');
  const r = buildReport([ev(1, 'run.cost', { issue: 1, role: 'worker', model: 'm', usd: 1.5, turns: 3 }, '2026-10-10T17:00:00Z')], cfg, { since: new Date('2026-10-10T08:00:00Z'), now, slot: '18:00' });
  assert.match(r.markdown, /\*\*Spend\*\* \(the CLI's cost estimate, not billed money\): ~\$1\.50 since the last report/);
});

test('report: the daily digest lists the last 24 h of auto-merges with links, once a day; a stop is always shown', () => {
  const merged = ev(1, 'merge.done', { issue: 3, number: 9, head: 'a'.repeat(40), sha: 'b'.repeat(40), url: 'https://example.com/pull/9', title: 'Fix totals' }, '2026-10-10T02:00:00Z');
  const old = ev(2, 'merge.done', { issue: 4, number: 7, head: 'a'.repeat(40), sha: 'c'.repeat(40), url: 'https://example.com/pull/7', title: 'Old' }, '2026-10-08T02:00:00Z');
  const now = new Date('2026-10-10T08:05:00Z');
  const first = buildReport([old, merged], cfg, { since: new Date('2026-10-09T18:00:00Z'), now, slot: cfg.project.reports.times[0]! }).markdown;
  assert.match(first, /\*\*Auto-merged, last 24 h\*\* \(1\)\n- \[#9\]\(https:\/\/example\.com\/pull\/9\) Fix totals `bbbbbbbb`/);
  assert.doesNotMatch(first, /#7/);
  const second = buildReport([merged], cfg, { since: now, now: new Date('2026-10-10T18:05:00Z'), slot: '18:00' }).markdown;
  assert.doesNotMatch(second, /Auto-merged/, 'once a day');
  const stopped = ev(3, 'merge.stopped', { reason: 'main went red after #9', number: 9, sha: 'b'.repeat(40), revert: null }, '2026-10-10T12:00:00Z');
  assert.match(buildReport([merged, stopped], cfg, { since: now, now: new Date('2026-10-10T18:05:00Z'), slot: '18:00' }).markdown, /\*\*Auto-merge stopped\*\*: main went red after #9/);
  const resumed = ev(4, 'merge.resumed', { detail: 'cleared' }, '2026-10-10T13:00:00Z');
  assert.doesNotMatch(buildReport([merged, stopped, resumed], cfg, { since: now, now: new Date('2026-10-10T18:05:00Z'), slot: '18:00' }).markdown, /Auto-merge stopped/);
});
