// #1231's acceptance bar for the soak (#1181): every attack the reviews found, as a must-fail case (a bad run whose
// verdict must report a failure), with healthy twins whose verdict must report none. Sources (the reviews' attack
// files): R1181b, R1181c (attacks-1181c/verdict.mjs) and R1181d (their cases, from the review comments), R1181f
// (attacks-1181f/attacks-r1181f.test.mjs), R1181g (r1181g/probe.mjs), R1181h (attacks-1181h/attack-1181h.test.mjs),
// R1181e's false fail (r1181e/overread.mjs), and the workflow bypasses of R1181c, R1181f 7 and R1181h 4.
// Not cases, by the reviews' own ranking: R1181d A15 / R1181f E1 (a run 4.96 h of 5.5 h: the 90% rule), R1181d A16
// (ticks 10x slower in the last 4 samples only: drift is judged on medians, a stated limit), and R1181h H4 (one held
// sample at the very end fails: the envelope reads the last ~30 samples, a stated limit).
// Out of this file's reach (R1231c): the driver's own fixes (it records oldestUnlandedMs, and passes sampleMs and
// issueEveryMs) and what the committed scripts/ci/fetch-pinned.sh does; the PR's own tests cover those.
// Revised per the spec reviews R1231c (its N1-N15 split the shapes earlier cases merged, so each fix has a case) and
// R1231e (its last cases). Frozen after R1231e by the owner's decision (c), 2026-11-08; the steps before the soak revised
// by the owner's decision on R1181l (npm ci --ignore-scripts, the locked tsc, gitleaks first with no BASH_ENV, node's
// path recorded after setup-node), in its own commit.
// Each must-fail case names the failure it expects (R1231a's lesson: "any failure" lets a fix that refuses everything
// pass); the healthy twins catch such a fix. Frozen once its spec review passes: a change then needs its own review.
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
const mustFail = (name: string, x: SoakSample[], want: RegExp, o: Opts = RUN) =>
  test(`must fail: ${name}`, () => {
    const f = failures(x, o);
    assert.notDeepEqual(f, [], `passed a bad run: ${JSON.stringify(soakVerdict(x, SOAK_LIMITS, o).measured)}`);
    assert.ok(f.some((m) => want.test(m)), `failed, but not for ${want}: ${f.join(' | ')}`);
  });
const LEAK_HEAP = /^leak: the heap/;
const LEAK_RSS = /^leak: RSS/;
const LEAK_FDS = /^leak: open file handles|^open file handles not counted/;
const OPEN = /^never finished|^leaked slots|^stuck/;
const WORK = /^too little work|^stalled/;
const LOG = /^log growth/;
const HANG = /^hang/;
const DRIFT = /^drift/;
const SHORT = /^too short/;
const mustPass = (name: string, x: SoakSample[], o: Opts = RUN) => test(`must pass: ${name}`, () => assert.deepEqual(failures(x, o), []));
const ramp = (m: number, from: number, size: number) => (m < 90 ? 0 : ((m - 90) / (N - 91)) * size) + from;
const saw = (m: number) => m % 10 >= 3 && m % 10 < 7;

// --- R1181b (round 1) ---
mustFail('R1181b: heap +1.5 GB in the last 35 min', series(N, (m) => (m >= 295 ? { heapUsed: 1600 * MB, rss: 1800 * MB } : {})), LEAK_HEAP);
mustFail('R1181b: a linear 165 MB heap leak', series(N, (m) => ({ heapUsed: 80 * MB + (Math.max(0, m - 10) * 165 * MB) / 320 })), LEAK_HEAP);
mustFail('R1181b: landing stops at task 15', series(N, (m) => ({ tasksDone: Math.min(15, m), filed: 2 * m + 1, eventsBytes: 1_000_000 + Math.min(15, m) * 1000 })), WORK);
mustFail('R1181b: a run of 2 h of the 5.5 h asked', series(120), SHORT);
mustFail('R1181b: all samples in the warm-up', series(6), SHORT);
mustFail('R1181b: open file handles uncounted in most samples', series(N, (m) => ({ fds: m % 3 ? null : 40 })), LEAK_FDS);
mustFail('R1181b: a 240-handle leak with one sample uncounted reads as a leak', series(N, (m) => ({ fds: m === 100 ? null : 40 + Math.floor((m * 240) / 330) })), /^leak: open file handles/);

// --- R1181d A1-A14 ---
mustFail('R1181d A1: heap +1.5 GB in the last 4 samples', series(N, (m) => (m >= N - 4 ? { heapUsed: 1600 * MB } : {})), LEAK_HEAP);
mustFail('R1181d A2: RSS +3 GB in the last 4 samples', series(N, (m) => (m >= N - 4 ? { rss: 3200 * MB } : {})), LEAK_RSS);
mustFail('R1181d A3: heap +250 MB over the last 5 samples', series(N, (m) => (m >= N - 5 ? { heapUsed: 330 * MB } : {})), LEAK_HEAP);
mustFail('R1181d A4: heap linear +148 MB', series(N, (m) => ({ heapUsed: 80 * MB + (Math.max(0, m - 10) * 148 * MB) / (N - 11) })), LEAK_HEAP);
mustFail('R1181d A5: RSS linear +295 MB', series(N, (m) => ({ rss: 200 * MB + (Math.max(0, m - 10) * 295 * MB) / (N - 11) })), LEAK_RSS);
mustFail('R1181d A6: fds +300 in the last 4 samples', series(N, (m) => (m >= N - 4 ? { fds: 340 } : {})), LEAK_FDS);
mustFail('R1181d A7: fds linear +37', series(N, (m) => ({ fds: 40 + Math.floor((Math.max(0, m - 10) * 37) / (N - 11)) })), LEAK_FDS);
mustFail('R1181d A8: a leaked slot with an orphaned run under 30 min', [...series(N - 1), sample((N - 1) * 60_000, { openRuns: 1, oldestOpenRunMs: 25 * 60_000, slotsHeld: 1 })], OPEN);
mustFail('R1181d A9: two leaked slots with two orphaned runs', [...series(N - 1), sample((N - 1) * 60_000, { openRuns: 2, oldestOpenRunMs: 29 * 60_000, slotsHeld: 2 })], OPEN);
mustFail('R1181d A10: a slot leaked mid-run, a run stuck 4 h closed a minute before the end', series(N, (m) => (m >= 60 && m < N - 1 ? { slotsHeld: 2, openRuns: 1, oldestOpenRunMs: (m - 60) * 60_000 } : {})), OPEN);
mustFail('R1181d A11: landing stops 78 min before the end', series(N, (m) => ({ tasksDone: Math.min(m, 252), filed: m + 1 })), WORK);
mustFail('R1181d A12: landing stops for the last third at the half-share edge', series(N, (m) => ({ tasksDone: 2 * Math.min(m, 252), filed: 2 * m + 1, eventsBytes: 1_000_000 + 2 * Math.min(m, 252) * 1000 })), WORK);
mustFail('R1181d A13: the log grows 50 MB in the last 30 min', series(N, (m) => ({ eventsBytes: 1_000_000 + m * 60 * 1024 + (m >= N - 30 ? ((m - (N - 30)) * 50 * MB) / 29 : 0) })), LOG);
mustFail('R1181d A14: the per-task log rate 100 then 350 KB', (() => { let b = 1_000_000; return series(N, (m) => ({ eventsBytes: (b += m < N / 2 ? 100 * 1024 : 350 * 1024) })); })(), LOG);

// --- R1181f ---
mustFail('R1181f S1: a heap sawtooth, peaks rising to +2.5 GB, the last 3 in a trough', series(N, (m) => ({ heapUsed: 80 * MB + (saw(m) ? (m / N) * 2500 * MB : 0) })), LEAK_HEAP);
mustFail('R1181f S2: an fd sawtooth, peaks rising to +400', series(N, (m) => ({ fds: 40 + (saw(m) ? Math.round((m / N) * 400) : 0) })), LEAK_FDS);
mustFail('R1181f G1: heap +2 GB held 130 min mid-run, let go', series(N, (m) => ({ heapUsed: m >= 100 && m < 230 ? 2080 * MB : 80 * MB })), LEAK_HEAP);
mustFail('R1181f SL1: a slot held 4 h next to one young orphaned run', series(N, (m) => (m >= 30 && m < N - 30 ? { openRuns: 1, slotsHeld: 1, oldestOpenRunMs: ((m - 30) % 25) * 60_000 } : {})), OPEN);
mustFail('R1181f SL2: two slots and two young orphaned runs for 4 h', series(N, (m) => (m >= 30 && m < N - 30 ? { openRuns: 2, slotsHeld: 2, oldestOpenRunMs: ((m - 30) % 29) * 60_000 } : {})), OPEN);
mustFail('R1181f W1: 49% of filed tasks never land', series(N, (m) => ({ filed: 2 * m + 1, tasksDone: Math.ceil((2 * m + 1) * 0.51) })), WORK);
mustFail('R1181f L1: a 45 MB log burst over 30 min at hour 2', series(N, (m) => ({ eventsBytes: 1_000_000 + m * 100 * 1024 + (m >= 120 ? Math.min(30, m - 120) * 1.5 * MB : 0) })), LOG);
mustFail('R1181f L2: 2.5 MB a sample for minutes 110-140', (() => { let b = 1_000_000; return series(N, (m) => ({ eventsBytes: (b += m >= 110 && m < 140 ? 2.5 * MB : 10 * 1024) })); })(), LOG);
mustFail('R1181f T1: no sample from minute 100 to 300, one 200-minute tick', [...series(100), ...series(N).slice(300).map((x, i) => sample((300 + i) * 60_000, { tickMs: i === 0 ? 200 * 60_000 : 50, maxTickMs: i === 0 ? 200 * 60_000 : 80, tasksDone: 100 + i, filed: 101 + i }))], HANG);
mustFail('R1181f D1: a tick linear in the log (138 ms + 0.0125 ms an event), a tick a second', series(N, (m) => ({ events: m * 60, tickMs: 138 + 0.0125 * m * 60 })), DRIFT);
test('must fail: R1181f SL3: an orphaned run re-paired by its retries still reads open, with its own age, and fails the soak', () => {
  const t0 = Date.parse('2026-11-08T00:00:00.000Z');
  const ev = (type: string, m: number) => ({ type, ts: new Date(t0 + m * 60_000).toISOString(), payload: { issue: 7, role: 'worker' } });
  const events = [ev('run.started', 0)];
  for (let m = 20; m <= 300; m += 20) events.push(ev('run.started', m), ev('run.finished', m + 1));
  const r = openRunsOf(events, t0 + 305 * 60_000);
  assert.equal(r.open, 1);
  assert.ok(r.oldestMs > SOAK_LIMITS.stuckMinutes * 60_000, `read as ${r.oldestMs / 60_000} min old`);
  const f = failures([...series(305), sample(305 * 60_000, { openRuns: r.open, oldestOpenRunMs: r.oldestMs })]);
  assert.ok(f.some((m) => OPEN.test(m)), `failed, but not for ${OPEN}: ${f.join(' | ')}`);
});

// --- R1181g ---
for (const t of [5, 10, 25]) mustFail(`R1181g: every tick ${t} min (a coordinator slow on every tick)`, Array.from({ length: Math.floor(330 / t) + 1 }, (_, i) => sample(i * t * 60_000, { tasksDone: i, filed: i + 1, maxTickMs: t * 60_000 - 1000, events: i * 10, eventsBytes: 1_000_000 + i * 60 * 1024 })), HANG);

// --- R1181h ---
mustFail('R1181h V1: heap high through the first quarter, then +1.1 GB over 4 h', series(N, (m) => ({ heapUsed: m < 90 ? 1100 * MB : ramp(m, 80 * MB, 1100 * MB) })), LEAK_HEAP);
mustFail('R1181h V1b: heap +300 MB through the first quarter, then +420 MB', series(N, (m) => ({ heapUsed: m < 90 ? 380 * MB : ramp(m, 80 * MB, 420 * MB) })), LEAK_HEAP);
mustFail('R1181h V1c: RSS high through the first quarter, then +750 MB', series(N, (m) => ({ rss: m < 90 ? 700 * MB : ramp(m, 200 * MB, 750 * MB) })), LEAK_RSS);
mustFail('R1181h V1d: fds 100 through the first quarter, then 40 to 130', series(N, (m) => ({ fds: m < 90 ? 100 : Math.round(ramp(m, 40, 90)) })), LEAK_FDS);
mustFail('R1181h V2: a 29-minute tick in every interval', Array.from({ length: 12 }, (_, i) => sample(i * 30 * 60_000, { tasksDone: 2 * i, filed: 2 * i + 1, maxTickMs: 29 * 60_000, eventsBytes: 1_000_000 + 2 * i * 60 * 1024 })), HANG);
mustFail('R1181h V2c: a 10-minute tick after every minute of work', Array.from({ length: 31 }, (_, i) => sample(i * 11 * 60_000, { tasksDone: 2 * i, filed: 2 * i + 1, maxTickMs: 10 * 60_000, eventsBytes: 1_000_000 + 2 * i * 60 * 1024 })), HANG);
mustFail('R1181h D2: one tick in three grows with the log to 20 s, the median flat', series(N, (m) => ({ events: m * 60, maxTickMs: 80 + m * 60 })), DRIFT);
mustFail('R1181h V3: ten tasks filed at the start never land', series(N, (m) => ({ filed: m + 10, tasksDone: m, oldestUnlandedMs: m * 60_000 })), WORK);
mustFail('R1181h W2: knobs set elsewhere: one task in 5.5 h, a sample every 30 min', Array.from({ length: 12 }, (_, i) => sample(i * 1800_000, { tasksDone: 1, filed: 1, events: 50 + i, eventsBytes: 1_000_000 + i * 1000 })), HANG, { expectedMs: 5.5 * 3600_000 - 1800_000 } as unknown as Opts);

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


// --- R1181c (attacks-1181c/verdict.mjs) ---
for (const stop of [250, 251, 260, 300, 320]) mustFail(`R1181c: landing (2/min) stops at minute ${stop} of 330`, series(N, (m) => ({ tasksDone: 2 * Math.min(m, stop), filed: 2 * m + 1 })), WORK);
for (const k of [35, 10, 6, 5, 4]) mustFail(`R1181c: heap +1.5 GB in the last ${k} min`, series(N, (m) => (m >= N - k ? { heapUsed: 1600 * MB } : {})), LEAK_HEAP);
for (const g of [140, 146, 150]) mustFail(`R1181c: a linear heap +${g} MB after the warm-up`, series(N, (m) => ({ heapUsed: 80 * MB + (Math.max(0, m - 10) * g * MB) / 320 })), LEAK_HEAP);
mustFail('R1181c: the tick 50 -> 1000 ms in the last 35 min', series(N, (m) => ({ tickMs: m >= 295 ? 1000 : 50, maxTickMs: m >= 295 ? 1200 : 80 })), DRIFT);
test('must fail: R1181c: a run stuck while a retry of the same issue starts and finishes reads open, with its own age', () => {
  const t0 = Date.parse('2026-11-08T00:00:00.000Z');
  const ev = (type: string, min: number) => ({ type, ts: new Date(t0 + min * 60_000).toISOString(), payload: { issue: 1, role: 'worker' } });
  assert.deepEqual(openRunsOf([ev('run.started', 0), ev('run.started', 100), ev('run.finished', 101)], t0 + 330 * 60_000), { open: 1, oldestMs: 330 * 60_000 });
});

// --- R1181e's healthy shapes (r1181e/healthy.mjs): rises that level off within the limit, steps within it ---
for (const p of [0.3, 0.5, 0.8]) mustPass(`R1181e: heap +120 MB over ${p * 100}% of the run, flat after`, series(N, (m) => ({ heapUsed: 80 * MB + 120 * MB * Math.min(1, Math.max(0, m - 10) / (p * (N - 10))) })));
for (const p of [0.3, 0.5]) mustPass(`R1181e: RSS +240 MB over ${p * 100}% of the run, flat after`, series(N, (m) => ({ rss: 200 * MB + 240 * MB * Math.min(1, Math.max(0, m - 10) / (p * (N - 10))) })));
for (const t of [165, 250]) mustPass(`R1181e: a heap step of +120 MB at minute ${t}`, series(N, (m) => ({ heapUsed: 80 * MB + (m >= t ? 120 * MB : 0) })));
for (const t of [100, 250]) mustPass(`R1181e: an fd step of +20 at minute ${t}`, series(N, (m) => ({ fds: 40 + (m >= t ? 20 : 0) })));
mustPass('a tick 1.5x slower, steady', series(N, () => ({ tickMs: 75, maxTickMs: 120 })));
mustPass('R1181h V1d twin: fds 100 through the first quarter, then 40 flat', series(N, (m) => ({ fds: m < 90 ? 100 : 40 })));

// --- R1231c: the review shapes the earlier cases merged, apart, so each fix has its own case (attacks-1231c) ---
mustFail('R1231c N1: no sample for minutes 101-125, ticks normal', series(N).filter((_, m) => m <= 100 || m >= 126), /^hang: no sample/);
mustFail('R1231c N2: landing (1/min) stops at minute 321', series(N, (m) => ({ tasksDone: Math.min(m, 321), oldestUnlandedMs: Math.max(0, m - 321) * 60_000 })), /^stalled/);
mustFail('R1231c N3 (R1181d A10, the slot half): 2 slots held minutes 60-328, no run open', series(N, (m) => (m >= 60 && m < N - 1 ? { slotsHeld: 2 } : {})), /^leaked slots/);
mustFail('R1231c N4 (R1181d A10, the run half): a run open minutes 60-328, no slot held', series(N, (m) => (m >= 60 && m < N - 1 ? { openRuns: 1, oldestOpenRunMs: (m - 60) * 60_000 } : {})), /^never finished/);
mustFail('R1231c N5 (R1181h D2 at D1\'s rate): the slowest tick 138 ms + 0.0125 ms an event', series(N, (m) => ({ events: m * 60, maxTickMs: 138 + 0.0125 * m * 60 })), /^drift: the slowest tick/);
mustFail('R1231c N6 (R1181h D2, a step): the slowest tick 80 -> 400 ms from minute 200', series(N, (m) => ({ events: m * 60, maxTickMs: m >= 200 ? 400 : 80 })), /^drift: the slowest tick/);
mustFail('R1231c N7 (R1181h W2, the filing knob alone): one task in 5.5 h, a sample a minute', series(N, (m) => ({ tasksDone: 1, filed: 1, events: m * 60 })), /^too little work: 1 task\(s\) filed/);
mustFail('R1231c N8: the log grows 10 MB in minutes 140-160 while landing pauses for minutes 120-180', series(N, (m) => { const d = m < 120 ? m : m < 180 ? 120 : m - 60; return { tasksDone: d, filed: d + 1, eventsBytes: 1_000_000 + d * 100 * 1024 + Math.min(20, Math.max(0, m - 140)) * 0.5 * MB }; }), /^log growth: the event log grew [\d.]+ MB in 30 min/);
mustFail('R1231c N9: the WAL grows to 95 MB', series(N, (m) => ({ walBytes: MB + m * 300_000 })), /^log growth: the WAL/);
mustFail('R1231c N10: a run of 4.8 h of the 5.5 h asked', series(289), SHORT);
{
  const s = [sample(0)];
  let at = 0;
  for (let i = 0; i < 302; i++) { at += (i % 100 < 51 ? 110 : 20) * 1000 + (i === 150 ? 200_000 : 0); s.push(sample(at)); }
  mustFail('R1231c N11: bunched samples (median 110 s) and one 5.2-min gap', s.map((x) => sample(x.at, { tasksDone: Math.floor(x.at / 60_000), filed: Math.floor(x.at / 60_000) + 1 })), /^hang: no sample/);
}
mustFail('R1231c N14 (R1181b 4 as dispatched): 0.1 h asked and run', series(6), SHORT, { expectedMs: 0.1 * 3600_000 - 60_000, sampleMs: 60_000, issueEveryMs: 30_000 } as unknown as Opts);
test('must fail: R1231c N15 (R1181b 1): issue 1 never finishes while 599 runs of other issues start and finish', () => {
  const t0 = Date.parse('2026-11-08T00:00:00.000Z');
  const ts = (m: number) => new Date(t0 + m * 60_000).toISOString();
  const ev = [{ type: 'run.started', ts: ts(0), payload: { issue: 1, role: 'worker' } }];
  for (let k = 0; k < 599; k++) ev.push({ type: 'run.started', ts: ts(1 + k * 0.5), payload: { issue: 100 + k, role: 'worker' } }, { type: 'run.finished', ts: ts(1.2 + k * 0.5), payload: { issue: 100 + k, role: 'worker' } });
  assert.deepEqual(openRunsOf(ev, t0 + 330 * 60_000), { open: 1, oldestMs: 330 * 60_000 });
});
mustFail('R1231c: the slowest tick 80 -> 1200 ms in the last 35 min, the median flat', series(N, (m) => ({ maxTickMs: m >= 295 ? 1200 : 80 })), /^drift: the slowest tick/);
mustFail('R1231c (the quarter drift apart from the last 30 min): the slowest tick 80 -> 400 ms for minutes 240-299, 80 for the last 30', series(N, (m) => ({ maxTickMs: m >= 240 && m < 300 ? 400 : 80 })), /^drift: the slowest tick of an interval went from/);
mustFail('R1181e (final-3 note 3): the log +8 MB in the last 30 min, 20 KB a task before', series(N, (m) => ({ eventsBytes: 1_000_000 + m * 20 * 1024 + (m >= N - 30 ? ((m - (N - 30)) * 8 * MB) / 29 : 0) })), LOG);

// --- R1231c: the reviews' healthy twins the file lacked ---
let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
test('must pass: R1181e noise, 500 seeds (heap sd 8 MB, RSS sd 30 MB, fds 40-44, tick 50 +- 10 ms)', () => {
  const bad: string[] = [];
  for (let k = 1; k <= 500; k++) {
    seed = k;
    const f = failures(series(N, (m) => ({ heapUsed: 80 * MB + 8 * MB * g(), rss: 200 * MB + 30 * MB * g(), fds: 40 + Math.floor(rnd() * 5), tickMs: 50 + 10 * g(), tasksDone: 2 * m, filed: 2 * m + 1, eventsBytes: 4_000_000 + m * 20_000, walBytes: 4 * MB })));
    if (f.length) bad.push(`${k}: ${f[0]}`);
  }
  assert.deepEqual(bad, []);
});
test('must pass: R1181g noise, 300 seeds (heap sd 15 MB, RSS sd 50 MB, fds 38-47, tick 150 +- 30 ms, log jitter)', () => {
  const bad: string[] = [];
  for (let k = 1; k <= 300; k++) {
    seed = k;
    const f = failures(series(N, (m) => ({ heapUsed: 80 * MB + 15 * MB * g(), rss: 200 * MB + 50 * MB * g(), fds: 38 + Math.floor(rnd() * 10), tickMs: 150 + 30 * g(), maxTickMs: 300 + 60 * Math.abs(g()), events: m * 60, eventsBytes: 1_000_000 + m * 60_000 + 200_000 * rnd() })));
    if (f.length) bad.push(`${k}: ${f[0]}`);
  }
  assert.deepEqual(bad, []);
});
mustPass('R1181g: the tick 150 ms rising 40 ms over the run', series(N, (m) => ({ tickMs: 150 + (40 * m) / N, maxTickMs: 300 + (40 * m) / N, events: m * 80 })));
mustPass('R1181g: the WAL fills to 4 MB, the main file grows in 400 KB checkpoint steps', series(N, (m) => ({ tasksDone: 2 * m, filed: 2 * m + 1, walBytes: Math.min(4 * MB, m * 280_000), eventsBytes: 32_768 + Math.min(4 * MB, m * 280_000) + Math.floor((m * 2 * 24_576) / 409_600) * 409_600 })));
for (const P of [15, 45, 90, 150]) mustPass(`R1181h H2: a heap sawtooth to +120 MB, period ${P}`, series(N, (m) => ({ heapUsed: 80 * MB + ((m % P) / (P - 1)) * 120 * MB })));
mustPass('R1181e: fds +24 over minutes 10-234, flat after', series(N, (m) => ({ fds: 40 + Math.round(24 * Math.min(1, Math.max(0, m - 10) / 224)) })));
mustPass('R1181h: the real 15-min runs\' log rate, 142 KB a task', series(N, (m) => ({ eventsBytes: 1_000_000 + m * 142 * 1024 })));
mustPass('the slowest tick 80 -> 200 ms in the last 35 min (under the drift limit)', series(N, (m) => ({ maxTickMs: m >= 295 ? 200 : 80 })));

// The steps before the soak step, exactly (R1231c).
const BEFORE_SOAK: unknown[] = [
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
  }
];

// --- R1231e: the last cases (attacks-1231e/missing2.test.mjs, ported 1:1) ---
mustFail('R1231e P1 (R1181c): a linear heap +132 MB after the warm-up', series(N, (m) => ({ heapUsed: 80 * MB + (Math.max(0, m - 10) * 132 * MB) / 320 })), LEAK_HEAP);
mustFail('R1231e P1b: the same, RSS +262 MB', series(N, (m) => ({ rss: 200 * MB + (Math.max(0, m - 10) * 262 * MB) / 320 })), LEAK_RSS);
{
  const s = [sample(0)];
  let at = 0;
  let i = 0;
  while (at <= 5.5 * 3600_000 - 15 * 60_000) {
    at += (i === 8 ? 40 : 15) * 60_000;
    s.push(sample(at, { tasksDone: Math.floor(at / 60_000), filed: Math.floor(at / 60_000) + 1, maxTickMs: i === 8 ? 40 * 60_000 : 80, events: Math.floor(at / 1000) }));
    i++;
  }
  mustFail('R1231e P2 (R1181f T1): a sample every 15 min, one 40-min tick (its gap under the gap limit)', s, /^hang: a tick took 40 min/, { expectedMs: 5.5 * 3600_000 - 15 * 60_000, sampleMs: 15 * 60_000, issueEveryMs: 30_000 } as unknown as Opts);
}
mustPass('R1231e P3: filing and landing pause 30 min from minute 150, idle ticks still log', series(N, (m) => { const d = m < 150 ? m : m < 180 ? 150 : m - 30; return { tasksDone: d, filed: d + 1 }; }));
mustFail('R1231e P4 (R1181c): the tick 50 -> 1000 ms in the last 35 min, the slowest tick 1200 ms throughout', series(N, (m) => ({ tickMs: m >= 295 ? 1000 : 50, maxTickMs: 1200 })), /^drift: the median tick of the last 30 min/);
mustFail('R1231e P5 (R1181h V3): no oldestUnlandedMs recorded fails closed', series(N, (m) => ({ filed: m + 10, tasksDone: m })).map((x) => { const c = { ...(x as unknown as Record<string, unknown>) }; delete c.oldestUnlandedMs; return c as unknown as SoakSample; }), /^samples missing oldestUnlandedMs/);
mustFail('R1231e P6: the median tick 50 -> 200 ms for minutes 240-299, 50 for the last 30, the slowest tick 300 ms throughout', series(N, (m) => ({ tickMs: m >= 240 && m < 300 ? 200 : 50, maxTickMs: 300 })), /^drift: the median tick went from/);

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
  // R1231c (R1181h 4): every step before the soak runs exactly this, so no earlier step can edit the code or the driver
  // the soak builds and runs, or swap an action: checkout and setup-node pinned by commit.
  assert.deepEqual(job.steps.slice(0, at), BEFORE_SOAK, 'every step before the soak runs exactly this');
  for (const s of job.steps.slice(0, at + 1)) {
    for (const k of ['if', 'continue-on-error', 'working-directory']) assert.equal(s[k], undefined, `step ${s.name ?? s.uses}: no ${k}`);
    // An earlier step writes nothing the soak step reads: no GITHUB_ENV, and GITHUB_PATH only for gitleaks's folder.
    if (s !== job.steps[at] && typeof s.run === 'string') {
      assert.doesNotMatch(s.run, /GITHUB_ENV/, `step ${s.name ?? s.run}: no GITHUB_ENV`);
      for (const l of s.run.split('\n').filter((x) => /GITHUB_PATH/.test(x))) assert.match(l, /^\s*echo "\$RUNNER_TEMP\/bin" >> "\$GITHUB_PATH"$/, l);
      // No package script and no npm script (R1181l 1, as ci.yml's shards): npm ci --ignore-scripts and the locked tsc,
      // run by the node recorded right after setup-node. The check runs on every step; only the two exact fragments that
      // name that recorded node are taken out first, and each may appear only in its own step, at its pinned place.
      const recordAt = BEFORE_SOAK.findIndex((x) => (x as { id?: string }).id === 'node');
      const tscAt = BEFORE_SOAK.findIndex((x) => /node_modules\/typescript\/bin\/tsc/.test(String((x as { run?: string }).run)));
      const i = job.steps.indexOf(s);
      assert.ok(!s.run.includes('$(command -v node)') || i === recordAt, `step ${s.name ?? s.run}: node recorded only in the record step`);
      assert.ok(!s.run.includes('${{ steps.node.outputs.path }}') || i === tscAt, `step ${s.name ?? s.run}: the recorded node run only by the tsc step`);
      const rest = s.run.replace('$(command -v node)', '').replace('${{ steps.node.outputs.path }} node_modules/', '');
      assert.doesNotMatch(rest, /\bnode\b(?!_modules)|\bnpm\s+(?!ci --ignore-scripts$)/m, `step ${s.name ?? s.run}: no node shim written`);
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
