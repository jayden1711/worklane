import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { mayReadRuns, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { RunRecorder } from '../src/run-record.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

/** A dashboard on a state dir with one recorded run for issue 4, as `user`. */
async function serve(user: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-runs-'));
  new EventLog(join(dir, 'events.db')).close();
  const r = new RunRecorder(dir, { role: 'worker', model: 'sonnet', cwd: join(dir, 'w'), issue: 4 });
  r.finish({ reason: 'succeeded', costUsd: 0.1, turns: 2, model: 'sonnet', final: 'done' });
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const get = (path: string, auth = true) => fetch(`${base}${path}`, auth ? { headers: { authorization: `Bearer ${d.token}`, ...asPerson(user) } } : {});
  return { d, get, id: r.id };
}

test('agent runs are the owner\'s and the writers\' to read; anyone else with the token gets 403 on every route under /api/runs and on /api/live, and the state tells the page', async () => {
  // The example project: example-owner owns it; example-owner and example-collaborator are its writers.
  for (const user of ['example-owner', 'Example-Collaborator']) {
    const s = await serve(user);
    try {
      const list = await s.get('/api/runs?issue=4');
      assert.equal(list.status, 200, `${user} reads an issue's runs`);
      assert.equal(((await list.json()) as unknown[]).length, 1);
      assert.equal((await s.get(`/api/runs/${s.id}`)).status, 200, `${user} reads a run`);
      assert.equal(((await (await s.get('/api/state')).json()) as { canReadRuns: boolean }).canReadRuns, true, `the state tells the page ${user} may read runs`);
      assert.notEqual((await s.get('/api/live')).status, 403, `${user} isn't refused the live-runs list`);
    } finally {
      await s.d.close();
    }
  }
  const s = await serve('someone-else');
  try {
    assert.equal((await s.get('/api/runs?issue=4', false)).status, 401, 'no token: as before');
    for (const path of ['/api/runs?issue=4', `/api/runs/${s.id}`, `/api/runs/${s.id}/research`, `/api/runs/${s.id}/feed`, '/api/runs/', '/api/live']) {
      const r = await s.get(path);
      assert.equal(r.status, 403, `${path} is refused, whatever route serves it`);
      assert.match(((await r.json()) as { error: string }).error, /^agent runs are for the instance's owners and writers \(admin or write on its repo\); @someone-else is a viewer/);
    }
    // Everything else on the dashboard is as it was for them; the state says not to ask for runs.
    const state = await s.get('/api/state');
    assert.equal(state.status, 200);
    assert.equal(((await state.json()) as { canReadRuns: boolean }).canReadRuns, false);
  } finally {
    await s.d.close();
  }
});

test('who may read runs: an owner or a writer (from the repo permission); a viewer or no role, nobody', () => {
  assert.equal(mayReadRuns('owner'), true);
  assert.equal(mayReadRuns('writer'), true);
  assert.equal(mayReadRuns('viewer'), false);
  assert.equal(mayReadRuns(null), false);
});
