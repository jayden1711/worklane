import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { autoMergeState, dashboardSite, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { initInstance } from '../src/instance.js';
import { prsView } from '../src/projection.js';
import { agentIsSelf, exampleProject } from './helpers.js';

const sha = (c: string) => c.repeat(40);
const seen = (issue: number, title: string) => ({ issue, title, labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' });

/** A log with one PR in each place a PR can be. */
function prLog() {
  const dir = mkdtempSync(join(tmpdir(), 'dash-prs-'));
  const log = new EventLog(join(dir, 'events.db'));
  const open = (issue: number, number: number, head: string) => {
    log.append('issue.seen', seen(issue, `Issue ${issue}`), 'c');
    log.append('pr.opened', { issue, number, url: `https://example.test/pr/${number}`, head, draft: true }, 'c');
  };
  // 11: ready, then the merge rules leave it to a person.
  open(11, 101, sha('a'));
  log.append('pr.status', { issue: 11, number: 101, head: sha('a'), ready: true, reasons: [], checks: [{ name: 'test', outcome: 'pass' }] }, 'c');
  log.append('pr.ready', { issue: 11, number: 101, head: sha('a') }, 'c');
  log.append('merge.decided', { issue: 11, number: 101, head: sha('a'), auto: false, reasons: ['touches a migration (L3)', 'over 400 changed lines'] }, 'c');
  // 12: a required check failed, two fix runs, then gave up.
  open(12, 102, sha('b'));
  log.append('pr.status', { issue: 12, number: 102, head: sha('b'), ready: false, reasons: ['test failed'], checks: [{ name: 'test', outcome: 'fail' }] }, 'c');
  log.append('ci_fix.started', { issue: 12, number: 102, head: sha('b'), checks: ['test'], attempt: 1, lease: sha('1') }, 'c');
  log.append('ci_fix.finished', { issue: 12, number: 102, outcome: 'pushed', head: sha('c'), detail: 'fixed the rounding' }, 'c');
  log.append('ci_fix.started', { issue: 12, number: 102, head: sha('c'), checks: ['test'], attempt: 2, lease: sha('2') }, 'c');
  log.append('ci_fix.finished', { issue: 12, number: 102, outcome: 'no_push', head: null, detail: 'unrelated flaky test' }, 'c');
  log.append('ci_fix.gave_up', { issue: 12, number: 102, head: sha('c'), reason: 'the failure is not caused by this change (a flaky test)' }, 'c');
  // 13: a fix run in progress.
  open(13, 103, sha('d'));
  log.append('ci_fix.started', { issue: 13, number: 103, head: sha('d'), checks: ['lint'], attempt: 1, lease: sha('3') }, 'c');
  // 14: auto-merged, main stayed green.
  open(14, 104, sha('e'));
  log.append('pr.ready', { issue: 14, number: 104, head: sha('e') }, 'c');
  log.append('merge.decided', { issue: 14, number: 104, head: sha('e'), auto: true, reasons: ['docs only, 12 lines', 'evaluator: high confidence'] }, 'c');
  log.append('merge.done', { issue: 14, number: 104, head: sha('e'), sha: sha('f'), url: 'https://example.test/commit/f', title: 'Issue 14' }, 'c');
  log.append('merge.main_result', { issue: 14, number: 104, sha: sha('f'), outcome: 'green', failed: [] }, 'c');
  log.append('pr.closed', { issue: 14, number: 104, merged: true }, 'c');
  // 15: waited for a person at an old head; a fix since moved it, so that call no longer stands.
  open(15, 105, sha('1'));
  log.append('merge.decided', { issue: 15, number: 105, head: sha('1'), auto: false, reasons: ['ci fix run happened'] }, 'c');
  log.append('ci_fix.started', { issue: 15, number: 105, head: sha('1'), checks: ['test'], attempt: 1, lease: sha('4') }, 'c');
  log.append('ci_fix.finished', { issue: 15, number: 105, outcome: 'pushed', head: sha('2'), detail: 'fixed' }, 'c');
  // 16: merged by a person; 17: closed unmerged.
  open(16, 106, sha('3'));
  log.append('pr.closed', { issue: 16, number: 106, merged: true }, 'c');
  open(17, 107, sha('4'));
  log.append('pr.closed', { issue: 17, number: 107, merged: false }, 'c');
  // A refused push, and an auto-merge stop then resume.
  log.append('issue.seen', seen(18, 'Too big'), 'c');
  log.append('push.refused', { issue: 18, head: sha('5'), stage: 'push', reasons: ['900 changed lines, over the 800 limit'] }, 'c');
  log.append('merge.stopped', { reason: 'main went red after #104', number: 104, sha: sha('f'), revert: 'https://example.test/pr/200' }, 'c');
  log.append('merge.resumed', { detail: 'the operator cleared the stop' }, 'c');
  return { dir, log };
}

test('the PR view: where each PR stands, why it waits, its checks and fix runs, what auto-merged', () => {
  const { log } = prLog();
  const v = prsView(log.read());
  const by = Object.fromEntries(v.prs.map((p) => [p.number, p]));
  assert.deepEqual(
    Object.fromEntries(v.prs.map((p) => [p.number, p.phase])),
    { 101: 'waiting', 102: 'gave_up', 103: 'fixing', 104: 'auto_merged', 105: 'checks', 106: 'merged', 107: 'closed' },
  );
  assert.deepEqual(by[101]!.decision?.reasons, ['touches a migration (L3)', 'over 400 changed lines'], 'exactly why it waits');
  assert.equal(by[101]!.draft, false);
  assert.equal(by[102]!.head, sha('c'), 'the pushed fix is the current head');
  assert.deepEqual(by[102]!.fixes.map((f) => [f.attempt, f.outcome]), [[1, 'pushed'], [2, 'no_push']]);
  assert.match(by[102]!.gaveUp!.reason, /flaky/);
  assert.equal(by[103]!.fixes[0]!.outcome, 'running');
  assert.deepEqual(by[104]!.merged, { at: by[104]!.merged!.at, sha: sha('f'), url: 'https://example.test/commit/f', auto: true }, 'a person merging later does not hide the auto-merge');
  assert.equal(by[104]!.mainResult?.outcome, 'green');
  assert.equal(by[106]!.merged?.auto, false);
  assert.equal(by[101]!.title, 'Issue 11');
  assert.deepEqual(v.refused.map((r) => [r.issue, r.title, r.reasons[0]]), [[18, 'Too big', '900 changed lines, over the 800 limit']]);
  assert.deepEqual(v.stops.map((s) => s.kind), ['resumed', 'stopped'], 'newest first');
  assert.equal(v.stops[1]!.revert, 'https://example.test/pr/200');
});

test('regression: a CI fix that gave up, then a person\'s push the merge policy still leaves to a person, shows both reasons', () => {
  // The coordinator's order: the fix flow gives up at the harness's head (#39); a person pushes; the watch
  // sees the new head ready; the merge policy says wait, at that head (#42).
  const dir = mkdtempSync(join(tmpdir(), 'dash-prs-'));
  const log = new EventLog(join(dir, 'events.db'));
  log.append('issue.seen', seen(21, 'Add the orders table'), 'c');
  log.append('pr.opened', { issue: 21, number: 121, url: 'https://example.test/pr/121', head: sha('a'), draft: true }, 'c');
  log.append('pr.status', { issue: 21, number: 121, head: sha('a'), ready: false, reasons: ['test failed'], checks: [{ name: 'test', outcome: 'fail' }] }, 'c');
  log.append('ci_fix.started', { issue: 21, number: 121, head: sha('a'), checks: ['test'], attempt: 1, lease: sha('1') }, 'c');
  log.append('ci_fix.finished', { issue: 21, number: 121, outcome: 'no_push', head: null, detail: 'the same test fails on main' }, 'c');
  log.append('ci_fix.gave_up', { issue: 21, number: 121, head: sha('a'), reason: 'the failure is not caused by this change' }, 'c');
  log.append('pr.status', { issue: 21, number: 121, head: sha('b'), ready: true, reasons: [], checks: [{ name: 'test', outcome: 'pass' }] }, 'c');
  log.append('pr.ready', { issue: 21, number: 121, head: sha('b') }, 'c');
  log.append('merge.decided', { issue: 21, number: 121, head: sha('b'), auto: false, reasons: ['high-risk: migrations', 'a CI fix run happened'] }, 'c');
  const pr = prsView(log.read()).prs[0]!;
  assert.equal(pr.head, sha('b'), 'the PR is at the person\'s push');
  assert.equal(pr.gaveUp?.reason, 'the failure is not caused by this change');
  assert.deepEqual(pr.waitReasons, ['high-risk: migrations', 'a CI fix run happened'], 'the merge call at the current head stands');
  assert.equal(pr.phase, 'gave_up');
  log.close();
});

test('conflict fixes, light checks and hotspot holds: where each PR stands, how long, and when it waits for a person', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-prs-flow-'));
  const log = new EventLog(join(dir, 'events.db'));
  const open = (issue: number, number: number, head: string) => {
    log.append('issue.seen', seen(issue, `Issue ${issue}`), 'c');
    log.append('pr.opened', { issue, number, url: `https://example.test/pr/${number}`, head, draft: true }, 'c');
  };
  // 31: a conflict with main being resolved right now.
  open(31, 131, sha('a'));
  log.append('conflict_fix.detected', { issue: 31, number: 131, head: sha('a'), base_sha: sha('b') }, 'c');
  log.append('conflict_fix.started', { issue: 31, number: 131, head: sha('a'), base_sha: sha('b'), strategy: 'merge', attempt: 1, lease: sha('1') }, 'c');
  // 32: resolved and pushed, but the result touches a hotspot file: it waits for the owner.
  open(32, 132, sha('c'));
  log.append('conflict_fix.detected', { issue: 32, number: 132, head: sha('c'), base_sha: sha('b') }, 'c');
  log.append('conflict_fix.started', { issue: 32, number: 132, head: sha('c'), base_sha: sha('b'), strategy: 'merge', attempt: 1, lease: sha('2') }, 'c');
  log.append('conflict_fix.finished', { issue: 32, number: 132, base_sha: sha('b'), strategy: 'merge', outcome: 'pushed', head: sha('d'), files: ['src/totals.js'], waits_owner: true, reasons: ['the merge touched src/totals.js (money-path)'], detail: 'merged main' }, 'c');
  // 33: ready, waiting on a light check against main's latest.
  open(33, 133, sha('e'));
  log.append('pr.ready', { issue: 33, number: 133, head: sha('e') }, 'c');
  log.append('light_check.started', { issue: 33, number: 133, head: sha('e'), main_sha: sha('f'), overlap: ['src/cart.js'] }, 'c');
  // 34: a light check finished: merge, after 4 minutes; then a conflict fix that gave up.
  open(34, 134, sha('5'));
  log.append('light_check.started', { issue: 34, number: 134, head: sha('5'), main_sha: sha('f'), overlap: [] }, 'c');
  log.append('light_check.finished', { issue: 34, number: 134, head: sha('5'), main_sha: sha('f'), overlap: [], outcome: 'merge', wait_ms: 240_000, detail: 'green on main + PR' }, 'c');
  log.append('conflict_fix.finished', { issue: 34, number: 134, base_sha: null, strategy: 'merge', outcome: 'gave_up', head: null, files: [], waits_owner: true, reasons: [], detail: 'both sides rewrote the same function' }, 'c');
  // Two hotspot holds: one released after 3 minutes, one still held.
  log.append('issue.seen', seen(40, 'Change the totals'), 'c');
  log.append('hotspot.held', { issue: 40, by: 31, files: ['src/totals.js'], reason: 'issue 31 is changing src/totals.js' }, 'c');
  log.append('hotspot.released', { issue: 40, waited_ms: 180_000, files: ['src/totals.js'], started: true }, 'c');
  log.append('issue.seen', seen(41, 'Round the discounts'), 'c');
  log.append('hotspot.held', { issue: 41, by: 32, files: ['src/totals.js', 'src/discounts.js'], reason: 'issue 32 is changing them' }, 'c');
  const v = prsView(log.read());
  const by = Object.fromEntries(v.prs.map((p) => [p.number, p]));
  assert.deepEqual(Object.fromEntries(v.prs.map((p) => [p.number, p.phase])), { 131: 'resolving', 132: 'waiting', 133: 'light_check', 134: 'waiting' });
  assert.deepEqual([by[131]!.conflict?.state, by[131]!.conflict?.attempt], ['running', 1]);
  assert.equal(by[132]!.head, sha('d'), 'the resolved branch is the PR\'s head');
  assert.deepEqual([by[132]!.conflict?.outcome, by[132]!.conflict?.waitsOwner, by[132]!.conflict?.files, by[132]!.conflict?.reasons], ['pushed', true, ['src/totals.js'], ['the merge touched src/totals.js (money-path)']]);
  assert.deepEqual([by[133]!.lightCheck?.state, by[133]!.lightCheck?.mainSha, by[133]!.lightCheck?.overlap], ['running', sha('f'), ['src/cart.js']]);
  assert.deepEqual([by[134]!.lightCheck?.outcome, by[134]!.lightCheck?.waitMs], ['merge', 240_000]);
  assert.equal(by[134]!.conflict?.outcome, 'gave_up');
  assert.deepEqual(v.holds.map((h) => [h.issue, h.title, h.by, h.files, h.until === null, h.waitedMs]), [[41, 'Round the discounts', 32, ['src/totals.js', 'src/discounts.js'], true, null], [40, 'Change the totals', 31, ['src/totals.js'], false, 180_000]], 'newest first; the released one with its wait');
  log.close();
});

test('auto-merge state: the policy kill switch, the repo rule and the stop file, as the coordinator reads them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-am-'));
  const policy = join(dir, 'policy.yaml');
  const write = (on: boolean) => writeFileSync(policy, `version: 1\nbudget: { daily_usd: 20 }\nagents: { max_workers: 2 }\nland_mode: pr\nauto_merge: ${on}\n`);
  write(true);
  assert.deepEqual(autoMergeState({ policyFile: policy, repoAuto: true, stateDir: dir }), { on: true, policy: true, repo: true, stopped: null, why: 'on: PRs the merge rules allow merge themselves' });
  assert.equal(autoMergeState({ policyFile: policy, repoAuto: false, stateDir: dir }).on, false, 'the repo can turn it off');
  writeFileSync(join(dir, 'auto-merge-stopped.json'), JSON.stringify({ reason: 'main went red after #104' }));
  const stopped = autoMergeState({ policyFile: policy, repoAuto: true, stateDir: dir });
  assert.equal(stopped.on, false);
  assert.equal(stopped.stopped, 'main went red after #104');
  assert.match(stopped.why, /stopped: main went red/);
  write(false);
  assert.match(autoMergeState({ policyFile: policy, repoAuto: true, stateDir: dir }).why, /kill switch \(auto_merge\) is off/, 'the kill switch is re-read');
  writeFileSync(policy, 'not: [valid');
  const bad = autoMergeState({ policyFile: policy, repoAuto: true, stateDir: dir });
  assert.equal(bad.on, false, 'an unreadable policy counts as off');
  assert.match(bad.why, /can't be read/);
  assert.match(autoMergeState({ policyFile: null, repoAuto: true, stateDir: dir }).why, /no instance/);
});

test('the dashboard serves the PR view with the instance\'s auto-merge state, and counts what needs you', async () => {
  const { dir, log } = prLog();
  const policy = join(dir, 'policy.yaml');
  writeFileSync(policy, 'version: 1\nbudget: { daily_usd: 20 }\nagents: { max_workers: 2 }\nland_mode: pr\nauto_merge: true\n');
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', policyFile: policy, slotsDir: join(dir, 'slots') });
  try {
    const base = d.url.split('/?')[0]!;
    const h = { authorization: `Bearer ${d.token}` };
    assert.equal((await fetch(`${base}/api/prs`)).status, 401);
    const v = (await (await fetch(`${base}/api/prs`, { headers: h })).json()) as { prs: { number: number; phase: string }[]; autoMerge: { on: boolean } };
    assert.equal(v.prs.length, 7);
    assert.equal(v.autoMerge.on, true);
    const st = (await (await fetch(`${base}/api/state`, { headers: h })).json()) as { prCounts: { open: number; needYou: number } };
    assert.deepEqual(st.prCounts, { open: 4, needYou: 2 }, 'waiting for review, and a CI fix that gave up');
  } finally {
    await d.close();
    log.close();
  }
});

test('an instance\'s dashboard reads its own policy file for the kill switch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-instances-'));
  const { dir: repo } = exampleProject();
  const home = initInstance('shop', repo, 'example-org/example-shop', dir);
  agentIsSelf(home);
  writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nland_mode: pr\nauto_merge: true\n');
  assert.equal(dashboardSite(repo, 'shop', dir).policyFile, join(home, 'policy.yaml'));
  assert.equal(dashboardSite(repo).policyFile, null, 'a checkout has none');
});
