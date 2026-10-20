// The engine's part of instance-rename.sh (src/instance-rename.ts): once the old instance's history is in the new
// one, the asks still open are asked again for the new name. The root side (users, units, records, the services) is proven on a real host: .github/workflows/ci-slow.yml, add-project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { asks } from '../src/console/asks.js';
import { renamedFrom } from '../src/instance-rename.js';

test("after a rename, the old name's open asks are withdrawn and asked again, the same, for the new name; answered ones stay as they were", () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'renamed-'));
  const log = new EventLog(':memory:');
  const a = asks(log);
  const base = { instance: 'alpha', title: 'The bot token', detail: 'Paste it.' };
  const open1 = a.create({ ...base, kind: 'paste_secret', credential: 'intake-discord', where: 'credentials.yaml intake.discord_token' });
  const open2 = a.create({ ...base, kind: 'question', options: ['yes', 'no'], writersMayAnswer: true });
  const done = a.create({ ...base, kind: 'approve_link', url: 'https://github.com/settings/apps/new' });
  a.answer(done.id, { by: 'owner', role: 'owner', answer: 'approved' });
  const other = a.create({ ...base, instance: 'alpha-2', kind: 'question', options: ['a', 'b'] });

  const r = renamedFrom({ stateDir, log, from: 'alpha', to: 'bravo' });
  assert.deepEqual(r.carried.map((c) => c.from), [open1.id, open2.id]);
  assert.equal(a.get(open1.id)!.status, 'cancelled');
  assert.match(a.get(open1.id)!.cancelled!.why, /renamed to bravo/);
  assert.equal(a.get(done.id)!.status, 'answered');
  assert.equal(a.get(other.id)!.status, 'open', "another instance's ask is never touched");
  const now = a.list({ instance: 'bravo', status: 'open' });
  assert.equal(now.length, 2);
  const p = now.find((x) => x.kind === 'paste_secret')!;
  assert.deepEqual({ title: p.title, detail: p.detail, credential: p.kind === 'paste_secret' && p.credential }, { title: 'The bot token', detail: 'Paste it.', credential: 'intake-discord' });
  const q = now.find((x) => x.kind === 'question')!;
  assert.ok(q.kind === 'question' && q.writersMayAnswer && q.options.join() === 'yes,no');
  assert.deepEqual(renamedFrom({ stateDir, log, from: 'alpha', to: 'bravo' }).carried, [], 'run again: nothing left to carry');
  assert.throws(() => renamedFrom({ stateDir, log, from: 'alpha', to: 'alpha' }));
});
