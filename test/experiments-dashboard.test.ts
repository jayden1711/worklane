// The Experiments page on the dashboard's server: a viewer gets nothing; a writer reads, pauses and stops a running
// job; only an owner starts, resumes, approves, declines or archives; every change is reviewed first (nothing written)
// and confirmed against what the review saw; every attempt is audited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { dashboardSite, siteOptions, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { loadPins } from '../src/experiments/store.js';
import { rootCommands, type RootState } from '../src/experiments/root-file.js';
import { initInstance } from '../src/instance.js';
import { agentIsSelf, asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const study = {
  id: 'example-speed',
  goal: 'Lower validation loss',
  metric: { name: 'val_loss', direction: 'min', min_delta: 0.01 },
  eval: { predict: 'p', score: 's', files: ['eval/score.py'], inputs: 'eval-inputs', labels: 'eval-labels' },
  train: { command: 't', data: ['train-set'], env: { lockfile: 'uv.lock', build: 'true' } },
  editable: ['train.py'],
  budget: { gpu_hours_per_day: 4, agent_usd_per_day: 5, agent_usd_total: 60, max_jobs: 200 },
};
const root: RootState = { state: 'on', file: { devices: [0], max_minutes: 20, gpu_hours_per_day: 8, output_gb: 50, env_network: false, tasks_max: 1024, memory_gb: 16, cpu_cores: 4, sources: { 'train-set': { sha256: 'a'.repeat(64), visibility: 'job' }, 'eval-inputs': { sha256: 'b'.repeat(64), visibility: 'job' }, 'eval-labels': { sha256: 'c'.repeat(64), visibility: 'scorer' } } } };

async function serve(rootState: RootState = root) {
  const base = mkdtempSync(join(tmpdir(), 'exp-dash-'));
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  mkdirSync(join(seed, 'eval'));
  writeFileSync(join(seed, 'eval', 'score.py'), 'print("score=1")\n');
  writeFileSync(join(seed, BRAND.configDir, 'experiments.yaml'), stringify({ version: 1, studies: [study] }));
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', join(base, 'remote.git'), 'main');
  const dir = join(base, 'clone');
  git(base, 'clone', '-q', join(base, 'remote.git'), dir);
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  const pinsFile = join(base, 'experiments.yaml');
  const eventsDb = join(stateDir, 'events.db');
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb, stateDir, user: 'example-owner', roleOf: exampleRoles, instance: 'shop', experiments: { repo: dir, branch: 'main', instance: 'ex', pinsFile, root: () => rootState }, slotsDir: mkdtempSync(join(tmpdir(), 'exp-slots-')) });
  const url = d.url.split('/?')[0]!;
  const h = (user: string) => ({ authorization: `Bearer ${d.token}`, ...asPerson(user), 'content-type': 'application/json' });
  const get = async (user: string) => {
    const r = await fetch(`${url}/api/experiments`, { headers: h(user) });
    return { status: r.status, body: (await r.json()) as { actions?: string[]; studies?: { id: string; started: boolean; phase?: string; log?: unknown[] }[] } };
  };
  const post = async (user: string, body: unknown) => {
    const r = await fetch(`${url}/api/experiments`, { method: 'POST', headers: h(user), body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { error?: string; changes?: string[]; summary?: string[]; digest?: string; confirmed?: boolean } };
  };
  const events = (type: string) => {
    const log = new EventLog(eventsDb);
    try {
      return log.read(0, [type as never]).map((e) => e.payload as Record<string, unknown>);
    } finally {
      log.close();
    }
  };
  const append = (type: string, payload: object) => {
    const log = new EventLog(eventsDb);
    try {
      log.append(type as never, payload as never, 'alice');
    } finally {
      log.close();
    }
  };
  const state = async (user: string) => (await (await fetch(`${url}/api/state`, { headers: h(user) })).json()) as Record<string, unknown>;
  return { d, get, post, events, append, pinsFile, state };
}

test('experiments-dashboard: a viewer gets nothing; a writer reads and pauses but never starts; review writes nothing; a stale review is refused', async () => {
  const s = await serve();
  try {
    assert.equal((await s.get('someone-else')).status, 403);
    assert.equal((await s.post('someone-else', { action: 'pause', study: 'example-speed' })).status, 403);
    const writer = await s.get('example-collaborator');
    assert.deepEqual(writer.body.actions, ['pause', 'stop_job'], 'a writer gets the safe direction only');
    assert.deepEqual((await s.get('example-owner')).body.actions, ['start', 'pause', 'resume', 'stop_job', 'approve', 'decline', 'archive']);
    assert.equal((await s.post('example-collaborator', { action: 'start', study: 'example-speed' })).status, 403);
    const review = await s.post('example-owner', { action: 'start', study: 'example-speed' });
    assert.equal(review.status, 200);
    assert.ok(review.body.changes!.some((c) => c.startsWith('version: (none) -> ')) && review.body.changes!.some((c) => c.startsWith('eval eval/score.py: sha256 ')));
    assert.ok(review.body.summary!.some((l) => /first job \(the baseline\) waits for your approval/.test(l)));
    assert.equal(existsSync(s.pinsFile), false, 'a review writes nothing');
    assert.equal((await s.post('example-owner', { action: 'start', study: 'example-speed', confirm: true, digest: 'stale' })).status, 400, 'a confirm needs the review it confirms');
    const done = await s.post('example-owner', { action: 'start', study: 'example-speed', confirm: true, digest: review.body.digest });
    assert.equal(done.status, 200);
    const pins = loadPins(s.pinsFile);
    assert.ok(!('error' in pins) && pins.pins.studies['example-speed']?.started_by === 'example-owner');
    assert.equal(s.events('experiment.changed')[0]!.action, 'start');
    // A writer pauses (the safe direction), through the same review.
    const p = await s.post('example-collaborator', { action: 'pause', study: 'example-speed' });
    assert.equal((await s.post('example-collaborator', { action: 'pause', study: 'example-speed', confirm: true, digest: p.body.digest })).status, 200);
    assert.deepEqual(s.events('experiment.changed').map((e) => [e.action, e.by]), [['start', 'example-owner'], ['pause', 'example-collaborator']]);
    assert.equal((await s.post('example-collaborator', { action: 'resume', study: 'example-speed' })).status, 403, 'resuming spends again: owners only');
  } finally {
    await s.d.close();
  }
});

test('experiments-dashboard: only an owner approves a waiting job, and only that one; the view shows it waiting and the log', async () => {
  const s = await serve();
  try {
    const r = await s.post('example-owner', { action: 'start', study: 'example-speed' });
    await s.post('example-owner', { action: 'start', study: 'example-speed', confirm: true, digest: r.body.digest });
    const pins = loadPins(s.pinsFile) as { pins: { studies: Record<string, { version: string }> } };
    const version = pins.pins.studies['example-speed']!.version;
    assert.equal((await s.post('example-owner', { action: 'approve', study: 'example-speed' })).status, 400, 'nothing waits yet');
    s.append('experiment.session', { study: 'example-speed', version, session: 's1', n: 1, kind: 'baseline', parent: null, size: 0, seed: 1 });
    s.append('experiment.proposed', { study: 'example-speed', version, session: 's1', n: 1, job: 'example-speed-1', hypothesis: 'Baseline', variable: '', motivation: 'm', expected_effect: 'e', config: {}, commit: 'a'.repeat(40), files: [], lockfile: false, approval: ['the first job of this study version'] });
    const view = (await s.get('example-collaborator')).body.studies![0]!;
    assert.deepEqual([view.started, view.phase, view.log!.length], [true, 'awaiting_approval', 1]);
    assert.equal((await s.post('example-collaborator', { action: 'approve', study: 'example-speed' })).status, 403);
    const a = await s.post('example-owner', { action: 'approve', study: 'example-speed' });
    assert.ok(a.body.summary!.some((l) => /Why it waited: the first job of this study version/.test(l)));
    assert.equal((await s.post('example-owner', { action: 'approve', study: 'example-speed', confirm: true, digest: a.body.digest })).status, 200);
    assert.deepEqual(s.events('experiment.approval').map((e) => [e.job, e.answer, e.by]), [['example-speed-1', 'approve', 'example-owner']]);
  } finally {
    await s.d.close();
  }
});

test('experiments-dashboard: a held result is the owner\'s to accept or reject, after reading its run record and the monitor', async () => {
  const s = await serve();
  try {
    const r = await s.post('example-owner', { action: 'start', study: 'example-speed' });
    await s.post('example-owner', { action: 'start', study: 'example-speed', confirm: true, digest: r.body.digest });
    const pins = loadPins(s.pinsFile) as { pins: { studies: Record<string, { version: string }> } };
    const version = pins.pins.studies['example-speed']!.version;
    const job = (n: number, kind: string, score: number, decision: string) => {
      s.append('experiment.session', { study: 'example-speed', version, session: `s${n}`, n, kind, parent: n === 1 ? null : 1, size: 0, seed: 1 });
      s.append('experiment.proposed', { study: 'example-speed', version, session: `s${n}`, n, job: `example-speed-${n}`, hypothesis: `h${n}`, variable: 'lr', motivation: 'm', expected_effect: 'e', config: {}, commit: 'a'.repeat(40), files: [], lockfile: false, approval: [] });
      s.append('experiment.recorded', { study: 'example-speed', version, job: `example-speed-${n}`, n, outcome: 'scored', score, step: null, gpu_minutes: 10, waited_s: 0, tail: '', decision, value: decision === 'keep' ? score : null, why: '' });
    };
    job(1, 'baseline', 3, 'keep');
    job(2, 'exploit', 1, 'stage2');
    s.append('experiment.judged', { study: 'example-speed', version, n: 2, decision: 'held', why: 'held for an owner\'s review: 1 ± 0.01 vs best 3 ± 0.01', stage2: { size: 0, meanCandidate: 1, meanBest: 3, spread: 0.01, seeds: 3, minutesCandidate: 30, minutesBest: 30 }, value: 1, after: 'keep' });
    s.append('experiment.monitor', { study: 'example-speed', version, session: 's2', n: 2, flagged: true, findings: ['it searched for the labels'], cost_usd: 0.05 });
    assert.equal((await s.post('example-collaborator', { action: 'approve', study: 'example-speed' })).status, 403);
    const a = await s.post('example-owner', { action: 'approve', study: 'example-speed' });
    assert.ok(a.body.summary!.some((l) => /size 1: 1\.0000 ± 0\.0100 vs best 3\.0000 \(3 seeds each; 30\.0 vs 30\.0 GPU-min\)/.test(l)), a.body.summary!.join('\n'));
    assert.ok(a.body.summary!.some((l) => /Monitor: flagged: it searched for the labels/.test(l)));
    assert.equal(a.body.changes![0], 'result #2: held -> accepted');
    assert.equal((await s.post('example-owner', { action: 'approve', study: 'example-speed', confirm: true, digest: a.body.digest })).status, 200);
    assert.deepEqual(s.events('experiment.verdict').map((e) => [e.n, e.answer]), [[2, 'accept']]);
  } finally {
    await s.d.close();
  }
});

test('#581 experiments-dashboard: /api/state says whether experiments are on, to owners and writers only', async () => {
  const on = await serve();
  try {
    assert.equal((await on.state('example-owner')).experiments, true);
    assert.equal((await on.state('example-collaborator')).experiments, true);
    assert.ok(!('experiments' in (await on.state('someone-else'))), 'a viewer gets no experiments key at all');
  } finally {
    await on.d.close();
  }
  for (const rootState of [{ state: 'off', why: 'no root file' }, { state: 'unknown', why: "can't be read" }] as RootState[]) {
    const off = await serve(rootState);
    try {
      assert.equal((await off.state('example-collaborator')).experiments, false, `${rootState.state}: off`);
      assert.ok(!('experiments' in (await off.state('someone-else'))));
    } finally {
      await off.d.close();
    }
  }
});

/** A dashboard on a checkout: `experiments` and `instance` as given. */
async function plain(o: { instance?: string } = {}) {
  const { dir } = exampleProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'exp-plain-'));
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', roleOf: exampleRoles, ...o, slotsDir: mkdtempSync(join(tmpdir(), 'exp-slots-')) });
  const url = d.url.split('/?')[0]!;
  const h = { authorization: `Bearer ${d.token}`, ...asPerson('example-owner'), 'content-type': 'application/json' };
  return {
    d,
    get: async () => (await (await fetch(`${url}/api/experiments`, { headers: h })).json()) as { unavailable?: string },
    post: async () => (await (await fetch(`${url}/api/experiments`, { method: 'POST', headers: h, body: JSON.stringify({ action: 'pause', study: 'x' }) })).json()) as { error?: string },
    state: async () => (await (await fetch(`${url}/api/state`, { headers: h })).json()) as Record<string, unknown>,
  };
}

test('#563 experiments-dashboard: started the way `dashboard --instance` starts it, an instance answers a view: not set up yet, with the root commands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exp-instances-'));
  const { dir: repo } = exampleProject();
  const home = initInstance('shop', repo, 'example-org/example-shop', dir);
  agentIsSelf(home);
  writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nland_mode: pr\n');
  const site = dashboardSite(repo, 'shop', dir);
  // As cli.ts `dashboard` starts it (the break-glass owner: no person named, so no role is asked of GitHub).
  const d = await startDashboard({ ...siteOptions(site), cfg: site.cfg, user: 'example-owner', instance: 'shop', slotsDir: mkdtempSync(join(tmpdir(), 'exp-slots-')) });
  try {
    const url = d.url.split('/?')[0]!;
    const h = { authorization: `Bearer ${d.token}` };
    const view = (await (await fetch(`${url}/api/experiments`, { headers: h })).json()) as { unavailable?: string; setup?: { state: string; why: string | null; commands: unknown } };
    assert.equal(view.unavailable, undefined, `a view, not: ${view.unavailable}`);
    // The test machine has no root file (test/isolate.ts moves /etc): missing setup, not a refusal.
    assert.equal(view.setup!.state, 'off');
    assert.match(view.setup!.why!, /^experiments are not set up yet for shop on this machine \(no root file\): root sets them up with `sudo bash scripts\/setup\/experiments\.sh install shop`$/);
    assert.deepEqual(view.setup!.commands, rootCommands('shop'));
    assert.equal(((await (await fetch(`${url}/api/state`, { headers: h })).json()) as { experiments?: boolean }).experiments, false, 'not set up: no sidebar item');
  } finally {
    await d.close();
  }
});

test('#563 experiments-dashboard: only a checkout or a same-user instance has none, and it says which', async () => {
  const checkout = await plain();
  try {
    const why = (await checkout.get()).unavailable ?? '';
    assert.match(why, /this dashboard serves a checkout$/);
    assert.doesNotMatch(why, /local instance/);
    assert.match((await checkout.post()).error ?? '', /this dashboard serves a checkout$/);
    assert.equal((await checkout.state()).experiments, false);
  } finally {
    await checkout.d.close();
  }
  const local = await plain({ instance: 'shop' });
  try {
    const why = (await local.get()).unavailable ?? '';
    assert.match(why, /the instance shop runs as this dashboard's user/);
    assert.doesNotMatch(why, /checkout/);
    assert.match((await local.post()).error ?? '', /the instance shop runs as this dashboard's user/);
  } finally {
    await local.d.close();
  }
});
