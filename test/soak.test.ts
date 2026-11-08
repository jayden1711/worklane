// The soak test (docs/soak.md). On every PR it runs SOAK_TICKS (12) coordinator ticks as a smoke test of the driver; the
// soak workflow (.github/workflows/soak.yml) runs it for SOAK_HOURS (8 on the trusted runner) and keeps its report.
// The coordinator is the real one, on a scratch repo with a local remote; the agents are stand-ins (no spend), and a
// new task is filed every SOAK_ISSUE_EVERY_S. Every SOAK_SAMPLE_S it records what the process holds; src/soak.ts
// judges the samples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { slotStatus } from '../src/slots.js';
import { SOAK_LIMITS, openRunsOf, soakVerdict, type SoakSample } from '../src/soak.js';
import { commitAll, coordinator, easyIssue, fixture, readAll, skip } from './repro-state-graph/harness.js';

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
  assert.match(fails([...series(119), sample(119 * 60_000, { openRuns: 1, oldestOpenRunMs: 45 * 60_000, slotsHeld: 1 })]), /^stuck: 1 agent run\(s\) open, the oldest for 45 min/);
  assert.match(fails([...series(119), sample(119 * 60_000, { slotsHeld: 2 })]), /leaked slots: 2 agent slot\(s\) held with 0 run\(s\) open/);
  assert.match(fails(series(120, (m) => ({ eventsBytes: 1_000_000 + m * 400 * 1024 }))), /log growth: the event log grew \d+ KB per finished task/);
  assert.match(fails(series(120, (m) => ({ walBytes: m === 60 ? 80 * MB : MB }))), /the WAL reached 80\.0 MB/);
  assert.match(fails(series(120, (m) => ({ tickMs: m < 60 ? 50 : 400 }))), /^drift: the median tick went from 50 ms to 400 ms/);
  assert.match(fails(series(120, () => ({ tasksDone: 0 }))), /too little work: 0 task\(s\) finished/);
  assert.match(fails(series(3)), /only 3 sample\(s\)/);
  // The warm-up is left out: a heap that fills its caches in the first minutes, then holds, is no leak.
  assert.deepEqual(soakVerdict(series(40, (m) => ({ heapUsed: m < 9 ? 20 * MB : 300 * MB }))).failures, []);
  assert.match(soakVerdict(series(40, (m) => ({ heapUsed: m < 9 ? 20 * MB : 300 * MB })), { ...SOAK_LIMITS, warmupMs: 0 }).failures.join(), /leak: the heap grew/, "the same samples judged with no warm-up: a leak");
  // A short open run is a run in progress, not a stuck one; handles that can't be counted are not judged.
  assert.deepEqual(soakVerdict([...series(119), sample(119 * 60_000, { openRuns: 1, oldestOpenRunMs: 60_000, slotsHeld: 1 })]).failures, []);
  assert.deepEqual(soakVerdict(series(120, (m) => ({ fds: m % 2 ? null : 40 + m }))).failures, []);
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
  assert.match(soakVerdict([...series(329), sample(329 * 60_000, { openRuns: r.open, oldestOpenRunMs: r.oldestMs, slotsHeld: 1 })]).failures.join(), /^stuck: 1 agent run\(s\) open, the oldest for 330 min/);
});

test('soak verdict: a late leak and a linear one just over the limit both fail; the end is judged, not only quarter medians (#1181 review, 2)', () => {
  // 5.5 h, a sample a minute. The heap jumps by 1.5 GB in the last 35 minutes: no quarter median moves, the end does.
  const late = series(330, (m) => (m >= 295 ? { heapUsed: 1600 * MB, rss: 1800 * MB } : {}));
  assert.match(soakVerdict(late).failures.join(' | '), /leak: the heap grew 1520\.0 MB .*\| leak: RSS grew 1600\.0 MB/);
  // A linear 165 MB over the run after the warm-up (limit 128 MB): quarter medians read ~124 MB, the end reads more.
  const linear = series(330, (m) => ({ heapUsed: 80 * MB + Math.max(0, m - 10) * (165 * MB) / 320 }));
  assert.match(soakVerdict(linear).failures.join(), /^leak: the heap grew 1[3-9]\d\.\d MB from the first quarter to the last or the end/);
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
  const v = soakVerdict(samples, limits);
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
