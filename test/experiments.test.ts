// Experiment studies, the engine's core (src/experiments/, docs/experiments.md): the study file, keep/discard and
// exploration, the session's one proposal and the change check, the state fold, approval and caps. No wiring here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalReasons, APPROVE_DEFAULTS, budgetHold, rootRefusal, sessionBudgetUsd, type RootCaps } from '../src/experiments/approval.js';
import { best, judge, nextSession, shouldExplore, type Entry } from '../src/experiments/keep.js';
import { renderLog } from '../src/experiments/log.js';
import { checkChange, parseRawDiff, readProposal, type Change } from '../src/experiments/proposal.js';
import { foldStudy, jobId, nextN, sessionHold, type StudyEvent } from '../src/experiments/state.js';
import { configRefusal, StudiesFile, Study, studyVersion } from '../src/experiments/study.js';
import { EventSchemas } from '../src/events/types.js';

const raw = {
  id: 'example-speed',
  goal: 'Lower validation loss at a fixed training budget',
  metric: { name: 'val_loss', direction: 'min', min_delta: 0.01 },
  eval: { predict: 'python eval/predict.py', score: 'python score.py', files: ['eval/score.py', 'eval/predict.py'], inputs: 'eval-inputs', labels: 'eval-labels' },
  train: { command: 'python train.py', data: ['train-set'], env: { lockfile: 'uv.lock', build: 'uv sync --frozen' } },
  editable: ['train.py', 'model/**', 'uv.lock'],
  config_schema: { lr: { type: 'number', min: 1e-5, max: 0.1 }, depth: { type: 'integer', min: 2, max: 24 }, opt: { type: 'enum', values: ['adam', 'sgd'] } },
  budget: { gpu_hours_per_day: 4, agent_usd_per_day: 5, agent_usd_total: 60, max_jobs: 200 },
};
const study = Study.parse(raw);
const metric = { direction: 'min' as const, min_delta: 0.01 };

test('study file: defaults, split eval only, unique ids', () => {
  assert.equal(study.eval.mode, 'split');
  assert.deepEqual(study.job, { max_minutes: 10, gpus: 1, output_gb: 5 });
  assert.deepEqual(study.exploration, { share: 0.2, near_miss: 0.02 });
  assert.equal(study.confirm_runs, 1);
  assert.throws(() => Study.parse({ ...raw, eval: { ...raw.eval, mode: 'in_process' } }), 'in-process evals are not in this version');
  assert.throws(() => StudiesFile.parse({ version: 1, studies: [raw, raw] }), /two studies/);
});

test('a study never lets a job read the labels or change the eval', () => {
  assert.throws(() => Study.parse({ ...raw, train: { ...raw.train, data: ['train-set', 'eval-labels'] } }), /labels/);
  assert.throws(() => Study.parse({ ...raw, eval: { ...raw.eval, labels: 'eval-inputs' } }), /labels/);
  assert.throws(() => Study.parse({ ...raw, editable: ['**'] }), /covers the eval file/);
  for (const p of ['/etc/x', '../x', '.worklane/roles/a.md', '.git/config']) assert.throws(() => Study.parse({ ...raw, editable: [p] }), p);
});

test('a study\'s version changes with its definition, its eval files and its data', () => {
  const v = studyVersion(study, { 'eval/score.py': 'a' }, { 'train-set': 'b' });
  assert.equal(v, studyVersion(Study.parse(JSON.parse(JSON.stringify(raw))), { 'eval/score.py': 'a' }, { 'train-set': 'b' }));
  assert.notEqual(v, studyVersion(study, { 'eval/score.py': 'c' }, { 'train-set': 'b' }));
  assert.notEqual(v, studyVersion(study, { 'eval/score.py': 'a' }, { 'train-set': 'c' }));
  assert.notEqual(v, studyVersion(Study.parse({ ...raw, goal: 'x' }), { 'eval/score.py': 'a' }, { 'train-set': 'b' }));
});

test('a config outside the schema never runs: refused, not clamped', () => {
  assert.equal(configRefusal({ lr: 0.01, depth: 4, opt: 'adam' }, study.config_schema), null);
  assert.match(configRefusal({ lr: 1 }, study.config_schema)!, /between/);
  assert.match(configRefusal({ depth: 4.5 }, study.config_schema)!, /integer/);
  assert.match(configRefusal({ opt: 'lion' }, study.config_schema)!, /one of/);
  assert.match(configRefusal({ seed: 1 }, study.config_schema)!, /not one of the study's knobs/);
});

test('the session\'s output: one proposal, its text capped and redacted, nothing extra', () => {
  const ok = readProposal({ hypothesis: 'h'.repeat(300), motivation: 'm\n\nx', expected_effect: 'e', config: { lr: 0.001 } }, study);
  assert.ok(!('refused' in ok));
  assert.equal(ok.hypothesis.length, 200);
  assert.equal(ok.motivation, 'm x');
  assert.match((readProposal({ hypothesis: 'h', motivation: 'm', expected_effect: 'e', config: {}, jobs: 2 }, study) as { refused: string }).refused, /unexpected fields: jobs/);
  assert.match((readProposal(null, study) as { refused: string }).refused, /no proposal/);
});

const ch = (path: string, oldMode = '100644', newMode = '100644'): Change => ({ path, oldMode, newMode, status: 'M' });

test('a change outside the editable paths never runs', () => {
  assert.deepEqual(checkChange([ch('train.py'), ch('model/a.py', '000000', '100644')], study), { ok: true, files: ['model/a.py', 'train.py'], lockfile: false });
  assert.match((checkChange([ch('train.py'), ch('eval/score.py')], study) as { why: string }).why, /eval file/);
  assert.match((checkChange([ch('README.md')], study) as { why: string }).why, /outside/);
  assert.match((checkChange([ch('.worklane/config.yaml')], study) as { why: string }).why, /outside/);
  assert.match((checkChange([ch('model/link', '000000', '120000')], study) as { why: string }).why, /symlink/);
  assert.match((checkChange([ch('train.py', '100644', '100755')], study) as { why: string }).why, /mode/);
  assert.match((checkChange([], study) as { why: string }).why, /no change/);
  assert.equal((checkChange([ch('uv.lock')], study) as { lockfile: boolean }).lockfile, true);
});

test('git diff --raw -z reads back', () => {
  const z = `:100644 100644 ${'a'.repeat(7)} ${'b'.repeat(7)} M\0train.py\0:000000 120000 ${'0'.repeat(7)} ${'c'.repeat(7)} A\0model/x\0`;
  assert.deepEqual(parseRawDiff(z), [ch('train.py'), { path: 'model/x', oldMode: '000000', newMode: '120000', status: 'A' }]);
});

const e = (n: number, kind: Entry['kind'], result: number | null, decision: Entry['decision'], extra: Partial<Entry> = {}): Entry => ({ n, kind, parent: null, result, decision, ...extra });

test('keep only when the best is beaten by more than min_delta; the first result is the baseline', () => {
  assert.equal(judge([], { n: 1, kind: 'baseline', result: 3 }, metric, 0).decision, 'keep');
  const log = [e(1, 'baseline', 3, 'keep')];
  assert.equal(judge(log, { n: 2, kind: 'exploit', result: 2.995 }, metric, 0).decision, 'discard', 'within min_delta');
  assert.equal(judge(log, { n: 2, kind: 'exploit', result: 3.5 }, metric, 0).decision, 'discard');
  assert.equal(judge(log, { n: 2, kind: 'exploit', result: 2.9 }, metric, 0).decision, 'keep');
  assert.equal(judge(log, { n: 2, kind: 'exploit', result: null }, metric, 0).decision, 'crash');
  assert.equal(judge([e(1, 'baseline', 3, 'keep')], { n: 2, kind: 'exploit', result: 3.5 }, { direction: 'max', min_delta: 0.01 }, 0).decision, 'keep', 'max');
});

test('with a confirm run, a beating result is kept on the worse of its runs, and a lucky seed is not', () => {
  const log = [e(1, 'baseline', 3, 'keep')];
  const first = judge(log, { n: 2, kind: 'exploit', result: 2.8 }, metric, 1);
  assert.equal(first.decision, 'pending_confirm');
  const after = [...log, e(2, 'exploit', 2.8, 'pending_confirm')];
  assert.deepEqual(nextSession(after, metric, study.exploration), { kind: 'confirm', parent: 2 }, 'the confirm runs before any new session');
  const lucky = judge(after, { n: 3, kind: 'confirm', of: 2, result: 2.995 }, metric, 1);
  assert.equal(lucky.decision, 'discard');
  const real = judge(after, { n: 3, kind: 'confirm', of: 2, result: 2.85 }, metric, 1);
  assert.deepEqual([real.decision, real.value], ['keep', 2.85]);
  assert.equal(judge(after, { n: 3, kind: 'confirm', of: 2, result: 2.7 }, metric, 1).value, 2.8, 'judged on the worse run, never the better');
  assert.deepEqual(best([...after, e(3, 'confirm', 2.85, 'keep', { of: 2, value: 2.85 })], 'min'), { n: 3, value: 2.85 });
  assert.notEqual(nextSession([...after, e(3, 'confirm', 2.995, 'discard', { of: 2 })], metric, study.exploration).kind, 'confirm', 'resolved');
});

test('the exploration share is exact, and an explore result never lowers the best', () => {
  const log: Entry[] = [e(1, 'baseline', 3, 'keep')];
  let explores = 0;
  for (let n = 2; n <= 101; n++) {
    const next = nextSession(log, metric, { share: 0.2, near_miss: 0.02 });
    if (next.kind === 'explore') explores++;
    const r = next.kind === 'explore' ? 3.5 : 3.2;
    const j = judge(log, { n, kind: next.kind, result: r }, metric, 0);
    log.push(e(n, next.kind, r, j.decision, { parent: next.parent }));
  }
  assert.equal(explores, 20);
  assert.deepEqual(best(log, 'min'), { n: 1, value: 3 });
  assert.equal(shouldExplore([], 0), false);
});

test('an explore session starts from a near-miss, not the best', () => {
  const log = [e(1, 'baseline', 3, 'keep'), e(2, 'exploit', 3.04, 'discard'), e(3, 'exploit', 3.5, 'discard'), e(4, 'exploit', 2.9, 'keep'), e(5, 'exploit', 2.93, 'discard'), e(6, 'exploit', 2.95, 'discard')];
  assert.deepEqual(nextSession(log, metric, { share: 0.5, near_miss: 0.02 }), { kind: 'explore', parent: 6 });
});

const ev = (type: string, payload: Record<string, unknown>, ts = '2026-10-15T12:00:00Z'): StudyEvent => ({ type, ts, payload: { study: 'example-speed', ...payload } });
const session = (n: number, s = `s${n}`) => ev('experiment.session', { version: 'v1', session: s, n, kind: n === 1 ? 'baseline' : 'exploit', parent: n === 1 ? null : 1 });
const proposed = (n: number, s = `s${n}`, approval: string[] = []) => ev('experiment.proposed', { version: 'v1', session: s, n, job: jobId('example-speed', n), hypothesis: `h${n}`, motivation: 'm', expected_effect: 'e', config: {}, commit: 'a'.repeat(40), files: ['train.py'], lockfile: false, approval });
const recorded = (n: number, score: number | null, decision: string) => ev('experiment.recorded', { version: 'v1', job: jobId('example-speed', n), n, outcome: score === null ? 'crashed' : 'scored', score, step: null, gpu_minutes: 10, waited_s: 0, tail: '', decision, value: score, why: '' });

test('never more than one job per session, and never a session while one is in flight', () => {
  const events = [session(1), proposed(1), proposed(1, 's1', ['again']), session(2), ev('experiment.job_started', { job: jobId('example-speed', 1), n: 1, gpu: 'planned' })];
  const s = foldStudy(events, 'example-speed', 'v1', 'min');
  assert.equal(s.entries.length, 1, 'no second session while #1 is in flight');
  assert.deepEqual(s.entries[0]!.approval, [], 'the first proposal of a session counts');
  assert.equal(s.phase, 'running');
  assert.match(sessionHold(s)!, /running/);
  const done = foldStudy([...events, recorded(1, 3, 'keep')], 'example-speed', 'v1', 'min');
  assert.equal(sessionHold(done), null);
  assert.deepEqual(done.best, { n: 1, value: 3 });
  assert.equal(foldStudy([session(1), proposed(1, 'other')], 'example-speed', 'v1', 'min').phase, 'session', 'another session\'s proposal changes nothing');
});

test('approval, decline, pause and the circuit breaker', () => {
  const waiting = foldStudy([session(1), proposed(1, 's1', ['the first job of this study version'])], 'example-speed', 'v1', 'min');
  assert.equal(waiting.phase, 'awaiting_approval');
  const declined = foldStudy([session(1), proposed(1, 's1', ['x']), ev('experiment.approval', { job: jobId('example-speed', 1), answer: 'decline', by: 'example-owner' })], 'example-speed', 'v1', 'min');
  assert.deepEqual([declined.phase, declined.entries[0]!.decision], ['idle', 'refused']);
  const crashes = [session(1), proposed(1), recorded(1, 3, 'keep'), ...[2, 3, 4].flatMap((n) => [session(n), proposed(n), recorded(n, null, 'crash')])];
  const broken = foldStudy(crashes, 'example-speed', 'v1', 'min');
  assert.equal(broken.broken, true);
  assert.match(sessionHold(broken)!, /in a row/);
  const resumed = [...crashes, ev('experiment.changed', { action: 'resume', by: 'example-owner', role: 'owner', detail: '' })];
  assert.equal(sessionHold(foldStudy(resumed, 'example-speed', 'v1', 'min')), null);
  assert.equal(sessionHold(foldStudy([...resumed, ev('experiment.changed', { action: 'pause', by: 'example-collaborator', role: 'writer', detail: '' })], 'example-speed', 'v1', 'min')), 'paused');
  assert.equal(nextN(crashes, 'example-speed'), 5);
});

test('another version\'s entries are not this version\'s log', () => {
  const s = foldStudy([session(1), proposed(1), recorded(1, 3, 'keep')], 'example-speed', 'v2', 'min');
  assert.deepEqual([s.entries.length, s.best], [0, null]);
});

test('every experiment event fits its schema', () => {
  for (const x of [session(1), proposed(1), recorded(1, 3, 'keep'), ev('experiment.job_started', { job: 'example-speed-1', n: 1, gpu: 'planned' })]) EventSchemas[x.type as keyof typeof EventSchemas].parse(x.payload);
});

test('approval: the first job, above 20 minutes, more than one GPU, big output, a lockfile change', () => {
  assert.equal(APPROVE_DEFAULTS.above_minutes, 20);
  const base = { minutes: 10, gpus: 1, output_gb: 5, first: false, lockfile: false };
  assert.deepEqual(approvalReasons(base, APPROVE_DEFAULTS), []);
  assert.equal(approvalReasons({ ...base, minutes: 20 }, APPROVE_DEFAULTS).length, 0);
  for (const k of [{ first: true }, { minutes: 21 }, { gpus: 2 }, { output_gb: 21 }, { lockfile: true }]) assert.equal(approvalReasons({ ...base, ...k }, APPROVE_DEFAULTS).length, 1, JSON.stringify(k));
});

const root: RootCaps = { devices: [0], max_minutes: 60, gpu_hours_per_day: 8, output_gb: 50, sources: { 'train-set': { sha256: 'a', visibility: 'job' }, 'eval-inputs': { sha256: 'b', visibility: 'job' }, 'eval-labels': { sha256: 'c', visibility: 'scorer' } } };

test('root\'s caps are limits no approval passes, and labels must be scorer-only there', () => {
  assert.equal(rootRefusal(study, root), null);
  assert.match(rootRefusal(study, null)!, /not on/);
  assert.match(rootRefusal(Study.parse({ ...raw, job: { max_minutes: 61 } }), root)!, /above root/);
  assert.match(rootRefusal(study, { ...root, sources: { ...root.sources, 'eval-labels': { sha256: 'c', visibility: 'job' } } })!, /scorer-only/);
  assert.match(rootRefusal(study, { ...root, sources: { ...root.sources, 'train-set': { sha256: 'a', visibility: 'scorer' } } })!, /scorer's only/);
  const { 'train-set': _, ...rest } = root.sources;
  assert.match(rootRefusal(study, { ...root, sources: rest })!, /not approved/);
});

test('budget: jobs, dollars today and in all, and GPU-hours a job could cross', () => {
  const u = { gpu_hours_today: 0, agent_usd_today: 0, agent_usd_total: 0, jobs: 0 };
  assert.equal(budgetHold(study, u, 10), null);
  assert.match(budgetHold(study, { ...u, gpu_hours_today: 3.9 }, 10)!, /GPU-hours/);
  assert.match(budgetHold(study, { ...u, agent_usd_today: 5 }, 10)!, /today/);
  assert.match(budgetHold(study, { ...u, agent_usd_total: 60 }, 10)!, /in all/);
  assert.match(budgetHold(study, { ...u, jobs: 200 }, 10)!, /jobs/);
  assert.match(budgetHold(study, u, 0)!, /instance/);
  assert.equal(sessionBudgetUsd(study, { ...u, agent_usd_today: 4.5 }, 10), 0.5);
});

test('the log has the fixed template and quotes what a session wrote', () => {
  const s = foldStudy([session(1), proposed(1), recorded(1, 3, 'keep')], 'example-speed', 'v1', 'min');
  const md = renderLog(study, s);
  for (const part of ['Motivation', 'Hypothesis', 'Change: commit', 'Config:', 'Budget: 10.0 GPU-min', 'Result: 3', 'Decision: keep', '> h1']) assert.ok(md.includes(part), part);
});
