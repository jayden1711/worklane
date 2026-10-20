// The value report (#708): PRs the engine merged on its own vs held, held reasons by kind, what became of the held
// ones, the hours-saved estimate (labeled, with its formula), and what went wrong after merges. Owners and writers
// only. Event fixtures, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { ConfigInvalid, loadConfig } from '../src/config/load.js';
import { autoMergeState, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { initInstance, loadInstance, readPolicy } from '../src/instance.js';
import { planPolicy, PolicyEditError } from '../src/policy-edit.js';
import { changeSetting } from '../src/settings.js';
import { instructionEvalReasons, mergeDecision, outsidePlanReasons, type MergeInput } from '../src/merge-policy.js';
import { computeLevel } from '../src/review.js';
import { BRAND } from '../src/brand.js';
import { DEFAULT_VALUE_CONSTANTS, holdKind, KILL_SWITCH_KINDS, valueReport, type ValueEvent } from '../src/value-report.js';
import { valueRoute } from '../src/value-report-route.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const HOUR = 3_600_000;
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
const sha = (c: string) => c.repeat(40).slice(0, 40);
const ev = (ts: string, type: string, payload: object): ValueEvent => ({ ts, type, payload });
const report = (events: ValueEvent[], days = 30, constants = DEFAULT_VALUE_CONSTANTS, from: 'policy' | 'default' = 'default') => valueReport(events, { now: NOW, days, estimate: { constants, from } });

const OFF_INSTANCE = 'auto-merge is off for this instance (policy.yaml auto_merge)';
const OFF_REPO = 'auto-merge is off for this repo (review.yaml merge.auto)';

/** One PR's life: opened (issue = number), decided, and merged by the engine. */
const decided = (n: number, auto: boolean, reasons: string[], h = 10, head = 'a') => ev(at(h), 'merge.decided', { issue: n, number: n, head: sha(head), auto, reasons });
const engineMerged = (n: number, h = 9, head = 'a', commit = String(n % 10)) => ev(at(h), 'merge.done', { issue: n, number: n, head: sha(head), sha: sha(commit), url: `u/${n}`, title: `PR ${n}` });
const closed = (n: number, merged: boolean, h = 5) => ev(at(h), 'pr.closed', { issue: n, number: n, merged });
const stats = (n: number, additions: number, deletions: number, head = 'a') => ev(at(11), 'pr.stats', { issue: n, number: n, head: sha(head), additions, deletions, files: 1, comments: 0 });

// --- Counts -------------------------------------------------------------------------------------------------------

test('counts: 3 auto-merges and 2 holds report 3 and 2; a head that flipped held -> auto counts once, as auto', () => {
  const events = [
    decided(1, true, []), engineMerged(1),
    decided(2, true, []), engineMerged(2),
    // Held, then the same head flipped to auto and merged: once, as auto.
    decided(3, false, ['doubt: no evaluator verdict'], 20), decided(3, true, [], 12), engineMerged(3, 11),
    decided(4, false, ['big: 900 changed lines (over 400)']),
    decided(5, false, ['doubt: the evaluator doubts the test']),
  ];
  const r = report(events);
  assert.equal(r.counts.auto, 3);
  assert.equal(r.counts.held, 2);
  assert.equal(r.counts.autoNotMerged, 0);
  assert.equal(r.unreadable, 0);
});

test('a held PR the engine merged on a person\'s approval is held (approved), never auto-merged', () => {
  const r = report([decided(1, false, ['high-risk: auth (src/auth.ts)']), engineMerged(1)]);
  assert.equal(r.counts.auto, 0);
  assert.equal(r.counts.held, 1);
  assert.equal(r.heldOutcomes.approved, 1);
});

test('decided auto but not merged yet counts in neither number', () => {
  const r = report([decided(1, true, [])]);
  assert.deepEqual([r.counts.auto, r.counts.held, r.counts.autoNotMerged], [0, 0, 1]);
});

test('the window: a PR last decided before it is not counted', () => {
  const r = report([decided(1, true, [], 24 * 10), engineMerged(1, 24 * 10 - 1), decided(2, false, ['doubt: x'])], 7);
  assert.equal(r.counts.auto, 0);
  assert.equal(r.counts.held, 1);
  assert.equal(r.window.days, 7);
  assert.equal(r.window.until, NOW.toISOString());
});

// --- Hold rate ----------------------------------------------------------------------------------------------------

test('hold rate: held / (held + auto) on the fixture; a window with no PRs is "no data" (null), not 0% or NaN', () => {
  const r = report([decided(1, true, []), engineMerged(1), decided(2, false, ['doubt: x']), decided(3, false, ['big: y']), decided(4, true, []), engineMerged(4)]);
  assert.equal(r.counts.holdRate, 2 / 4);
  const empty = report([]);
  assert.equal(empty.counts.holdRate, null);
  assert.equal(report([decided(1, true, [], 24 * 40), engineMerged(1, 24 * 40)]).counts.holdRate, null, 'PRs only outside the window: no data');
});

// --- Kinds --------------------------------------------------------------------------------------------------------

test('kinds: a PR with a high-risk: and a doubt: reason counts once in each kind and once in the held total; unknown is "other"', () => {
  const r = report([
    decided(1, false, ['high-risk: auth (src/auth.ts)', 'high-risk: money (src/pay.ts)', 'doubt: no evaluator verdict']),
    decided(2, false, ['something new nobody wrote a prefix for']),
  ]);
  assert.equal(r.counts.held, 2);
  const by = Object.fromEntries(r.heldByKind.map((k) => [k.kind, k.prs]));
  assert.equal(by['high-risk'], 1, 'two high-risk reasons on one PR: once');
  assert.equal(by['doubt'], 1);
  assert.equal(by['other'], 1, 'an unknown prefix is counted, never dropped');
});

/** A change the policy merges (as test/merge-policy.test.ts builds it): each case turns one thing. */
let exampleReview: ReturnType<typeof loadConfig>['review'] | undefined;
const reviewOf = () => (exampleReview ??= loadConfig(exampleProject().dir).review)!;
function clean(over: Partial<MergeInput> = {}): MergeInput {
  const review = reviewOf();
  const level = computeLevel({ files: [{ path: 'src/price.js', added: 1, removed: 0 }], labels: [], moneyPaths: [], scope: undefined }, review);
  return {
    branch: `${BRAND.cli}/issue-7`,
    openedByHarness: true,
    policyOn: true,
    repoOn: true,
    stopped: null,
    level,
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

test('every reason mergeDecision writes falls in a named kind of the one table (src/hold-words.ts), never "other"; the kill switch is its two kinds', () => {
  const review = reviewOf();
  const ci = computeLevel({ files: [{ path: '.github/workflows/ci.yml', added: 1, removed: 0 }], labels: [], moneyPaths: [], scope: undefined }, review);
  const cases: Partial<MergeInput>[] = [
    { openedByHarness: false },
    { branch: `${BRAND.cli}/revert-9` },
    { branch: `${BRAND.cli}/check-from-feedback-3` },
    { policyOn: false, repoOn: false },
    { stopped: 'main went red after #3' },
    { level: ci },
    { claimedProtected: true },
    { verdict: { patch_correct: true, test_correct: true, confidence: 'high', design_change: true, design_reason: 'x' } },
    { newTopLevel: ['newpkg'] },
    { lines: 9999, files: 99 },
    { verdict: null },
    { verdict: { patch_correct: false, test_correct: false, confidence: 'low', unread: ['a.js'] } },
    { ciFixRuns: 2, foreignPush: true, pushLimitHit: true },
    { instructionEvals: instructionEvalReasons(['role worker', 'skill triage'], []) },
    { outsidePlan: outsidePlanReasons({ planFiles: [], level: ci, waitCategories: [...review.levels.L3_human.when, 'ci-config'], newTopLevel: ['newpkg'] }) },
  ];
  let seen = 0;
  for (const over of cases) {
    const d = mergeDecision(clean(over));
    assert.equal(d.auto, false, JSON.stringify(over));
    for (const reason of d.reasons) {
      seen++;
      assert.notEqual(holdKind(reason), 'other', reason);
    }
  }
  assert.ok(seen >= cases.length);
  // The kill switch, as mergeDecision writes it, is exactly the kill-switch kinds, and the fixtures below use its words.
  const off = mergeDecision(clean({ policyOn: false, repoOn: false })).reasons;
  assert.deepEqual(off, [OFF_INSTANCE, OFF_REPO]);
  assert.deepEqual(off.map(holdKind), [...KILL_SWITCH_KINDS]);
  assert.ok(!KILL_SWITCH_KINDS.includes(holdKind('auto-merge is stopped: main went red')), 'a stop is not the kill switch');
});

// --- Held outcomes and wait ---------------------------------------------------------------------------------------

test('a held PR closed merged:true with no merge.done is merged by a person (inferred); closed and waiting are told apart', () => {
  const r = report([
    decided(1, false, ['doubt: x'], 10), closed(1, true, 4),
    decided(2, false, ['doubt: x'], 10), closed(2, false, 8),
    decided(3, false, ['doubt: x'], 10),
  ]);
  assert.deepEqual(r.heldOutcomes, { approved: 0, merged_by_person: 1, closed: 1, waiting: 1 });
  // First hold to merge (6 h) and to close (2 h): median of the two resolved.
  assert.equal(r.heldWait.resolved, 2);
  assert.equal(r.heldWait.medianMs, 4 * HOUR);
});

test('held wait is measured from the first hold, and is null when nothing held was resolved', () => {
  const r = report([decided(1, false, ['doubt: x'], 30), ev(at(20), 'merge.decided', { issue: 1, number: 1, head: sha('b'), auto: false, reasons: ['big: y'] }), closed(1, true, 10)]);
  assert.equal(r.heldWait.medianMs, 20 * HOUR);
  assert.equal(report([decided(1, false, ['doubt: x'])]).heldWait.medianMs, null);
});

// --- Would have merged --------------------------------------------------------------------------------------------

test('would have merged: held only by the kill switch counts 1; the kill switch plus any other reason counts 0', () => {
  const r = report([decided(1, false, [OFF_INSTANCE]), decided(2, false, [OFF_INSTANCE, OFF_REPO]), decided(3, false, [OFF_INSTANCE, 'doubt: no evaluator verdict'])]);
  assert.equal(r.wouldHaveMerged.count, 2);
  assert.deepEqual(r.wouldHaveMerged.prs.map((p) => p.number).sort(), [1, 2]);
});

test('would have merged: a person merged it, and the main watch said red, reverted or green on its commit', () => {
  const r = report([
    decided(1, false, [OFF_INSTANCE], 20), closed(1, true, 10), ev(at(9), 'main_watch.checked', { sha: sha('1'), how: 'person', number: 1 }),
    decided(2, false, [OFF_INSTANCE], 20), closed(2, true, 10), ev(at(9), 'main_watch.unaccounted', { sha: sha('2'), url: 'c/2', reason: 'merged with checks not green', number: 2, revert: null }),
    decided(3, false, [OFF_INSTANCE], 20), closed(3, true, 10), ev(at(9), 'main_watch.unaccounted', { sha: sha('3'), url: 'c/3', reason: 'red', number: 3, revert: 'https://example.invalid/pull/99' }),
    decided(4, false, [OFF_INSTANCE], 20),
  ]);
  const main = Object.fromEntries(r.wouldHaveMerged.prs.map((p) => [p.number, [p.outcome, p.main]]));
  assert.deepEqual(main[1], ['merged_by_person', 'green']);
  assert.deepEqual(main[2], ['merged_by_person', 'red']);
  assert.deepEqual(main[3], ['merged_by_person', 'reverted']);
  assert.deepEqual(main[4], ['waiting', 'none']);
});

// --- Hours saved --------------------------------------------------------------------------------------------------

test('hours saved: equals the formula on fixture pr.stats; carries the formula and constants; a constant changes the number', () => {
  const events = [
    stats(1, 100, 100), decided(1, true, []), engineMerged(1), // 200 lines: min(60, 10 + 5*2) = 20 min
    stats(2, 5000, 0), decided(2, true, []), engineMerged(2), // capped: 60 min
    decided(3, true, []), engineMerged(3), // no pr.stats: not estimated, counted as without stats
    stats(4, 10, 0), decided(4, false, ['doubt: x']), // held: never in the estimate
  ];
  const r = report(events);
  assert.equal(r.hoursSaved.estimate, (20 + 60) / 60);
  assert.equal(r.hoursSaved.prs, 2);
  assert.equal(r.hoursSaved.withoutStats, 1);
  assert.deepEqual(r.hoursSaved.constants, { base_min: 10, per_100_lines_min: 5, cap_min: 60 });
  assert.match(r.hoursSaved.formula, /min\(cap_min, base_min \+ per_100_lines_min × changed_lines \/ 100\) \/ 60/);
  assert.match(r.hoursSaved.label, /estimate/);
  assert.equal(r.hoursSaved.constantsFrom, 'default');
  const other = report(events, 30, { base_min: 30, per_100_lines_min: 5, cap_min: 60 }, 'policy');
  assert.equal(other.hoursSaved.estimate, (40 + 60) / 60);
  assert.equal(other.hoursSaved.constantsFrom, 'policy');
});

test('spend: run.cost of the auto-merged PRs\' issues, per auto-merged PR; none is null, not 0', () => {
  const events = [decided(1, true, []), engineMerged(1), decided(2, true, []), engineMerged(2), decided(3, false, ['doubt: x'])];
  const cost = (issue: number, usd: number) => ev(at(12), 'run.cost', { issue, role: 'worker', model: 'm', usd, turns: 1 });
  const r = report([...events, cost(1, 1.5), cost(2, 0.5), cost(3, 9)]);
  assert.equal(r.spend.usd, 2);
  assert.equal(r.spend.perAutoPr, 1);
  assert.equal(report([decided(3, false, ['doubt: x'])]).spend.perAutoPr, null);
});

// --- Post-merge ---------------------------------------------------------------------------------------------------

test('post-merge: a revert from merge.stopped or main_watch.unaccounted, and a fix-forward outcome, go to the auto-merged PR they follow', () => {
  const events = [
    decided(1, true, []), engineMerged(1, 9, 'a', '1'), ev(at(8), 'merge.main_result', { issue: 1, number: 1, sha: sha('1'), outcome: 'red', failed: ['ci'] }), ev(at(7), 'merge.stopped', { reason: 'main red', number: 1, sha: sha('1'), revert: 'https://example.invalid/pull/50' }),
    decided(2, true, []), engineMerged(2, 9, 'a', '2'), ev(at(8), 'main_watch.unaccounted', { sha: sha('2'), url: 'c', reason: 'red', number: 2, revert: 'https://example.invalid/pull/51' }),
    decided(3, true, []), engineMerged(3, 9, 'a', '3'), ev(at(8), 'merge.main_result', { issue: 3, number: 3, sha: sha('3'), outcome: 'red', failed: ['ci'] }),
    // By the red sha alone (no culprit recorded): the PR whose merge commit it is.
    ev(at(6), 'fix_forward.finished', { sha: sha('3'), outcome: 'fixed', attempts: 1, culprit: null, by: 77, revert: null, detail: '' }),
    decided(4, true, []), engineMerged(4, 9, 'a', '4'), ev(at(8), 'merge.main_result', { issue: 4, number: 4, sha: sha('4'), outcome: 'green', failed: [] }),
    // A person's merge of a held PR: its own group.
    decided(5, false, ['doubt: x']), closed(5, true, 8), ev(at(7), 'fix_forward.finished', { sha: sha('e'), outcome: 'gave_up', attempts: 2, culprit: 5, by: null, revert: null, detail: '' }),
  ];
  const r = report(events);
  // Red: #1 and #3 by their post-merge result, #2 by the main watch's flag.
  assert.deepEqual(r.postMerge.auto, { merged: 4, mainRed: 3, reverts: 2, fixForward: { fixed: 1, reverted: 0, gave_up: 0 } });
  assert.deepEqual(r.postMerge.person, { merged: 1, mainRed: 0, reverts: 0, fixForward: { fixed: 0, reverted: 0, gave_up: 1 } });
});

// --- Malformed events ---------------------------------------------------------------------------------------------

test('a garbled event is "unreadable N", skipped, and never counted as auto-merged', () => {
  const events = [
    // A decision with no readable auto, then a merge: no readable decision, so not auto-merged.
    ev(at(10), 'merge.decided', { issue: 1, number: 1, head: sha('a'), auto: 'yes', reasons: [] }),
    engineMerged(1),
    // A readable auto decision, then a garbled merge.done: not merged, so not auto-merged.
    decided(2, true, []),
    ev(at(9), 'merge.done', { issue: 2, number: 2, head: 'not-a-sha', sha: sha('2'), url: '', title: '' }),
    // A bad timestamp on a relevant event is unreadable too; an unrelated type is never counted.
    { ts: 'not a time', type: 'merge.decided', payload: { issue: 3, number: 3, head: sha('a'), auto: true, reasons: [] } },
    ev(at(9), 'some.other_event', { anything: true }),
    { ts: at(9), type: 'pr.closed', payload: null },
  ];
  const r = report(events);
  assert.equal(r.unreadable, 4);
  assert.equal(r.counts.auto, 0);
  assert.equal(r.hoursSaved.prs, 0);
  // PR 2: a readable auto decision, then a garbled merge.done naming it: unsure, in neither number.
  assert.equal((r.counts as Record<string, unknown>).unsure, 1);
  assert.equal(r.counts.autoNotMerged, 0);
});

/** The figure for PRs a garbled decision or merge left unsure (read untyped, so this also runs on a tree without it). */
const unsure = (r: ReturnType<typeof report>) => (r.counts as Record<string, unknown>).unsure;

test('a garbled hold between an auto decision and the merge: the PR is unsure, never auto-merged, never in hours saved', () => {
  // Review round 1's sequence: a readable auto decision, a garbled hold for the same PR, then the engine's merge.
  const events = [
    stats(9, 100, 0),
    decided(9, true, [], 12),
    ev(at(11), 'merge.decided', { issue: 9, number: 9, head: sha('a'), auto: 'no', reasons: ['high-risk: x'] }),
    engineMerged(9, 10),
  ];
  const r = report(events);
  assert.equal(r.unreadable, 1);
  assert.equal(r.counts.auto, 0, 'the skipped hold must not leave the earlier auto decision standing');
  assert.equal(r.counts.held, 0);
  assert.equal(unsure(r), 1);
  assert.equal(r.hoursSaved.prs, 0);
  assert.equal(r.hoursSaved.estimate, 0);
  assert.equal(r.counts.holdRate, null, 'an unsure PR is in neither side of the hold rate');
  assert.equal(r.postMerge.auto.merged, 0);
  assert.equal(r.spend.perAutoPr, null);
});

test('a garbled merge.done naming a PR makes it unsure; a garbled event naming no PR leaves the others alone', () => {
  const r = report([
    decided(1, true, []), engineMerged(1),
    decided(2, true, []), ev(at(9), 'merge.done', { issue: 2, number: 2, head: sha('a'), sha: 'zz', url: '', title: '' }), engineMerged(2, 8),
    ev(at(9), 'merge.decided', { issue: 3, number: 'three', head: sha('a'), auto: true, reasons: [] }),
  ]);
  assert.equal(r.unreadable, 2);
  assert.equal(r.counts.auto, 1, 'PR 1 only: PR 2 has a garbled merge');
  assert.equal(unsure(r), 1);
});

test('a hold the engine merged on approval, then a later auto decision: never auto-merged (the merge was the approval\'s)', () => {
  const r = report([decided(1, false, ['high-risk: auth (a)'], 12), engineMerged(1, 11), decided(1, true, [], 10, 'b')]);
  assert.equal(r.counts.auto, 0);
  assert.equal(r.hoursSaved.prs, 0);
  assert.equal(r.counts.autoNotMerged, 1);
});

// --- The estimate's constants: an owner setting in policy.yaml (slice 3) -------------------------------------------

/** A policy within the example project's config (agents.yaml: daily_budget_usd 40, workers max 4), auto-merge on. */
const POLICY = 'version: 1\nbudget: { daily_usd: 50 }\nagents: { max_workers: 4 }\nland_mode: pr\nauto_merge: true\n';
const estimateYaml = (base: string, per100: string, cap: string) => `value_report:\n  hours_estimate: { base_min: ${base}, per_100_lines_min: ${per100}, cap_min: ${cap} }\n`;
function policyAt(extra: string): string {
  const f = join(mkdtempSync(join(tmpdir(), 'value-policy-')), 'policy.yaml');
  writeFileSync(f, POLICY + extra, { mode: 0o600 });
  return f;
}
/** policy.yaml's value_report, read untyped (so this also runs on a tree without it). */
const valueReportOf = (p: unknown) => (p as Record<string, unknown> | undefined)?.value_report;

test('policy.yaml value_report.hours_estimate: the owner\'s constants load, bounds included; without it there is none', () => {
  const r = readPolicy(policyAt(estimateYaml('15', '2.5', '90')));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(valueReportOf(r.policy), { hours_estimate: { base_min: 15, per_100_lines_min: 2.5, cap_min: 90 } });
  const edges = readPolicy(policyAt(estimateYaml('0', '0', '480')));
  assert.deepEqual(edges.errors, [], 'zero and the 480-minute bound are allowed');
  const none = readPolicy(policyAt(''));
  assert.deepEqual(none.errors, []);
  assert.equal(valueReportOf(none.policy), undefined);
});

test('invalid constants are refused as the rest of the policy is: named by path, the instance does not load, never a silent default', () => {
  const bad: [string, string, string][] = [
    ['base_min', estimateYaml('-1', '5', '60'), 'negative'],
    ['base_min', estimateYaml('.nan', '5', '60'), 'NaN'],
    ['cap_min', estimateYaml('10', '5', '.inf'), 'infinite'],
    ['per_100_lines_min', estimateYaml('10', '-.inf', '60'), 'minus infinity'],
    ['cap_min', estimateYaml('10', '5', '480.5'), 'over the 480-minute bound'],
    ['per_100_lines_min', estimateYaml('10', '100000', '60'), 'far over the bound'],
    ['base_min', estimateYaml('"10"', '5', '60'), 'a string'],
    ['base_min', estimateYaml('null', '5', '60'), 'null'],
    ['per_100_lines_min', 'value_report:\n  hours_estimate: { base_min: 10, cap_min: 60 }\n', 'missing: all three or none'],
  ];
  for (const [key, yaml, why] of bad) {
    const r = readPolicy(policyAt(yaml));
    assert.equal(r.policy, undefined, why);
    assert.ok(r.errors.some((e) => e.path === `value_report.hours_estimate.${key}`), `${why}: ${JSON.stringify(r.errors)}`);
  }
  const extra = readPolicy(policyAt('value_report:\n  hours_estimate: { base_min: 10, per_100_lines_min: 5, cap_min: 60, bonus_min: 99 }\n'));
  assert.equal(extra.policy, undefined);
  assert.ok(extra.errors.some((e) => e.path === 'value_report.hours_estimate'), JSON.stringify(extra.errors));
  const unknown = readPolicy(policyAt('value_report:\n  hours: 3\n'));
  assert.equal(unknown.policy, undefined);
  assert.ok(unknown.errors.some((e) => e.path === 'value_report'), JSON.stringify(unknown.errors));
  // The instance itself refuses to load, as for any bad policy key.
  const dir = mkdtempSync(join(tmpdir(), 'value-inst-'));
  const home = initInstance('shop', mkdtempSync(join(tmpdir(), 'value-repo-')), 'example-org/example-shop', dir, 'shop-agent', '/home/example');
  writeFileSync(join(home, 'policy.yaml'), POLICY + estimateYaml('10', '5', '-0.5'));
  let errs: { path: string }[] = [];
  assert.throws(() => loadInstance('shop', dir), (e) => {
    errs = (e as ConfigInvalid).errors;
    return e instanceof ConfigInvalid;
  });
  assert.ok(errs.some((e) => e.path === 'value_report.hours_estimate.cap_min'), JSON.stringify(errs));
});

test('the route: the policy\'s constants, said so; no instance policy, the defaults, said so; a bad policy is refused, never estimated with the defaults', () => {
  const events = [stats(1, 100, 100), decided(1, true, []), engineMerged(1)]; // 200 changed lines
  const route = (policyFile: string | null, role: 'owner' | 'viewer' = 'owner') => valueRoute({ method: 'GET', role, login: 'p', events, query: new URLSearchParams(), now: NOW, policyFile } as Parameters<typeof valueRoute>[0]);
  type Hours = { hoursSaved: { estimate: number; constants: unknown; constantsFrom: unknown } };
  const own = route(policyAt(estimateYaml('15', '2.5', '90')));
  assert.equal(own.status, 200);
  const h = (own.body as Hours).hoursSaved;
  assert.deepEqual(h.constants, { base_min: 15, per_100_lines_min: 2.5, cap_min: 90 });
  assert.equal(h.constantsFrom, 'policy');
  assert.equal(h.estimate, (15 + 2.5 * 2) / 60);
  for (const [policyFile, why] of [[policyAt(''), 'a policy that sets none'], [null, 'a checkout: no instance policy']] as const) {
    const r = route(policyFile);
    assert.equal(r.status, 200, why);
    assert.deepEqual((r.body as Hours).hoursSaved.constants, DEFAULT_VALUE_CONSTANTS, why);
    assert.equal((r.body as Hours).hoursSaved.constantsFrom, 'default', why);
  }
  const gone = join(mkdtempSync(join(tmpdir(), 'value-gone-')), 'policy.yaml');
  for (const [policyFile, says] of [
    [policyAt(estimateYaml('-1', '5', '60')), /value_report\.hours_estimate\.base_min/],
    [policyAt(estimateYaml('10', '5', '.inf')), /value_report\.hours_estimate\.cap_min/],
    [policyAt('value_report:\n  hours_estimate: { base_min: 10 }\n'), /value_report\.hours_estimate\.per_100_lines_min/],
    [gone, /missing/],
  ] as const) {
    const r = route(policyFile);
    assert.equal(r.status, 500, String(says));
    assert.deepEqual(Object.keys(r.body as object), ['error'], 'no figures from a policy that does not load');
    assert.match((r.body as { error: string }).error, says);
    assert.match((r.body as { error: string }).error, /policy/);
    assert.ok(!(r.body as { error: string }).error.includes(policyFile), 'the key and the problem, never where the instance home is');
    // A viewer is refused first, as ever: nothing about the policy reaches them.
    const v = route(policyFile, 'viewer');
    assert.equal(v.status, 403);
    assert.doesNotMatch((v.body as { error: string }).error, /value_report|missing/);
  }
});

test('the setting changes no gate: auto-merge is the same with or without it, a bad one only turns it off, and no dashboard form or setting writes it', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'value-state-'));
  const without = autoMergeState({ policyFile: policyAt(''), repoAuto: true, stateDir });
  assert.equal(without.on, true);
  for (const est of [estimateYaml('0', '0', '0'), estimateYaml('480', '480', '480')]) assert.deepEqual(autoMergeState({ policyFile: policyAt(est), repoAuto: true, stateDir }), without, est);
  const broken = autoMergeState({ policyFile: policyAt(estimateYaml('10', '5', '9999')), repoAuto: true, stateDir });
  assert.equal(broken.on, false, 'a policy that does not load fails closed');
  // Only policy.yaml's own editor sets it: the dashboard's Policy form and Settings refuse the key.
  const cfg = loadConfig(exampleProject().dir);
  const path = policyAt(estimateYaml('15', '2.5', '90'));
  for (const key of ['value_report.hours_estimate.base_min', 'value_report', 'hours_estimate.cap_min']) {
    assert.throws(() => planPolicy({ path, cfg, values: { [key]: 1 } }), (e) => e instanceof PolicyEditError && /not editable here/.test(e.message), key);
    assert.throws(() => changeSetting({ policyPath: path, cfg, eventsDb: join(stateDir, 'events.db'), key, value: 1, by: 'example-owner', owner: true }), /unknown setting/, key);
  }
  // An edit the form does make keeps the owner's constants as they were.
  const plan = planPolicy({ path, cfg, values: { auto_merge: false } });
  assert.deepEqual(valueReportOf(parseDocument(plan.text).toJS()), { hours_estimate: { base_min: 15, per_100_lines_min: 2.5, cap_min: 90 } });
  assert.equal(readFileSync(path, 'utf8'), POLICY + estimateYaml('15', '2.5', '90'), 'planning writes nothing');
});

// --- The route ----------------------------------------------------------------------------------------------------

test('valueRoute: owners and writers get the report; a viewer is refused (403, the writers-only message); read-only; days checked', () => {
  const events = [decided(1, true, []), engineMerged(1)];
  for (const role of ['owner', 'writer'] as const) {
    const r = valueRoute({ method: 'GET', role, login: 'p', events, query: new URLSearchParams(), now: NOW, policyFile: null });
    assert.equal(r.status, 200, role);
    assert.equal((r.body as { counts: { auto: number } }).counts.auto, 1);
  }
  for (const role of ['viewer', null, undefined] as const) {
    const r = valueRoute({ method: 'GET', role, login: 'someone', events, query: new URLSearchParams(), now: NOW, policyFile: null });
    assert.equal(r.status, 403, String(role));
    assert.deepEqual(Object.keys(r.body as object), ['error'], 'a refusal carries nothing but the error');
  }
  assert.equal((valueRoute({ method: 'GET', role: 'viewer', login: 'someone', events, query: new URLSearchParams(), now: NOW, policyFile: null }).body as { error: string }).error, "the value report is for the instance's owners and writers (admin or write on its repo); @someone is a viewer");
  assert.equal(valueRoute({ method: 'POST', role: 'owner', login: 'p', events, query: new URLSearchParams(), now: NOW, policyFile: null }).status, 405);
  assert.equal(valueRoute({ method: 'GET', role: 'owner', login: 'p', events, query: new URLSearchParams('days=7'), now: NOW, policyFile: null }).status, 200);
  assert.equal((valueRoute({ method: 'GET', role: 'owner', login: 'p', events, query: new URLSearchParams('days=7'), now: NOW, policyFile: null }).body as { window: { days: number } }).window.days, 7);
  for (const bad of ['days=0', 'days=-1', 'days=abc', 'days=100000', 'days=7.5']) assert.equal(valueRoute({ method: 'GET', role: 'owner', login: 'p', events, query: new URLSearchParams(bad), now: NOW, policyFile: null }).status, 400, bad);
});

/**
 * A bin dir of recording stand-ins (each exits 1) and nothing else: with PATH set to it alone, no real host tool can
 * run from the dashboard while it serves the report, and any call is written down.
 */
function standIns(): { bin: string; log: string } {
  const bin = mkdtempSync(join(tmpdir(), 'value-bin-'));
  const log = join(bin, 'calls.log');
  for (const tool of ['systemctl', 'launchctl', 'loginctl', 'journalctl', 'gh', 'git', 'docker', 'sudo', 'tailscale', 'id', 'useradd', 'df', 'lslocks', 'ps']) {
    const f = join(bin, tool);
    writeFileSync(f, `#!/bin/sh\necho ${tool} >> '${log}'\nexit 1\n`);
    chmodSync(f, 0o755);
  }
  return { bin, log };
}

test('GET /api/value through the dashboard: owner and writer 200, a viewer 403 with nothing but the error; read only from the event log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-value-'));
  const log = new EventLog(join(dir, 'events.db'));
  log.append('merge.decided', { issue: 1, number: 1, head: sha('a'), auto: true, reasons: [] }, 'coordinator');
  log.append('merge.done', { issue: 1, number: 1, head: sha('a'), sha: sha('1'), url: 'u', title: 't' }, 'coordinator');
  log.append('merge.decided', { issue: 2, number: 2, head: sha('b'), auto: false, reasons: ['high-risk: auth (src/auth.ts)'] }, 'coordinator');
  log.close();
  const { dir: root } = exampleProject(); // real git, in its own temp dir, before PATH narrows
  const { bin, log: calls } = standIns();
  const path = process.env.PATH;
  process.env.PATH = bin; // the stand-ins alone: no /usr/bin, no /bin
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const call = (user: string, q = '', init: RequestInit = {}) => fetch(`${base}/api/value${q}`, { ...init, headers: { authorization: `Bearer ${d.token}`, ...asPerson(user) } });
  try {
    const before = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
    for (const user of ['example-owner', 'example-collaborator']) {
      const res = await call(user);
      assert.equal(res.status, 200, user);
      const r = (await res.json()) as { counts: { auto: number; held: number }; heldByKind: { kind: string; prs: number }[] };
      assert.equal(r.counts.auto, 1);
      assert.equal(r.counts.held, 1);
      assert.deepEqual(r.heldByKind, [{ kind: 'high-risk', prs: 1 }]);
    }
    const refused = await call('someone-else');
    assert.equal(refused.status, 403);
    const body = (await refused.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['error']);
    assert.match(String(body.error), /owners and writers/);
    assert.doesNotMatch(JSON.stringify(body), /high-risk|auth/, 'no hold reason reaches a viewer');
    assert.equal((await call('example-owner', '', { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await call('example-owner', '?days=nope')).status, 400);
    const after = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
    assert.equal(after, before, 'serving the report ran no host tool');
  } finally {
    await d.close();
    process.env.PATH = path;
  }
});

test('GET /api/value on an instance\'s dashboard: the constants come from its policy.yaml, re-read on each request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-value-policy-'));
  const log = new EventLog(join(dir, 'events.db'));
  log.append('pr.stats', { issue: 1, number: 1, head: sha('a'), additions: 100, deletions: 100, files: 1, comments: 0 }, 'coordinator');
  log.append('merge.decided', { issue: 1, number: 1, head: sha('a'), auto: true, reasons: [] }, 'coordinator');
  log.append('merge.done', { issue: 1, number: 1, head: sha('a'), sha: sha('1'), url: 'u', title: 't' }, 'coordinator');
  log.close();
  const policyFile = policyAt(estimateYaml('15', '2.5', '90'));
  const { dir: root } = exampleProject();
  const { bin, log: calls } = standIns();
  const path = process.env.PATH;
  process.env.PATH = bin;
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots'), policyFile });
  const base = d.url.split('/?')[0]!;
  const get = async () => {
    const res = await fetch(`${base}/api/value`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson('example-owner') } });
    return { status: res.status, body: (await res.json()) as { error?: string; hoursSaved?: { constants: unknown; constantsFrom: unknown; estimate: number } } };
  };
  try {
    const before = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
    const r = await get();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.hoursSaved?.constants, { base_min: 15, per_100_lines_min: 2.5, cap_min: 90 });
    assert.equal(r.body.hoursSaved?.constantsFrom, 'policy');
    assert.equal(r.body.hoursSaved?.estimate, 20 / 60);
    // The owner breaks the file while the dashboard runs: refused at once, not the old constants nor the defaults.
    writeFileSync(policyFile, POLICY + estimateYaml('15', '2.5', '-90'));
    const broken = await get();
    assert.equal(broken.status, 500);
    assert.match(String(broken.body.error), /value_report\.hours_estimate\.cap_min/);
    assert.equal(broken.body.hoursSaved, undefined);
    const after = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
    assert.equal(after, before, 'serving the report ran no host tool');
  } finally {
    await d.close();
    process.env.PATH = path;
  }
});
