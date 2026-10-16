// The engine's part of instance-rename.sh (src/instance-rename.ts): once the old instance's history is in the new
// one, no Siri token made for the old name works, and the asks still open are asked again for the new name. The root
// side (users, units, records, the services) is proven on a real host: .github/workflows/ci-slow.yml, add-project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { asks } from '../src/console/asks.js';
import { renamedFrom } from '../src/instance-rename.js';
import { createDevice, readDevices, TOKEN_PREFIX, verifyToken } from '../src/siri/tokens.js';

const node = { id: 'n1', name: 'phone-node' };

test("after a rename, a Siri token made for the old name is refused on the new one, even with its name rewritten; the owner's new tokens work", () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'renamed-'));
  const log = new EventLog(':memory:');
  const { token } = createDevice({ stateDir, instance: 'alpha', name: 'phone', by: 'owner' });
  assert.ok(token.startsWith(`${TOKEN_PREFIX}alpha_`));
  assert.equal(verifyToken({ stateDir, instance: 'alpha', token, node }).ok, true, 'it worked before');
  const rewritten = token.replace(`${TOKEN_PREFIX}alpha_`, `${TOKEN_PREFIX}bravo_`);

  const r = renamedFrom({ stateDir, log, from: 'alpha', to: 'bravo' });
  assert.equal(r.revoked.length, 1);
  for (const [t, inst] of [[token, 'bravo'], [rewritten, 'bravo'], [token, 'alpha']] as const) assert.equal(verifyToken({ stateDir, instance: inst, token: t, node }).ok, false, `${inst}: ${t.slice(0, 30)}`);
  assert.equal(readDevices(stateDir)[0]!.revokedBy, 'rename from alpha');

  const fresh = createDevice({ stateDir, instance: 'bravo', name: 'phone', by: 'owner' });
  assert.equal(verifyToken({ stateDir, instance: 'bravo', token: fresh.token, node }).ok, true, 'a new device token for the new name works');
  // Run again (a rename resumed): the owner's new token is never revoked.
  assert.deepEqual(renamedFrom({ stateDir, log, from: 'alpha', to: 'bravo' }).revoked, []);
  assert.equal(verifyToken({ stateDir, instance: 'bravo', token: fresh.token, node }).ok, true);
});

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
