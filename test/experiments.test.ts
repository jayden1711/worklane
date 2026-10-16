// Experiment studies, the engine's core (src/experiments/): the study file, the two-stage keep/discard with the scale
// ladder, the anomaly hold, one variable per hypothesis, exploration, the session's one proposal and the change check,
// the state fold, approval and caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalReasons, APPROVE_DEFAULTS, budgetHold, rootRefusal, sessionBudgetUsd, type RootCaps } from '../src/experiments/approval.js';
import { best, judgeStage2, nextStep, screen, shouldExplore, variablesChanged, type Entry, type Plan } from '../src/experiments/keep.js';
import { renderLog } from '../src/experiments/log.js';
import { checkChange, parseRawDiff, readProposal, type Change } from '../src/experiments/proposal.js';
import { foldStudy, jobId, nextN, sessionHold, type StudyEvent } from '../src/experiments/state.js';
import { configRefusal, StudiesFile, Study, studyVersion } from '../src/experiments/study.js';
import { EventSchemas } from '../src/events/types.js';

const raw = {
  id: 'example-speed',
  goal: 'Lower validation loss at a fixed training budget',
  metric: { name: 'val_loss', direction: 'min', min_delta: 0.01 },
  eval: { predict: 'python eval/predict.py', score: 'python score.py', files: ['eval/score.py'], predict_files: ['eval/predict.py'], inputs: 'eval-inputs', labels: 'eval-labels' },
  train: { command: 'python train.py', data: ['train-set'], env: { lockfile: 'uv.lock', build: 'uv sync --frozen' } },
  editable: ['train.py', 'model/**', 'uv.lock'],
  config_schema: { lr: { type: 'number', min: 1e-5, max: 0.1 }, depth: { type: 'integer', min: 2, max: 24 }, opt: { type: 'enum', values: ['adam', 'sgd'] } },
  budget: { gpu_hours_per_day: 4, agent_usd_per_day: 5, agent_usd_total: 60, max_jobs: 200 },
};
const study = Study.parse(raw);
const plan = (o: Partial<Plan> = {}): Plan => ({ metric: { direction: 'min', min_delta: 0.01, anomaly_margin: 0.25 }, screen: { margin: 0.05, seeds: 3 }, sizes: 1, exploration: { share: 0, near_miss: 0.02 }, ...o });

test('study file: defaults, kinds, split eval only, unique ids', () => {
  assert.deepEqual([study.kind, study.eval.mode, study.metric.source, study.metric.anomaly_margin], ['supervised', 'split', 'score', 0.25]);
  assert.deepEqual(study.screen, { margin: 0, seeds: 3 });
  for (const kind of ['supervised', 'self_supervised', 'unsupervised', 'generative']) assert.equal(Study.parse({ ...raw, kind }).kind, kind);
  assert.throws(() => Study.parse({ ...raw, eval: { ...raw.eval, mode: 'in_process' } }));
  assert.throws(() => StudiesFile.parse({ version: 1, studies: [raw, raw] }), /two studies/);
});

test('rl_rollout is refused with a clear message: not supported in this version', () => {
  assert.throws(() => Study.parse({ ...raw, kind: 'rl_rollout' }), /rl_rollout is not supported in this version/);
});

test('a study never lets a job read the labels or the scorer, or change the eval', () => {
  assert.throws(() => Study.parse({ ...raw, train: { ...raw.train, data: ['train-set', 'eval-labels'] } }), /labels/);
  assert.throws(() => Study.parse({ ...raw, eval: { ...raw.eval, labels: 'eval-inputs' } }), /labels/);
  assert.throws(() => Study.parse({ ...raw, editable: ['**'] }), /covers the eval file/);
  assert.throws(() => Study.parse({ ...raw, eval: { ...raw.eval, predict_files: ['eval/score.py'] } }), /the scorer's/);
  for (const p of ['/etc/x', '../x', '.worklane/roles/a.md', '.git/config']) assert.throws(() => Study.parse({ ...raw, editable: [p] }), p);
});

test('a study\'s version changes with its definition, its eval files and its data', () => {
  const v = studyVersion(study, { 'eval/score.py': 'a' }, { 'train-set': 'b' });
  assert.notEqual(v, studyVersion(study, { 'eval/score.py': 'c' }, { 'train-set': 'b' }));
  assert.notEqual(v, studyVersion(study, { 'eval/score.py': 'a' }, { 'train-set': 'c' }));
  assert.notEqual(v, studyVersion(Study.parse({ ...raw, goal: 'x' }), { 'eval/score.py': 'a' }, { 'train-set': 'b' }));
});

test('a config outside the schema never runs: refused, not clamped', () => {
  assert.equal(configRefusal({ lr: 0.01, depth: 4, opt: 'adam' }, study.config_schema), null);
  assert.match(configRefusal({ lr: 1 }, study.config_schema)!, /between/);
  assert.match(configRefusal({ seed: 1 }, study.config_schema)!, /not one of the study's knobs/);
});

test('the session\'s output: one proposal with its one variable, capped and redacted, nothing extra', () => {
  const ok = readProposal({ hypothesis: 'h'.repeat(300), variable: 'lr', motivation: 'm\n\nx', expected_effect: 'e', config: { lr: 0.001 } }, study);
  assert.ok(!('refused' in ok));
  assert.deepEqual([ok.hypothesis.length, ok.motivation, ok.variable], [200, 'm x', 'lr']);
  assert.match((readProposal({ hypothesis: 'h', variable: 'v', motivation: 'm', expected_effect: 'e', config: {}, jobs: 2 }, study) as { refused: string }).refused, /unexpected fields: jobs/);
  assert.match((readProposal({ hypothesis: 'h', motivation: 'm', expected_effect: 'e', config: {} }, study) as { refused: string }).refused, /no variable/);
});

const ch = (path: string, oldMode = '100644', newMode = '100644'): Change => ({ path, oldMode, newMode, status: 'M' });

test('a change outside the editable paths, or to any eval file, never runs', () => {
  assert.deepEqual(checkChange([ch('train.py'), ch('model/a.py', '000000', '100644')], study), { ok: true, files: ['model/a.py', 'train.py'], lockfile: false });
  assert.match((checkChange([ch('eval/score.py')], study) as { why: string }).why, /eval file/);
  assert.match((checkChange([ch('eval/predict.py')], study) as { why: string }).why, /eval file/);
  assert.match((checkChange([ch('README.md')], study) as { why: string }).why, /outside/);
  assert.match((checkChange([ch('model/link', '000000', '120000')], study) as { why: string }).why, /symlink/);
  assert.match((checkChange([], study) as { why: string }).why, /no change/);
});

test('git diff --raw -z reads back', () => {
  const z = `:100644 100644 ${'a'.repeat(7)} ${'b'.repeat(7)} M\0train.py\0`;
  assert.deepEqual(parseRawDiff(z), [ch('train.py')]);
});

test('one variable per hypothesis: a knob, or the code; two of anything is two', () => {
  assert.deepEqual(variablesChanged({ lr: 0.02 }, { lr: 0.01 }, false), ['knob lr']);
  assert.deepEqual(variablesChanged({ lr: 0.01 }, { lr: 0.01 }, true), ['code']);
  assert.deepEqual(variablesChanged({ lr: 0.02, depth: 4 }, { lr: 0.01 }, false), ['knob lr', 'knob depth']);
  assert.deepEqual(variablesChanged({ lr: 0.02 }, { lr: 0.01 }, true), ['knob lr', 'code']);
});

const e = (n: number, kind: Entry['kind'], result: number | null, decision: Entry['decision'], extra: Partial<Entry> = {}): Entry => ({ n, kind, parent: null, size: 0, seed: 1, result, decision, ...extra });
const seeds = (of: number, vs: number, cand: number[], bst: number[], size = 0, from = 100): Entry[] => [...cand.map((r, i) => e(from + i, 'seed', r, 'seed', { of, arm: 'candidate', size, seed: i + 1, minutes: 10 })), ...bst.map((r, i) => e(from + 50 + i, 'seed', r, 'seed', { of, arm: 'best', size, seed: i + 1, minutes: 10, parent: vs }))];

test('a stage-1 loser is screened out and never run again', () => {
  const log = [e(1, 'baseline', 3, 'keep')];
  const sc = screen(log, 2.99, plan());
  assert.equal(sc.decision, 'screened_out');
  assert.match(sc.why, /screened out, 1 seed/);
  const next = nextStep([...log, e(2, 'exploit', 2.99, 'screened_out', { parent: 1 })], plan());
  assert.equal(next.do, 'session', 'the next step is a new hypothesis, never a seed of #2');
});

test('a stage-1 winner gets N seeds of itself and N of the best, alternating, at the same size, then a judgment', () => {
  const log: Entry[] = [e(1, 'baseline', 3, 'keep'), e(2, 'exploit', 2.8, 'stage2', { parent: 1, vs: 1 })];
  assert.equal(screen(log.slice(0, 1), 2.8, plan()).decision, 'stage2');
  const asked: string[] = [];
  for (let i = 0; i < 6; i++) {
    const s = nextStep(log, plan());
    assert.equal(s.do, 'seed');
    if (s.do !== 'seed') return;
    asked.push(`${s.arm}:${s.source}:${s.size}`);
    log.push(e(10 + i, 'seed', 2.8, 'seed', { of: 2, arm: s.arm, size: s.size, seed: s.seed }));
  }
  assert.deepEqual(asked.sort(), ['best:1:0', 'best:1:0', 'best:1:0', 'candidate:2:0', 'candidate:2:0', 'candidate:2:0']);
  assert.deepEqual(nextStep(log, plan()), { do: 'judge', of: 2 });
});

test('a candidate within the seeds\' spread is discarded, and reported as mean ± spread', () => {
  const c = e(2, 'exploit', 2.8, 'stage2', { parent: 1, vs: 1 });
  const log = [e(1, 'baseline', 3, 'keep'), c, ...seeds(2, 1, [2.9, 3.1, 2.7], [3.0, 3.2, 2.8])];
  const j = judgeStage2(log, c, plan(), false);
  assert.equal(j.decision, 'discard');
  assert.match(j.why, /within the spread: 2\.9 ± 0\.2 vs best 3 ± 0\.2/);
  assert.deepEqual([j.stage2.minutesCandidate, j.stage2.minutesBest], [30, 30], 'the same budget each, recorded');
  const clear = judgeStage2([e(1, 'baseline', 3, 'keep'), c, ...seeds(2, 1, [2.8, 2.81, 2.79], [3.0, 3.01, 2.99])], c, plan(), false);
  assert.equal(clear.decision, 'keep');
  assert.ok(Math.abs(clear.value! - 2.8) < 1e-9);
});

test('a ladder winner is not promotable until the next size passes too', () => {
  const p = plan({ sizes: 2 });
  const c = e(2, 'exploit', 2.8, 'stage2', { parent: 1, vs: 1 });
  const at0 = [e(1, 'baseline', 3, 'keep'), c, ...seeds(2, 1, [2.8, 2.81, 2.79], [3.0, 3.01, 2.99])];
  const j0 = judgeStage2(at0, c, p, false);
  assert.equal(j0.decision, 'ladder');
  const onLadder = { ...c, decision: 'ladder' as const, stage2: [j0.stage2] };
  const log = [at0[0]!, onLadder, ...at0.slice(2)];
  assert.equal(best(log)!.n, 1, 'not the best yet');
  const s = nextStep(log, p);
  assert.ok(s.do === 'seed' && s.size === 1, 'its next runs are at the next size');
  const j1 = judgeStage2([...log, ...seeds(2, 1, [2.5, 2.51, 2.49], [2.7, 2.71, 2.69], 1, 300)], onLadder, p, false);
  assert.equal(j1.decision, 'keep');
});

test('a winner past the anomaly margin, or whose session the monitor flagged, is held for review', () => {
  const c = e(2, 'exploit', 1, 'stage2', { parent: 1, vs: 1 });
  const big = [e(1, 'baseline', 3, 'keep'), c, ...seeds(2, 1, [1.0, 1.01, 0.99], [3.0, 3.01, 2.99])];
  assert.equal(judgeStage2(big, c, plan(), false).decision, 'held');
  const small = [e(1, 'baseline', 3, 'keep'), c, ...seeds(2, 1, [2.8, 2.81, 2.79], [3.0, 3.01, 2.99])];
  assert.equal(judgeStage2(small, c, plan(), true).decision, 'held', 'flagged by the monitor');
  assert.deepEqual(nextStep([e(1, 'baseline', 3, 'keep'), { ...c, decision: 'held' }], plan()), { do: 'wait', why: '#2 waits for an owner\'s review' });
});

test('an explore winner is combined onto the best, not promoted alone', () => {
  const c = e(3, 'explore', 2.8, 'stage2', { parent: 2, vs: 1 });
  const log = [e(1, 'baseline', 3, 'keep'), e(2, 'exploit', 2.98, 'screened_out', { parent: 1 }), c, ...seeds(3, 1, [2.8, 2.81, 2.79], [3.0, 3.01, 2.99])];
  const j = judgeStage2(log, c, plan(), false);
  assert.equal(j.decision, 'winner');
  assert.deepEqual(nextStep([...log.slice(0, 2), { ...c, decision: 'winner' }], plan()), { do: 'session', kind: 'combine', parent: 1, combines: 3 });
});

test('the exploration share is exact and the best never worsens', () => {
  const log: Entry[] = [e(1, 'baseline', 3, 'keep')];
  let explores = 0;
  for (let n = 2; n <= 101; n++) {
    const s = nextStep(log, plan({ exploration: { share: 0.2, near_miss: 0.02 } }));
    assert.equal(s.do, 'session');
    if (s.do !== 'session') return;
    if (s.kind === 'explore') explores++;
    log.push(e(n, s.kind, 3.5, screen(log, 3.5, plan()).decision, { parent: s.parent }));
  }
  assert.equal(explores, 20);
  assert.deepEqual(best(log), { n: 1, value: 3 });
  assert.equal(shouldExplore([], 0), false);
});

const ev = (type: string, payload: Record<string, unknown>, ts = '2026-10-15T12:00:00Z'): StudyEvent => ({ type, ts, payload: { study: 'example-speed', ...payload } });
const session = (n: number, s = `s${n}`, kind = n === 1 ? 'baseline' : 'exploit') => ev('experiment.session', { version: 'v1', session: s, n, kind, parent: n === 1 ? null : 1, size: 0, seed: 1 });
const proposed = (n: number, s = `s${n}`, approval: string[] = []) => ev('experiment.proposed', { version: 'v1', session: s, n, job: jobId('example-speed', n), hypothesis: `h${n}`, variable: 'lr', motivation: 'm', expected_effect: 'e', config: {}, commit: 'a'.repeat(40), files: ['train.py'], lockfile: false, approval });
const recorded = (n: number, score: number | null, decision: string) => ev('experiment.recorded', { version: 'v1', job: jobId('example-speed', n), n, outcome: score === null ? 'crashed' : 'scored', score, step: null, gpu_minutes: 10, waited_s: 0, tail: '', decision, value: decision === 'keep' ? score : null, why: '' });

test('never more than one job per session, and never a session while one is in flight', () => {
  const events = [session(1), proposed(1), proposed(1, 's1', ['again']), session(2), ev('experiment.job_started', { job: jobId('example-speed', 1), n: 1, gpu: 'planned' })];
  const s = foldStudy(events, 'example-speed', 'v1');
  assert.equal(s.entries.length, 1);
  assert.deepEqual(s.entries[0]!.approval, []);
  assert.equal(s.phase, 'running');
  const done = foldStudy([...events, recorded(1, 3, 'keep')], 'example-speed', 'v1');
  assert.equal(sessionHold(done), null);
  assert.deepEqual(done.best, { n: 1, value: 3 });
});

test('approval, decline, an owner\'s verdict on a held result, pause and the circuit breaker', () => {
  const declined = foldStudy([session(1), proposed(1, 's1', ['x']), ev('experiment.approval', { job: jobId('example-speed', 1), answer: 'decline', by: 'example-owner' })], 'example-speed', 'v1');
  assert.deepEqual([declined.phase, declined.entries[0]!.decision], ['idle', 'refused']);
  const held = [session(1), proposed(1), recorded(1, 3, 'keep'), session(2), proposed(2), recorded(2, 2.8, 'stage2'), ev('experiment.judged', { version: 'v1', n: 2, decision: 'held', why: 'held', stage2: { size: 0, meanCandidate: 1, meanBest: 3, spread: 0.01, seeds: 3, minutesCandidate: 30, minutesBest: 30 }, value: 1, after: 'keep' })];
  assert.match(sessionHold(foldStudy(held, 'example-speed', 'v1'))!, /waits for an owner's review/);
  const accepted = foldStudy([...held, ev('experiment.verdict', { n: 2, answer: 'accept', by: 'example-owner' })], 'example-speed', 'v1');
  assert.deepEqual(accepted.best, { n: 2, value: 1 });
  const rejected = foldStudy([...held, ev('experiment.verdict', { n: 2, answer: 'reject', by: 'example-owner' })], 'example-speed', 'v1');
  assert.deepEqual([rejected.best?.n, rejected.entries[1]!.decision], [1, 'discard']);
  const crashes = [session(1), proposed(1), recorded(1, 3, 'keep'), ...[2, 3, 4].flatMap((n) => [session(n), proposed(n), recorded(n, null, 'crash')])];
  assert.match(sessionHold(foldStudy(crashes, 'example-speed', 'v1'))!, /in a row/);
  assert.equal(nextN(crashes, 'example-speed'), 5);
});

test('every experiment event fits its schema', () => {
  for (const x of [session(1), proposed(1), recorded(1, 3, 'keep'), ev('experiment.job_started', { job: 'example-speed-1', n: 1, gpu: 'planned' }), ev('experiment.verdict', { n: 1, answer: 'accept', by: 'o' })]) EventSchemas[x.type as keyof typeof EventSchemas].parse(x.payload);
});

test('approval: the first job, more than one GPU, an output quota over 20 GB, a lockfile change; time is a cap, not a threshold', () => {
  assert.deepEqual(APPROVE_DEFAULTS, { above_gb: 20 });
  const base = { gpus: 1, output_gb: 5, first: false, lockfile: false };
  assert.deepEqual(approvalReasons(base, APPROVE_DEFAULTS), []);
  for (const k of [{ first: true }, { gpus: 2 }, { output_gb: 21 }, { lockfile: true }]) assert.equal(approvalReasons({ ...base, ...k }, APPROVE_DEFAULTS).length, 1, JSON.stringify(k));
});

const root: RootCaps = { devices: [0], max_minutes: 20, gpu_hours_per_day: 8, output_gb: 50, sources: { 'train-set': { sha256: 'a', visibility: 'job' }, 'eval-inputs': { sha256: 'b', visibility: 'job' }, 'eval-labels': { sha256: 'c', visibility: 'scorer' } } };

test('root\'s caps are limits no approval passes, a ladder size\'s minutes included', () => {
  assert.equal(rootRefusal(study, root), null);
  assert.match(rootRefusal(Study.parse({ ...raw, job: { max_minutes: 21 } }), root)!, /above root/);
  assert.match(rootRefusal(Study.parse({ ...raw, ladder: [{ name: 's', config: {} }, { name: 'l', config: {}, max_minutes: 30 }] }), root)!, /above root/);
  assert.match(rootRefusal(study, { ...root, sources: { ...root.sources, 'eval-labels': { sha256: 'c', visibility: 'job' } } })!, /scorer-only/);
});

test('budget: jobs, dollars today and in all, and GPU-hours a job could cross', () => {
  const u = { gpu_hours_today: 0, agent_usd_today: 0, agent_usd_total: 0, jobs: 0 };
  assert.equal(budgetHold(study, u, 10), null);
  assert.match(budgetHold(study, { ...u, gpu_hours_today: 3.9 }, 10)!, /GPU-hours/);
  assert.match(budgetHold(study, { ...u, agent_usd_total: 60 }, 10)!, /in all/);
  assert.equal(sessionBudgetUsd(study, { ...u, agent_usd_today: 4.5 }, 10), 0.5);
});

test('the log a session reads: the metric in words and its own results; never approval reasons or the eval', () => {
  const s = foldStudy([session(1), proposed(1, 's1', ['held for an owner\'s review before it runs']), ev('experiment.approval', { job: jobId('example-speed', 1), answer: 'approve', by: 'example-owner' }), recorded(1, 3, 'keep')], 'example-speed', 'v1');
  const md = renderLog(study, s);
  for (const part of ['Motivation', 'Hypothesis', 'The one thing it changes: lr', 'Result: 3', 'Decision: keep', 'more than the seeds\' spread']) assert.ok(md.includes(part), part);
  for (const never of ['held for an owner', 'score.py', 'eval-labels', 'python']) assert.ok(!md.includes(never), never);
});
