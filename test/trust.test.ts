// Trust, measured (src/merge-metrics.ts trustMetrics, src/trust.ts): each number from a fixture event log, the
// recommendation's thresholds, what a viewer sees, the weekly digest, and that nothing here can change slots, caps
// or merges (read-only measurement, docs/design.md's stage-3 waiver of 2026-10-13).
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { IntakeConfig, type IntakeSource } from '../src/intake/report.js';
import { trustMetrics, type AreaTrust, type MetricEvent } from '../src/merge-metrics.js';
import { FakeRunner } from '../src/runner.js';
import { agentAdvice, allowlistShows, TRUST_RULES, TRUST_SOURCES, trustDigest, trustForViewer, trustView, trustWeek, verificationAdvice } from '../src/trust.js';
import { VIEWER_EVENTS } from '../src/viewer-events.js';
import { asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const HOUR = 3_600_000;
let base = NOW;
const at = (daysAgo: number, hours = 0) => new Date(base.getTime() - daysAgo * 24 * HOUR + hours * HOUR).toISOString();
const ev = (ts: string, type: string, payload: object): MetricEvent => ({ ts, type, payload });
const sha = (c: string) => c.repeat(40).slice(0, 40);

/**
 * Eight merges over 30 days, four of which fail, one way each:
 * - #1 (money path) merged 10 days ago; a production report 4 days ago was fixed by #8 on the same file: escaped.
 * - #3 (other) merged 3 days ago; #7, a bug filed 2 days ago, fixed the same file a day ago: a fix PR followed.
 * - #4 (other) merged 2 days ago; the default branch went red on it an hour later, green two hours after: main red.
 * - #5 (other) merged 20 days ago; #6, "Revert ... #105", merged a day later: reverted.
 * And #2 (auth) merged 5 days ago and did not fail. Plus reviews, checks, test tiers and runs' costs.
 */
function fixture(now = NOW): MetricEvent[] {
  base = now;
  const merge = (issue: number, ts: string, title = `Change ${issue}`) => ev(ts, 'merge.done', { issue, number: 100 + issue, head: sha('e'), sha: sha(String(issue)), url: '', title });
  const files = (issue: number, ts: string, f: string[]) => ev(ts, 'change.proposed', { issue, files: f });
  const level = (issue: number, ts: string, reasons: string[]) => ev(ts, 'review.level_set', { issue, head: sha('e'), level: 'L2', reasons });
  return [
    level(1, at(11), ['money-path: src/pay.ts']),
    files(1, at(11), ['src/pay.ts']),
    merge(1, at(10)),
    level(2, at(6), ['auth: src/auth/login.ts']),
    files(2, at(6), ['src/auth/login.ts']),
    merge(2, at(5)),
    files(3, at(4), ['src/ui.ts']),
    ev(at(3), 'pr.closed', { issue: 3, number: 103, merged: true }),
    files(4, at(3), ['src/list.ts']),
    merge(4, at(2)),
    ev(at(2, 1), 'merge.main_result', { issue: 4, number: 104, sha: sha('4'), outcome: 'red', failed: ['ci'] }),
    ev(at(2, 3), 'merge.main_result', { issue: 9, number: 109, sha: sha('9'), outcome: 'green', failed: [] }),
    files(5, at(21), ['src/export.ts']),
    merge(5, at(20), 'Add export'),
    merge(6, at(19), 'Revert "Add export" (#105)'),
    ev(at(2), 'issue.seen', { issue: 7, title: 'The list is blank', labels: ['bug'], author: 'a', owner: null, actionable: true, why: '' }),
    files(7, at(1, -2), ['src/ui.ts']),
    merge(7, at(1)),
    ev(at(4), 'intake.filed', { id: 'r1', issue: 8, ready: true }),
    level(8, at(4), ['money-path: src/pay.ts']),
    files(8, at(4), ['src/pay.ts']),
    merge(8, at(4, 12)),
    // Reviews: #2's plan sent back, #4's approved, PR #103 rejected once.
    ev(at(6), 'plan.decided', { issue: 2, decision: 'd1', answer: 'revise', by: 'o', note: '' }),
    ev(at(3), 'plan.decided', { issue: 4, decision: 'd2', answer: 'approve', by: 'o', note: '' }),
    ev(at(3), 'correction.recorded', { key: 'k', kind: 'pr_rejected', issue: null, pr: 103, by: 'o', text: 'no' }),
    // Checks: "unit" failed then passed on one commit of #3 (flaky); passed once on #4 (2 min, the verify stage).
    ev(at(3, -2), 'check.result', { issue: 3, head: sha('a'), stage: 'pr', checks: [{ check: 'unit', status: 'fail', exitCode: 1 }] }),
    ev(at(3, -1), 'check.result', { issue: 3, head: sha('a'), stage: 'pr', checks: [{ check: 'unit', status: 'pass', exitCode: 0 }] }),
    ev(at(2, -1), 'check.result', { issue: 4, head: sha('b'), stage: 'verify', checks: [{ check: 'unit', status: 'pass', exitCode: 0, duration_ms: 120_000 }] }),
    // A test run on PR #101 (money path): the fast tier passed in 5 min and failed in 4 on the same commit.
    ev(at(10, -1), 'testrun.queued', { id: 't1', sha: sha('c'), kind: 'fast', prs: [101], shard: null }),
    ev(at(10, -1), 'testrun.tier', { id: 't1', tier: 'fast', ok: true, duration_ms: 300_000 }),
    ev(at(10, -1), 'testrun.tier', { id: 't1', tier: 'fast', ok: false, duration_ms: 240_000 }),
    // Costs: #1 $4 and 1.5k tokens, #2 $2 and 2k, a chat run $1 (no issue), #4's evaluator $0.5 over 10 min.
    ev(at(10, -2), 'run.cost', { issue: 1, role: 'worker', model: 'm', usd: 4, turns: 1, tokens_in: 1000, tokens_out: 500 }),
    ev(at(5, -2), 'run.cost', { issue: 2, role: 'worker', model: 'm', usd: 2, turns: 1, tokens_in: 2000, tokens_out: 0 }),
    ev(at(1), 'run.cost', { issue: null, role: 'chat', model: 'm', usd: 1, turns: 1 }),
    ev(at(2, -2), 'run.cost', { issue: 4, role: 'evaluator-verdict', model: 'm', usd: 0.5, turns: 1, secs: 600 }),
  ];
}

/** The fixture into a real event log, at its own times (append stamps now), oldest first. */
function seed(log: EventLog, now = NOW) {
  const insert = log.db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)');
  for (const e of [...fixture(now)].sort((a, b) => a.ts.localeCompare(b.ts))) insert.run(e.ts, e.type, 'coordinator', 'coordinator', JSON.stringify(e.payload));
}

const windows = () => {
  const m = trustMetrics(fixture(), { now: NOW });
  return { w7: m.windows.find((w) => w.days === 7)!, w30: m.windows.find((w) => w.days === 30)! };
};

test('merges and the change failure rate: each failure kind, by area and window', () => {
  const { w7, w30 } = windows();
  assert.equal(w30.total.merges, 8);
  assert.deepEqual([w30.byArea.money.merges, w30.byArea.auth.merges, w30.byArea.other.merges], [2, 1, 5]);
  assert.deepEqual(
    w30.failures.map((f) => [f.issue, f.area, f.kind, f.by]),
    [
      [5, 'other', 'reverted', 106],
      [4, 'other', 'main_red', null],
      [3, 'other', 'fix_followed', 107],
      [1, 'money', 'escaped', 108],
    ],
  );
  assert.equal(w30.total.failures, 4);
  assert.equal(w30.total.changeFailureRate, 0.5);
  assert.equal(w30.byArea.money.changeFailureRate, 0.5);
  assert.equal(w30.byArea.auth.changeFailureRate, 0);
  assert.equal(w30.byArea.other.changeFailureRate, 0.6);
  // The last 7 days: #2, #3, #4, #7, #8 merged; #3 and #4 of them failed.
  assert.equal(w7.total.merges, 5);
  assert.equal(w7.total.failures, 2);
  assert.equal(w7.total.changeFailureRate, 0.4);
});

test('escaped bugs: a production report traced to the merge that last changed its fix\'s files, by that merge\'s area', () => {
  const { w7, w30 } = windows();
  assert.equal(w30.total.escapedBugs, 1);
  assert.equal(w30.byArea.money.escapedBugs, 1);
  assert.equal(w30.escapedMoney, 1);
  assert.equal(w7.total.escapedBugs, 1, 'filed 4 days ago');
  // Untraced: the fix changed no file a harness merge had changed.
  const other = fixture().map((e) => (e.type === 'change.proposed' && (e.payload as { issue: number }).issue === 8 ? { ...e, payload: { issue: 8, files: ['src/new.ts'] } } : e));
  assert.equal(trustMetrics(other, { now: NOW }).windows[1]!.total.escapedBugs, 0);
});

test('time to restore: from a failure showing to its fix, its revert, or the default branch green again', () => {
  const { w7, w30 } = windows();
  assert.deepEqual([...w30.total.restoreHours!].sort((a, b) => a - b), [0, 2, 12, 24]);
  assert.equal(w30.total.medianRestoreHours, 7);
  assert.equal(w7.total.medianRestoreHours, 12, '2, 12 and 24 hours showed in the last 7 days');
  assert.equal(w30.byArea.money.medianRestoreHours, 12);
});

test('the revise/reject rate: issues a person sent back, of those they reviewed', () => {
  const { w30 } = windows();
  assert.equal(w30.total.reviewed, 8);
  assert.equal(w30.total.revisedOrRejected, 2, "#2's plan revised, PR #103 rejected");
  assert.equal(w30.total.reviseRejectRate, 0.25);
  assert.equal(w30.byArea.auth.reviseRejectRate, 1);
});

test('the flaky-check rate: a check or test tier that both passed and failed on one commit', () => {
  const { w30 } = windows();
  assert.equal(w30.total.checks, 3);
  assert.equal(w30.total.flakyChecks, 2);
  assert.equal(w30.total.flakyRate, 0.667);
  assert.equal(w30.byArea.money.flakyChecks, 1, "the test run was on #1's PR");
  assert.equal(w30.byArea.other.flakyRate, 0.5);
});

test('cost per merged PR, in dollars and tokens, from the runs\' cost records; runs on no issue only in the total', () => {
  const { w7, w30 } = windows();
  assert.deepEqual(w30.total.cost, { usd: 7.5, tokens: 3500, perMergedPrUsd: 0.94, perMergedPrTokens: 438 });
  assert.deepEqual(w30.byArea.money.cost, { usd: 4, tokens: 1500, perMergedPrUsd: 2, perMergedPrTokens: 750 });
  assert.deepEqual(w30.byArea.auth.cost, { usd: 2, tokens: 2000, perMergedPrUsd: 2, perMergedPrTokens: 2000 });
  assert.equal(w7.total.cost.usd, 3.5);
});

test('verification time per tier: test-run tiers, the verify checks and the evaluator, per area', () => {
  const { w7, w30 } = windows();
  assert.deepEqual(w30.total.verification, [
    { tier: 'evaluator', runs: 1, medianMinutes: 10, totalMinutes: 10 },
    { tier: 'test tier: fast', runs: 2, medianMinutes: 4.5, totalMinutes: 9 },
    { tier: 'verify checks', runs: 1, medianMinutes: 2, totalMinutes: 2 },
  ]);
  assert.deepEqual(w30.byArea.money.verification.map((t) => t.tier), ['test tier: fast']);
  assert.deepEqual(w30.byArea.other.verification.map((t) => t.tier), ['evaluator', 'verify checks']);
  assert.deepEqual(w7.total.verification.map((t) => t.tier), ['evaluator', 'verify checks'], 'the test run was 10 days ago');
});

const totals = (merges: number, cfr: number | null) => ({ merges, changeFailureRate: cfr }) as AreaTrust;

test('the agent recommendation: ready to raise only at 30+ merges, a change failure rate under 5% and no escaped money-path bug', () => {
  const advice = (merges: number, cfr: number | null, escapedMoney: number) => agentAdvice({ days: 30, total: totals(merges, cfr), escapedMoney }, 2);
  const raise = advice(30, 0.049, 0);
  assert.equal(raise.action, 'raise');
  assert.equal(raise.to, 3);
  assert.match(raise.text, /^Ready to raise to 3 agents: /);
  assert.match(raise.text, /stays a machine owner's action/);
  for (const [merges, cfr, escaped, why] of [
    [29, 0, 0, /at least 30 merges in 30 days \(29\)/],
    [30, 0.05, 0, /a change failure rate under 5% \(5%\)/],
    [30, 0, 1, /no escaped money-path bug \(1\)/],
    [30, null, 0, /a change failure rate under 5% \(–\)/],
  ] as const) {
    const a = advice(merges, cfr, escaped);
    assert.equal(a.action, 'keep', `${merges} merges, ${cfr}, ${escaped} escaped`);
    assert.equal(a.to, 2);
    assert.match(a.text, /^Keep 2 agents: not yet /);
    assert.match(a.text, why);
  }
  assert.equal(agentAdvice({ days: 30, total: totals(0, null), escapedMoney: 0 }, 1).text.startsWith('Keep 1 agent:'), true);
  assert.deepEqual(TRUST_RULES.raise, { days: 30, minMerges: 30, maxChangeFailureRate: 0.05 });
});

test('the verification advice per area: heavier where failures justify it, lighter only outside money path and auth', () => {
  const advise = (area: 'money' | 'auth' | 'other', merges: number, cfr: number | null, escapedBugs = 0) => {
    const blank = { merges: 0, changeFailureRate: null, escapedBugs: 0 };
    return verificationAdvice({ money: blank, auth: blank, other: blank, [area]: { merges, changeFailureRate: cfr, escapedBugs } }).find((x) => x.area === area)!.advice;
  };
  assert.equal(advise('money', 10, 0.1), 'heavier');
  assert.equal(advise('money', 10, 0.099), 'keep');
  assert.equal(advise('money', 9, 0.5), 'too_few');
  assert.equal(advise('auth', 3, 0, 1), 'heavier', 'an escaped bug is enough');
  assert.equal(advise('other', 20, 0.019), 'lighter');
  assert.equal(advise('other', 20, 0.02), 'keep');
  assert.equal(advise('other', 19, 0), 'keep');
  assert.equal(advise('money', 50, 0), 'keep', 'never lighter on the money path');
  assert.equal(advise('auth', 50, 0), 'keep', 'never lighter on auth');
});

test('a viewer sees only the figures the viewer-events allowlist permits, and never cost', () => {
  const full = trustView(fixture(), { agents: 2, now: NOW });
  const v = trustForViewer(full, VIEWER_EVENTS);
  const w30 = v.windows.find((w) => w.days === 30)!;
  // Merges are made of allowlisted fields (pr.closed, merge.done, land.result): shown. Nothing else is today.
  assert.equal(w30.total.merges, 8);
  for (const k of ['failures', 'changeFailureRate', 'escapedBugs', 'restoreHours', 'medianRestoreHours', 'reviewed', 'reviseRejectRate', 'flakyRate', 'verification', 'cost'] as const) assert.equal(w30.total[k], null, k);
  assert.equal(w30.byArea, null, "the area comes from the review level's reasons, which viewers don't get");
  assert.equal(w30.failures, null);
  assert.equal(v.agents, null);
  assert.equal(v.verification, null);
  assert.ok(v.hidden.includes('cost') && v.hidden.includes('failures') && v.hidden.includes('area'));
  assert.ok(!JSON.stringify(v).includes('"usd"'), 'no cost anywhere');
  // Everything allowlisted: every figure shown, and still never cost.
  const everything = Object.fromEntries(Object.values(TRUST_SOURCES).flatMap((s) => Object.entries(s)).map(([t]) => [t, [...new Set(Object.values(TRUST_SOURCES).flatMap((s) => s[t] ?? []))]]));
  const all = trustForViewer(full, everything);
  assert.equal(all.windows[1]!.total.changeFailureRate, 0.5);
  assert.notEqual(all.windows[1]!.byArea, null);
  assert.equal(all.agents?.action, 'keep');
  assert.equal(all.windows[1]!.total.cost, null);
  assert.deepEqual(all.hidden, ['cost']);
  assert.equal(allowlistShows({ 'review.level_set': ['issue', 'reasons'] }, VIEWER_EVENTS), false);
  assert.equal(allowlistShows({ 'pr.closed': ['issue', 'merged'] }, VIEWER_EVENTS), true);
});

test('the weekly digest: the 7- and 30-day numbers, by area, both recommendations, and that it changes nothing', () => {
  const text = trustDigest(trustView(fixture(), { agents: 2, now: NOW }), { instance: 'example', dashboardUrl: 'https://dash.example.test/' });
  assert.match(text, /^\*\*Trust, week of 2026-10-12: example\*\* \(last 7 \/ 30 days\)/);
  assert.match(text, /- Merged: 5 \/ 8/);
  assert.match(text, /- Change failure rate: 40% \/ 50%/);
  assert.match(text, /- Escaped bugs: 1 \/ 1 \(money path, 30 days: 1\)/);
  assert.match(text, /- Cost per merged PR \(estimates\): ~\$0\.70, 400 tokens \/ ~\$0\.94, 438 tokens/);
  assert.match(text, /- money path: 2 merged, failure rate 50%, ~\$2\.00\/PR, verification 5 min\/PR/);
  assert.match(text, /Agents: Keep 2 agents: not yet at least 30 merges/);
  assert.match(text, /Verification: Verify money path changes more heavily/);
  assert.match(text, /nothing here changes the agent count, the slots, the caps or any merge/);
  assert.match(text, /https:\/\/dash\.example\.test\/reports$/);
  assert.ok(text.length < 2000);
  assert.equal(trustWeek(new Date('2026-10-18T23:00:00Z')), '2026-10-12');
});

// --- Read-only: no write path -----------------------------------------------------------------------------------

/** Every module src/trust.ts reaches through its imports (type-only imports included), and every bare import. */
function importClosure(entry: string): { files: string[]; bare: string[] } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1] ?? m[2] ?? m[3]!;
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      else bare.add(spec);
    }
  };
  visit(entry);
  return { files: [...files].map((f) => f.slice(join(repoRoot, 'src').length + 1)).sort(), bare: [...bare].sort() };
}

test('no write path: the trust numbers and the panel\'s view import nothing that writes, runs a command or reaches out', () => {
  const { files, bare } = importClosure(join(repoRoot, 'src', 'trust.ts'));
  // Only the pure metrics: nothing from the slots, settings, merge flow, GitHub, the event log's writer, the OS layer.
  assert.deepEqual(files, ['merge-metrics.ts', 'trust.ts']);
  assert.deepEqual(bare, [], 'no node: module (fs, child_process, net, http) and no package');
  for (const f of files) {
    const src = readFileSync(join(repoRoot, 'src', f), 'utf8');
    assert.doesNotMatch(src, /\b(fetch|require|process\.|writeFile|appendFile|spawn|exec)\s*\(|process\.env/, `${f} reaches outside itself`);
  }
});

async function serve(user: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-trust-'));
  const log = new EventLog(join(dir, 'events.db'));
  // The server counts up to the real now: the fixture as of a minute ago.
  seed(log, new Date(Date.now() - 60_000));
  log.close();
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asPerson(user) } });
  return { d, call, eventsDb: join(dir, 'events.db') };
}

test('GET /api/trust: every figure for the owner and writers, the allowlisted ones for a viewer; any other method is refused and nothing changes', async () => {
  for (const user of ['example-owner', 'example-collaborator']) {
    const s = await serve(user);
    try {
      const t = (await (await s.call('/api/trust')).json()) as { windows: { days: number; total: { merges: number; cost: { usd: number } | null } }[]; agents: { text: string } | null; hidden: string[] };
      assert.equal(t.windows.find((w) => w.days === 30)!.total.merges, 8, `${user}: the merges, whenever they merged (fixture times are relative to a fixed day)`);
      assert.notEqual(t.windows[0]!.total.cost, null, `${user} sees cost`);
      assert.match(t.agents!.text, /^Keep 1 agent:|^Keep \d+ agents:/);
      assert.deepEqual(t.hidden, []);
    } finally {
      await s.d.close();
    }
  }
  const s = await serve('someone-else');
  try {
    const t = (await (await s.call('/api/trust')).json()) as { windows: { total: { merges: number | null; cost: unknown; changeFailureRate: unknown } }[]; agents: unknown; hidden: string[] };
    assert.equal(t.windows[0]!.total.cost, null, 'a viewer never sees cost');
    assert.equal(t.windows[0]!.total.changeFailureRate, null);
    assert.equal(typeof t.windows[0]!.total.merges, 'number');
    assert.equal(t.agents, null);
    assert.ok(t.hidden.includes('cost'));
  } finally {
    await s.d.close();
  }
  // Read-only: no method but GET, even for the owner, and the event log is the same after.
  const o = await serve('example-owner');
  try {
    const before = new EventLog(o.eventsDb).read(0).length;
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await o.call('/api/trust', { method, ...(method === 'DELETE' ? {} : { body: '{"agents":3}' }) })).status, 405, method);
    assert.equal(new EventLog(o.eventsDb).read(0).length, before);
  } finally {
    await o.d.close();
  }
});

// --- The weekly digest in the ops channel ----------------------------------------------------------------------

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function coordinator(ops: string | undefined, now: () => Date) {
  const base = mkdtempSync(join(tmpdir(), 'trust-digest-'));
  const repo = join(base, 'checkout');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const log = new EventLog(join(base, 'events.db'));
  seed(log);
  // A test run's per-test durations a day ago: the slow tests the metrics digest lists.
  const durations = { id: 'r1', tier: 'full', tests: [{ name: 'db > migrates', ms: 45_000 }, { name: 'ui > renders', ms: 1200 }], parsed: 2 };
  log.db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run(new Date(NOW.getTime() - 24 * HOUR).toISOString(), 'testrun.durations', 'coordinator', 'coordinator', JSON.stringify(durations));
  const stateDir = join(base, 'state');
  const slotsDir = join(base, 'slots');
  mkdirSync(stateDir);
  mkdirSync(slotsDir);
  const posts: { where: string; text: string }[] = [];
  const src: IntakeSource = { name: 'discord', take: async () => [], reply: async (t, text) => (posts.push({ where: t.id, text }), true), openThread: async () => '1', watch: () => {} };
  const config = IntakeConfig.parse({ version: 1, discord: { enabled: true, guild: '555555', channels: ['111111'], ...(ops ? { ops_channel: ops, dashboard_url: 'https://dash.example.test/' } : {}) } });
  const c = new Coordinator({
    cfg: loadConfig(repo),
    log,
    backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'),
    runner: new FakeRunner(() => ({ structured: { kind: 'needs_info' } })),
    repo,
    instance: 'example',
    stateDir,
    slotsDir,
    now,
    machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) },
    settings: () => ({ settings: {}, error: null }),
    intake: { config: () => config, sources: [src], pullMs: 0, roleOf: exampleRoles },
  });
  return { c, log, posts };
}

test('the weekly digest goes to the ops channel once a week, only when one is set, and records nothing but the post', async () => {
  const OPS = '300000000001';
  let now = NOW;
  const { c, log, posts } = coordinator(OPS, () => now);
  const none = coordinator(undefined, () => NOW);
  const [before, beforeNone] = [log.read(0).length, none.log.read(0).length];
  await c.checkIntake();
  await c.checkIntake();
  await none.c.checkIntake();
  await none.c.checkIntake();
  assert.equal(posts.length, 3, 'once this week: the trust digest, then the metrics and the slow tests');
  assert.ok(posts.every((p) => p.where === OPS));
  assert.match(posts[0]!.text, /^\*\*Trust, week of 2026-10-12: example\*\*/);
  assert.match(posts[0]!.text, /Change failure rate: 40% \/ 50%/);
  assert.match(posts[1]!.text, /^\*\*Metrics, week of 2026-10-12: example\*\*/);
  assert.match(posts[2]!.text, /^\*\*The 2 slowest tests\*\*, last 7 days \(median of 1 run; budget 30 s\):\n1\. 45 s `db > migrates`\n2\. 1\.2 s `ui > renders`\n\*\*Over the 30 s budget: 1\*\*\n- 45 s `db > migrates`$/);
  assert.equal(none.posts.length, 0, 'no ops channel: no digest');
  // What the digest added to the same passes: its post (before and after it is sent), nothing else.
  const added = log.read(0).slice(before);
  const plain = none.log.read(0).slice(beforeNone).map((e) => `${e.type} ${JSON.stringify(e.payload)}`);
  const extra = added.filter((e) => !plain.includes(`${e.type} ${JSON.stringify(e.payload)}`));
  assert.deepEqual(
    extra.map((e) => [e.type, (e.payload as { key: string }).key]),
    [
      ['discord.posting', 'trust-digest:2026-10-12'],
      ['discord.posted', 'trust-digest:2026-10-12'],
      ['discord.posting', 'metrics-digest:2026-10-12:0'],
      ['discord.posted', 'metrics-digest:2026-10-12:0'],
      ['discord.posting', 'metrics-digest:2026-10-12:1'],
      ['discord.posted', 'metrics-digest:2026-10-12:1'],
    ],
  );
  now = new Date(NOW.getTime() + 7 * 24 * HOUR);
  await c.checkIntake();
  assert.equal(posts.length, 6, 'and again the next week');
});
