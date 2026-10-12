import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { mayReadIntake, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { exampleProject } from './helpers.js';

/** A dashboard on an event log with three reports (one filed and replied to, one waiting on the owner, one dropped), as `user`. */
async function serve(user: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-intake-'));
  const log = new EventLog(join(dir, 'events.db'));
  log.append('intake.received', { id: 'r1', source: 'discord', sender: 'a1b2c3', excerpt: 'Checkout total is off by a cent for [AMOUNT]' }, 'coordinator');
  log.append('intake.triaged', { id: 'r1', kind: 'bug', reproduction: 'reproduced', ignored: [] }, 'coordinator');
  log.append('intake.filed', { id: 'r1', issue: 7, ready: true }, 'coordinator');
  log.append('intake.replied', { id: 'r1', stage: 'filed', ok: true }, 'coordinator');
  log.append('intake.received', { id: 'r2', source: 'bug-store', sender: 'd4e5f6', excerpt: 'Please add dark mode' }, 'coordinator');
  log.append('intake.triaged', { id: 'r2', kind: 'feature', reproduction: null, ignored: [] }, 'coordinator');
  log.append('intake.awaiting', { id: 'r2', decision: 'intake-r2' }, 'coordinator');
  log.append('intake.received', { id: 'r3', source: 'bug-store', sender: 'd4e5f6', excerpt: 'buy now [URL]' }, 'coordinator');
  log.append('intake.dropped', { id: 'r3', reason: 'spam' }, 'coordinator');
  log.close();
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user, slotsDir: join(dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const get = (path: string, auth = true) => fetch(`${base}${path}`, auth ? { headers: { authorization: `Bearer ${d.token}` } } : {});
  return { d, get };
}

type Report = { id: string; source: string; outcome: string; issue: number | null; dropped: string | null; replies: string[]; excerpt: string | null; kind: string | null };

test('intake: each report and what became of it, and the health numbers, for the owner and the writers', async () => {
  for (const user of ['example-owner', 'example-collaborator']) {
    const s = await serve(user);
    try {
      assert.equal((await s.get('/api/intake', false)).status, 401);
      const r = await s.get('/api/intake');
      assert.equal(r.status, 200, `${user} reads intake`);
      const v = (await r.json()) as { reports: Report[]; health: { perDay: { source: string; reports: number }[]; dropped: Record<string, number> } };
      const by = Object.fromEntries(v.reports.map((x) => [x.id, x]));
      assert.deepEqual([by.r1!.outcome, by.r1!.issue, by.r1!.replies, by.r1!.kind], ['filed', 7, ['filed'], 'bug']);
      assert.equal(by.r2!.outcome, 'awaiting_owner');
      assert.deepEqual([by.r3!.outcome, by.r3!.dropped], ['dropped', 'spam']);
      assert.equal(by.r1!.excerpt, 'Checkout total is off by a cent for [AMOUNT]', 'the redacted excerpt, as recorded');
      assert.deepEqual(v.health.dropped, { spam: 1 });
      assert.deepEqual(v.health.perDay.map((d) => [d.source, d.reports]), [['bug-store', 2], ['discord', 1]]);
      assert.equal(((await (await s.get('/api/state')).json()) as { canReadIntake: boolean }).canReadIntake, true);
    } finally {
      await s.d.close();
    }
  }
});

test('intake is refused to anyone but the owner and the writers, and the state tells the page not to ask', async () => {
  const s = await serve('someone-else');
  try {
    const r = await s.get('/api/intake');
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /^intake reports are for the owner \(@example-owner\) and the project's writers; @someone-else isn't one/);
    assert.equal(((await (await s.get('/api/state')).json()) as { canReadIntake: boolean }).canReadIntake, false);
  } finally {
    await s.d.close();
  }
  const owners = { default: 'example-owner', writers: ['example-owner', 'example-collaborator'] };
  assert.equal(mayReadIntake('EXAMPLE-COLLABORATOR', owners), true, 'logins compared without case');
  assert.equal(mayReadIntake('', owners), false);
});
