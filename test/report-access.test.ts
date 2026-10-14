import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { mayReadReports, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

async function serve(user: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-report-'));
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

test('the report preview is the owner\'s and the writers\', with the throughput section the posted report leaves out; anyone else is refused and the state says so', async () => {
  for (const user of ['example-owner', 'example-collaborator']) {
    const s = await serve(user);
    try {
      assert.equal((await s.get('/api/report', false)).status, 401);
      const r = await s.get('/api/report');
      assert.equal(r.status, 200, `${user} reads it`);
      const { report } = (await r.json()) as { report: string };
      assert.match(report, /\*\*Spend\*\*/);
      assert.match(report, /\*\*Throughput, last 7 days\*\*[\s\S]*Merged PRs: 1/, 'the preview has the throughput section');
      assert.equal(((await (await s.get('/api/state')).json()) as { canReadReports: boolean }).canReadReports, true);
    } finally {
      await s.d.close();
    }
  }
  const s = await serve('someone-else');
  try {
    const r = await s.get('/api/report');
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /^the report preview is for the instance's owners and writers \(admin or write on its repo\); @someone-else is a viewer/);
    assert.equal(((await (await s.get('/api/state')).json()) as { canReadReports: boolean }).canReadReports, false);
  } finally {
    await s.d.close();
  }
  assert.equal(mayReadReports('owner'), true);
  assert.equal(mayReadReports(null), false);
});
