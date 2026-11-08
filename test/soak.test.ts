// The soak test (docs/soak.md). On every PR it runs SOAK_TICKS (12) coordinator ticks as a smoke test of the driver; the
// soak workflow (.github/workflows/soak.yml) runs it for SOAK_HOURS (1 to 5.5, on GitHub-hosted runners) and keeps its report.
// The coordinator is the real one, on a scratch repo with a local remote; the agents are stand-ins (no spend), and a
// new task is filed every SOAK_ISSUE_EVERY_S. Every SOAK_SAMPLE_S it records what the process holds; src/soak.ts
// judges the samples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { slotStatus } from '../src/slots.js';
import { SOAK_LIMITS, openRunsOf, soakVerdict, theilSen, type SoakSample } from '../src/soak.js';
import { commitAll, coordinator, easyIssue, fixture, readAll, skip } from './repro-state-graph/harness.js';
import { repoRoot } from './helpers.js';

const MB = 2 ** 20;
const sample = (at: number, o: Partial<SoakSample> = {}): SoakSample => ({ at, rss: 200 * MB, heapUsed: 80 * MB, fds: 40, eventsBytes: 1_000_000 + at, walBytes: MB, tickMs: 50, tasksDone: Math.floor(at / 60_000), filed: Math.floor(at / 60_000) + 1, openRuns: 0, oldestOpenRunMs: 0, slotsHeld: 0, ...o });
/** Samples every minute for `minutes`, with `f` changing each by its minute. */
const series = (minutes: number, f: (m: number) => Partial<SoakSample> = () => ({})) => Array.from({ length: minutes }, (_, m) => sample(m * 60_000, f(m)));

test('soak verdict: steady samples pass, with what was measured', () => {
  const v = soakVerdict(series(120));
  assert.deepEqual(v.failures, []);
  assert.equal(v.measured.tasks_done, 119);
  assert.equal(v.measured.heap_growth, '0.0 MB');
});

test('soak verdict: each failure it is there for (a leak of heap, RSS or handles; a stuck run; leaked slots; log growth; WAL; drift; no work)', () => {
  const fails = (s: SoakSample[]) => soakVerdict(s).failures.join(' | ');
  assert.match(fails(series(120, (m) => ({ heapUsed: 80 * MB + m * 2 * MB }))), /^leak: the heap grew/);
  assert.match(fails(series(120, (m) => ({ rss: 200 * MB + m * 4 * MB }))), /leak: RSS grew/);
  assert.match(fails(series(120, (m) => ({ fds: 40 + m }))), /leak: open file handles grew by/);
  assert.match(fails([...series(119), sample(119 * 60_000, { openRuns: 1, oldestOpenRunMs: 45 * 60_000, slotsHeld: 1 })]), /^stuck: 1 agent run\(s\) open at minute 119, the oldest for 45 min/);
  assert.match(fails([...series(119), sample(119 * 60_000, { slotsHeld: 2 })]), /leaked slots: 2 agent slot\(s\) held at minute 119 with 0 run\(s\) open/);
  assert.match(fails(series(120, (m) => ({ eventsBytes: 1_000_000 + m * 400 * 1024 }))), /log growth: the event log grew \d+ KB per finished task/);
  assert.match(fails(series(120, (m) => ({ walBytes: m === 60 ? 80 * MB : MB }))), /the WAL reached 80\.0 MB/);
  assert.match(fails(series(120, (m) => ({ tickMs: m < 60 ? 50 : 400 }))), /^drift: the median tick went from 50 ms to 400 ms/);
  assert.match(fails(series(120, () => ({ tasksDone: 0 }))), /too little work: 0 task\(s\) finished/);
  assert.match(fails(series(3)), /only 3 sample\(s\)/);
  // The warm-up is left out: a heap that fills its caches in the first minutes, then holds, is no leak.
  assert.deepEqual(soakVerdict(series(40, (m) => ({ heapUsed: m < 9 ? 20 * MB : 300 * MB }))).failures, []);
  assert.match(soakVerdict(series(40, (m) => ({ heapUsed: m < 9 ? 20 * MB : 300 * MB })), { ...SOAK_LIMITS, warmupMs: 0 }).failures.join(), /leak: the heap grew/, 'the same samples judged with no warm-up: a leak');
  // A run open at the end, however young, never finished: the driver samples after idle(), with nothing in flight
  // (#1181 review R1181d: an orphaned run.started hid one leaked slot each).
  assert.match(soakVerdict([...series(119), sample(119 * 60_000, { openRuns: 1, oldestOpenRunMs: 60_000, slotsHeld: 1 })]).failures.join(), /^never finished: 1 agent run\(s\) started and not finished at the end/);
});

test('open runs: a finish closes its own run, never another; a run stuck while hundreds of others finish out of order is the oldest (#1181 review, 1)', () => {
  const t0 = Date.parse('2026-11-08T00:00:00.000Z');
  const ts = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const ev = (type: string, issue: number, role: string, min: number) => ({ type, ts: ts(min), payload: { issue, role } });
  // Run 1 starts and never finishes (its slot held); 599 later runs start and finish, each a minute or less apart.
  const events = [ev('run.started', 1, 'worker', 0)];
  for (let i = 2; i <= 600; i++) events.push(ev('run.started', i, 'worker', i / 2), ev('run.finished', i, 'worker', i / 2 + 0.25));
  const now = t0 + 330 * 60_000;
  assert.deepEqual(openRunsOf(events, now), { open: 1, oldestMs: 330 * 60_000 });
  // Out of order: B finishes before A; A is the one still open, and its age is A's.
  assert.deepEqual(openRunsOf([ev('run.started', 7, 'worker', 0), ev('run.started', 8, 'worker', 10), ev('run.finished', 8, 'worker', 11)], t0 + 60 * 60_000), { open: 1, oldestMs: 60 * 60_000 });
  // The same issue's worker and evaluator are two runs; a finish with no start closes nothing.
  assert.equal(openRunsOf([ev('run.started', 3, 'worker', 0), ev('run.finished', 3, 'evaluator', 1), ev('run.finished', 9, 'worker', 2)], t0 + 5 * 60_000).open, 1);
  assert.deepEqual(openRunsOf([], now), { open: 0, oldestMs: 0 });
  // And so the verdict: that stuck run and its slot fail the soak.
  const r = openRunsOf(events, now);
  assert.match(soakVerdict([...series(329), sample(329 * 60_000, { openRuns: r.open, oldestOpenRunMs: r.oldestMs, slotsHeld: 1 })]).failures.join(), /^stuck: 1 agent run\(s\) open at minute 329, the oldest for 330 min/);
});

test('soak verdict: a late leak and a linear one just over the limit both fail; the end is judged, not only quarter medians (#1181 review, 2)', () => {
  // 5.5 h, a sample a minute. The heap jumps by 1.5 GB in the last 35 minutes: no quarter median moves, the end does.
  const late = series(330, (m) => (m >= 295 ? { heapUsed: 1600 * MB, rss: 1800 * MB } : {}));
  assert.match(soakVerdict(late).failures.join(' | '), /leak: the heap grew 1520\.0 MB .*\| leak: RSS grew 1600\.0 MB/);
  // A linear 165 MB over the run after the warm-up (limit 128 MB): quarter medians read ~124 MB, the end reads more.
  const linear = series(330, (m) => ({ heapUsed: 80 * MB + Math.max(0, m - 10) * (165 * MB) / 320 }));
  assert.match(soakVerdict(linear).failures.join(), /^leak: the heap grew 16\d\.\d MB/, 'read whole, by its slope');
  // A heap that rises and falls back (a GC) by the end, and one that only rises within the limit, still pass.
  assert.deepEqual(soakVerdict(series(330, (m) => (m >= 200 && m < 280 ? { heapUsed: 400 * MB } : {}))).failures, []);
  assert.deepEqual(soakVerdict(series(330, (m) => ({ heapUsed: 80 * MB + Math.max(0, m - 10) * (60 * MB) / 320 }))).failures, []);
});

test('soak verdict: a coordinator that stops landing work fails, however fast its ticks (#1181 review, 3)', () => {
  // Landing stops at task 15 while a task is filed every 30 s for 5.5 h.
  const stopped = series(330, (m) => ({ tasksDone: Math.min(15, m), filed: 2 * m + 1, eventsBytes: 1_000_000 + Math.min(15, m) * 1000 }));
  const f = soakVerdict(stopped).failures.join(' | ');
  assert.match(f, /stalled: no task landed in the last quarter \(\d+ filed in it; 15 landed in all\)/);
  assert.match(f, /too little work: 15 of 659 task\(s\) filed landed \(at least 50%\)/);
  // Slower than filing, but still landing to the end and over half of it: no stall.
  assert.deepEqual(soakVerdict(series(330, (m) => ({ tasksDone: m, filed: Math.ceil(m * 1.6) + 1 }))).failures, []);
  // Nothing filed in the last quarter (the driver stopped filing): nothing to land, no stall.
  assert.deepEqual(soakVerdict(series(330, (m) => ({ tasksDone: Math.min(200, m), filed: Math.min(200, m) + 1 }))).failures, []);
});

test('soak verdict: a run too short to judge, or shorter than asked, fails; never judged on its warm-up (#1181 review, 4)', () => {
  // hours=0.07 or 0.1: 5 or 6 one-minute samples, every one in the 10-minute warm-up.
  for (const n of [5, 6, 10]) assert.match(soakVerdict(series(n)).failures.join(), /^too short: 0 sample\(s\) after the 10-minute warm-up \(at least 4\): nothing was judged$/, `${n} samples`);
  assert.match(soakVerdict(series(13)).failures.join(), /^too short: 3 sample\(s\) after/);
  assert.deepEqual(soakVerdict(series(14)).failures, [], 'four past the warm-up: judged');
  // Asked for 5.5 h, stopped at 2 h: too short; at 5.4 h (the last sample a minute before the end): fine.
  assert.match(soakVerdict(series(120), SOAK_LIMITS, { expectedMs: 5.5 * 3600_000 }).failures.join(), /too short: it ran 1\.98 h of the 5\.50 h asked for/);
  assert.deepEqual(soakVerdict(series(330), SOAK_LIMITS, { expectedMs: 5.5 * 3600_000 - 60_000 }).failures, []);
});

test('soak verdict: open file handles are judged over the samples that counted them; mostly uncounted fails (#1181 review, 5a)', () => {
  // One uncounted sample of 330, and a 240-handle leak: still a leak.
  assert.match(soakVerdict(series(330, (m) => ({ fds: m === 100 ? null : 40 + Math.floor((m * 240) / 330) }))).failures.join(), /^leak: open file handles grew by/);
  // Half uncounted, half counting a leak: a leak.
  assert.match(soakVerdict(series(120, (m) => ({ fds: m % 2 ? null : 40 + m }))).failures.join(), /^leak: open file handles grew by/);
  // Most, or all, uncounted: a failure saying so, never a pass.
  assert.match(soakVerdict(series(120, (m) => ({ fds: m % 3 ? null : 40 }))).failures.join(), /^open file handles not counted in \d+ of 110 sample\(s\)/);
  assert.match(soakVerdict(series(120, () => ({ fds: null }))).failures.join(), /not counted in 110 of 110/);
  assert.deepEqual(soakVerdict(series(120, (m) => ({ fds: m === 50 ? null : 40 }))).failures, [], 'steady, one uncounted: fine');
});

test('the soak workflow: schedule and dispatch only, read-only, on GitHub-hosted runners, 1 to 5.5 h, and green only on a verdict with no failure (#1181 review, 5b)', async () => {
  const { parse } = await import('yaml');
  const text = readFileSync(join(repoRoot, '.github', 'workflows', 'soak.yml'), 'utf8');
  const w = parse(text) as { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, { 'runs-on': unknown; permissions?: unknown; 'continue-on-error'?: unknown; steps: { uses?: string; with?: Record<string, unknown>; run?: string; name?: string; 'continue-on-error'?: unknown }[] }> };
  assert.deepEqual(Object.keys(w.on).sort(), ['schedule', 'workflow_dispatch'], 'never on a pull request or a push');
  assert.deepEqual(w.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(w.jobs), ['soak']);
  const job = w.jobs.soak!;
  assert.equal(job['runs-on'], 'ubuntu-latest');
  // No job-level permissions: they would override the read-only top level (#1181 review R1181c).
  assert.equal(job.permissions, undefined, 'the job takes the top-level read-only token');
  assert.equal(job['continue-on-error'], undefined, 'a failed soak fails the job');
  assert.doesNotMatch(text, /secrets\./);
  assert.deepEqual(job.steps.find((s) => s.uses?.startsWith('actions/checkout@'))?.with, { 'persist-credentials': false }, 'no token left in .git/config');
  const run = job.steps.find((s) => s.name === 'soak')!.run!;
  assert.match(run, /exit !\(h >= 1 && h <= 5\.5\)/, 'hours from 1 to 5.5');
  // The gitleaks download rides out a release-download 504 (#1201), and its sha256 is still checked after it.
  const gitleaks = job.steps.find((s) => s.name === 'install gitleaks')!.run!;
  assert.match(gitleaks, /curl -sSfL --retry 5 --retry-all-errors --retry-delay 5 -o "\$f" "https:\/\/github\.com\/gitleaks\/gitleaks\/releases\/download\//);
  assert.ok(gitleaks.indexOf('sha256sum -c -') > gitleaks.indexOf('curl '), 'the pinned sha256 is checked after the download');
  // After the run: the verdict file must exist and say no failures (a skipped or renamed test exits 0 with none).
  const check = run.indexOf('soak-verdict.json');
  assert.ok(check > run.indexOf('dist/test/soak.test.js'), 'the verdict is read after the run');
  assert.match(run.slice(check - 400), /failures\.length[^\n]*process\.exit\(1\)/);
  // Nothing may swallow that exit (#1181 review R1181c): the check is the step's last line, as written, and the step can't
  // carry on past a failure.
  const lines = run.trimEnd().split('\n');
  assert.match(lines.at(-1)!, /^\s*node -e '[^']*process\.exit\(1\);? \}' "\$SOAK_REPORT_DIR\/soak-verdict\.json"$/, 'the verdict check ends the step, with nothing after it');
  assert.doesNotMatch(run, /\|\|\s*(true|:)\b|set \+e|; *true *$/m, 'no failure is swallowed');
  assert.equal(job.steps.find((s) => s.name === 'soak')!['continue-on-error'], undefined);
});

test('soak verdict: a stall that begins inside the last quarter still fails, judged from the last landing (#1181 review R1181c, 1)', () => {
  // A task filed every 30 s for 5.5 h; landing stops at minute 251, 260, 300 or 320 of 330.
  for (const stop of [251, 260, 300, 320]) {
    const f = soakVerdict(series(330, (m) => ({ tasksDone: Math.min(stop, m), filed: 2 * m + 1, eventsBytes: 1_000_000 + Math.min(stop, m) * 1000 }))).failures.join(' | ');
    assert.match(f, /stalled: no task landed in the last \d+ min \(\d+ filed since; limit 5 min; \d+ landed in all\)/, `landing stopped at minute ${stop}: ${f}`);
  }
  // Landing to the very end, however slowly: no stall.
  assert.deepEqual(soakVerdict(series(330, (m) => ({ tasksDone: Math.floor(m * 0.6), filed: m + 1 }))).failures, []);
});

// R1181d's attacks, each a bad run that the verdict passed (failures: []) at 81d057a2: every one must fail now.
test('soak verdict: R1181d attacks A1-A14, each a bad 5.5 h run, fail (#1181 review R1181d)', () => {
  const N = 330;
  const opts = { expectedMs: 5.5 * 3600_000 - 60_000 };
  const v = (s: SoakSample[]) => soakVerdict(s, SOAK_LIMITS, opts).failures.join(' | ');
  const cases: [string, SoakSample[], RegExp][] = [
    ['A1 heap +1.5 GB in the last 4 samples', series(N, (m) => (m >= N - 4 ? { heapUsed: 1600 * MB } : {})), /leak: the heap grew/],
    ['A2 RSS +3 GB in the last 4 samples', series(N, (m) => (m >= N - 4 ? { rss: 3200 * MB } : {})), /leak: RSS grew/],
    ['A3 heap +250 MB over the last 5 samples', series(N, (m) => (m >= N - 5 ? { heapUsed: 330 * MB } : {})), /leak: the heap grew 250\.0 MB/],
    ['A4 heap linear +148 MB', series(N, (m) => ({ heapUsed: 80 * MB + (Math.max(0, m - 10) * (148 * MB)) / (N - 11) })), /leak: the heap grew 14\d\.\d MB/],
    ['A5 RSS linear +295 MB', series(N, (m) => ({ rss: 200 * MB + (Math.max(0, m - 10) * (295 * MB)) / (N - 11) })), /leak: RSS grew 29\d\.\d MB/],
    ['A6 fds +300 in the last 4 samples', series(N, (m) => (m >= N - 4 ? { fds: 340 } : {})), /leak: open file handles grew by 300/],
    ['A7 fds linear +37', series(N, (m) => ({ fds: 40 + Math.floor((Math.max(0, m - 10) * 37) / (N - 11)) })), /leak: open file handles grew by 3[3-9]/],
    ['A8 a leaked slot with an orphaned run under 30 min', [...series(N - 1), sample((N - 1) * 60_000, { openRuns: 1, oldestOpenRunMs: 25 * 60_000, slotsHeld: 1 })], /never finished: 1 agent run/],
    ['A9 two leaked slots with two orphaned runs', [...series(N - 1), sample((N - 1) * 60_000, { openRuns: 2, oldestOpenRunMs: 29 * 60_000, slotsHeld: 2 })], /never finished: 2 agent run/],
    ['A10 a slot leaked mid-run, a run stuck 4 h closed a minute before the end', series(N, (m) => (m >= 60 && m < N - 1 ? { slotsHeld: 2, openRuns: 1, oldestOpenRunMs: (m - 60) * 60_000 } : {})), /stuck: 1 agent run\(s\) open at minute \d+, the oldest for 31 min .*leaked slots: 2 agent slot\(s\) held at minute 60/],
    ['A11 landing stops 78 min before the end', series(N, (m) => ({ tasksDone: Math.min(m, 252), filed: m + 1 })), /stalled: no task landed in the last 77 min/],
    ['A12 landing stops for the last third at the half-share edge', series(N, (m) => ({ tasksDone: 2 * Math.min(m, 252), filed: 2 * m + 1, eventsBytes: 1_000_000 + 2 * Math.min(m, 252) * 1000 })), /stalled: no task landed in the last 77 min/],
    ['A13 the log grows 50 MB in the last 30 min', series(N, (m) => ({ eventsBytes: 1_000_000 + m * 60 * 1024 + (m >= N - 30 ? ((m - (N - 30)) * (50 * MB)) / 29 : 0) })), /log growth: the event log grew \d+ KB per finished task \(over the run, its last quarter or its last 30 min/],
    ['A14 the per-task log rate 100 then 350 KB', (() => { let b = 1_000_000; return series(N, (m) => ({ eventsBytes: (b += m < N / 2 ? 100 * 1024 : 350 * 1024) })); })(), /log growth: the event log grew 35\d KB per finished task/],
  ];
  for (const [name, samples, want] of cases) assert.match(v(samples), want, name);
  // And their good twins pass: the same shape within its limit.
  assert.deepEqual(soakVerdict(series(N, (m) => (m >= N - 4 ? { heapUsed: 180 * MB } : {})), SOAK_LIMITS, opts).failures, [], 'heap +100 MB at the end: within 128');
  assert.deepEqual(soakVerdict(series(N, (m) => ({ fds: 40 + Math.floor((Math.max(0, m - 10) * 20) / (N - 11)) })), SOAK_LIMITS, opts).failures, [], 'fds +20: within 32');
});

test('theilSen: the median pairwise slope, robust to a spike', () => {
  assert.equal(theilSen([{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 4 }]), 2);
  assert.equal(theilSen([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 100 }, { x: 3, y: 3 }, { x: 4, y: 4 }]), 1, 'one spike moves no median');
  assert.equal(theilSen([{ x: 0, y: 5 }]), 0);
});

/** Open file handles of this process, where the platform shows them. */
function openFds(): number | null {
  for (const d of ['/proc/self/fd', '/dev/fd']) {
    try {
      return readdirSync(d).length;
    } catch {
      // not here
    }
  }
  return null;
}

test('soak: the real coordinator works for a while with stand-in agents; nothing leaks, sticks or grows past its limits', { skip, timeout: 10 * 3600_000 }, async () => {
  const hours = Number(process.env.SOAK_HOURS ?? 0);
  // The PR smoke counts ticks, not time (a slow runner gives the same number of samples): SOAK_TICKS, one sample and
  // one new task each. A real soak (SOAK_HOURS) runs for its hours.
  const smokeTicks = hours > 0 ? Infinity : Number(process.env.SOAK_TICKS ?? 12);
  const ms = hours > 0 ? hours * 3600_000 : Infinity;
  const sampleMs = hours > 0 ? Number(process.env.SOAK_SAMPLE_S ?? 60) * 1000 : 0;
  const issueEveryMs = hours > 0 ? Number(process.env.SOAK_ISSUE_EVERY_S ?? 30) * 1000 : 0;
  let tickCount = 0;
  const f = fixture();
  let n = 0;
  // Stand-in agents: the worker adds the file its task asks for; the evaluator approves what it read.
  const runner = new FakeRunner((req: RunRequest) => {
    if (req.role === 'worker') {
      const file = /Add (soak-\d+\.js)\./.exec(req.prompt)?.[1];
      if (file) {
        writeFileSync(join(req.cwd, 'src', file), `export const n = ${JSON.stringify(file)};\n`);
        commitAll(req.cwd, `Add ${file}`);
      }
      return { structured: { summary: 'added' } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: readAll(req) } };
  });
  const c = coordinator(f, runner);
  const samples: SoakSample[] = [];
  // Elapsed time on the monotonic clock (#582): an NTP step never moves it. A run's age (below) is against the log's own wall-clock times.
  const start = performance.now();
  let lastIssue = -Infinity;
  let lastSample = -Infinity;
  let ticks: number[] = [];
  try {
    while (performance.now() - start < ms && tickCount++ < smokeTicks) {
      const at = performance.now() - start;
      if (at - lastIssue >= issueEveryMs) {
        f.backlog.open(easyIssue(`Add soak-${++n}.js`, `soak-${n}.js`));
        lastIssue = at;
      }
      const t0 = performance.now();
      await c.tick();
      await c.idle();
      ticks.push(performance.now() - t0);
      if (at - lastSample >= sampleMs) {
        const events = f.log.read(0, ['run.started', 'run.finished', 'land.result']);
        const runs = openRunsOf(events, Date.now());
        // A forced GC before each reading (soak.yml runs node --expose-gc), so a peak is held memory, not garbage.
        (globalThis as { gc?: () => void }).gc?.();
        const mem = process.memoryUsage();
        // The log's size is its file and its WAL: writes sit in the WAL until a checkpoint moves them over.
        const wal = existsSync(`${f.log.path}-wal`) ? statSync(`${f.log.path}-wal`).size : 0;
        ticks.sort((a, b) => a - b);
        samples.push({
          at,
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          fds: openFds(),
          eventsBytes: statSync(f.log.path).size + wal,
          walBytes: wal,
          tickMs: ticks[ticks.length >> 1] ?? 0,
          tasksDone: events.filter((e) => e.type === 'land.result' && (e.payload as { outcome: string }).outcome === 'landed').length,
          filed: n,
          openRuns: runs.open,
          oldestOpenRunMs: runs.oldestMs,
          slotsHeld: slotStatus(f.slotsDir).agents.length,
        });
        ticks = [];
        lastSample = at;
      }
    }
  } finally {
    c.stop();
    await c.idle();
  }
  // The short smoke run has no warm-up to leave out and too little time to judge a slope: its limits say so.
  const limits = hours > 0 ? SOAK_LIMITS : { ...SOAK_LIMITS, warmupMs: 0, heapGrowthBytes: 512 * MB, rssGrowthBytes: 1024 * MB, fdGrowth: 256, tickDrift: 20 };
  // A real soak is judged against the hours it was asked for (a run that stopped early fails).
  const v = soakVerdict(samples, limits, hours > 0 ? { expectedMs: ms - sampleMs } : {});
  const out = process.env.SOAK_REPORT_DIR;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'soak-samples.json'), JSON.stringify(samples));
    writeFileSync(join(out, 'soak-verdict.json'), JSON.stringify({ hours: (performance.now() - start) / 3600_000, issues: n, ...v }, null, 2));
  }
  f.log.close();
  rmSync(f.base, { recursive: true, force: true });
  assert.deepEqual(v.failures, [], JSON.stringify(v.measured));
  assert.ok(samples.length >= 4, `${samples.length} samples`);
});
