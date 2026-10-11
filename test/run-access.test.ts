import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { mayReadRuns, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { RunRecorder } from '../src/run-record.js';
import { exampleProject } from './helpers.js';

/** A dashboard on a state dir with one recorded run for issue 4, as `user`. */
async function serve(user: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-runs-'));
  new EventLog(join(dir, 'events.db')).close();
  const r = new RunRecorder(dir, { role: 'worker', model: 'sonnet', cwd: join(dir, 'w'), issue: 4 });
  r.finish({ reason: 'succeeded', costUsd: 0.1, turns: 2, model: 'sonnet', final: 'done' });
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user, slotsDir: join(dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const get = (path: string, auth = true) => fetch(`${base}${path}`, auth ? { headers: { authorization: `Bearer ${d.token}` } } : {});
  return { d, get, id: r.id };
}

test('agent runs are the owner\'s and the writers\' to read; anyone else with the token gets 403 on every route under /api/runs', async () => {
  // The example project: example-owner owns it; example-owner and example-collaborator are its writers.
  for (const user of ['example-owner', 'Example-Collaborator']) {
    const s = await serve(user);
    try {
      const list = await s.get('/api/runs?issue=4');
      assert.equal(list.status, 200, `${user} reads an issue's runs`);
      assert.equal(((await list.json()) as unknown[]).length, 1);
      assert.equal((await s.get(`/api/runs/${s.id}`)).status, 200, `${user} reads a run`);
    } finally {
      await s.d.close();
    }
  }
  const s = await serve('someone-else');
  try {
    assert.equal((await s.get('/api/runs?issue=4', false)).status, 401, 'no token: as before');
    for (const path of ['/api/runs?issue=4', `/api/runs/${s.id}`, `/api/runs/${s.id}/research`, `/api/runs/${s.id}/feed`, '/api/runs/']) {
      const r = await s.get(path);
      assert.equal(r.status, 403, `${path} is refused, whatever route serves it`);
      assert.match(((await r.json()) as { error: string }).error, /^agent runs are for the owner \(@example-owner\) and the project's writers; @someone-else isn't one/);
    }
    // Everything else on the dashboard is as it was for them.
    assert.equal((await s.get('/api/state')).status, 200);
  } finally {
    await s.d.close();
  }
});

test('who may read runs: the owner or a writer, logins compared without case; no login, nobody', () => {
  const owners = { default: 'example-owner', writers: ['example-owner', 'example-collaborator'] };
  assert.equal(mayReadRuns('example-owner', owners), true);
  assert.equal(mayReadRuns('EXAMPLE-COLLABORATOR', owners), true);
  assert.equal(mayReadRuns('someone-else', owners), false);
  assert.equal(mayReadRuns('', owners), false);
  assert.equal(mayReadRuns('lead', { default: 'lead', writers: [] }), true, 'the owner even when not listed as a writer');
});
