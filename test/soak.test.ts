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
const sample = (at: number, o: Partial<SoakSample> = {}): SoakSample => ({ at, rss: 200 * MB, heapUsed: 80 * MB, fds: 40, eventsBytes: 1_000_000 + at, walBytes: MB, events: Math.floor(at / 6_000), tickMs: 50, maxTickMs: 80, tasksDone: Math.floor(at / 60_000), filed: Math.floor(at / 60_000) + 1, oldestUnlandedMs: 0, openRuns: 0, oldestOpenRunMs: 0, slotsHeld: 0, ...o });
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
  assert.match(fails([...series(119), sample(119 * 60_000, { openRuns: 1, oldestOpenRunMs: 45 * 60_000, slotsHeld: 1 })]), /^never finished: 1 agent run\(s\) open at minute 119, with nothing in flight at a sample \(the oldest read as 45 min\)/);
  assert.match(fails([...series(119), sample(119 * 60_000, { slotsHeld: 2 })]), /leaked slots: 2 agent slot\(s\) held at minute 119 with 0 run\(s\) open/);
  assert.match(fails(series(120, (m) => ({ eventsBytes: 1_000_000 + m * 400 * 1024 }))), /log growth: the event log grew \d+ KB per landed task/);
  assert.match(fails(series(120, (m) => ({ walBytes: m === 60 ? 80 * MB : MB }))), /the WAL reached 80\.0 MB/);
  assert.match(fails(series(120, (m) => ({ tickMs: m < 60 ? 50 : 400 }))), /^drift: the median tick went from 50 ms to 400 ms/);
  assert.match(fails(series(120, () => ({ tasksDone: 0 }))), /too little work: 0 task\(s\) landed/);
  assert.match(fails(series(3)), /only 3 sample\(s\)/);
  // The warm-up is left out: a heap that fills its caches in the first minutes, then holds, is no leak.
  assert.deepEqual(soakVerdict(series(40, (m) => ({ heapUsed: m < 9 ? 20 * MB : 300 * MB }))).failures, []);
  assert.match(soakVerdict(series(40, (m) => ({ heapUsed: m < 9 ? 20 * MB : 300 * MB })), { ...SOAK_LIMITS, warmupMs: 0 }).failures.join(), /leak: the heap grew/, 'the same samples judged with no warm-up: a leak');
  // A run open at the end, however young, never finished: the driver samples after idle(), with nothing in flight
  // (#1181 review R1181d: an orphaned run.started hid one leaked slot each).
  assert.match(soakVerdict([...series(119), sample(119 * 60_000, { openRuns: 1, oldestOpenRunMs: 60_000, slotsHeld: 1 })]).failures.join(), /^never finished: 1 agent run\(s\) open at minute 119/);
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
  assert.match(soakVerdict([...series(329), sample(329 * 60_000, { openRuns: r.open, oldestOpenRunMs: r.oldestMs, slotsHeld: 1 })]).failures.join(), /^never finished: 1 agent run\(s\) open at minute 329, .*the oldest read as 330 min/);
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
  assert.match(f, /stalled: no task landed in the last \d+ min \(\d+ filed since; limit 5 min; 15 landed in all\)/);
  assert.match(f, /too little work: \d+ of \d+ task\(s\) filed not landed at minute 10 \(at most 10\)/);
  // Landing as fast as filing, a few behind at each sample: no stall, no backlog.
  assert.deepEqual(soakVerdict(series(330, (m) => ({ tasksDone: Math.max(0, 2 * m - 8), filed: 2 * m + 1 }))).failures, []);
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

/**
 * Every step up to and including the soak, as written (#1181 reviews R1181f 7, R1181h 4): the soak step's script
 * alone was pinned, and an earlier step could put a fake node on GITHUB_PATH or SOAK_* knobs and NODE_OPTIONS in
 * GITHUB_ENV. A change to any of them changes this too.
 */
const SOAK_STEPS: unknown[] = [
  {
    "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "with": {
      "persist-credentials": false
    }
  },
  {
    "uses": "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "with": {
      "node-version": "24",
      "cache": "npm"
    }
  },
  {
    "run": "npm ci"
  },
  {
    "name": "install gitleaks",
    "shell": "bash",
    "env": {
      "GITLEAKS_VERSION": "8.30.1"
    },
    "run": "f=\"gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz\"\nmkdir -p \"$RUNNER_TEMP/bin\" && cd \"$RUNNER_TEMP/bin\"\nbash \"$GITHUB_WORKSPACE/scripts/ci/fetch-pinned.sh\" \"https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${f}\" 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb \"$f\"\ntar -xzf \"$f\" gitleaks\necho \"$RUNNER_TEMP/bin\" >> \"$GITHUB_PATH\"\n"
  },
  {
    "run": "npm run build"
  },
  {
    "name": "soak",
    "shell": "bash",
    "env": {
      "HOURS": "${{ inputs.hours || '5.5' }}",
      "SOAK_REPORT_DIR": "${{ runner.temp }}/soak",
      "SOAK_SAMPLE_S": "60",
      "SOAK_ISSUE_EVERY_S": "30",
      "SOAK_TICK_MS": "1000",
      "NODE_OPTIONS": "",
      "BASH_ENV": ""
    },
    "run": "if ! [[ \"$HOURS\" =~ ^[0-9]+(\\.[0-9]+)?$ ]] || ! awk -v h=\"$HOURS\" 'BEGIN { exit !(h >= 1 && h <= 5.5) }'; then\n  echo \"hours must be a number from 1 to 5.5 (got: $HOURS): a shorter run is no soak\"; exit 2\nfi\nnode_bin=\"$(command -v node)\"\ncase \"$node_bin\" in \"$RUNNER_TOOL_CACHE\"/*) ;; *) echo \"node is $node_bin, not setup-node's (under $RUNNER_TOOL_CACHE)\"; exit 3 ;; esac\nSOAK_HOURS=\"$HOURS\" timeout --signal=INT \"$(awk -v h=\"$HOURS\" 'BEGIN { printf \"%d\", h * 3600 + 900 }')\" \\\n  \"$node_bin\" --max-old-space-size=4096 --expose-gc --import ./dist/test/isolate.js --test --test-name-pattern='^soak: the real coordinator' dist/test/soak.test.js\n\"$node_bin\" -e 'const v = JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")); if (!Array.isArray(v.failures) || v.failures.length || v.asked !== Number(process.argv[2])) { console.error(`soak failed: ${JSON.stringify(v.failures)} (asked ${v.asked} h of ${process.argv[2]})`); process.exit(1); }' \"$SOAK_REPORT_DIR/soak-verdict.json\" \"$HOURS\"\n"
  }
];

test('the soak workflow: schedule and dispatch only, read-only, on GitHub-hosted runners, 1 to 5.5 h, and green only on a verdict with no failure for the hours asked (#1181 reviews 5b, R1181c, R1181f 7)', async () => {
  const { parse } = await import('yaml');
  const text = readFileSync(join(repoRoot, '.github', 'workflows', 'soak.yml'), 'utf8');
  type Step = Record<string, unknown> & { uses?: string; with?: Record<string, unknown>; run?: string; name?: string };
  const w = parse(text) as Record<string, unknown> & { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, Record<string, unknown> & { steps: Step[] }> };
  // The workflow's keys, exactly: no workflow-level env: or defaults: that could change the step's shell or hours.
  assert.deepEqual(Object.keys(w).sort(), ['concurrency', 'jobs', 'name', 'on', 'permissions']);
  assert.deepEqual(Object.keys(w.on).sort(), ['schedule', 'workflow_dispatch'], 'never on a pull request or a push');
  assert.deepEqual(w.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(w.jobs), ['soak']);
  const job = w.jobs.soak!;
  // The job's keys, exactly: no if:, no permissions: (they'd override the read-only top level), no continue-on-error,
  // no environment, container or strategy (R1181c 2, R1181f 7).
  assert.deepEqual(Object.keys(job).sort(), ['runs-on', 'steps', 'timeout-minutes']);
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.doesNotMatch(text, /\bsecrets\b/, 'no secret, in any form (toJSON(secrets) too)');
  assert.deepEqual(job.steps.find((s) => s.uses?.startsWith('actions/checkout@'))?.with, { 'persist-credentials': false }, 'no token left in .git/config');
  const at = job.steps.findIndex((s) => s.name === 'soak');
  assert.ok(at > 0, 'a soak step');
  // Every step up to and including the soak runs: none has an if:, a continue-on-error or a working-directory.
  for (const s of job.steps.slice(0, at + 1)) assert.deepEqual(Object.keys(s).filter((k) => !['uses', 'with', 'run', 'name', 'shell', 'env'].includes(k)), [], `step ${s.name ?? s.uses ?? s.run}`);
  const step = job.steps[at]!;
  assert.deepEqual(Object.keys(step).sort(), ['env', 'name', 'run', 'shell']);
  assert.equal(step.shell, 'bash');
  assert.deepEqual(job.steps.slice(0, at + 1), SOAK_STEPS, 'every step through the soak runs exactly this');
  // The soak step sets its own knobs and clears NODE_OPTIONS and BASH_ENV, and runs setup-node's node only.
  assert.deepEqual(Object.keys(step.env as object).sort(), ['BASH_ENV', 'HOURS', 'NODE_OPTIONS', 'SOAK_ISSUE_EVERY_S', 'SOAK_REPORT_DIR', 'SOAK_SAMPLE_S', 'SOAK_TICK_MS']);
  assert.match(step.run!, /case "\$node_bin" in "\$RUNNER_TOOL_CACHE"\/\*\) ;; \*\)[^\n]*exit 3 ;; esac/);
  // The gitleaks download goes through the pinned-download helper (#1201): retried, and checked against its sha256.
  const gitleaks = job.steps.find((s) => s.name === 'install gitleaks')!.run!;
  assert.match(gitleaks, /^ {0}bash "\$GITHUB_WORKSPACE\/scripts\/ci\/fetch-pinned\.sh" "https:\/\/github\.com\/gitleaks\/gitleaks\/releases\/download\/v\$\{GITLEAKS_VERSION\}\/\$\{f\}" [0-9a-f]{64} "\$f"$/m);
  assert.doesNotMatch(gitleaks, /\bcurl\b/);
});

test('the soak driver refuses to run a soak without a forced GC (#1181 review R1181f 7)', () => {
  const src = readFileSync(join(repoRoot, 'test', 'soak.test.ts'), 'utf8');
  assert.match(src, /if \(hours > 0 && typeof gc !== 'function'\) throw new Error\(/);
});

test('soak verdict: a stall that begins inside the last quarter still fails, judged from the last landing (#1181 review R1181c, 1)', () => {
  // A task filed every 30 s for 5.5 h; landing stops at minute 251, 260, 300 or 320 of 330.
  for (const stop of [251, 260, 300, 320]) {
    const f = soakVerdict(series(330, (m) => ({ tasksDone: Math.min(stop, m), filed: 2 * m + 1, eventsBytes: 1_000_000 + Math.min(stop, m) * 1000 }))).failures.join(' | ');
    assert.match(f, /stalled: no task landed in the last \d+ min \(\d+ filed since; limit 5 min; \d+ landed in all\)/, `landing stopped at minute ${stop}: ${f}`);
  }
  // Landing to the very end, however slowly: no stall.
  assert.deepEqual(soakVerdict(series(330, (m) => ({ tasksDone: Math.max(0, m - 5), filed: m + 1 }))).failures, []);
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
    ['A10 a slot leaked mid-run, a run stuck 4 h closed a minute before the end', series(N, (m) => (m >= 60 && m < N - 1 ? { slotsHeld: 2, openRuns: 1, oldestOpenRunMs: (m - 60) * 60_000 } : {})), /never finished: 1 agent run\(s\) open at minute 60, .*leaked slots: 2 agent slot\(s\) held at minute 60/],
    ['A11 landing stops 78 min before the end', series(N, (m) => ({ tasksDone: Math.min(m, 252), filed: m + 1 })), /stalled: no task landed in the last 77 min/],
    ['A12 landing stops for the last third at the half-share edge', series(N, (m) => ({ tasksDone: 2 * Math.min(m, 252), filed: 2 * m + 1, eventsBytes: 1_000_000 + 2 * Math.min(m, 252) * 1000 })), /stalled: no task landed in the last 77 min/],
    ['A13 the log grows 50 MB in the last 30 min', series(N, (m) => ({ eventsBytes: 1_000_000 + m * 60 * 1024 + (m >= N - 30 ? ((m - (N - 30)) * (50 * MB)) / 29 : 0) })), /log growth: the event log grew \d+ KB per landed task \(over the run or a 30-minute window of it/],
    ['A14 the per-task log rate 100 then 350 KB', (() => { let b = 1_000_000; return series(N, (m) => ({ eventsBytes: (b += m < N / 2 ? 100 * 1024 : 350 * 1024) })); })(), /log growth: the event log grew 35\d KB per landed task/],
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

// R1181f's attacks, each a bad 5.5 h run that the verdict passed (failures: []) at 4f236b91: every one must fail now.
test('soak verdict: R1181f attacks S1, S2, G1, SL1, SL2, W1, L1, L2, T1 and D1, each a bad 5.5 h run, fail (#1181 review R1181f)', () => {
  const N = 330;
  const opts = { expectedMs: 5.5 * 3600_000 - 60_000 };
  const v = (x: SoakSample[]) => soakVerdict(x, SOAK_LIMITS, opts).failures.join(' | ');
  const saw = (m: number) => m % 10 >= 3 && m % 10 < 7;
  const cases: [string, SoakSample[], RegExp][] = [
    ['S1 a heap sawtooth, its peaks rising to +2.5 GB, the last 3 samples in a trough', series(N, (m) => ({ heapUsed: 80 * MB + (saw(m) ? (m / N) * 2500 * MB : 0) })), /leak: the heap grew/],
    ['S2 an fd sawtooth, its peaks rising to +400', series(N, (m) => ({ fds: 40 + (saw(m) ? Math.round((m / N) * 400) : 0) })), /leak: open file handles grew by/],
    ['G1 heap +2 GB held for 130 min mid-run, let go before the last quarter', series(N, (m) => ({ heapUsed: m >= 100 && m < 230 ? 2080 * MB : 80 * MB })), /leak: the heap peaked 2000\.0 MB above its start mid-run/],
    ['SL1 a slot held for 4 h next to one young orphaned run', series(N, (m) => (m >= 30 && m < N - 30 ? { openRuns: 1, slotsHeld: 1, oldestOpenRunMs: ((m - 30) % 25) * 60_000 } : {})), /never finished: 1 agent run\(s\) open at minute 30, .*leaked slots: 1 agent slot\(s\) held at minute 30/],
    ['SL2 two slots and two young orphaned runs for 4 h', series(N, (m) => (m >= 30 && m < N - 30 ? { openRuns: 2, slotsHeld: 2, oldestOpenRunMs: ((m - 30) % 29) * 60_000 } : {})), /never finished: 2 agent run\(s\) open at minute 30, .*leaked slots: 2 agent slot\(s\) held at minute 30/],
    ['W1 51% of filed tasks land, steadily to the end', series(N, (m) => ({ filed: 2 * m + 1, tasksDone: Math.ceil((2 * m + 1) * 0.51) })), /too little work: \d+ of \d+ task\(s\) filed not landed at minute \d+ \(at most 10\)/],
    ['L1 a 45 MB log burst over 30 min at hour 2', series(N, (m) => ({ eventsBytes: 1_000_000 + m * 100 * 1024 + (m >= 120 ? Math.min(30, m - 120) * 1.5 * MB : 0) })), /log growth: the event log grew \d+ KB per landed task \(over the run or a 30-minute window of it/],
    ['L2 2.5 MB a sample for minutes 110-140, 10 KB otherwise', (() => { let b = 1_000_000; return series(N, (m) => ({ eventsBytes: (b += m >= 110 && m < 140 ? 2.5 * MB : 10 * 1024) })); })(), /log growth: the event log grew \d+ KB per landed task/],
    ['T1 no sample from minute 100 to 300, and one 200-minute tick', [...series(100), ...series(N).slice(300).map((x, i) => ({ ...x, tickMs: i === 0 ? 200 * 60_000 : 50, maxTickMs: i === 0 ? 200 * 60_000 : 80, tasksDone: 100 + i, filed: 101 + i }))], /hang: no sample for 201 min before minute 300 .*hang: a tick took 200 min before minute 300/],
    ['D1 a tick linear in the log (138 ms + 0.0125 ms an event, as measured), ticking every second', series(N, (m) => ({ events: m * 60, tickMs: 138 + 0.0125 * m * 60 })), /drift: a tick costs 1250 ms more per 100k events in the log \(limit 250\)/],
  ];
  for (const [name, x, want] of cases) assert.match(v(x), want, name);
  // A log burst while little lands (filing stopped at minute 200): judged by its bytes, not per task.
  assert.match(v(series(N, (m) => ({ tasksDone: Math.min(200, m), filed: Math.min(200, m) + 1, eventsBytes: 1_000_000 + m * 60_000 + (m >= 250 ? Math.min(30, m - 250) * MB : 0) }))), /log growth: the event log grew \d+\.\d MB in 30 min from minute \d+ while 0 task\(s\) landed/);
  // The tick's own time hides nothing either: T1's tick alone, with its samples kept, fails.
  assert.match(v(series(N, (m) => (m === 200 ? { maxTickMs: 40 * 60_000 } : {}))), /^hang: a tick took 40 min before minute 200/);
});

// R1181g's and R1181h's attacks, each a bad 5.5 h run that the verdict passed at 463b3f26: every one must fail now.
test('soak verdict: R1181g slow ticks and R1181h V1-V3, V2c, D2 and W2, each a bad 5.5 h run, fail (#1181 reviews R1181g, R1181h)', () => {
  const N = 330;
  const opts = { expectedMs: 5.5 * 3600_000 - 60_000 };
  const v = (x: SoakSample[], o: { expectedMs?: number; sampleMs?: number; issueEveryMs?: number } = opts) => soakVerdict(x, SOAK_LIMITS, o).failures.join(' | ');
  /** A sample every `everyMin` minutes, one task landed and one filed per sample: a coordinator slow on every tick. */
  const slow = (everyMin: number) => Array.from({ length: Math.floor(330 / everyMin) + 1 }, (_, i) => sample(i * everyMin * 60_000, { tasksDone: i, filed: i + 1, maxTickMs: everyMin * 60_000 - 1000, events: i * 10, eventsBytes: 1_000_000 + i * 60 * 1024 }));
  for (const t of [5, 10, 25]) assert.match(v(slow(t)), /hang: \d+ samples of the 329 .*too little work: \d+ task\(s\) filed of the \d+ its schedule/, `R1181g: every tick ${t} min`);
  const ramp = (m: number, from: number, size: number) => (m < 90 ? 0 : ((m - 90) / (N - 91)) * size) + from;
  const cases: [string, SoakSample[], RegExp][] = [
    ['V1 heap high through the first quarter, then +1.1 GB linear over 4 h', series(N, (m) => ({ heapUsed: m < 90 ? 1100 * MB : ramp(m, 80 * MB, 1100 * MB) })), /leak: the heap grew 1\d{3}\.\d MB/],
    ['V1b heap +300 MB through the first quarter, then +420 MB', series(N, (m) => ({ heapUsed: m < 90 ? 380 * MB : ramp(m, 80 * MB, 420 * MB) })), /leak: the heap grew/],
    ['V1c RSS high through the first quarter, then +750 MB', series(N, (m) => ({ rss: m < 90 ? 700 * MB : ramp(m, 200 * MB, 750 * MB) })), /leak: RSS grew/],
    ['V1d fds 100 through the first quarter, then 40 leaking to 130', series(N, (m) => ({ fds: m < 90 ? 100 : Math.round(ramp(m, 40, 90)) })), /leak: open file handles grew by/],
    ['V2 a 29-minute tick in every interval', Array.from({ length: 12 }, (_, i) => sample(i * 30 * 60_000, { tasksDone: 2 * i, filed: 2 * i + 1, maxTickMs: 29 * 60_000 })), /hang: 12 samples of the 329/],
    ['V2c a 10-minute tick after every minute of work', Array.from({ length: 31 }, (_, i) => sample(i * 11 * 60_000, { tasksDone: 2 * i, filed: 2 * i + 1, maxTickMs: 10 * 60_000 })), /hang: no sample for 11 min before minute 11 \(limit 5 min\)/],
    ['D2 one tick in three grows with the log to 20 s, the median flat', series(N, (m) => ({ events: m * 60, maxTickMs: 80 + m * 60 })), /drift: the slowest tick of an interval/],
    ['V3 ten tasks filed at the start never land', series(N, (m) => ({ filed: m + 10, tasksDone: m, oldestUnlandedMs: m * 60_000 })), /too little work: a task filed 31 min before minute 31 hadn't landed/],
    ['W2 knobs set elsewhere: one task, a sample every 30 min', Array.from({ length: 12 }, (_, i) => sample(i * 1800_000, { tasksDone: 1, filed: 1, events: 50 + i, eventsBytes: 1_000_000 + i * 1000 })), /hang: 12 samples of the 300/],
  ];
  for (const [name, x, want] of cases) assert.match(v(x, name.startsWith('W2') ? { expectedMs: 5.5 * 3600_000 - 1800_000 } : opts), want, name);
});

test('soak verdict: healthy shapes pass: a high first quarter then flat, steady RSS at 80% of its limit under noise, landings in batches, a tick 1.5x slower (good twins of R1181g, R1181h)', () => {
  const N = 330;
  const opts = { expectedMs: 5.5 * 3600_000 - 60_000 };
  const ok = (x: SoakSample[], why: string) => assert.deepEqual(soakVerdict(x, SOAK_LIMITS, opts).failures, [], why);
  ok(series(N, (m) => ({ heapUsed: m < 90 ? 1100 * MB : 80 * MB })), 'V1 twin: a startup set let go, then flat');
  ok(series(N, (m) => ({ fds: m < 90 ? 100 : 40 })), 'V1d twin');
  // H1: RSS +205 MB linear (80% of 256), heap noise sd 8 MB, RSS sd 30 MB, 50 seeds.
  const bad: string[] = [];
  for (let seed = 1; seed <= 50; seed++) {
    const r = rng(seed);
    const f = soakVerdict(series(N, (m) => ({ rss: 200 * MB + (Math.max(0, m - 10) / (N - 11)) * 0.8 * 256 * MB + r.normal(30 * MB), heapUsed: 80 * MB + r.normal(8 * MB) })), SOAK_LIMITS, opts).failures;
    if (f.length) bad.push(`${seed}: ${f[0]}`);
  }
  assert.deepEqual(bad, [], 'H1: RSS at 80% of its limit, 50 noisy runs');
  // H3: landings in batches of 10 every 10 minutes, the run ending 9 minutes after a batch.
  ok(series(N, (m) => ({ tasksDone: Math.floor(m / 10) * 10, filed: m + 1, eventsBytes: 1_000_000 + m * 100 * 1024, oldestUnlandedMs: (m % 10) * 60_000 })), 'H3: a merge train');
  ok(series(N, (m) => ({ tickMs: 75, maxTickMs: 120 })), 'a tick 1.5x slower, steady');
});

test('open runs: an orphan is not closed by its retries, and any open run at a sample fails the soak (#1181 review R1181f SL3)', () => {
  const t0 = Date.parse('2026-11-08T00:00:00.000Z');
  const ts = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const ev = (type: string, min: number) => ({ type, ts: ts(min), payload: { issue: 7, role: 'worker' } });
  // Issue 7's worker run is orphaned at minute 0, then retried every 20 minutes (each retry starts and finishes).
  const events = [ev('run.started', 0)];
  for (let m = 20; m <= 300; m += 20) events.push(ev('run.started', m), ev('run.finished', m + 1));
  const r = openRunsOf(events, t0 + 305 * 60_000);
  assert.equal(r.open, 1, 'the count is exact');
  assert.equal(r.oldestMs, 305 * 60_000, "and the orphan keeps its own age: a retry's finish closes the retry");
  assert.match(soakVerdict([...series(305), sample(305 * 60_000, { openRuns: r.open, oldestOpenRunMs: r.oldestMs })]).failures.join(), /^never finished: 1 agent run\(s\) open at minute 305, .*the oldest read as 305 min/);
});

test('soak verdict: a sample missing a field fails closed (a fixture or driver that drops one judges nothing)', () => {
  for (const k of ['events', 'maxTickMs', 'tasksDone'] as const) {
    const x = series(60).map((s) => { const c: Partial<SoakSample> = { ...s }; delete c[k]; return c as SoakSample; });
    assert.match(soakVerdict(x).failures.join(), new RegExp(`^samples missing ${k}: nothing was judged$`), k);
  }
});

/** A seeded generator (mulberry32) and a normal draw from it: the noise cases are the same on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { u, normal: (sd: number) => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u()) * sd };
}

test('soak verdict: healthy runs pass: a rise that levels off within the limit, a small sawtooth, noise, a steady tick (good twins of R1181e and R1181f)', () => {
  const N = 330;
  const opts = { expectedMs: 5.5 * 3600_000 - 60_000 };
  const ok = (x: SoakSample[], why: string) => assert.deepEqual(soakVerdict(x, SOAK_LIMITS, opts).failures, [], why);
  // R1181e: a rise to minute 234 that holds after; the slope reading read ~1.4x of it and failed the run.
  const plateau = (m: number) => Math.min(Math.max(0, m - 10), 224) / 224;
  ok(series(N, (m) => ({ heapUsed: 80 * MB + plateau(m) * 95 * MB })), 'heap +95 MB to minute 234, flat after');
  ok(series(N, (m) => ({ rss: 200 * MB + plateau(m) * 190 * MB })), 'RSS +190 MB the same shape');
  for (const share of [0.6, 0.7, 0.8]) ok(series(N, (m) => ({ heapUsed: 80 * MB + Math.min(m / (N * share), 1) * 120 * MB })), `heap +120 MB over ${share * 100}% of the run, flat after`);
  ok(series(N, (m) => ({ heapUsed: 80 * MB + (m % 10 >= 3 && m % 10 < 7 ? (m / N) * 100 * MB : 0) })), 'a sawtooth whose peaks rise to +100 MB');
  ok(series(N, (m) => (m >= 200 && m < 280 ? { heapUsed: 400 * MB } : {})), 'heap +320 MB held for 80 min mid-run (under 4x the limit)');
  // Noise: heap sd 8 MB, RSS sd 30 MB, fds 40-44, ticks 50 ± 10 ms with a tick a second in the log; 50 seeded runs.
  for (let seed = 1; seed <= 50; seed++) {
    const r = rng(seed);
    ok(series(N, (m) => ({ heapUsed: 80 * MB + r.normal(8 * MB), rss: 200 * MB + r.normal(30 * MB), fds: 40 + Math.floor(r.u() * 5), events: m * 60, tickMs: 50 + r.normal(10), maxTickMs: 120 + r.u() * 100 })), `noise, seed ${seed}`);
  }
  // A log rate that varies by window but stays under the limit everywhere.
  ok((() => { let b = 1_000_000; return series(N, (m) => ({ eventsBytes: (b += m % 60 < 30 ? 200 * 1024 : 20 * 1024) })); })(), 'the log at 200 KB a task for half of each hour');
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
  // A fixed tick period, as production ticks on one (#1181 review R1181f D1): back to back, a tick that slows with the
  // log also slows the log's growth, and drift hides. The smoke ticks back to back.
  const tickPeriodMs = hours > 0 ? Number(process.env.SOAK_TICK_MS ?? 1000) : 0;
  // A real soak forces a GC before each reading, so a peak is held memory (R1181e, R1181f: without --expose-gc, gc?.()
  // did nothing, and the soak read GC noise). Without it there is no soak.
  const gc = (globalThis as { gc?: () => void }).gc;
  if (hours > 0 && typeof gc !== 'function') throw new Error('a soak needs node --expose-gc: its readings are taken after a forced GC');
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
  const landed = new Set<string>();
  /** Each task filed, by its issue number: when (R1181h V3: the oldest one not landed is judged by its age). */
  const filedAt = new Map<string, number>();
  try {
    while (performance.now() - start < ms && tickCount++ < smokeTicks) {
      const at = performance.now() - start;
      if (at - lastIssue >= issueEveryMs) {
        filedAt.set(String(f.backlog.open(easyIssue(`Add soak-${++n}.js`, `soak-${n}.js`))), at);
        lastIssue = at;
      }
      const t0 = performance.now();
      await c.tick();
      await c.idle();
      ticks.push(performance.now() - t0);
      const wait = tickPeriodMs - (performance.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (at - lastSample >= sampleMs) {
        const events = f.log.read(0, ['run.started', 'run.finished', 'land.result']);
        const runs = openRunsOf(events, Date.now());
        // A forced GC before each reading (soak.yml runs node --expose-gc), so a peak is held memory, not garbage.
        gc?.();
        // Distinct issues landed: a task landed twice counts once (R1181f W1).
        for (const e of events) if (e.type === 'land.result' && (e.payload as { outcome: string }).outcome === 'landed') landed.add(String((e.payload as { issue: unknown }).issue));
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
          events: f.log.lastId(),
          tickMs: ticks[ticks.length >> 1] ?? 0,
          maxTickMs: ticks.at(-1) ?? 0,
          tasksDone: landed.size,
          filed: n,
          oldestUnlandedMs: Math.max(0, ...[...filedAt].filter(([k]) => !landed.has(k)).map(([, t]) => at - t)),
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
  // Nor a log rate: 12 ticks never reach a WAL checkpoint, so it reads page writes (R1181e note 4: 243 KB of 256).
  const limits = hours > 0 ? SOAK_LIMITS : { ...SOAK_LIMITS, warmupMs: 0, heapGrowthBytes: 512 * MB, rssGrowthBytes: 1024 * MB, fdGrowth: 256, tickDrift: 20, tickMsPer100kEvents: 0, logBytesPerTask: 4 * MB };
  // A real soak is judged against the hours it was asked for (a run that stopped early fails).
  const v = soakVerdict(samples, limits, hours > 0 ? { expectedMs: ms - sampleMs, sampleMs, issueEveryMs } : {});
  const out = process.env.SOAK_REPORT_DIR;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'soak-samples.json'), JSON.stringify(samples));
    writeFileSync(join(out, 'soak-verdict.json'), JSON.stringify({ asked: hours, hours: (performance.now() - start) / 3600_000, issues: n, ...v }, null, 2));
  }
  f.log.close();
  rmSync(f.base, { recursive: true, force: true });
  assert.deepEqual(v.failures, [], JSON.stringify(v.measured));
  assert.ok(samples.length >= 4, `${samples.length} samples`);
});
