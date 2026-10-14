import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { mayReadDigest, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

async function serve(user: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-waiting-'));
  const log = new EventLog(join(dir, 'events.db'));
  log.append('issue.seen', { issue: 4, title: 'Round totals', labels: ['ready'], author: 'o', owner: 'example-owner', actionable: true, why: '' }, 'coordinator');
  log.append('decision.asked', { id: 'd1', kind: 'question', issue: 4, owner: 'example-owner', question: 'Which rounding mode?', options: ['half-up', 'banker'], recommendation: 'half-up', receipts: [] }, 'coordinator');
  log.append('merge.stopped', { reason: 'main went red', number: null, sha: null, revert: null }, 'coordinator');
  log.close();
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const get = (path: string, auth = true) => fetch(`${base}${path}`, auth ? { headers: { authorization: `Bearer ${d.token}`, ...asPerson(user) } } : {});
  return { d, get };
}

test('what waits on the owner, and the digest\'s Markdown, are the owner\'s and the writers\'; anyone else is refused and the state says so', async () => {
  for (const user of ['example-owner', 'example-collaborator']) {
    const s = await serve(user);
    try {
      assert.equal((await s.get('/api/waiting', false)).status, 401);
      const r = await s.get('/api/waiting');
      assert.equal(r.status, 200, `${user} reads it`);
      const w = (await r.json()) as { items: { kind: string; issue: number | null; detail: string; title: string | null }[]; markdown: string };
      assert.deepEqual(w.items.map((i) => [i.kind, i.issue]), [['merge_stopped', null], ['awaiting_decision', 4]]);
      assert.equal(w.items[1]!.title, 'Round totals');
      assert.match(w.markdown, /^## Waiting on you: /, 'the digest, named for the project');
      assert.match(w.markdown, /\*\*Decisions waiting for you\*\* \(1\)\n- #4 Round totals: @example-owner: Which rounding mode\? \(waiting \d+ min\)/);
      assert.equal(((await (await s.get('/api/state')).json()) as { canReadDigest: boolean }).canReadDigest, true);
    } finally {
      await s.d.close();
    }
  }
  const s = await serve('someone-else');
  try {
    const r = await s.get('/api/waiting');
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /^what waits on the owner is for the instance's owners and writers \(admin or write on its repo\); @someone-else is a viewer/);
    assert.equal(((await (await s.get('/api/state')).json()) as { canReadDigest: boolean }).canReadDigest, false);
  } finally {
    await s.d.close();
  }
  assert.equal(mayReadDigest('writer'), true);
  assert.equal(mayReadDigest(null), false);
});
