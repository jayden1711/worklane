import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { mayReadThroughput, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

async function serve(user: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-throughput-'));
  const log = new EventLog(join(dir, 'events.db'));
  log.append('run.cost', { issue: 2, role: 'worker', model: 'm', usd: 1.5, turns: 2 }, 'coordinator');
  log.append('land.result', { issue: 2, outcome: 'landed', landed: 'a'.repeat(40), detail: '' }, 'coordinator');
  log.close();
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const get = (path: string, auth = true) => fetch(`${base}${path}`, auth ? { headers: { authorization: `Bearer ${d.token}`, ...asPerson(user) } } : {});
  return { d, get };
}

test('the throughput panel\'s numbers are the owner\'s and the writers\'; anyone else is refused and the state says so', async () => {
  for (const user of ['example-owner', 'example-collaborator']) {
    const s = await serve(user);
    try {
      assert.equal((await s.get('/api/throughput', false)).status, 401);
      const r = await s.get('/api/throughput');
      assert.equal(r.status, 200, `${user} reads it`);
      const t = (await r.json()) as { merged: { total: number }; cost: { perMergedPrUsd: number; byStage: { stage: string; usd: number }[] }; top: { stage: string }[] };
      assert.equal(t.merged.total, 1);
      assert.equal(t.cost.perMergedPrUsd, 1.5);
      assert.equal(t.cost.byStage.find((x) => x.stage === 'gardener')!.usd, 0, 'a stage with no runs is zero, not missing');
      assert.deepEqual(t.top.map((x) => x.stage), ['worker']);
      assert.equal(((await (await s.get('/api/state')).json()) as { canReadThroughput: boolean }).canReadThroughput, true);
    } finally {
      await s.d.close();
    }
  }
  const s = await serve('someone-else');
  try {
    const r = await s.get('/api/throughput');
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /^throughput is for the instance's owners and writers \(admin or write on its repo\); @someone-else is a viewer/);
    assert.equal(((await (await s.get('/api/state')).json()) as { canReadThroughput: boolean }).canReadThroughput, false);
  } finally {
    await s.d.close();
  }
  assert.equal(mayReadThroughput('owner'), true);
  assert.equal(mayReadThroughput(null), false);
});
