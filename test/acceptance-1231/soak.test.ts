// #1231's acceptance bar for the soak (#1181): every attack the reviews found, as a must-fail case (a bad run whose
// verdict must report a failure), with healthy twins whose verdict must report none. Sources (the reviews' attack
// files): R1181b and R1181d (their cases in the PR's history, from the review comments), R1181f
// (attacks-1181f/attacks-r1181f.test.mjs), R1181g (r1181g/probe.mjs), R1181h (attacks-1181h/attack-1181h.test.mjs),
// R1181e's false fail (r1181e/overread.mjs), and the workflow bypasses of R1181c, R1181f 7 and R1181h 4.
// Not cases, by the reviews' own ranking: R1181d A15 / R1181f E1 (a run 4.96 h of 5.5 h: the 90% rule), and R1181h H4
// (one held sample at the very end fails: the envelope reads the last ~30 samples, a stated limit).
// Frozen: a change to this file needs its own acceptance review (#1231).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { SOAK_LIMITS, openRunsOf, soakVerdict, type SoakSample } from '../../src/soak.js';
import { repoRoot } from '../helpers.js';

const MB = 2 ** 20;
const N = 330;
/** A sample a minute; every field a verdict may read (typed loosely: the verdict's sample type may name fewer). */
const sample = (at: number, o: Record<string, unknown> = {}): SoakSample =>
  ({ at, rss: 200 * MB, heapUsed: 80 * MB, fds: 40, eventsBytes: 1_000_000 + at, walBytes: MB, events: Math.floor(at / 6_000), tickMs: 50, maxTickMs: 80, tasksDone: Math.floor(at / 60_000), filed: Math.floor(at / 60_000) + 1, oldestUnlandedMs: 0, openRuns: 0, oldestOpenRunMs: 0, slotsHeld: 0, ...o }) as unknown as SoakSample;
const series = (n: number, f: (m: number) => Record<string, unknown> = () => ({})) => Array.from({ length: n }, (_, m) => sample(m * 60_000, f(m)));
/** A 5.5 h run, judged as the driver judges it: the hours asked, the driver's sample and filing periods. */
type Opts = Parameters<typeof soakVerdict>[2];
const RUN = { expectedMs: 5.5 * 3600_000 - 60_000, sampleMs: 60_000, issueEveryMs: 60_000 } as unknown as Opts;
const failures = (x: SoakSample[], o: Opts = RUN) => soakVerdict(x, SOAK_LIMITS, o).failures;
const mustFail = (name: string, x: SoakSample[], o: Opts = RUN) => test(`must fail: ${name}`, () => assert.notDeepEqual(failures(x, o), [], `passed a bad run: ${JSON.stringify(soakVerdict(x, SOAK_LIMITS, o).measured)}`));
const mustPass = (name: string, x: SoakSample[], o: Opts = RUN) => test(`must pass: ${name}`, () => assert.deepEqual(failures(x, o), []));
const ramp = (m: number, from: number, size: number) => (m < 90 ? 0 : ((m - 90) / (N - 91)) * size) + from;
const saw = (m: number) => m % 10 >= 3 && m % 10 < 7;

// --- R1181b (round 1) ---
mustFail('R1181b: heap +1.5 GB in the last 35 min', series(N, (m) => (m >= 295 ? { heapUsed: 1600 * MB, rss: 1800 * MB } : {})));
mustFail('R1181b: a linear 165 MB heap leak', series(N, (m) => ({ heapUsed: 80 * MB + (Math.max(0, m - 10) * 165 * MB) / 320 })));
mustFail('R1181b: landing stops at task 15', series(N, (m) => ({ tasksDone: Math.min(15, m), filed: 2 * m + 1, eventsBytes: 1_000_000 + Math.min(15, m) * 1000 })));
mustFail('R1181b: a run of 2 h of the 5.5 h asked', series(120));
mustFail('R1181b: all samples in the warm-up', series(6));
mustFail('R1181b: open file handles uncounted in most samples', series(N, (m) => ({ fds: m % 3 ? null : 40 })));
mustFail('R1181b: a 240-handle leak with one sample uncounted', series(N, (m) => ({ fds: m === 100 ? null : 40 + Math.floor((m * 240) / 330) })));

// --- R1181d A1-A14 ---
mustFail('R1181d A1: heap +1.5 GB in the last 4 samples', series(N, (m) => (m >= N - 4 ? { heapUsed: 1600 * MB } : {})));
mustFail('R1181d A2: RSS +3 GB in the last 4 samples', series(N, (m) => (m >= N - 4 ? { rss: 3200 * MB } : {})));
mustFail('R1181d A3: heap +250 MB over the last 5 samples', series(N, (m) => (m >= N - 5 ? { heapUsed: 330 * MB } : {})));
mustFail('R1181d A4: heap linear +148 MB', series(N, (m) => ({ heapUsed: 80 * MB + (Math.max(0, m - 10) * 148 * MB) / (N - 11) })));
mustFail('R1181d A5: RSS linear +295 MB', series(N, (m) => ({ rss: 200 * MB + (Math.max(0, m - 10) * 295 * MB) / (N - 11) })));
mustFail('R1181d A6: fds +300 in the last 4 samples', series(N, (m) => (m >= N - 4 ? { fds: 340 } : {})));
mustFail('R1181d A7: fds linear +37', series(N, (m) => ({ fds: 40 + Math.floor((Math.max(0, m - 10) * 37) / (N - 11)) })));
mustFail('R1181d A8: a leaked slot with an orphaned run under 30 min', [...series(N - 1), sample((N - 1) * 60_000, { openRuns: 1, oldestOpenRunMs: 25 * 60_000, slotsHeld: 1 })]);
mustFail('R1181d A9: two leaked slots with two orphaned runs', [...series(N - 1), sample((N - 1) * 60_000, { openRuns: 2, oldestOpenRunMs: 29 * 60_000, slotsHeld: 2 })]);
mustFail('R1181d A10: a slot leaked mid-run, a run stuck 4 h closed a minute before the end', series(N, (m) => (m >= 60 && m < N - 1 ? { slotsHeld: 2, openRuns: 1, oldestOpenRunMs: (m - 60) * 60_000 } : {})));
mustFail('R1181d A11: landing stops 78 min before the end', series(N, (m) => ({ tasksDone: Math.min(m, 252), filed: m + 1 })));
mustFail('R1181d A12: landing stops for the last third at the half-share edge', series(N, (m) => ({ tasksDone: 2 * Math.min(m, 252), filed: 2 * m + 1, eventsBytes: 1_000_000 + 2 * Math.min(m, 252) * 1000 })));
mustFail('R1181d A13: the log grows 50 MB in the last 30 min', series(N, (m) => ({ eventsBytes: 1_000_000 + m * 60 * 1024 + (m >= N - 30 ? ((m - (N - 30)) * 50 * MB) / 29 : 0) })));
mustFail('R1181d A14: the per-task log rate 100 then 350 KB', (() => { let b = 1_000_000; return series(N, (m) => ({ eventsBytes: (b += m < N / 2 ? 100 * 1024 : 350 * 1024) })); })());

// --- R1181f ---
mustFail('R1181f S1: a heap sawtooth, peaks rising to +2.5 GB, the last 3 in a trough', series(N, (m) => ({ heapUsed: 80 * MB + (saw(m) ? (m / N) * 2500 * MB : 0) })));
mustFail('R1181f S2: an fd sawtooth, peaks rising to +400', series(N, (m) => ({ fds: 40 + (saw(m) ? Math.round((m / N) * 400) : 0) })));
mustFail('R1181f G1: heap +2 GB held 130 min mid-run, let go', series(N, (m) => ({ heapUsed: m >= 100 && m < 230 ? 2080 * MB : 80 * MB })));
mustFail('R1181f SL1: a slot held 4 h next to one young orphaned run', series(N, (m) => (m >= 30 && m < N - 30 ? { openRuns: 1, slotsHeld: 1, oldestOpenRunMs: ((m - 30) % 25) * 60_000 } : {})));
mustFail('R1181f SL2: two slots and two young orphaned runs for 4 h', series(N, (m) => (m >= 30 && m < N - 30 ? { openRuns: 2, slotsHeld: 2, oldestOpenRunMs: ((m - 30) % 29) * 60_000 } : {})));
mustFail('R1181f W1: 49% of filed tasks never land', series(N, (m) => ({ filed: 2 * m + 1, tasksDone: Math.ceil((2 * m + 1) * 0.51) })));
mustFail('R1181f L1: a 45 MB log burst over 30 min at hour 2', series(N, (m) => ({ eventsBytes: 1_000_000 + m * 100 * 1024 + (m >= 120 ? Math.min(30, m - 120) * 1.5 * MB : 0) })));
mustFail('R1181f L2: 2.5 MB a sample for minutes 110-140', (() => { let b = 1_000_000; return series(N, (m) => ({ eventsBytes: (b += m >= 110 && m < 140 ? 2.5 * MB : 10 * 1024) })); })());
mustFail('R1181f T1: no sample from minute 100 to 300, one 200-minute tick', [...series(100), ...series(N).slice(300).map((x, i) => sample((300 + i) * 60_000, { tickMs: i === 0 ? 200 * 60_000 : 50, maxTickMs: i === 0 ? 200 * 60_000 : 80, tasksDone: 100 + i, filed: 101 + i }))]);
mustFail('R1181f D1: a tick linear in the log (138 ms + 0.0125 ms an event), a tick a second', series(N, (m) => ({ events: m * 60, tickMs: 138 + 0.0125 * m * 60 })));
test('must fail: R1181f SL3: an orphaned run re-paired by its retries still reads open, with its own age, and fails the soak', () => {
  const t0 = Date.parse('2026-11-08T00:00:00.000Z');
  const ev = (type: string, m: number) => ({ type, ts: new Date(t0 + m * 60_000).toISOString(), payload: { issue: 7, role: 'worker' } });
  const events = [ev('run.started', 0)];
  for (let m = 20; m <= 300; m += 20) events.push(ev('run.started', m), ev('run.finished', m + 1));
  const r = openRunsOf(events, t0 + 305 * 60_000);
  assert.equal(r.open, 1);
  assert.ok(r.oldestMs > SOAK_LIMITS.stuckMinutes * 60_000, `read as ${r.oldestMs / 60_000} min old`);
  assert.notDeepEqual(failures([...series(305), sample(305 * 60_000, { openRuns: r.open, oldestOpenRunMs: r.oldestMs })]), []);
});

// --- R1181g ---
for (const t of [5, 10, 25]) mustFail(`R1181g: every tick ${t} min (a coordinator slow on every tick)`, Array.from({ length: Math.floor(330 / t) + 1 }, (_, i) => sample(i * t * 60_000, { tasksDone: i, filed: i + 1, maxTickMs: t * 60_000 - 1000, events: i * 10, eventsBytes: 1_000_000 + i * 60 * 1024 })));

// --- R1181h ---
mustFail('R1181h V1: heap high through the first quarter, then +1.1 GB over 4 h', series(N, (m) => ({ heapUsed: m < 90 ? 1100 * MB : ramp(m, 80 * MB, 1100 * MB) })));
mustFail('R1181h V1b: heap +300 MB through the first quarter, then +420 MB', series(N, (m) => ({ heapUsed: m < 90 ? 380 * MB : ramp(m, 80 * MB, 420 * MB) })));
mustFail('R1181h V1c: RSS high through the first quarter, then +750 MB', series(N, (m) => ({ rss: m < 90 ? 700 * MB : ramp(m, 200 * MB, 750 * MB) })));
mustFail('R1181h V1d: fds 100 through the first quarter, then 40 to 130', series(N, (m) => ({ fds: m < 90 ? 100 : Math.round(ramp(m, 40, 90)) })));
mustFail('R1181h V2: a 29-minute tick in every interval', Array.from({ length: 12 }, (_, i) => sample(i * 30 * 60_000, { tasksDone: 2 * i, filed: 2 * i + 1, maxTickMs: 29 * 60_000, eventsBytes: 1_000_000 + 2 * i * 60 * 1024 })));
mustFail('R1181h V2c: a 10-minute tick after every minute of work', Array.from({ length: 31 }, (_, i) => sample(i * 11 * 60_000, { tasksDone: 2 * i, filed: 2 * i + 1, maxTickMs: 10 * 60_000, eventsBytes: 1_000_000 + 2 * i * 60 * 1024 })));
mustFail('R1181h D2: one tick in three grows with the log to 20 s, the median flat', series(N, (m) => ({ events: m * 60, maxTickMs: 80 + m * 60 })));
mustFail('R1181h V3: ten tasks filed at the start never land', series(N, (m) => ({ filed: m + 10, tasksDone: m, oldestUnlandedMs: m * 60_000 })));
mustFail('R1181h W2: knobs set elsewhere: one task in 5.5 h, a sample every 30 min', Array.from({ length: 12 }, (_, i) => sample(i * 1800_000, { tasksDone: 1, filed: 1, events: 50 + i, eventsBytes: 1_000_000 + i * 1000 })), { expectedMs: 5.5 * 3600_000 - 1800_000 } as unknown as Opts);

// --- Healthy twins: the verdict must pass these ---
mustPass('a steady 5.5 h run', series(N));
mustPass('R1181e: heap +95 MB to minute 234, flat after', series(N, (m) => ({ heapUsed: 80 * MB + (Math.min(Math.max(0, m - 10), 224) / 224) * 95 * MB })));
mustPass('R1181e: RSS +190 MB the same shape', series(N, (m) => ({ rss: 200 * MB + (Math.min(Math.max(0, m - 10), 224) / 224) * 190 * MB })));
mustPass('a heap hump of +320 MB held 80 min mid-run', series(N, (m) => (m >= 200 && m < 280 ? { heapUsed: 400 * MB } : {})));
mustPass('R1181h V1 twin: a high first quarter, then flat', series(N, (m) => ({ heapUsed: m < 90 ? 1100 * MB : 80 * MB })));
mustPass('R1181h H3: landings in batches of 10 every 10 minutes', series(N, (m) => ({ tasksDone: Math.floor(m / 10) * 10, filed: m + 1, eventsBytes: 1_000_000 + m * 100 * 1024, oldestUnlandedMs: (m % 10) * 60_000 })));
test('must pass: R1181h H1: RSS +205 MB linear (80% of its limit) under noise, 50 seeds', () => {
  const rng = (seed: number) => { let a = seed >>> 0; const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; return (sd: number) => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u()) * sd; };
  const bad: string[] = [];
  for (let seed = 1; seed <= 50; seed++) {
    const n = rng(seed);
    const f = failures(series(N, (m) => ({ rss: 200 * MB + (Math.max(0, m - 10) / (N - 11)) * 0.8 * 256 * MB + n(30 * MB), heapUsed: 80 * MB + n(8 * MB) })));
    if (f.length) bad.push(`${seed}: ${f[0]}`);
  }
  assert.deepEqual(bad, []);
});

// --- The workflow: the bypasses of R1181c 2, R1181f 7 and R1181h 4 ---
test('must hold: the soak workflow can be green only on a soak run as asked (R1181c 2, R1181f 7, R1181h 4)', () => {
  const text = readFileSync(join(repoRoot, '.github', 'workflows', 'soak.yml'), 'utf8');
  type Step = Record<string, unknown> & { name?: string; run?: string; env?: Record<string, unknown>; uses?: string };
  const w = parse(text) as { on: Record<string, unknown>; permissions: unknown; env?: unknown; defaults?: unknown; jobs: Record<string, Record<string, unknown> & { steps: Step[] }> };
  assert.deepEqual(Object.keys(w.on).sort(), ['schedule', 'workflow_dispatch'], 'never on a pull request');
  assert.deepEqual(w.permissions, { contents: 'read' });
  assert.equal(w.env, undefined, 'no workflow-level env');
  assert.equal(w.defaults, undefined);
  assert.doesNotMatch(text, /\bsecrets\b/, 'no secret, in any form');
  const job = w.jobs.soak!;
  for (const k of ['if', 'permissions', 'continue-on-error', 'env', 'container', 'strategy', 'environment']) assert.equal(job[k], undefined, `no job ${k}`);
  const at = job.steps.findIndex((s) => s.name === 'soak');
  assert.ok(at > 0);
  for (const s of job.steps.slice(0, at + 1)) {
    for (const k of ['if', 'continue-on-error', 'working-directory']) assert.equal(s[k], undefined, `step ${s.name ?? s.uses}: no ${k}`);
    // An earlier step writes nothing the soak step reads: no GITHUB_ENV, and GITHUB_PATH only for gitleaks's folder.
    if (s !== job.steps[at] && typeof s.run === 'string') {
      assert.doesNotMatch(s.run, /GITHUB_ENV/, `step ${s.name ?? s.run}: no GITHUB_ENV`);
      for (const l of s.run.split('\n').filter((x) => /GITHUB_PATH/.test(x))) assert.match(l, /^\s*echo "\$RUNNER_TEMP\/bin" >> "\$GITHUB_PATH"$/, l);
      assert.doesNotMatch(s.run, /\bnode\b(?!_modules)|\bnpm\s+(?!ci$|run build$)/m, `step ${s.name ?? s.run}: no node shim written`);
    }
  }
  const step = job.steps[at]!;
  const env = step.env ?? {};
  // The knobs are set in the step, NODE_OPTIONS and BASH_ENV cleared (R1181h 4: GITHUB_ENV from an earlier step).
  assert.equal(env.SOAK_SAMPLE_S, '60');
  assert.equal(env.SOAK_ISSUE_EVERY_S, '30');
  assert.equal(env.NODE_OPTIONS, '');
  assert.equal(env.BASH_ENV, '');
  const run = step.run!;
  assert.match(run, /SOAK_HOURS="\$HOURS"/, 'the hours asked, not a constant');
  assert.match(run, /--expose-gc/);
  assert.match(run, /case "\$node_bin" in "\$RUNNER_TOOL_CACHE"\/\*\)/, "setup-node's node only");
  assert.doesNotMatch(run, /\|\|\s*(true|:|exit 0)\b|set \+e|\btrap\b|exit 0\b/, 'nothing swallows a failure');
  const lines = run.trimEnd().split('\n');
  assert.match(lines.at(-1)!, /v\.asked !== Number\(process\.argv\[2\]\)[\s\S]*process\.exit\(1\)[\s\S]*"\$HOURS"$/, 'the verdict check ends the step and checks the hours asked');
});
