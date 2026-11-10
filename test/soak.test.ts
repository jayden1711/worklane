// The soak test (docs/soak.md). On every PR it runs SOAK_TICKS (12) coordinator ticks as a smoke test of the driver; the
// soak workflow (.github/workflows/soak.yml) runs it for SOAK_HOURS (1 to 5.5, on GitHub-hosted runners) and keeps its report.
// The coordinator is the real one, on a scratch repo with a local remote; the agents are stand-ins (no spend), and a
// new task is filed every SOAK_ISSUE_EVERY_S. Every SOAK_SAMPLE_S it records what the process holds; src/soak.ts
// judges the samples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, statfsSync, watch, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { EventSchemas } from '../src/events/types.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { slotStatus } from '../src/slots.js';
import { worktreeDir } from '../src/worktrees.js';
import { SOAK_LIMITS, openRunsOf, soakVerdict, theilSen, type SoakSample } from '../src/soak.js';
import { commitAll, coordinator, easyIssue, fixture, git, readAll, skip } from './repro-state-graph/harness.js';
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
    "name": "record node",
    "id": "node",
    "shell": "bash",
    "run": "echo \"path=$(command -v node)\" >> \"$GITHUB_OUTPUT\""
  },
  {
    "name": "install gitleaks",
    "shell": "bash",
    "env": {
      "GITLEAKS_VERSION": "8.30.1",
      "BASH_ENV": ""
    },
    "run": "f=\"gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz\"\nmkdir -p \"$RUNNER_TEMP/bin\" && cd \"$RUNNER_TEMP/bin\"\nbash -p \"$GITHUB_WORKSPACE/scripts/ci/fetch-pinned.sh\" \"https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${f}\" 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb \"$f\"\ntar -xzf \"$f\" gitleaks\necho \"$RUNNER_TEMP/bin\" >> \"$GITHUB_PATH\"\n"
  },
  {
    "run": "npm ci --ignore-scripts"
  },
  {
    "run": "${{ steps.node.outputs.path }} node_modules/typescript/bin/tsc -p tsconfig.json"
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
      "BASH_ENV": "",
      "NODE_BIN": "${{ steps.node.outputs.path }}"
    },
    "run": "/bin/rm -rf -- \"$SOAK_REPORT_DIR\"\nif ! [[ \"$HOURS\" =~ ^[0-9]+(\\.[0-9]+)?$ ]] || ! /usr/bin/awk -v h=\"$HOURS\" 'BEGIN { exit !(h >= 1 && h <= 5.5) }'; then\n  echo \"hours must be a number from 1 to 5.5 (got: $HOURS): a shorter run is no soak\"; exit 2\nfi\nnode_bin=\"$NODE_BIN\"\ncase \"$node_bin\" in \"$RUNNER_TOOL_CACHE\"/*) ;; *) echo \"node is $node_bin, not setup-node's (under $RUNNER_TOOL_CACHE)\"; exit 3 ;; esac\nSOAK_HOURS=\"$HOURS\" /usr/bin/timeout --signal=INT \"$(/usr/bin/awk -v h=\"$HOURS\" 'BEGIN { printf \"%d\", h * 3600 + 900 }')\" \\\n  /usr/bin/env -u NODE_TEST_CONTEXT \"$node_bin\" --max-old-space-size=4096 --expose-gc --import ./dist/test/isolate.js --test --test-name-pattern='^soak: the real coordinator' dist/test/soak.test.js\n\"$node_bin\" -e 'const v = JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")); if (!Array.isArray(v.failures) || v.failures.length || v.asked !== Number(process.argv[2])) { console.error(`soak failed: ${JSON.stringify(v.failures)} (asked ${v.asked} h of ${process.argv[2]})`); process.exit(1); }' \"$SOAK_REPORT_DIR/soak-verdict.json\" \"$HOURS\"\n"
  }
];

test('the soak workflow: schedule and dispatch only, read-only, on GitHub-hosted runners, 1 to 5.5 h, and green only on a verdict with no failure for the hours asked (#1181 reviews 5b, R1181c, R1181f 7)', async () => {
  const { parse } = await import('yaml');
  const text = readFileSync(join(repoRoot, '.github', 'workflows', 'soak.yml'), 'utf8');
  type Step = Record<string, unknown> & { uses?: string; with?: Record<string, unknown>; run?: string; name?: string };
  const w = parse(text) as Record<string, unknown> & { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, Record<string, unknown> & { steps: Step[] }> };
  // The workflow's keys, exactly: no workflow-level env: or defaults: that could change the step's shell or hours.
  assert.deepEqual(Object.keys(w).sort(), ['concurrency', 'jobs', 'name', 'on', 'permissions']);
  // Per branch (R1181j N2): a dispatch from another branch never replaces main's pending scheduled run.
  assert.deepEqual(w.concurrency, { group: 'soak-${{ github.ref }}', 'cancel-in-progress': false });
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
  for (const s of job.steps.slice(0, at + 1)) assert.deepEqual(Object.keys(s).filter((k) => !['uses', 'with', 'run', 'name', 'shell', 'env', 'id'].includes(k)), [], `step ${s.name ?? s.uses ?? s.run}`);
  const step = job.steps[at]!;
  assert.deepEqual(Object.keys(step).sort(), ['env', 'name', 'run', 'shell']);
  assert.equal(step.shell, 'bash');
  assert.deepEqual(job.steps.slice(0, at + 1), SOAK_STEPS, 'every step through the soak runs exactly this');
  // The soak step sets its own knobs and clears NODE_OPTIONS and BASH_ENV, and runs setup-node's node only.
  assert.deepEqual(Object.keys(step.env as object).sort(), ['BASH_ENV', 'HOURS', 'NODE_BIN', 'NODE_OPTIONS', 'SOAK_ISSUE_EVERY_S', 'SOAK_REPORT_DIR', 'SOAK_SAMPLE_S', 'SOAK_TICK_MS']);
  assert.match(step.run!, /case "\$node_bin" in "\$RUNNER_TOOL_CACHE"\/\*\) ;; \*\)[^\n]*exit 3 ;; esac/);
  // R1181j 4: the report folder emptied first (a verdict an earlier step left is never the one read), and the soak's
  // node run without NODE_TEST_CONTEXT (with it, node --test runs nothing and exits 0).
  assert.match(step.run!, /^\/bin\/rm -rf -- "\$SOAK_REPORT_DIR"\n/);
  assert.match(step.run!, /\n {2}\/usr\/bin\/env -u NODE_TEST_CONTEXT "\$node_bin" --max-old-space-size/);
  // R1181l 1: no tool the step runs is looked up on PATH (an earlier step's file in $RUNNER_TEMP/bin stood in for
  // timeout or env, and the step went green with no soak); node is the one found, then checked against the tool cache.
  for (const word of step.run!.split(/[\s;|&()$"`]+/)) assert.ok(!['rm', 'awk', 'timeout', 'env', 'mkdir', 'cat', 'sh', 'bash'].includes(word), `a bare ${word}`);
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

/** Bytes under `dir`, links not followed (R1181j 2: a leaked worktree or file grows it). */
export function dirBytes(dir: string): number {
  return dirUsage(dir).bytes;
}

/** Bytes and entries (files and folders) under `dir`, links not followed (R1181l 3: 24,000 empty files grow no bytes). */
export function dirUsage(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    files += 1;
    if (e.isDirectory()) {
      const u = dirUsage(p);
      bytes += u.bytes;
      files += u.files;
    } else if (e.isFile()) bytes += statSync(p).size;
  }
  return { bytes, files };
}

/**
 * The live processes in this process's group, less this process and the ps that counts them; null where ps can't
 * (R1181l 4: counting by parent missed a process double-forked away, `sh -c 'x &'`, whose parent is then init).
 */
export function childCount(mark?: string, seen?: Set<number>): number | null {
  return childPids(mark, seen)?.length ?? null;
}
/**
 * The processes this one started, however far they moved away (R1181m D1: the coordinator spawns each child detached,
 * in its own group, so counting by our group missed every one): its descendants by parent; those in this process's
 * group; those in a group or session a descendant leads or led (`seen` keeps those across samples), and on Linux,
 * those whose environment carries `mark` (set before anything is spawned), so a setsid'd double fork still counts.
 */
export function childPids(mark?: string, seen: Set<number> = new Set(), start: ProcessSnapshot | null = null): number[] | null {
  const linux = process.platform === 'linux';
  const r = spawnSync('ps', ['-A', '-o', linux ? 'pid=,ppid=,pgid=,sid=,uid=' : 'pid=,ppid=,pgid='], { encoding: 'utf8' });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  const rows = r.stdout.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((x) => x.length >= 3 && x.every(Number.isFinite));
  const own = rows.find(([pid]) => pid === process.pid)?.[2];
  if (own === undefined) return null;
  const kids = new Map<number, number[]>();
  for (const [pid, ppid] of rows) kids.set(ppid!, [...(kids.get(ppid!) ?? []), pid!]);
  const desc = new Set<number>();
  const todo = [process.pid];
  while (todo.length) for (const k of kids.get(todo.pop()!) ?? []) if (k !== r.pid && !desc.has(k)) { desc.add(k); todo.push(k); }
  for (const d of desc) seen.add(d);
  const marked = new Set<number>();
  if (linux && mark) {
    for (const n of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
      try {
        if (readFileSync(`/proc/${n}/environ`, 'latin1').split('\0').includes(`SOAK_CHILD_MARK=${mark}`)) marked.add(Number(n));
      } catch {
        // gone, or another user's
      }
    }
  }
  // R1181p D5: our group only when we lead it (under `node --test` every test file, and the runner, share its group).
  const leader = own === process.pid;
  // R1181p D1 (Linux): a process of this user that wasn't alive at the start, in a session that wasn't either: an
  // orphan in a new session (setsid, a user-manager service) that dropped the mark. A desktop session's new terminal
  // counts too, which is why the soak runs on a CI runner.
  const uid = process.getuid?.();
  const fresh = (pid: number, sid: number | undefined, u: number | undefined) => linux && start !== null && u === uid && sid !== undefined && !start.pids.has(pid) && !start.sids.has(sid);
  return rows
    .filter(([pid, , pgid, sid, u]) => pid !== process.pid && pid !== process.ppid && pid !== r.pid && (desc.has(pid!) || (leader && pgid === own) || seen.has(pgid!) || (sid !== undefined && seen.has(sid)) || marked.has(pid!) || fresh(pid!, sid, u)))
    .map(([pid]) => pid!);
}

/** The processes and sessions alive at a moment (Linux): what a soak started later is told apart from (R1181p D1). */
export type ProcessSnapshot = { pids: Set<number>; sids: Set<number> };
export function processSnapshot(): ProcessSnapshot | null {
  if (process.platform !== 'linux') return null;
  const r = spawnSync('ps', ['-A', '-o', 'pid=,sid='], { encoding: 'utf8' });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  const rows = r.stdout.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((x) => x.length === 2 && x.every(Number.isFinite));
  return { pids: new Set(rows.map(([p]) => p!)), sids: new Set(rows.map(([, sid]) => sid!)) };
}

/** Their resident memory, in bytes (R1181n: a child's memory weighed nothing). */
export function rssOf(pids: readonly number[]): number {
  if (!pids.length) return 0;
  const r = spawnSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
  return (r.stdout ?? '').split('\n').map((l) => Number(l.trim())).filter(Number.isFinite).reduce((a, b) => a + b, 0) * 1024;
}

/** inotify watches this process and `pids` hold (Linux, /proc/<pid>/fdinfo), else null (R1181n, R1181p D3). */
export function inotifyWatches(pids: readonly number[] = []): number | null {
  try {
    readdirSync('/proc/self/fdinfo');
  } catch {
    return null;
  }
  let n = 0;
  for (const p of ['self', ...pids]) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${p}/fdinfo`);
    } catch {
      continue; // gone
    }
    for (const fd of fds) {
      try {
        n += readFileSync(`/proc/${p}/fdinfo/${fd}`, 'utf8').split('\n').filter((l) => l.startsWith('inotify ')).length;
      } catch {
        // closed meanwhile
      }
    }
  }
  return n;
}

/** The paths this process and `pids` hold open or mapped (Linux, /proc/<pid>/fd and maps); empty elsewhere. */
function heldPaths(pids: readonly number[]): Set<string> {
  const held = new Set<string>();
  for (const p of ['self', ...pids]) {
    try {
      for (const fd of readdirSync(`/proc/${p}/fd`)) {
        try {
          held.add(readlinkSync(`/proc/${p}/fd/${fd}`));
        } catch {
          // closed meanwhile
        }
      }
      for (const l of readFileSync(`/proc/${p}/maps`, 'utf8').split('\n')) {
        const at = l.indexOf('/');
        if (at >= 0) held.add(l.slice(at));
      }
    } catch {
      // gone, or not Linux
    }
  }
  return held;
}

/**
 * Bytes in files this process and `pids` hold open after they were unlinked (Linux): no folder walk finds them, and
 * their blocks stay in use (R1181o D1: an 88 MB deleted, open file passed). Each file once.
 */
export function deletedOpenBytes(pids: readonly number[]): number {
  const seen = new Set<string>();
  let bytes = 0;
  for (const p of ['self', ...pids]) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${p}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (!readlinkSync(`/proc/${p}/fd/${fd}`).endsWith(' (deleted)')) continue;
        const st = statSync(`/proc/${p}/fd/${fd}`);
        if (!st.isFile() || seen.has(`${st.dev}:${st.ino}`)) continue;
        seen.add(`${st.dev}:${st.ino}`);
        bytes += st.size;
      } catch {
        // closed meanwhile
      }
    }
  }
  return bytes;
}

/**
 * The used space of the filesystems under `paths` (each once, statfs) plus the kernel's Shmem (Linux): the levels no
 * walk can name (R1181p D2). Null where it can't be read.
 */
export function fsLevels(paths: readonly (string | undefined)[]): number | null {
  try {
    const devs = new Set<number>();
    let bytes = 0;
    for (const p of paths) {
      if (!p || !existsSync(p)) continue;
      const dev = statSync(p).dev;
      if (devs.has(dev)) continue;
      devs.add(dev);
      const f = statfsSync(p);
      bytes += (f.blocks - f.bfree) * f.bsize;
    }
    const shmem = /^Shmem:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (!shmem) return null;
    return bytes + Number(shmem[1]) * 1024;
  } catch {
    return null;
  }
}

/**
 * The places a soak's files can land besides its folder (R1181n): the isolate's home, and the /dev/shm entries this
 * process or a counted one (`pids`) holds open or mapped (R1181p D4: any other program's there failed a healthy run).
 */
export function usageOutside(base: string, pids: readonly number[] = []): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const xdg = process.env.XDG_CONFIG_HOME;
  const home = xdg ? dirname(xdg) : null;
  if (home && existsSync(home) && !home.startsWith(base)) {
    const u = dirUsage(home);
    bytes += u.bytes;
    files += u.files;
  }
  if (existsSync('/dev/shm')) {
    const held = [...heldPaths(pids)].filter((x) => x.startsWith('/dev/shm/'));
    for (const n of readdirSync('/dev/shm')) {
      const at = join('/dev/shm', n);
      if (!held.some((x) => x === at || x.startsWith(`${at}/`))) continue;
      try {
        const st = statSync(at);
        files += 1;
        if (st.isFile()) bytes += st.size;
        else if (st.isDirectory()) {
          const u = dirUsage(join('/dev/shm', n));
          bytes += u.bytes;
          files += u.files;
        }
      } catch {
        // gone
      }
    }
  }
  return { bytes, files };
}

/** Every event type that names a failure, read from the schema itself, so a new one is never missed (R1181p D6). */
export const FAILURE_TYPES: readonly string[] = Object.freeze(Object.keys(EventSchemas).filter((t) => /[._]failed$/.test(t)).sort());
/** coordinator.error events, agent runs that didn't succeed, and other failure events, in the log so far (R1181l 5). */
export function failureCounts(log: { read: (afterId?: number, types?: never[]) => { type: string; payload: unknown }[] }): { errors: number; failedRuns: number; failureEvents: number } {
  const ev = log.read(0, ['coordinator.error', 'run.finished', ...FAILURE_TYPES] as never[]);
  return {
    errors: ev.filter((e) => e.type === 'coordinator.error').length,
    failedRuns: ev.filter((e) => (e.type === 'run.finished' && (e.payload as { reason?: string }).reason !== 'succeeded') || e.type === 'run.startup_failed').length,
    failureEvents: ev.filter((e) => e.type !== 'run.startup_failed' && FAILURE_TYPES.includes(e.type)).length,
  };
}

/** Entries in a folder, 0 when it isn't there: the coordinator's worktree folder (R1181k D1). */
export const entriesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).length : 0);

/** The repo's git worktrees, the main one included (R1181j 2). */
const worktreeCount = (repo: string) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

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
  // What was alive before the soak (Linux): a new session of this user after it is the soak's (R1181p D1).
  const startProcs = processSnapshot();
  const f = fixture();
  // Temp files count too (R1181l 3: os.tmpdir() leftovers were outside the measured folder): TMPDIR inside it.
  const tmp = join(f.base, 'tmp');
  mkdirSync(tmp);
  const oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  // Every process the soak starts carries this mark, so one double-forked away from every group still counts (R1181m).
  const childMark = `${process.pid}-${Date.now()}`;
  const oldMark = process.env.SOAK_CHILD_MARK;
  process.env.SOAK_CHILD_MARK = childMark;
  const seenLeaders = new Set<number>();
  /** The coordinator's worktree folder (R1181k D1: a checkout copied aside, git's list unchanged, is still here). */
  const wtDir = worktreeDir(f.repo, f.cfg.tests.worktree.root, join(f.stateDir, 'tasks'));
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
  const report = process.env.SOAK_REPORT_DIR;
  if (report) mkdirSync(report, { recursive: true });
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
        const kids = childPids(childMark, seenLeaders, startProcs);
        const inside = dirUsage(f.base);
        const outside = usageOutside(f.base, kids ?? []);
        const usage = { bytes: inside.bytes + outside.bytes + deletedOpenBytes(kids ?? []), files: inside.files + outside.files };
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
          ...failureCounts(f.log),
          worktrees: worktreeCount(f.repo),
          worktreeDirs: entriesIn(wtDir),
          diskBytes: usage.bytes,
          files: usage.files,
          children: kids?.length ?? null,
          childRss: rssOf(kids ?? []),
          watches: inotifyWatches(kids ?? []),
          fullRunHeld: slotStatus(f.slotsDir).fullRun ? 1 : 0,
          levelBytes: hours > 0 && process.platform === 'linux' ? fsLevels([f.base, '/var/tmp', '/dev/shm', process.env.XDG_RUNTIME_DIR]) : null,
        });
        // Each sample as it is taken (R1181j N1: a crash or an OOM left no report, in the runs that most need one).
        if (report) appendFileSync(join(report, 'soak-samples.jsonl'), `${JSON.stringify(samples.at(-1))}\n`);
        ticks = [];
        lastSample = at;
      }
    }
  } finally {
    c.stop();
    await c.idle();
    if (oldTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmp;
    if (oldMark === undefined) delete process.env.SOAK_CHILD_MARK;
    else process.env.SOAK_CHILD_MARK = oldMark;
  }
  // The short smoke run has no warm-up to leave out and too little time to judge a slope: its limits say so.
  // Nor a log rate: 12 ticks never reach a WAL checkpoint, so it reads page writes (R1181e note 4: 243 KB of 256).
  const limits = hours > 0 ? SOAK_LIMITS : { ...SOAK_LIMITS, warmupMs: 0, heapGrowthBytes: 512 * MB, rssGrowthBytes: 1024 * MB, fdGrowth: 256, tickDrift: 20, tickMsPer100kEvents: 0, logBytesPerTask: 4 * MB };
  // A real soak is judged against the hours it was asked for (a run that stopped early fails).
  // `extended`: errors, worktrees and disk are recorded here, so a sample without them fails (R1181j 1, 2).
  const linux = process.platform === 'linux';
  const v = soakVerdict(samples, limits, hours > 0 ? { expectedMs: ms - sampleMs, sampleMs, issueEveryMs, extended: true, linux } : { extended: true, linux });
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
  // R1181j 1, 2: the driver records errors, worktrees, disk and children in every sample.
  for (const k of ['errors', 'worktrees', 'diskBytes'] as const) assert.ok(samples.every((s) => typeof s[k] === 'number'), `every sample has ${k}`);
  assert.ok(samples.every((s) => 'children' in s), 'every sample has children (a count, or null where ps cannot)');
});

// --- R1181j: what the verdict never saw (errors, worktrees, child processes, disk), and R1181i's gaps ---
test('soak verdict: coordinator errors after the warm-up fail; none, or only in the warm-up, pass (#1181 review R1181j 1)', () => {
  const opts = { expectedMs: 5.5 * 3600_000 - 60_000 };
  const v = (x: SoakSample[]) => soakVerdict(x, SOAK_LIMITS, opts).failures;
  // A step failing on every tick (R1181j's audit-chain throw), its work still landing.
  assert.match(v(series(330, (m) => ({ errors: m }))).join(' | '), /^errors: 329 coordinator\.error event\(s\) in the run \(limit 0\)/);
  assert.match(v(series(330, (m) => ({ errors: m >= 200 ? 1 : 0 }))).join(' | '), /^errors: 1 coordinator\.error/);
  assert.deepEqual(v(series(330, () => ({ errors: 0 }))), []);
  // R1181n: from the run's start, the warm-up included (an error in the first 10 minutes was never judged).
  assert.match(v(series(330, (m) => ({ errors: Math.min(m, 3) }))).join(' | '), /^errors: 3 coordinator\.error/, 'three in the warm-up');
  assert.match(v(series(330, (m) => ({ errors: m >= 10 ? 1 : 0 }))).join(' | '), /^errors: 1 coordinator\.error/, 'one before the first sample after the warm-up');
});

test('soak verdict: worktrees, child processes and disk are judged like open file handles; steady counts pass (#1181 review R1181j 2)', () => {
  const opts = { expectedMs: 5.5 * 3600_000 - 60_000 };
  const v = (x: SoakSample[]) => soakVerdict(x, SOAK_LIMITS, opts).failures.join(' | ');
  // R1181j's removeWorktree no-op: +2 worktrees a task.
  assert.match(v(series(330, (m) => ({ worktrees: 2 + 2 * m }))), /leak: worktrees grew by \d+/);
  assert.match(v(series(330, (m) => ({ worktrees: 2 + Math.floor(m / 60) }))), /leak: worktrees grew by 5/, 'one more an hour');
  assert.equal(v(series(330, (m) => ({ worktrees: m % 3 ? 2 : 4 }))), '', 'a task in flight at some samples');
  assert.match(v(series(330, (m) => ({ children: 1 + Math.floor(m / 30) }))), /leak: child processes grew by \d+/);
  assert.equal(v(series(330, () => ({ children: 1 }))), '');
  assert.match(v(series(330, (m) => ({ children: m % 3 ? null : 1 }))), /^child processes not counted in \d+ of 320 sample\(s\)/);
  // A file kept per task: 3 MB a landed task.
  assert.match(v(series(330, (m) => ({ diskBytes: 50 * MB + m * 3 * MB }))), /^disk growth: \d+\.\d MB under the soak's folder after the warm-up, besides the event log: \d{4} KB per landed task/);
  assert.equal(v(series(330, (m) => ({ diskBytes: 50 * MB + m * 100 * 1024 }))), '', '100 KB a task');
});

test("soak verdict: the driver's run (extended) fails closed on a sample missing errors, worktrees or disk (#1181 review R1181j)", () => {
  const full = (m: number) => ({ errors: 0, worktrees: 2, diskBytes: 50 * MB, children: 1 + 0 * m, failedRuns: 0, failureEvents: 0, worktreeDirs: 1, files: 400, fullRunHeld: 0, childRss: 50 * MB });
  assert.deepEqual(soakVerdict(series(330, full), SOAK_LIMITS, { expectedMs: 5.5 * 3600_000 - 60_000, extended: true }).failures, []);
  for (const k of ['errors', 'worktrees', 'diskBytes', 'children', 'failedRuns', 'failureEvents', 'worktreeDirs', 'files', 'fullRunHeld', 'childRss'] as const) {
    const x = series(330, full).map((s, i) => (i === 200 ? { ...s, [k]: undefined } : s));
    assert.match(soakVerdict(x, SOAK_LIMITS, { expectedMs: 5.5 * 3600_000 - 60_000, extended: true }).failures.join(), new RegExp(`^samples missing ${k}: nothing was judged`), k);
  }
});

test('soak verdict: a run too short for a drift check names it in measured, not passed in silence (#1181 review R1181j N3)', () => {
  const short = soakVerdict(series(90), SOAK_LIMITS, { expectedMs: 1.5 * 3600_000 - 60_000 });
  assert.deepEqual(short.failures, []);
  assert.match(String(short.measured.not_judged), /the last 30 min's drift .*the tick against the log/);
  assert.equal(soakVerdict(series(330, (m) => ({ events: m * 80 })), SOAK_LIMITS, { expectedMs: 5.5 * 3600_000 - 60_000 }).measured.not_judged, 'none');
});

test('soak verdict: R1181i G1-G4, a task waiting past the limit or a backlog mid-run, and fds held then let go, fail (#1181 review R1181i)', () => {
  const N = 330;
  const opts = { expectedMs: 5.5 * 3600_000 - 60_000, sampleMs: 60_000, issueEveryMs: 60_000 };
  const v = (x: SoakSample[]) => soakVerdict(x, SOAK_LIMITS, opts).failures.join(' | ');
  const aged = (from: number, to: number) => series(N, (m) => (m >= from && m < to ? { filed: m + 2, oldestUnlandedMs: (m - from) * 60_000 } : m >= to ? { filed: m + 2, tasksDone: m + 1 } : {}));
  assert.match(v(aged(100, 190)), /too little work: a task filed \d+ min/, 'G1 one task waits 90 min mid-run');
  assert.match(v(aged(200, 260)), /too little work: a task filed \d+ min/, 'G2 one task waits 60 min');
  assert.equal(v(aged(200, 225)), '', 'G2 twin: a 25-min wait passes');
  assert.match(v(series(N, (m) => ({ fds: m >= 100 && m < 230 ? 240 : 40 }))), /leak: open file handles peaked/, 'G3 fds +200 held 130 min, let go');
  assert.match(v(series(N, (m) => (m >= 100 && m < 120 ? { filed: m + 1, tasksDone: m - 24, oldestUnlandedMs: 20 * 60_000 } : {}))), /too little work: \d+ of \d+ task\(s\) filed not landed/, 'G4 a backlog of 25 mid-run');
});

test('the soak driver writes each sample as it is taken, so a crash or an OOM still leaves a report (#1181 review R1181j N1)', () => {
  // A text pin (the driver runs only as the smoke and the real soak, without a report folder in the unit tests).
  const src = readFileSync(join(repoRoot, 'test', 'soak.test.ts'), 'utf8');
  assert.match(src, /\n\s*\/\/ Each sample as it is taken[^\n]*\n\s*if \(report\) appendFileSync\(join\(report, 'soak-samples\.jsonl'\), `\$\{JSON\.stringify\(samples\.at\(-1\)\)\}\\n`\);/);
});

// --- R1181k, R1181l: the disk outside the log, files, the worktree folder, failed runs, and the driver's own counts ---
test('soak verdict: the disk outside the log, files and the worktree folder are judged; a healthy run passes (#1181 reviews R1181k D1, R1181l 3)', () => {
  const opts = { expectedMs: 5.5 * 3600_000 - 60_000 };
  const v = (x: SoakSample[]) => soakVerdict(x, SOAK_LIMITS, opts).failures.join(' | ');
  // The healthy shape: the disk grows with the log (240 KB a task), little else.
  const log = (m: number) => 1_000_000 + m * 240 * 1024;
  assert.equal(v(series(330, (m) => ({ eventsBytes: log(m), diskBytes: 30 * MB + log(m) + m * 4 * 1024, files: 500 + m * 27, worktreeDirs: 1 }))), '', 'the measured healthy rates');
  // V2: 1.9 MB kept a task besides the log.
  assert.match(v(series(330, (m) => ({ eventsBytes: log(m), diskBytes: 30 * MB + log(m) + m * 1.9 * MB }))), /^disk growth: .*besides the event log: \d+ KB per landed task \(limit 64 KB\)/);
  // V1: +8 GB held for minutes 100-300, then freed; V1b: 2 GB over the run, freed in the last 2 minutes.
  assert.match(v(series(330, (m) => ({ eventsBytes: log(m), diskBytes: 30 * MB + log(m) + (m >= 100 && m < 300 ? 8192 * MB : 0) }))), /leak: the disk under the soak's folder, besides the event log (grew|peaked)/);
  assert.match(v(series(330, (m) => ({ eventsBytes: log(m), diskBytes: 30 * MB + log(m) + (m < 328 ? (m / 328) * 2048 * MB : 0) }))), /leak: the disk under the soak's folder, besides the event log (grew|peaked)/);
  // 2,000 empty files a task.
  assert.match(v(series(330, (m) => ({ files: 500 + m * 2000 }))), /^file growth: \d+ files under the soak's folder after the warm-up, 2000 per landed task \(limit 64\)/);
  // R1181k A3: a checkout copied aside before `git worktree remove`: git's list steady, the folder +1 a task.
  assert.match(v(series(330, (m) => ({ worktrees: 2, worktreeDirs: 1 + m }))), /leak: the worktree folder's entries grew/);
  // The worktree limit is 2 (R1181l N1): +3 over the run fails.
  assert.match(v(series(330, (m) => ({ worktrees: 2 + Math.floor((m * 4) / 330) }))), /leak: worktrees grew by 3/);
  assert.equal(v(series(330, (m) => ({ worktrees: 2 + Math.floor((m * 3) / 330) }))), '', '+2 is at the limit');
});

test('soak verdict: an agent run that did not succeed, or another failure event, after the warm-up fails (#1181 review R1181l 5)', () => {
  const opts = { expectedMs: 5.5 * 3600_000 - 60_000 };
  const v = (x: SoakSample[]) => soakVerdict(x, SOAK_LIMITS, opts).failures.join(' | ');
  assert.match(v(series(330, (m) => ({ failedRuns: m >= 200 ? 1 : 0 }))), /^errors: 1 agent run\(s\) that did not succeed in the run/);
  assert.match(v(series(330, (m) => ({ failureEvents: Math.floor(m / 100) }))), /^errors: 3 failure event\(s\)/);
  assert.match(v(series(330, (m) => ({ failedRuns: Math.min(m, 2), failureEvents: 0 }))), /^errors: 2 agent run/, 'two in the warm-up (R1181n)');
  assert.equal(v(series(330, () => ({ failedRuns: 0, failureEvents: 0 }))), '', 'none');
});

test("the soak driver's counts read what they claim: failures in a log, worktrees, bytes and files, the worktree folder, and grouped processes (#1181 review R1181k D2)", async () => {
  const d = mkdtempSync(join(tmpdir(), 'soak-counts-'));
  try {
    // The log: two coordinator.error, a failed and a succeeded run, a startup failure, a merge.failed.
    const log = new EventLog(join(d, 'events.db'));
    log.append('coordinator.error', { instance: 'i', where: 'x', kind: 'TypeError', message: 'm' } as never, 'i');
    log.append('coordinator.error', { instance: 'i', where: 'x', kind: 'TypeError', message: 'm' } as never, 'i');
    log.append('run.finished', { issue: 1, role: 'worker', reason: 'failed', detail: 'x' } as never, 'i');
    log.append('run.finished', { issue: 1, role: 'worker', reason: 'succeeded', detail: '' } as never, 'i');
    log.append('run.startup_failed', { issue: 2, role: 'worker', attempt: 1, seconds: 1, turns: 0, detail: 'x' } as never, 'i');
    log.append('merge.failed', { issue: 3, number: 9, head: 'a'.repeat(40), why: 'x' } as never, 'i');
    assert.deepEqual(failureCounts(log), { errors: 2, failedRuns: 2, failureEvents: 1 });
    log.close();
    // Bytes and files.
    const box = join(d, 'box');
    mkdirSync(join(box, 'sub'), { recursive: true });
    writeFileSync(join(box, 'sub', 'a'), 'x'.repeat(1000));
    writeFileSync(join(box, 'b'), '');
    assert.deepEqual(dirUsage(box), { bytes: 1000, files: 3 });
    assert.equal(dirBytes(box), 1000);
    assert.equal(entriesIn(box), 2);
    assert.equal(entriesIn(join(d, 'not-there')), 0);
    // Worktrees: 1, then 2.
    const repo = join(d, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'i');
    assert.equal(worktreeCount(repo), 1);
    git(repo, 'worktree', 'add', '-q', join(d, 'wt'));
    assert.equal(worktreeCount(repo), 2);
    // A process double-forked away (its parent is then init) still counts: on Linux by the mark; elsewhere by our group,
    // only when we lead it (R1181p D5: under `node --test` the group is the runner's, every test file's).
    if (process.platform !== 'win32') {
      assert.notEqual(childCount(), null);
      const mark = `df-${process.pid}-${Date.now()}`;
      const pid = Number(spawnSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8', env: { ...process.env, SOAK_CHILD_MARK: mark } }).stdout.trim());
      try {
        // By its pid, not a total: other processes of the group (a test runner's) come and go meanwhile.
        const leads = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim()) === process.pid;
        if (process.platform === 'linux' || leads) assert.ok(childPids(mark)!.includes(pid), `${pid} in ${JSON.stringify(childPids(mark))}`);
      } finally {
        if (pid > 0) process.kill(pid);
      }
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('the soak driver takes each count from those helpers (#1181 review R1181k D2: a constant in their place passed every test)', () => {
  const src = readFileSync(join(repoRoot, 'test', 'soak.test.ts'), 'utf8');
  for (const line of ['...failureCounts(f.log),', 'worktrees: worktreeCount(f.repo),', 'worktreeDirs: entriesIn(wtDir),', 'diskBytes: usage.bytes,', 'files: usage.files,', 'children: kids?.length ?? null,', 'childRss: rssOf(kids ?? []),', 'watches: inotifyWatches(kids ?? []),', 'fullRunHeld: slotStatus(f.slotsDir).fullRun ? 1 : 0,', "levelBytes: hours > 0 && process.platform === 'linux' ? fsLevels([f.base, '/var/tmp', '/dev/shm', process.env.XDG_RUNTIME_DIR]) : null,"]) assert.ok(src.includes(`\n          ${line}\n`), line);
  assert.match(src, /\n {8}const kids = childPids\(childMark, seenLeaders, startProcs\);\n {8}const inside = dirUsage\(f\.base\);\n {8}const outside = usageOutside\(f\.base, kids \?\? \[\]\);\n {8}const usage = \{ bytes: inside\.bytes \+ outside\.bytes \+ deletedOpenBytes\(kids \?\? \[\]\), files: inside\.files \+ outside\.files \};\n/);
  assert.match(src, /\n {2}const startProcs = processSnapshot\(\);\n {2}const f = fixture\(\);\n/);
  assert.match(src, /extended: true, linux \}/);
  assert.match(src, /\n {2}process\.env\.SOAK_CHILD_MARK = childMark;\n/);
  // R1181l 3: temp files are made inside the measured folder.
  assert.match(src, /\n {2}const tmp = join\(f\.base, 'tmp'\);\n {2}mkdirSync\(tmp\);\n {2}const oldTmp = process\.env\.TMPDIR;\n {2}process\.env\.TMPDIR = tmp;\n/);
});

// --- R1181m, R1181n: detached and setsid'd children, the full-run lock, children's memory, watches ---
test('soak verdict: the full-run lock held at an idle sample, the children\'s memory grown, and inotify watches grown fail; steady passes (#1181 review R1181n)', () => {
  const opts = { expectedMs: 5.5 * 3600_000 - 60_000 };
  const v = (x: SoakSample[]) => soakVerdict(x, SOAK_LIMITS, opts).failures.join(' | ');
  assert.match(v(series(330, (m) => ({ fullRunHeld: m === 200 ? 1 : 0 }))), /^leaked the full-run lock: held at minute 200/);
  assert.match(v(series(330, (m) => ({ childRss: 50 * MB + m * 2 * MB }))), /leak: the child processes' RSS grew/);
  assert.match(v(series(330, (m) => ({ watches: 10 + m }))), /leak: inotify watches grew/);
  assert.equal(v(series(330, () => ({ fullRunHeld: 0, childRss: 50 * MB, watches: 10 }))), '');
});

test("the soak driver counts a detached child and, on Linux, a setsid'd double fork; children's memory, watches and the outside places are read (#1181 reviews R1181m D1, R1181n)", async () => {
  if (process.platform === 'win32') return;
  const mark = `t-${process.pid}-${Date.now()}`;
  const old = process.env.SOAK_CHILD_MARK;
  process.env.SOAK_CHILD_MARK = mark;
  const seen = new Set<number>();
  const pids: number[] = [];
  try {
    // A detached child (the coordinator spawns detached: its own group).
    const c = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    c.unref();
    pids.push(c.pid!);
    assert.ok(childPids(mark, seen)!.includes(c.pid!), 'a detached child');
    assert.ok(rssOf([c.pid!]) > 0, 'its memory is read');
    if (process.platform === 'linux') {
      // A setsid'd double fork: its parent gone, its session's leader never seen; the mark finds it.
      const pid = Number(spawnSync('setsid', ['sh', '-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim());
      pids.push(pid);
      assert.ok(childPids(mark, seen)!.includes(pid), "a setsid'd double fork");
      assert.equal(typeof inotifyWatches(), 'number');
    }
    // A file in the isolate's home (XDG_*) counts toward the disk.
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) {
      const before = usageOutside('/nonexistent').bytes;
      mkdirSync(xdg, { recursive: true });
      const f = join(xdg, `soak-test-${process.pid}`);
      writeFileSync(f, 'x'.repeat(8192));
      try {
        assert.ok(usageOutside('/nonexistent').bytes >= before + 8192, 'the isolate home');
      } finally {
        rmSync(f, { force: true });
      }
    }
    // Our own files in /dev/shm count toward the disk while we hold them (Linux; R1181p D4: only a held one counts, so
    // this test holds it open: written and closed, it read as another program's, and this assertion failed on CI).
    if (existsSync('/dev/shm')) {
      const shm = join('/dev/shm', `soak-test-${process.pid}`);
      const before = usageOutside('/nonexistent').bytes;
      writeFileSync(shm, 'x'.repeat(4096));
      const fd = openSync(shm, 'r');
      try {
        assert.ok(usageOutside('/nonexistent').bytes >= before + 4096);
      } finally {
        closeSync(fd);
        rmSync(shm, { force: true });
      }
    }
  } finally {
    for (const p of pids) if (p > 0) try { process.kill(p); } catch { /* gone */ }
    if (old === undefined) delete process.env.SOAK_CHILD_MARK;
    else process.env.SOAK_CHILD_MARK = old;
  }
});

// --- R1181o, R1181p: what no walk names, orphans in a new session, children's watches, /dev/shm held, the runner's
// group, every failure type ---
const linuxOnly = { skip: process.platform !== 'linux' };
const waitFor = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return ok();
};

test('soak: every event type ending in .failed or _failed is counted, read from src/events/types.ts itself (#1181 review R1181p D6)', () => {
  // Pinned against the schema's text, so a type added there is in the set (and so counted) without another edit.
  const text = readFileSync(join(repoRoot, 'src', 'events', 'types.ts'), 'utf8');
  const named = [...text.matchAll(/^ {2}'([a-z_]+(?:\.[a-z_]+)+)': /gm)].map((m) => m[1]!).filter((t) => /[._]failed$/.test(t)).sort();
  assert.deepEqual([...FAILURE_TYPES], named);
  for (const t of ['testrun.checks_failed', 'deploy.failed', 'fix_forward.attempt_failed', 'preview.failed', 'claude_auth.failed', 'merge.failed', 'attempt.failed', 'testrun.wipe_failed', 'run.startup_failed']) assert.ok(FAILURE_TYPES.includes(t), t);
  // Every one of them counts (the stand-ins never fail, so each is the coordinator's); run.startup_failed as a run.
  const rows = FAILURE_TYPES.map((type) => ({ type, payload: {} }));
  assert.deepEqual(failureCounts({ read: () => rows }), { errors: 0, failedRuns: 1, failureEvents: FAILURE_TYPES.length - 1 });
});

test('soak verdict: the filesystems\' and the kernel\'s used space grown fails, as the disk; steady passes; mostly unread fails; on Linux the watches are required (#1181 reviews R1181o D1, R1181p D2)', () => {
  const opts = { expectedMs: 5.5 * 3600_000 - 60_000 };
  const v = (x: SoakSample[], o = {}) => soakVerdict(x, SOAK_LIMITS, { ...opts, ...o }).failures.join(' | ');
  assert.match(v(series(330, (m) => ({ levelBytes: 10_000 * MB + m * 2 * MB }))), /leak: the used space of the soak's filesystems and the kernel's shared memory grew/);
  assert.equal(v(series(330, () => ({ levelBytes: 10_000 * MB }))), '');
  assert.match(v(series(330, (m) => ({ levelBytes: m % 3 === 0 ? 10_000 * MB : null }))), /the filesystems' used space not read in \d+ of/);
  assert.equal(v(series(330, () => ({ levelBytes: null }))), '', 'not read at all (off Linux, or the smoke): not judged');
  const full = (m: number) => ({ errors: 0, worktrees: 1, diskBytes: 30 * MB, children: 0, failedRuns: 0, failureEvents: 0, worktreeDirs: 1, files: 500 + m, fullRunHeld: 0, childRss: 0 });
  assert.match(v(series(330, full), { extended: true, linux: true }), /^samples missing watches: nothing was judged/);
  assert.equal(v(series(330, (m) => ({ ...full(m), watches: 3 })), { extended: true, linux: true }), '');
  assert.equal(v(series(330, full), { extended: true }), '', 'off Linux the watches are not required');
});

test("soak driver: our group counts only when we lead it, and never the test runner (#1181 review R1181p D5: sibling test files' children counted as ours)", () => {
  if (process.platform === 'win32') return;
  assert.ok(!childPids()!.includes(process.ppid), 'the runner');
  const leads = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim()) === process.pid;
  // An orphan in our group with no mark: the group rule alone would count it.
  const pid = Number(spawnSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8', env: { ...process.env, SOAK_CHILD_MARK: '' } }).stdout.trim());
  try {
    assert.equal(childPids(undefined, new Set(), null)!.includes(pid), leads, leads ? 'we lead our group: counted' : "the runner's group: not counted by it");
  } finally {
    if (pid > 0) process.kill(pid);
  }
});

test("soak driver: a process that was seen leading its group or session counts its double fork after it is gone, its mark cleared (#1181 review R1181p D7 L2)", async () => {
  if (process.platform === 'win32') return;
  const c = spawn('sh', ['-c', 'read x; env -u SOAK_CHILD_MARK sleep 30 >/dev/null 2>&1 & echo $!'], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  c.stdout!.on('data', (b) => (out += String(b)));
  const seen = new Set<number>();
  let pid = 0;
  try {
    assert.ok(await waitFor(() => childPids(undefined, seen)!.includes(c.pid!)), 'seen as a descendant');
    assert.ok(seen.has(c.pid!));
    c.stdin!.end('go\n');
    assert.ok(await waitFor(() => out.includes('\n') && c.exitCode !== null));
    pid = Number(out.trim());
    assert.ok(childPids(undefined, seen, null)!.includes(pid), 'its double fork, by the leader it was seen as');
    assert.ok(!childPids(undefined, new Set(), null)!.includes(pid), 'control: no leader seen, no mark, no snapshot: not counted');
  } finally {
    for (const p of [pid, c.pid ?? 0]) if (p > 0) try { process.kill(p); } catch { /* gone */ }
  }
});

test('soak driver (Linux): an orphan in a new session that dropped the mark, started after the snapshot, counts (#1181 review R1181p D1)', linuxOnly, async () => {
  const snap = processSnapshot()!;
  assert.ok(snap.pids.has(process.pid));
  const mark = `ns-${process.pid}-${Date.now()}`;
  const r = spawnSync('sh', ['-c', 'setsid sh -c \'env -u SOAK_CHILD_MARK sleep 30 >/dev/null 2>&1 & echo $!\''], { encoding: 'utf8', env: { ...process.env, SOAK_CHILD_MARK: mark } });
  const pid = Number(r.stdout.trim());
  try {
    assert.ok(pid > 0);
    assert.ok(childPids(mark, new Set(), snap)!.includes(pid), 'a new session of this user since the snapshot');
    assert.ok(!childPids(mark, new Set(), null)!.includes(pid), 'control: without the snapshot nothing else finds it');
  } finally {
    if (pid > 0) try { process.kill(pid); } catch { /* gone */ }
  }
});

test("soak driver (Linux): inotify watches are read, this process's and a counted child's (#1181 review R1181p D3, D7 L3)", linuxOnly, async () => {
  const d = mkdtempSync(join(tmpdir(), 'soak-inotify-'));
  const file = join(d, 'f');
  writeFileSync(file, 'x');
  const before = inotifyWatches()!;
  const w = watch(file);
  let c: ReturnType<typeof spawn> | null = null;
  try {
    assert.ok(inotifyWatches()! >= before + 1, "this process's own");
    c = spawn(process.execPath, ['-e', 'require("fs").watch(process.argv[1]); setInterval(() => {}, 1000)', file], { stdio: 'ignore' });
    assert.ok(await waitFor(() => inotifyWatches([c!.pid!])! - inotifyWatches()! >= 1), "a child's, summed with ours");
  } finally {
    w.close();
    c?.kill();
    rmSync(d, { recursive: true, force: true });
  }
});

test('soak driver (Linux): a /dev/shm entry counts only while a counted process holds it; an unlinked open file is counted; the levels are read (#1181 reviews R1181p D4, D2, R1181o D1)', linuxOnly, () => {
  const shm = join('/dev/shm', `soak-held-${process.pid}`);
  writeFileSync(shm, 'x'.repeat(8192));
  try {
    const free = usageOutside('/nonexistent');
    const fd = openSync(shm, 'r');
    try {
      assert.ok(usageOutside('/nonexistent').bytes >= free.bytes + 8192, 'held open: counted');
    } finally {
      closeSync(fd);
    }
    assert.equal(usageOutside('/nonexistent').bytes, free.bytes, "another program's (nobody counted holds it): not counted");
  } finally {
    rmSync(shm, { force: true });
  }
  const d = mkdtempSync(join(tmpdir(), 'soak-unlinked-'));
  const file = join(d, 'gone');
  const fd = openSync(file, 'w+');
  try {
    writeSync(fd, Buffer.alloc(1 << 20, 1));
    const named = deletedOpenBytes([]);
    rmSync(file);
    assert.ok(deletedOpenBytes([]) >= named + (1 << 20), 'unlinked and still open: its bytes counted');
  } finally {
    closeSync(fd);
    rmSync(d, { recursive: true, force: true });
  }
  assert.equal(typeof fsLevels([tmpdir(), '/dev/shm']), 'number');
});
