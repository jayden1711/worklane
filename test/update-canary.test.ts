// The canary ties engine updates to a real end-to-end run: after every install (and once a day) a tiny issue is filed
// on a scratch-repo instance, and it must go issue -> plan -> PR -> green checks -> merged within the time limit.
// After an install, a canary that fails or runs out of time rolls the engine back (the migrations' backups, the old
// engine, the services restarted), holds the commit and raises a watchdog incident; one that passes keeps the update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canaryIssue, canaryProgress, canaryRefusal, canaryTask, checkCanary, fileCanary, machineCanaryInstance, type CanaryStatus } from '../src/canary.js';
import { checkDraftedIssue } from '../src/backlog/types.js';
import { needsPlan } from '../src/plan-mode.js';
import type { StoredEvent } from '../src/events/types.js';
import { heldUpdate, installedEngine, updateLog, updatesPanel, updateSettings, type UpdateEntry } from '../src/updates.js';
import { repoRoot } from './helpers.js';

type Inst = { unit: string; name: string; user: string; env: string[] };
const u = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as {
  run(deps: object): Promise<string>;
  canaryCommand(inst: Inst, sub: string, repo: string, extra: string[], opt?: string): string[];
  canaryConfig(cfg: unknown): { instance: string; repo: string; limitMs: number } | null;
  dailyDue(state: unknown, now: number): boolean;
  DAY_MS: number;
};

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const T0 = Date.parse('2026-10-13T03:00:00.000Z');
const MIN = 60_000;
const CANARY_REPO = 'example-org/canary-scratch';
const show = (name: string) => `User=wl-${name}\nEnvironment=PATH=/usr/local/bin:/usr/bin:/bin\nExecStart={ path=/usr/local/bin/worklane ; argv[]=/usr/local/bin/worklane coordinator run --instance ${name} ; ignore_errors=no }\n`;

/**
 * A machine with a real instance (alice) and the canary instance, both migrated by an update, and a fake canary
 * command: `file` files issue #n, `check` answers with whatever the test sets (`verdict`), or fails.
 */
function machine(o: { head?: string; limit?: number; fileFails?: boolean } = {}) {
  const calls: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const incidents: string[] = [];
  let engine = OLD;
  let head = o.head ?? NEW;
  let clock = T0;
  let held: { sha: string; at: string; failed: string[] } | null = null;
  let canary: { pending: unknown; lastFiledAt?: string } | null = null;
  let issue = 0;
  let verdict: CanaryStatus | 'error' = { state: 'pending', stage: 'filed', reason: 'waiting for the instance to take it', pr: null };
  const version: Record<string, number> = { alice: 1, canary: 1 };
  const running = new Set<string>();
  const units = ['worklane-alice.service', 'worklane-canary.service'];
  const deps = {
    config: () => ({ enabled: true, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'], canary: { instance: 'canary', repo: CANARY_REPO, ...(o.limit ? { time_limit_minutes: o.limit } : {}) } }),
    installed: () => engine,
    exec: (file: string, args: string[]) => {
      if (file === 'git') return `${head}\trefs/heads/main\n`;
      if (file === 'systemctl' && args[0] === 'list-units') return units.map((x) => `${x} loaded active running x`).join('\n');
      if (file === 'systemctl' && args[0] === 'show' && args[2] === 'User,Environment,ExecStart') return show(/worklane-([a-z]+)\./.exec(args[3]!)![1]!);
      if (file === 'systemctl' && args[0] === 'show') return running.has(args[3]!) ? 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n' : 'ActiveState=inactive\nSubState=dead\nNRestarts=0\nResult=success\n';
      if (file === 'systemctl' && (args[0] === 'restart' || args[0] === 'stop')) {
        calls.push(`${args[0]} ${args.length - 1}`);
        for (const x of args.slice(1)) (args[0] === 'restart' ? running.add(x) : running.delete(x));
        return '';
      }
      if (file === 'systemd-run' && args.includes('migrate')) {
        const name = args[args.indexOf('--instance') + 1]!;
        calls.push(`migrate ${name}`);
        version[name] = 2;
        return `${JSON.stringify({ ok: true, applied: [{ kind: 'state', path: `/srv/${name}/events.db`, from: 1, to: 2 }], made: [{ kind: 'state', path: `/srv/${name}/events.db`, backup: `/srv/${name}/events.db.bak` }] })}\n`;
      }
      if (file === 'systemd-run' && args.includes('canary')) {
        const sub = args[args.indexOf('canary') + 1]!;
        calls.push(`canary ${sub} as ${args[args.indexOf('-p') + 1]} on ${args.includes(`/opt/worklane/current/dist/src/cli.js`) ? 'current' : '?'}`);
        assert.equal(args[args.indexOf('--repo') + 1], CANARY_REPO, 'only ever the canary repo');
        if (sub === 'file') {
          if (o.fileFails) {
            const e = new Error('Command failed: systemd-run') as Error & { stdout: string };
            e.stdout = `${JSON.stringify({ ok: false, error: 'GitHub 403 forbidden: Resource not accessible by integration' })}\n`;
            throw e;
          }
          issue += 1;
          return `${JSON.stringify({ ok: true, issue, url: `https://github.com/${CANARY_REPO}/issues/${issue}`, id: 'x' })}\n`;
        }
        if (verdict === 'error') throw new Error('Command failed: systemd-run (exit 1)');
        return `${JSON.stringify({ ok: true, ...verdict })}\n`;
      }
      if (file === 'systemd-run' && args.includes('/bin/sh')) {
        const user = args[args.indexOf('-p') + 1]!.replace('User=wl-', '');
        calls.push(`restore ${user}`);
        version[user] = 1;
        return '';
      }
      if (file === 'systemd-run') return calls.push('build'), '';
      if (file === 'journalctl') return 'x';
      calls.push(`? ${file} ${args.join(' ')}`);
      return '';
    },
    fetchJson: async (url: string) => (url.includes('/compare/') ? { status: 'ahead', ahead_by: 1, behind_by: 0 } : { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', started_at: '1', id: 1 }] }),
    slots: () => [],
    alive: () => false,
    installTree: () => calls.push('installTree'),
    switchTo: (sha: string) => ((engine = sha), calls.push(`switchTo ${sha.slice(0, 4)}`)),
    now: () => clock,
    sleep: async (ms: number) => void (clock += ms),
    log: (e: Record<string, unknown>) => logs.push({ at: new Date(clock).toISOString(), ...e }),
    held: () => held,
    hold: (e: { sha: string; at: string; failed: string[] }) => void (held = e),
    configChangedAt: () => 0,
    note: (event: string, sha: string | null, reason: string) => (logs.push({ at: new Date(clock).toISOString(), event, to: sha, reason }), event),
    canaryState: () => canary,
    saveCanary: (s: { pending: unknown; lastFiledAt?: string }) => void (canary = JSON.parse(JSON.stringify(s))),
    raiseIncident: (kind: string, key: string, detail: string, fix: string) => void incidents.push(`raise ${kind} ${key}: ${detail} | ${fix}`),
    resolveIncident: (kind: string, key: string) => void incidents.push(`resolve ${kind} ${key}`),
  };
  return {
    deps,
    calls,
    logs,
    incidents,
    version,
    engine: () => engine,
    held: () => held,
    canary: () => canary,
    advance: (ms: number) => void (clock += ms),
    setHead: (sha: string) => void (head = sha),
    setVerdict: (v: CanaryStatus | 'error') => void (verdict = v),
    last: (event: string) => [...logs].reverse().find((l) => l.event === event) as (UpdateEntry & Record<string, unknown>) | undefined,
  };
}

const PR = { number: 7, url: `https://github.com/${CANARY_REPO}/pull/7` };
const PASSED: CanaryStatus = { state: 'passed', stage: 'merged', reason: 'PR #7 merged with 1 green check', pr: PR };
const FAILED: CanaryStatus = { state: 'failed', stage: 'pr', reason: 'PR #7 was closed without merging', pr: PR };

test('after an install, the canary is filed on the canary instance, as its user, with the engine just installed; no rollback yet', async () => {
  const m = machine();
  assert.equal(await u.run(m.deps), 'installed');
  assert.equal(m.engine(), NEW);
  assert.deepEqual(m.calls.filter((c) => c.startsWith('canary')), ['canary file as User=wl-canary on current']);
  assert.equal(m.last('installed')!.canary, 'pending');
  const filed = m.last('canary_filed')!;
  assert.equal(filed.trigger, 'update');
  assert.equal(filed.issue, 1);
  assert.equal(filed.to, NEW);
  assert.equal(filed.deadline, new Date(Date.parse(String(m.last('installed')!.at)) + 120 * MIN).toISOString(), 'the default time limit: 120 minutes');
  assert.equal(m.held(), null);
});

test('a failing canary after an update rolls back to the previous engine (backups restored), holds the commit and raises an incident', async () => {
  const m = machine();
  assert.equal(await u.run(m.deps), 'installed');
  m.advance(10 * MIN);
  m.setVerdict(FAILED);
  const before = m.calls.length;
  assert.equal(await u.run(m.deps), 'rolled_back');
  assert.deepEqual(m.calls.slice(before), ['canary check as User=wl-canary on current', 'stop 2', 'restore alice', 'restore canary', 'switchTo aaaa', 'restart 2']);
  assert.equal(m.engine(), OLD, 'the previous engine');
  assert.deepEqual(m.version, { alice: 1, canary: 1 }, "every migration's backup put back");
  assert.equal(m.held()!.sha, NEW);
  assert.match(m.held()!.failed[0]!, /^rollback: canary failed: PR #7 was closed without merging/);
  const rb = m.last('rolled_back')!;
  assert.equal(rb.from, NEW);
  assert.equal(rb.to, OLD);
  assert.equal(rb.held, true);
  assert.equal(rb.back, 'healthy');
  assert.deepEqual(rb.canary, { issue: 1, url: `https://github.com/${CANARY_REPO}/issues/1`, stage: 'pr', pr: PR });
  const failed = m.last('canary_failed')!;
  assert.equal(failed.duration_ms, 10 * MIN);
  assert.deepEqual(failed.pr, PR);
  assert.equal(m.incidents.length, 1);
  assert.match(m.incidents[0]!, /^raise canary_failed canary: the canary after installing bbbbbbbbbbbb failed: PR #7 was closed without merging; rolled back and held/);
  // The owner sees it held, and the held commit is not tried again.
  const log = m.logs as unknown as UpdateEntry[];
  assert.equal(heldUpdate(log)!.sha, NEW);
  assert.equal(await u.run(m.deps), 'held');
  assert.ok(!m.calls.slice(before + 6).includes('installTree'));
});

test('a passing canary keeps the update: no rollback, no hold, the incident resolved, the result logged with its PR and duration', async () => {
  const m = machine();
  assert.equal(await u.run(m.deps), 'installed');
  m.setVerdict({ state: 'pending', stage: 'pr', reason: 'PR #7 open', pr: PR });
  m.advance(10 * MIN);
  assert.equal(await u.run(m.deps), 'canary_pending');
  m.advance(15 * MIN);
  m.setVerdict(PASSED);
  assert.equal(await u.run(m.deps), 'canary_passed');
  assert.equal(m.engine(), NEW);
  assert.equal(m.held(), null);
  assert.ok(!m.calls.some((c) => c.startsWith('restore') || c === 'switchTo aaaa'));
  assert.deepEqual(m.incidents, ['resolve canary_failed canary']);
  const passed = m.last('canary_passed')!;
  assert.equal(passed.trigger, 'update');
  assert.equal(passed.duration_ms, 25 * MIN);
  assert.deepEqual(passed.pr, PR);
  assert.equal(m.canary()!.pending, null);
  assert.equal(heldUpdate(m.logs as unknown as UpdateEntry[]), null);
  // Back to normal: main is current, and today's canary already ran.
  assert.equal(await u.run(m.deps), 'current');
});

test('the time limit: a canary still pending at its deadline fails as timed out, and after an install that rolls back', async () => {
  const m = machine({ limit: 60 });
  assert.equal(await u.run(m.deps), 'installed');
  m.setVerdict({ state: 'pending', stage: 'pr', reason: 'PR #7 open: waiting for green checks and the merge', pr: PR });
  m.advance(59 * MIN);
  assert.equal(await u.run(m.deps), 'canary_pending', 'inside the limit it waits');
  assert.equal(m.engine(), NEW);
  // A broken check command counts as no progress, not as a pass.
  m.setVerdict('error');
  assert.equal(await u.run(m.deps), 'canary_pending');
  m.setVerdict({ state: 'pending', stage: 'pr', reason: 'PR #7 open: waiting for green checks and the merge', pr: PR });
  m.advance(2 * MIN);
  assert.equal(await u.run(m.deps), 'rolled_back');
  assert.equal(m.engine(), OLD);
  const failed = m.last('canary_failed')!;
  assert.equal(failed.timed_out, true);
  assert.match(String(failed.reason), /^timed out after 61 minutes at "pr": PR #7 open/);
  assert.match(m.held()!.failed[0]!, /^rollback: canary failed: timed out after 61 minutes/);
});

test('while a canary runs, no other update starts', async () => {
  const m = machine();
  assert.equal(await u.run(m.deps), 'installed');
  m.setHead('c'.repeat(40));
  const before = m.calls.length;
  assert.equal(await u.run(m.deps), 'canary_pending');
  assert.ok(!m.calls.slice(before).some((c) => c === 'installTree' || c === 'build'));
});

test("a canary that can't even be filed after an install fails at once and rolls back", async () => {
  const m = machine({ fileFails: true });
  assert.equal(await u.run(m.deps), 'rolled_back');
  assert.equal(m.engine(), OLD);
  assert.match(String(m.last('canary_failed')!.reason), /couldn't file the canary issue: GitHub 403 forbidden/);
  assert.equal(m.held()!.sha, NEW);
  assert.equal(m.incidents.length, 1);
});

test('the daily trigger: a canary on the engine as it is once a day; a failing one alerts but rolls nothing back', async () => {
  const m = machine({ head: OLD }); // main is what's installed: nothing to update
  assert.equal(await u.run(m.deps), 'canary_filed');
  assert.equal(m.last('canary_filed')!.trigger, 'daily');
  assert.equal(await u.run(m.deps), 'canary_pending');
  m.advance(20 * MIN);
  m.setVerdict(PASSED);
  assert.equal(await u.run(m.deps), 'canary_passed');
  assert.equal(m.last('canary_passed')!.trigger, 'daily');
  // Not again the same day.
  m.advance(23 * 60 * MIN);
  assert.equal(await u.run(m.deps), 'current');
  assert.equal(m.logs.filter((l) => l.event === 'canary_filed').length, 1);
  // A day after the last one was filed: the next.
  m.advance(40 * MIN);
  m.setVerdict(FAILED);
  assert.equal(await u.run(m.deps), 'canary_filed');
  assert.equal(await u.run(m.deps), 'canary_failed');
  assert.equal(m.engine(), OLD);
  assert.equal(m.held(), null, 'a daily canary never holds a commit');
  assert.ok(!m.calls.some((c) => c.startsWith('switchTo') || c.startsWith('restore')));
  assert.match(m.incidents.at(-1)!, /^raise canary_failed canary: the daily canary failed: PR #7 was closed without merging/);
  assert.ok(u.dailyDue(null, T0), 'never filed: due');
  assert.ok(!u.dailyDue({ lastFiledAt: new Date(T0).toISOString() }, T0 + u.DAY_MS - 1));
  assert.ok(u.dailyDue({ lastFiledAt: new Date(T0).toISOString() }, T0 + u.DAY_MS));
});

test('no canary configured: an install is final at once, as before', async () => {
  const m = machine();
  const deps = { ...m.deps, config: () => ({ ...m.deps.config(), canary: undefined }) };
  assert.equal(await u.run(deps), 'installed');
  assert.ok(!m.calls.some((c) => c.startsWith('canary')));
  assert.equal(m.last('installed')!.canary, undefined);
  assert.equal(await u.run(deps), 'current');
});

test("the canary config and command: a plain instance name and owner/repo only; run as the canary's user with the installed engine", () => {
  assert.deepEqual(u.canaryConfig({ canary: { instance: 'canary', repo: CANARY_REPO } }), { instance: 'canary', repo: CANARY_REPO, limitMs: 120 * MIN });
  assert.equal(u.canaryConfig({ canary: { instance: 'canary', repo: CANARY_REPO, time_limit_minutes: 45 } })!.limitMs, 45 * MIN);
  assert.equal(u.canaryConfig({ canary: { instance: 'x;rm', repo: CANARY_REPO } }), null);
  assert.equal(u.canaryConfig({ canary: { instance: 'canary', repo: 'not a repo' } }), null);
  const cmd = u.canaryCommand({ unit: 'worklane-canary.service', name: 'canary', user: 'wl-canary', env: [] }, 'check', CANARY_REPO, ['--issue', '4']);
  assert.deepEqual(cmd.slice(0, 7), ['systemd-run', '--wait', '--collect', '--pipe', '--quiet', '-p', 'User=wl-canary']);
  assert.deepEqual(cmd.slice(-12), ['/usr/bin/env', 'node', '/opt/worklane/current/dist/src/cli.js', 'canary', 'check', '--instance', 'canary', '--repo', CANARY_REPO, '--issue', '4', '--json']);
});

// ---------- the engine's half: src/canary.ts ----------

test('the canary issue is a valid five-part issue the instance takes as it is, and plans first', () => {
  const c = canaryIssue('update', new Date('2026-10-13T03:04:00Z'));
  assert.equal(c.id, 'update-202610130304');
  const checked = checkDraftedIssue(c.title, c.body);
  assert.ok(checked.ok, JSON.stringify(checked));
  assert.ok(c.labels.includes('ready'));
  assert.ok(needsPlan(c.labels), 'a plan before the build');
  assert.match(c.body, /grep -qx "canary update-202610130304" CANARY\.md/);
});

test('the canary never works on a real repo: only the repo the machine config names, and never one another instance runs on', () => {
  const base = { instance: 'canary', instanceRepo: CANARY_REPO, canaryRepo: CANARY_REPO, others: [{ name: 'canary', repo: CANARY_REPO }] };
  assert.equal(canaryRefusal(base), null);
  assert.match(canaryRefusal({ ...base, instanceRepo: 'example-org/product' })!, /runs on example-org\/product, not the canary repo/);
  assert.match(canaryRefusal({ ...base, others: [...base.others, { name: 'product', repo: CANARY_REPO.toUpperCase() }] })!, /also the repo of product/);
  assert.match(canaryRefusal({ ...base, canaryRepo: '' })!, /not owner\/repo/);
});

const ev = (id: number, type: string, payload: Record<string, unknown>) => ({ id, ts: '', type, actor: 'c', source: 'coordinator', payload }) as unknown as StoredEvent;

test("how far the canary got, from the instance's own events; a merged PR counts only with every check green and GitHub agreeing", async () => {
  const p = (events: StoredEvent[], extra: object = {}) => canaryProgress({ issue: 4, repo: CANARY_REPO, events, ...extra });
  const seen = ev(1, 'issue.seen', { issue: 4, actionable: false, why: 'opened by canary-app[bot] (not a writer) and no writer added ready' });
  assert.deepEqual([p([]).state, p([]).stage], ['pending', 'filed']);
  assert.match(p([seen]).reason, /^not taken: opened by canary-app\[bot\] \(not a writer\)/, 'says why it is not taken');
  const claimed = ev(2, 'issue.claimed', { issue: 4 });
  const plan = ev(3, 'plan.posted', { issue: 4, held: false, reasons: [] });
  const opened = ev(4, 'pr.opened', { issue: 4, number: 7, url: PR.url, head: 'c'.repeat(40), draft: false });
  const merged = ev(5, 'pr.closed', { issue: 4, number: 7, merged: true });
  assert.equal(p([claimed]).stage, 'taken');
  assert.equal(p([claimed, plan]).stage, 'planned');
  assert.equal(p([claimed, plan, opened]).stage, 'pr');
  assert.deepEqual(p([claimed, plan, opened]).pr, PR);
  assert.equal(p([claimed, plan, opened, merged]).stage, 'checks');
  assert.equal(p([claimed, plan, ev(3, 'plan.posted', { issue: 4, held: true, reasons: ['changes the merge policy'] })]).state, 'failed');
  assert.equal(p([claimed, plan, opened, ev(5, 'pr.closed', { issue: 4, number: 7, merged: false })]).state, 'failed');
  assert.match(p([claimed, plan, ev(4, 'pr.opened', { issue: 4, number: 7, url: 'https://github.com/example-org/product/pull/7', head: 'c'.repeat(40), draft: false })]).reason, /not in the canary repo/);
  assert.equal(p([ev(2, 'issue.claimed', { issue: 5 })]).stage, 'filed', "another issue's events don't count");
  // GitHub's word once merged: checks on the head, all green.
  const all = [claimed, plan, opened, merged];
  const gh = (state: string, checks: { name: string; status: string; conclusion: string | null }[]) => {
    const asked: string[] = [];
    const backlog = {
      pullRequest: async (n: number) => (asked.push(`pr ${n}`), { number: n, url: PR.url, head: 'b', headSha: 'c'.repeat(40), base: 'main', draft: false, state, title: 't', mergeable: null, mergeableState: 'unknown' }),
      checks: async (sha: string) => (asked.push(`checks ${sha.slice(0, 4)}`), checks.map((c) => ({ ...c, source: 'check_run' }))),
    };
    return { backlog: backlog as never, asked };
  };
  const green = gh('merged', [{ name: 'test', status: 'completed', conclusion: 'success' }]);
  const ok = await checkCanary(green.backlog, CANARY_REPO, 4, all);
  assert.deepEqual([ok.state, ok.stage, ok.reason], ['passed', 'merged', 'PR #7 merged with 1 green check']);
  assert.deepEqual(green.asked, ['pr 7', 'checks cccc']);
  assert.equal((await checkCanary(gh('merged', [{ name: 'test', status: 'completed', conclusion: 'failure' }]).backlog, CANARY_REPO, 4, all)).state, 'failed');
  assert.match((await checkCanary(gh('merged', []).backlog, CANARY_REPO, 4, all)).reason, /no checks on its head/);
  assert.match((await checkCanary(gh('closed', []).backlog, CANARY_REPO, 4, all)).reason, /GitHub says closed/);
  const early = gh('merged', []);
  assert.equal((await checkCanary(early.backlog, CANARY_REPO, 4, [claimed, plan, opened])).state, 'pending');
  assert.deepEqual(early.asked, [], 'GitHub is asked only once the instance recorded the merge');
});

test('filing the canary: the canary label made, then the issue on the canary repo with its labels', async () => {
  const calls: string[] = [];
  const backlog = { ensureLabels: async (l: { name: string }[]) => (calls.push(`labels ${l.map((x) => x.name).join(',')}`), []), createIssue: async (title: string, _b: string, labels: string[]) => (calls.push(`issue ${title} [${labels.join(',')}]`), 12) };
  const r = await fileCanary(backlog as never, CANARY_REPO, 'daily', new Date('2026-10-13T03:04:00Z'));
  assert.deepEqual(r, { issue: 12, url: `https://github.com/${CANARY_REPO}/issues/12`, id: 'daily-202610130304' });
  assert.deepEqual(calls, ['labels canary', 'issue Canary daily-202610130304: add one line to CANARY.md [ready,size:M,canary]']);
});

// ---------- the Updates panel's data ----------

test("the Updates panel's data: installed engine, last install, the rollback held because the canary failed, the canary's last result", () => {
  const dir = mkdtempSync(join(tmpdir(), 'upd-panel-'));
  const at = (min: number) => new Date(T0 + min * MIN).toISOString();
  const lines = [
    { at: at(0), event: 'installed', from: OLD, to: NEW, canary: 'pending' },
    { at: at(0), event: 'canary_filed', trigger: 'update', reason: 'the post-update canary: issue #1', issue: 1, url: `https://github.com/${CANARY_REPO}/issues/1`, to: NEW, deadline: at(120) },
    { at: at(121), event: 'canary_failed', trigger: 'update', issue: 1, url: `https://github.com/${CANARY_REPO}/issues/1`, stage: 'pr', reason: 'timed out after 121 minutes at "pr": PR #7 open', pr: PR, duration_ms: 121 * MIN, to: NEW, timed_out: true },
    { at: at(122), event: 'rolled_back', from: NEW, to: OLD, reason: 'rollback: canary failed: timed out after 121 minutes', canary: { issue: 1, url: null, stage: 'pr', pr: PR }, held: true, back: 'healthy' },
  ];
  writeFileSync(join(dir, 'log'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  writeFileSync(join(dir, 'updates.json'), JSON.stringify({ enabled: true, repo_url: 'x', canary: { instance: 'canary', repo: CANARY_REPO, time_limit_minutes: 90 } }));
  const settings = updateSettings(join(dir, 'updates.json'));
  assert.deepEqual(settings!.canary, { instance: 'canary', repo: CANARY_REPO, timeLimitMinutes: 90 });
  const panel = updatesPanel(updateLog(join(dir, 'log')), settings, { sha: OLD, version: '0.4.1' });
  assert.deepEqual(panel.installed, { sha: OLD, version: '0.4.1' });
  assert.deepEqual(panel.lastInstall, { at: at(0), from: OLD, to: NEW });
  assert.deepEqual(panel.rollback, { at: at(122), sha: NEW, reason: 'rollback: canary failed: timed out after 121 minutes', held: true, canary: true });
  assert.equal(panel.canary.running, null);
  assert.deepEqual(panel.canary.last, { at: at(121), passed: false, trigger: 'update', stage: 'pr', why: 'timed out after 121 minutes at "pr": PR #7 open', durationMs: 121 * MIN, timedOut: true, issue: { number: 1, url: `https://github.com/${CANARY_REPO}/issues/1` }, pr: PR, sha: NEW });
  // A later install ends the rollback; a daily canary filed since shows as running.
  const later = [...updateLog(join(dir, 'log')), { at: at(600), event: 'installed', from: OLD, to: 'c'.repeat(40) } as UpdateEntry, { at: at(601), event: 'canary_filed', trigger: 'daily', issue: 2, url: 'u', deadline: at(721) } as UpdateEntry];
  const p2 = updatesPanel(later, settings, { sha: null, version: null });
  assert.equal(p2.rollback, null);
  assert.deepEqual(p2.canary.running, { at: at(601), trigger: 'daily', issue: 2, url: 'u', deadline: at(721) });
  assert.equal(updatesPanel([], null, { sha: null, version: null }).configured, false);
});

test('the installed engine: its version from its package.json, its commit from the current link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-'));
  const sha = 'd'.repeat(40);
  mkdirSync(join(dir, sha));
  writeFileSync(join(dir, sha, 'package.json'), JSON.stringify({ version: '9.8.7' }));
  assert.deepEqual(installedEngine(join(dir, sha)), { sha: null, version: '9.8.7' }, 'not a link: the version only');
  assert.deepEqual(installedEngine(join(dir, 'missing')), { sha: null, version: null });
  if (process.platform === 'win32') return; // the updater's link is a Linux machine's
  symlinkSync(join(dir, sha), join(dir, 'current'));
  assert.deepEqual(installedEngine(join(dir, 'current')), { sha, version: '9.8.7' });
});

test("the canary instance takes its own App's canary issue (an App can't be a writer); nothing else changes who is taken", () => {
  const bot = 'example-canary[bot]';
  const issue = { author: bot, labels: ['ready', 'size:M', 'canary'], state: 'open' as const };
  const on = { instance: 'canary', canaryInstance: 'canary', bot };
  assert.deepEqual(canaryTask(issue, on), { actionable: true, why: "the machine's canary, opened by this instance's App example-canary[bot]" });
  assert.equal(canaryTask(issue, { ...on, instance: 'product' }), null, 'not on any other instance');
  assert.equal(canaryTask(issue, { ...on, canaryInstance: null }), null, 'not without a canary in the machine config');
  assert.equal(canaryTask({ ...issue, author: 'someone-else' }, on), null, "only its own App's");
  assert.equal(canaryTask({ ...issue, author: 'other-app[bot]' }, on), null, 'not another App');
  assert.equal(canaryTask({ ...issue, labels: ['ready', 'size:M'] }, on), null, 'only a canary issue');
  assert.equal(canaryTask({ ...issue, labels: ['canary'] }, on), null, 'only a ready one');
  assert.equal(canaryTask({ ...issue, state: 'closed' }, on), null);
  assert.equal(canaryTask(issue, { ...on, bot: 'Example Harness' }), null, 'a custom commit identity is not an App');
  const dir = mkdtempSync(join(tmpdir(), 'canary-cfg-'));
  writeFileSync(join(dir, 'updates.json'), JSON.stringify({ enabled: true, canary: { instance: 'canary', repo: CANARY_REPO } }));
  assert.equal(machineCanaryInstance(join(dir, 'updates.json')), 'canary');
  assert.equal(machineCanaryInstance(join(dir, 'none.json')), null);
});
