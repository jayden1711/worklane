// Issue #821: GET /api/prs gave every role the merge decision's reasons. A viewer (read on the repo) now gets each
// PR's state only, as on /api/state and /api/events; the owner and writers still get everything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { prsView, type PrView } from '../src/projection.js';
import { prForViewer, prsForViewer, viewerPhase } from '../src/prs-viewer.js';
import { asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

const sha = (c: string) => c.repeat(40);
const seen = (issue: number, title: string) => ({ issue, title, labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' });

/** Words only the merge decision, the fix runs, the conflict fixes and the other writers' sections carry. */
const SECRETS = [
  'L3-REVIEW-LEVEL', 'guard-category-secrets', 'src/billing/ledger.ts', 'POLICY-STATE-auto-off', 'flaky-reason-xyz', 'fix-detail-abc',
  'src/totals.js', 'money-path-reason', 'src/cart.js', 'refused-900-lines', 'stop-main-red', 'operator-cleared', 'hotspot-why', 'src/discounts.js',
  'AUTO-REASON-docs-only', sha('f'), 'stopfile-reason-qq', 'hygiene-why', 'held for an owner',
];

/** A log with a held PR, a gave-up fix, a conflict that waits for the owner, a light check, an auto-merge and the rest. */
function heldLog() {
  const dir = mkdtempSync(join(tmpdir(), 'prs-viewer-'));
  const log = new EventLog(join(dir, 'events.db'));
  const open = (issue: number, number: number, head: string) => {
    log.append('issue.seen', seen(issue, `Issue ${issue}`), 'c');
    log.append('pr.opened', { issue, number, url: `https://example.test/pr/${number}`, head, draft: true }, 'c');
  };
  // 11: ready, then the merge rules hold it for a person, with reasons naming a level, a guard, a path and a policy state.
  open(11, 101, sha('a'));
  log.append('pr.status', { issue: 11, number: 101, head: sha('a'), ready: true, reasons: [], checks: [{ name: 'test', outcome: 'pass' }] }, 'c');
  log.append('pr.ready', { issue: 11, number: 101, head: sha('a') }, 'c');
  log.append('merge.decided', { issue: 11, number: 101, head: sha('a'), auto: false, reasons: ['L3-REVIEW-LEVEL', 'guard-category-secrets touched', 'changes src/billing/ledger.ts', 'POLICY-STATE-auto-off'] }, 'c');
  // 12: a CI fix that gave up.
  open(12, 102, sha('b'));
  log.append('pr.status', { issue: 12, number: 102, head: sha('b'), ready: false, reasons: ['test failed'], checks: [{ name: 'test', outcome: 'fail' }] }, 'c');
  log.append('ci_fix.started', { issue: 12, number: 102, head: sha('b'), checks: ['test'], attempt: 1, lease: sha('1') }, 'c');
  log.append('ci_fix.finished', { issue: 12, number: 102, outcome: 'no_push', head: null, detail: 'fix-detail-abc' }, 'c');
  log.append('ci_fix.gave_up', { issue: 12, number: 102, head: sha('b'), reason: 'flaky-reason-xyz' }, 'c');
  // 13: a conflict fix whose result waits for the owner.
  open(13, 103, sha('c'));
  log.append('conflict_fix.detected', { issue: 13, number: 103, head: sha('c'), base_sha: sha('9') }, 'c');
  log.append('conflict_fix.started', { issue: 13, number: 103, head: sha('c'), base_sha: sha('9'), strategy: 'merge', attempt: 1, lease: sha('2') }, 'c');
  log.append('conflict_fix.finished', { issue: 13, number: 103, base_sha: sha('9'), strategy: 'merge', outcome: 'pushed', head: sha('d'), files: ['src/totals.js'], waits_owner: true, reasons: ['money-path-reason'], detail: 'merged main' }, 'c');
  // 14: a light check running.
  open(14, 104, sha('e'));
  log.append('pr.ready', { issue: 14, number: 104, head: sha('e') }, 'c');
  log.append('light_check.started', { issue: 14, number: 104, head: sha('e'), main_sha: sha('7'), overlap: ['src/cart.js'] }, 'c');
  // 15: auto-merged, with the reasons it merged itself.
  open(15, 105, sha('8'));
  log.append('pr.ready', { issue: 15, number: 105, head: sha('8') }, 'c');
  log.append('merge.decided', { issue: 15, number: 105, head: sha('8'), auto: true, reasons: ['AUTO-REASON-docs-only'] }, 'c');
  log.append('merge.done', { issue: 15, number: 105, head: sha('8'), sha: sha('f'), url: 'https://example.test/commit/merge', title: 'Issue 15' }, 'c');
  log.append('merge.main_result', { issue: 15, number: 105, sha: sha('f'), outcome: 'green', failed: [] }, 'c');
  log.append('pr.closed', { issue: 15, number: 105, merged: true }, 'c');
  // 16: closed unmerged; 17: still a draft with checks running.
  open(16, 106, sha('3'));
  log.append('pr.closed', { issue: 16, number: 106, merged: false }, 'c');
  open(17, 107, sha('4'));
  // A refused push, a stop and resume, a hotspot hold, a stale-PR pass.
  log.append('issue.seen', seen(18, 'Too big'), 'c');
  log.append('push.refused', { issue: 18, head: sha('5'), stage: 'push', reasons: ['refused-900-lines'] }, 'c');
  log.append('merge.stopped', { reason: 'stop-main-red', number: 105, sha: sha('f'), revert: 'https://example.test/pr/200' }, 'c');
  log.append('merge.resumed', { detail: 'operator-cleared' }, 'c');
  log.append('issue.seen', seen(19, 'Round the discounts'), 'c');
  log.append('hotspot.held', { issue: 19, by: 13, files: ['src/totals.js', 'src/discounts.js'], reason: 'hotspot-why' }, 'c');
  log.append('pr_hygiene.pass', { merged_in: 1, conflicting: 0, closed: 0, held: 1, skipped: 0, prs: [{ number: 103, outcome: 'held', why: 'hygiene-why' }] }, 'c');
  // The auto-merge stop file, whose reason the writers' auto-merge card shows.
  writeFileSync(join(dir, 'auto-merge-stopped.json'), JSON.stringify({ reason: 'stopfile-reason-qq' }));
  return { dir, log };
}

const PHASES = { 101: 'waiting', 102: 'waiting', 103: 'waiting', 104: 'ready', 105: 'merged', 106: 'closed', 107: 'checks' };

test('a viewer\'s GET /api/prs: each PR\'s state only, none of the merge decision; the owner and a writer still get why', async () => {
  const { dir, log } = heldLog();
  const policy = join(dir, 'policy.yaml');
  writeFileSync(policy, 'version: 1\nbudget: { daily_usd: 20 }\nagents: { max_workers: 2 }\nland_mode: pr\nauto_merge: true\n');
  const { dir: root } = exampleProject();
  // 'odd-role' gets a role this code doesn't know: it must get the least, as a viewer does.
  const roleOf = async (login: string) => (login === 'odd-role' ? ('auditor' as Awaited<ReturnType<typeof exampleRoles>>) : exampleRoles(login));
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', roleOf, policyFile: policy, slotsDir: join(dir, 'slots') });
  try {
    const base = d.url.split('/?')[0]!;
    const get = (login: string, path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(login) } });
    // The viewer: the measurement the issue asks for first, then the fix.
    const res = await get('someone-else', '/api/prs');
    assert.equal(res.status, 200, 'a viewer still sees the PR list');
    const raw = await res.text();
    const shown = SECRETS.filter((s) => raw.includes(s));
    assert.deepEqual(shown, [], 'nothing of the merge decision, fix runs, conflicts, refused pushes, stops, holds or the stop file reaches a viewer');
    const v = JSON.parse(raw) as { prs: Record<string, unknown>[]; refused: unknown[]; stops: unknown[]; holds: unknown[]; hygiene: unknown; autoMerge: unknown; forViewer?: boolean };
    assert.deepEqual(Object.fromEntries(v.prs.map((p) => [p.number, p.phase])), PHASES, 'the state only: waiting, checks, ready, merged or closed');
    for (const p of v.prs) {
      assert.deepEqual([p.decision, p.waitReasons, p.status, p.gaveUp, p.fixes, p.conflict, p.lightCheck, p.mainResult, p.mergeFailed, p.unready, p.head], [null, [], null, null, [], null, null, null, null, null, ''], `PR ${p.number}: no decision or its detail`);
    }
    assert.deepEqual(v.prs.find((p) => p.number === 105)!.merged, { at: (v.prs.find((p) => p.number === 105)!.merged as { at: string }).at, sha: '', url: '', auto: false }, 'when it merged, not how');
    assert.deepEqual([v.refused, v.stops, v.holds, v.hygiene, v.autoMerge, v.forViewer], [[], [], [], null, null, true]);
    // The same viewer's other surfaces that show PRs don't carry them either (the rule this route now matches).
    for (const path of ['/api/state', '/api/events', '/api/board', '/api/decisions/pr-101', '/api/decisions/pr-105', '/api/waiting']) {
      const other = await get('someone-else', path);
      const body = await other.text();
      assert.ok(other.status === 200 || other.status === 403, `${path}: ${other.status}`);
      assert.deepEqual(SECRETS.filter((s) => body.includes(s)), [], `${path} for a viewer`);
    }
    // A role this code doesn't know gets the viewer's answer, never the writers'.
    const odd = await (await get('odd-role', '/api/prs')).text();
    assert.deepEqual(SECRETS.filter((s) => odd.includes(s)), [], 'an unknown role gets the least');
    assert.equal((JSON.parse(odd) as { forViewer?: boolean }).forViewer, true);
    // The owner and a writer: every reason, as before.
    for (const login of ['example-owner', 'example-collaborator']) {
      const w = (await (await get(login, '/api/prs')).json()) as { prs: PrView[]; refused: unknown[]; autoMerge: { stopped: string | null } | null; forViewer?: boolean };
      const held = w.prs.find((p) => p.number === 101)!;
      assert.deepEqual(held.waitReasons, ['L3-REVIEW-LEVEL', 'guard-category-secrets touched', 'changes src/billing/ledger.ts', 'POLICY-STATE-auto-off'], `${login} sees why it waits`);
      assert.equal(held.phase, 'waiting');
      assert.equal(w.prs.find((p) => p.number === 102)!.phase, 'gave_up');
      assert.equal(w.prs.find((p) => p.number === 105)!.phase, 'auto_merged');
      assert.equal(w.refused.length, 1);
      assert.equal(w.autoMerge?.stopped, 'stopfile-reason-qq');
      assert.equal(w.forViewer, undefined);
    }
  } finally {
    await d.close();
    log.close();
  }
});

test('the page as a viewer sees it: each PR\'s state, a note that the reasons and auto-merge are the writers\', never "no reason recorded"', async () => {
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const out = mkdtempSync(join(tmpdir(), 'prs-viewer-web-'));
  await build({ configFile: false, root: join(repoRoot, 'web'), logLevel: 'silent', plugins: [react()], ssr: { noExternal: true }, build: { ssr: join(repoRoot, 'web', 'src', 'render-check.tsx'), outDir: out, emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'render-check.mjs' } } } });
  const r = (await import(pathToFileURL(join(out, 'render-check.mjs')).href)) as { renderPrs(view: unknown): string };
  const { log } = heldLog();
  const full = prsView(log.read());
  log.close();
  // As the server sends it: through JSON.
  const viewer = r.renderPrs(JSON.parse(JSON.stringify(prsForViewer(full))));
  assert.deepEqual(SECRETS.filter((s) => viewer.includes(s)), [], 'nothing of why on the page');
  assert.match(viewer, /data-testid="prs-viewer-note"/);
  assert.doesNotMatch(viewer, /data-testid="prs-auto-merge"/, 'no auto-merge card, so no "off" it can\'t know');
  assert.doesNotMatch(viewer, /no reason recorded/, 'a held PR has reasons; the viewer is told they are the writers\'');
  assert.match(viewer, /data-pr="101"[^]*?owners and writers/);
  // The writers' page is as before: the reasons and the auto-merge card.
  const writer = r.renderPrs({ ...full, autoMerge: { on: false, policy: true, repo: true, stopped: 'stopfile-reason-qq', why: 'stopped: stopfile-reason-qq' } });
  assert.match(writer, /L3-REVIEW-LEVEL/);
  assert.match(writer, /data-testid="prs-auto-merge"/);
  assert.doesNotMatch(writer, /prs-viewer-note/);
});

test('the viewer\'s PR is built field by field: a field added to a PR later stays the writers\', and every phase maps to a viewer\'s', () => {
  const { log } = heldLog();
  const full = prsView(log.read());
  log.close();
  const extra = { ...full.prs[0]!, secretAddedLater: 'L3-REVIEW-LEVEL' } as PrView;
  assert.equal(Object.hasOwn(prForViewer(extra), 'secretAddedLater'), false, 'not on the list: not shown');
  assert.deepEqual(Object.keys(prsForViewer(full)).sort(), ['autoMerge', 'forViewer', 'holds', 'hygiene', 'prs', 'refused', 'stops']);
  const open = { state: 'open' as const, draft: false };
  assert.deepEqual(
    (['waiting', 'gave_up', 'fixing', 'resolving', 'light_check', 'checks', 'ready'] as const).map((phase) => viewerPhase({ ...open, phase })),
    ['waiting', 'waiting', 'ready', 'ready', 'ready', 'ready', 'ready'],
  );
  assert.equal(viewerPhase({ phase: 'fixing', state: 'open', draft: true }), 'checks', 'by draft, never "fixing"');
  assert.equal(viewerPhase({ phase: 'auto_merged', state: 'merged', draft: false }), 'merged', 'never "auto-merged"');
  // Fail closed: a phase or state this code doesn't know gives the least.
  assert.equal(viewerPhase({ phase: 'something_new' as PrView['phase'], state: 'open', draft: true }), 'checks');
  assert.equal(viewerPhase({ phase: 'waiting', state: 'reopened' as PrView['state'], draft: false }), 'closed');
});
