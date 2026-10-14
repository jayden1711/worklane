import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

async function serve(user: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-research-'));
  const log = new EventLog(join(dir, 'events.db'));
  const run = '2026-10-11T00-00-00-000Z-researcher-abc123';
  log.append('research.searched', { issue: 9, run, query: 'sqlite vacuum into durability' }, 'c');
  log.append('research.fetched', { issue: 9, run, url: 'https://sqlite.org/lang_vacuum.html', host: 'sqlite.org', refused: null }, 'c');
  log.append('research.fetched', { issue: 9, run, url: 'https://tracker.example.net/x', host: 'tracker.example.net', refused: 'not on the allowed hosts' }, 'c');
  log.append('research.capped', { issue: 9, run, why: 'searches: 20 of 20 today' }, 'c');
  // Another run's, and one recorded before any run started: neither is this run's.
  log.append('research.searched', { issue: 9, run: 'other-run', query: 'not this one' }, 'c');
  log.append('research.capped', { issue: 9, run: null, why: 'spend cap reached before the run' }, 'c');
  log.close();
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots') });
  const url = `${d.url.split('/?')[0]}/api/runs/${run}/research`;
  return { d, url, h: { authorization: `Bearer ${d.token}`, ...asPerson(user) } };
}

test('a research run\'s searches, fetches (refusals marked) and caps, for the owner and the writers', async () => {
  const s = await serve('example-owner');
  try {
    assert.equal((await fetch(s.url)).status, 401);
    const r = await fetch(s.url, { headers: s.h });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      searches: ['sqlite vacuum into durability'],
      fetches: [
        { url: 'https://sqlite.org/lang_vacuum.html', host: 'sqlite.org', refused: null },
        { url: 'https://tracker.example.net/x', host: 'tracker.example.net', refused: 'not on the allowed hosts' },
      ],
      capped: ['searches: 20 of 20 today'],
    });
  } finally {
    await s.d.close();
  }
  // A writer reads it as the owner does; anyone else is refused by the runs gate, as for the rest of the run.
  const writer = await serve('example-collaborator');
  try {
    const r = await fetch(writer.url, { headers: writer.h });
    assert.equal(r.status, 200, 'a writer reads it');
    assert.equal(((await r.json()) as { searches: string[] }).searches.length, 1);
  } finally {
    await writer.d.close();
  }
  const other = await serve('someone-else');
  try {
    const r = await fetch(other.url, { headers: other.h });
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /^agent runs are for the instance's owners and writers/);
  } finally {
    await other.d.close();
  }
});
