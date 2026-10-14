// Stale PR hygiene: the pure decisions (src/pr-hygiene.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abandoned, carriedHead, countsOf, heldReasons, HYGIENE_MARKER, hygieneDue, hygieneLine, hygieneWeek, isStale, lastActivity, mergeInBase, supersededBy } from '../src/pr-hygiene.js';
import { loadConfig } from '../src/config/load.js';
import { exampleProject } from './helpers.js';

const DAY = 86_400_000;
const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const c = 'c'.repeat(40);
const m = 'd'.repeat(40);

test('pr_hygiene defaults: every 6 hours, stale after 3 days, abandoned after 14, needs-owner and hold labels hold a PR', () => {
  const cfg = loadConfig(exampleProject().dir);
  assert.deepEqual(cfg.project.pr_hygiene, { enabled: true, every_hours: 6, stale_after_days: 3, abandon_after_days: 14, hold_labels: ['needs-owner', 'hold'] });
});

test('a pass is due once per every_hours; a base is stale only past stale_after_days', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  assert.equal(hygieneDue(null, now, 6), true);
  assert.equal(hygieneDue('2026-10-13T07:00:00Z', now, 6), false);
  assert.equal(hygieneDue('2026-10-13T06:00:00Z', now, 6), true);
  assert.equal(isStale(now - 3 * DAY, now, 3), false);
  assert.equal(isStale(now - 3 * DAY - 1, now, 3), true);
});

test('held: a hold label, a head the merge policy left to an owner, or someone else pushed', () => {
  const base = { labels: ['bug'], holdLabels: ['needs-owner', 'hold'], waitsOwner: false, head: a, ourHead: a };
  assert.deepEqual(heldReasons(base), []);
  assert.match(heldReasons({ ...base, labels: ['needs-owner'] }).join(), /labelled needs-owner/);
  assert.match(heldReasons({ ...base, waitsOwner: true }).join(), /left it to an owner/);
  assert.match(heldReasons({ ...base, ourHead: b }).join(), /someone else pushed/);
});

test('abandoned only with the task closed or superseded and no activity for abandon_after_days', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const o = { taskClosed: true, supersededBy: null, lastActivityMs: now - 15 * DAY, nowMs: now, abandonDays: 14, task: 7 };
  assert.deepEqual(abandoned(o), { abandoned: true, why: 'its task #7 is closed, and it has had no commit or comment for 15 days (pr_hygiene.abandon_after_days: 14)' });
  assert.equal(abandoned({ ...o, taskClosed: false }).abandoned, false, 'task open: never abandoned');
  assert.equal(abandoned({ ...o, taskClosed: false, supersededBy: 12 }).abandoned, true);
  assert.equal(abandoned({ ...o, lastActivityMs: now - 13 * DAY }).abandoned, false, 'recent activity');
  assert.equal(abandoned({ ...o, lastActivityMs: null }).abandoned, false, 'unknown activity never proves abandoned');
  assert.equal(supersededBy([{ issue: 7, number: 10 }, { issue: 7, number: 14 }, { issue: 8, number: 20 }], { issue: 7, number: 10 }), 14);
  assert.equal(supersededBy([{ issue: 7, number: 10 }], { issue: 7, number: 10 }), null);
});

test("last activity: the newest commit, comment or review; the pass's own comments don't count; an undated comment is unknown", () => {
  const t0 = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(lastActivity({ commitAtMs: t0, comments: [{ body: 'hi', at: '2026-10-05T00:00:00Z' }], reviewsAt: ['2026-10-03T00:00:00Z'] }), Date.parse('2026-10-05T00:00:00Z'));
  assert.equal(lastActivity({ commitAtMs: t0, comments: [{ body: `${HYGIENE_MARKER}\nmerged main in`, at: '2026-10-09T00:00:00Z' }], reviewsAt: [] }), t0);
  assert.equal(lastActivity({ commitAtMs: t0, comments: [{ body: 'hi' }], reviewsAt: [] }), null);
});

test("the evaluator's head carries across the harness's merge-ins, and the PR's change is measured from the merged base", () => {
  const ins = [
    { number: 5, from: a, head: b, base_sha: m },
    { number: 5, from: b, head: c, base_sha: m },
  ];
  assert.equal(carriedHead(ins, 5, c), a);
  assert.equal(carriedHead(ins, null, c), a);
  assert.equal(carriedHead(ins, 6, c), c, "another PR's merge-ins don't carry");
  assert.equal(carriedHead(ins, 5, 'e'.repeat(40)), 'e'.repeat(40));
  assert.equal(mergeInBase(ins, 5, c), m);
  assert.equal(mergeInBase(ins, 5, a), null);
});

test('counts per pass, their line, and the digest hook summing a week of passes', () => {
  const counts = countsOf([
    { number: 1, outcome: 'merged_in', why: '' },
    { number: 2, outcome: 'held', why: '' },
    { number: 3, outcome: 'skipped', why: '' },
    { number: 4, outcome: 'skipped', why: '' },
  ]);
  assert.deepEqual(counts, { merged_in: 1, conflicting: 0, closed: 0, held: 1, skipped: 2 });
  assert.equal(hygieneLine(counts), '1 merged in, 0 conflicting, 0 closed, 1 held for an owner, 2 skipped');
  const ev = (ts: string, p: object) => ({ type: 'pr_hygiene.pass', ts, payload: p });
  const week = hygieneWeek([ev('2026-10-01T00:00:00Z', { ...counts, merged_in: 9 }), ev('2026-10-10T00:00:00Z', counts), ev('2026-10-12T00:00:00Z', { ...counts, closed: 2 })], Date.parse('2026-10-06T00:00:00Z'));
  assert.deepEqual({ ...week, line: undefined }, { merged_in: 2, conflicting: 0, closed: 2, held: 2, skipped: 4, passes: 2, line: undefined });
  assert.equal(week.line, 'Stale PRs (2 passes): 2 merged in, 0 conflicting, 2 closed, 2 held for an owner, 4 skipped');
  assert.equal(hygieneWeek([], 0).line, 'Stale PRs: no pass ran');
});
