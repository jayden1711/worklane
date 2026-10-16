import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { MACHINE_EVENTS, machineRequests } from '../src/machine-requests.js';
import { runMachineRequests } from '../src/coordinator/machine-requests.js';
import { approvalDigest } from '../src/plugins/approval.js';
import { handlePluginsRoute, WRITER_FIELDS } from '../src/plugins/dashboard.js';
import { confirm, ingest, readPreview, recordOf, stage } from '../src/plugins/root-ops.js';
import { pluginsForRun, PLUGINS_OFF_FILE } from '../src/plugins/run.js';

const me = process.getuid!();

/** An instance with one approved plugin `kit` (roles builder), and a fresh preview of `docs` waiting for review. */
function instance(name: string) {
  const home = mkdtempSync(join(tmpdir(), 'inst-'));
  const eventsDb = join(mkdtempSync(join(tmpdir(), 'ev-')), 'events.db');
  new EventLog(eventsDb).close();
  for (const id of ['kit', 'docs']) {
    const from = mkdtempSync(join(tmpdir(), 'fetched-'));
    const files: Record<string, string> = { '.claude-plugin/plugin.json': JSON.stringify({ name: id, version: '1.0.0' }), 'skills/a/SKILL.md': '---\nname: a\ndescription: a\n---\nA.\n' };
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(from, p)), { recursive: true });
      writeFileSync(join(from, p), c);
    }
    ingest({ instance: name, id, source: { type: 'git', url: 'https://example.com/o/r.git', sha: 'a'.repeat(40) }, from, approvedIds: new Set() });
  }
  const d = approvalDigest(recordOf(readPreview(name, 'kit'), ['builder']));
  stage({ instance: name, id: 'kit', roles: ['builder'], digest: d, by: 'wl-x' });
  confirm({ instance: name, id: 'kit', digest: d, by: 'root', allowlistOwnerUid: me });
  return { home, eventsDb };
}

/** Call the route as `role`, with this body; what it answered and what it audited. */
async function call(inst: ReturnType<typeof instance>, name: string, role: 'owner' | 'writer' | 'viewer' | null, method: string, path: string, body: unknown = {}) {
  let out: { status: number; body: Record<string, unknown> } | null = null;
  const audited: { action: string; detail: Record<string, unknown> }[] = [];
  const handled = await handlePluginsRoute({ method } as IncomingMessage, {} as ServerResponse, new URL(`http://x${path}`), {
    instance: name,
    instanceHome: inst.home,
    eventsDb: inst.eventsDb,
    blocked: async () => null,
    allowlistOwnerUid: me,
    who: { login: 'alice', role },
    readBody: async () => body,
    json: (_res, status, b) => (out = { status, body: b as Record<string, unknown> }),
    audit: (action, detail) => audited.push({ action, detail }),
  });
  return { handled, out: out as unknown as { status: number; body: Record<string, unknown> }, audited };
}
const requests = (eventsDb: string) => {
  const log = new EventLog(eventsDb);
  try {
    return machineRequests(log.read(0, [...MACHINE_EVENTS]));
  } finally {
    log.close();
  }
};

test('each role sees only what it can use: viewers nothing, writers an allowlist of fields, owners everything', async () => {
  const inst = instance('pa');
  assert.equal((await call(inst, 'pa', 'viewer', 'GET', '/api/plugins')).out.status, 403);
  assert.equal((await call(inst, 'pa', null, 'GET', '/api/plugins')).out.status, 403);
  const w = (await call(inst, 'pa', 'writer', 'GET', '/api/plugins')).out.body as { entries: Record<string, unknown>[] } & Record<string, unknown>;
  assert.deepEqual(Object.keys(w.entries[0]!).sort(), [...WRITER_FIELDS].sort());
  for (const k of ['previews', 'pending', 'audit', 'blocked', 'requests']) assert.equal(k in w, false, `a writer gets no ${k}`);
  assert.doesNotMatch(JSON.stringify(w), /sha256:[0-9a-f]{64}/, 'no digests for writers');
  const o = (await call(inst, 'pa', 'owner', 'GET', '/api/plugins')).out.body as { entries: { record: unknown }[]; previews: { id: string }[] };
  assert.ok(o.entries[0]!.record);
  assert.deepEqual(o.previews.map((p) => p.id).sort(), ['docs', 'kit']);
});

test('every action is the owner\'s: a writer\'s is refused and audited, and nothing is recorded', async () => {
  const inst = instance('pb');
  for (const path of ['/api/plugins/fetch', '/api/plugins/stage', '/api/plugins/toggle', '/api/plugins/remove']) {
    const r = await call(inst, 'pb', 'writer', 'POST', path, { id: 'kit', confirm: true });
    assert.equal(r.out.status, 403, path);
    assert.match(r.audited[0]!.action, /_refused$/);
  }
  assert.deepEqual(requests(inst.eventsDb), []);
});

test('stage is Review then Confirm: the review shows the digest and the root command; only that digest is staged (fail-without: staging a changed preview)', async () => {
  const inst = instance('pc');
  const review = (await call(inst, 'pc', 'owner', 'POST', '/api/plugins/stage', { id: 'docs', roles: ['builder'] })).out.body as { digest: string; command: string; confirmed: boolean };
  assert.equal(review.confirmed, false);
  assert.match(review.command, /^sudo bash \/opt\/[^ ]+\/current\/scripts\/setup\/plugins\.sh confirm pc docs sha256:[0-9a-f]{64}$/);
  assert.deepEqual(requests(inst.eventsDb), [], 'a review records nothing');
  const stale = await call(inst, 'pc', 'owner', 'POST', '/api/plugins/stage', { id: 'docs', roles: ['builder', 'reviewer'], confirm: true, digest: review.digest });
  assert.equal(stale.out.status, 409);
  const ok = await call(inst, 'pc', 'owner', 'POST', '/api/plugins/stage', { id: 'docs', roles: ['builder'], confirm: true, digest: review.digest });
  assert.equal(ok.out.status, 200, JSON.stringify(ok.out.body));
  const r = requests(inst.eventsDb);
  assert.deepEqual(r.map((x) => [x.via, x.args]), [['plugins', ['plugin-stage', 'docs', review.digest, 'builder']]]);
});

test('the coordinator runs an owner\'s plugin step without a machine owner (Q13), but no other machine change', async () => {
  const inst = instance('pd');
  await call(inst, 'pd', 'owner', 'POST', '/api/plugins/fetch', { kind: 'npm', id: 'notes', package: '@scope/notes', version: '1.2.3' });
  const log = new EventLog(inst.eventsDb);
  const ran: string[][] = [];
  try {
    log.append('machine.requested', { id: 'mr-other', args: ['set-slots', '3'], by: 'alice', via: 'plugins', ask: null }, 'alice', 'human');
    runMachineRequests({ log, instance: 'pd', exec: (_f, a) => (ran.push(a), 'ok'), ownersFile: join(tmpdir(), 'no-owners.json') });
  } finally {
    log.close();
  }
  assert.deepEqual(ran.map((a) => a.slice(2)), [['mcp-fetch', 'notes', '@scope/notes', '1.2.3']]);
  const byId = Object.fromEntries(requests(inst.eventsDb).map((x) => [x.args[0], x.status]));
  assert.deepEqual(byId, { 'mcp-fetch': 'done', 'set-slots': 'refused' });
});

test('switching off is Review then Confirm, written at once, and the next run loses it; on again restores it', async () => {
  const inst = instance('pe');
  const rev = (await call(inst, 'pe', 'owner', 'POST', '/api/plugins/toggle', { id: 'kit', on: false })).out.body as { changes: string[] };
  assert.match(rev.changes[0]!, /roles builder lose kit/);
  assert.deepEqual(pluginsForRun({ instance: 'pe', instanceHome: inst.home, role: 'builder', allowlistOwnerUid: me }).ids, ['kit'], 'a review writes nothing');
  await call(inst, 'pe', 'owner', 'POST', '/api/plugins/toggle', { id: 'kit', on: false, confirm: true });
  assert.match(readFileSync(join(inst.home, PLUGINS_OFF_FILE), 'utf8'), /kit/);
  assert.deepEqual(pluginsForRun({ instance: 'pe', instanceHome: inst.home, role: 'builder', allowlistOwnerUid: me }).ids, []);
  await call(inst, 'pe', 'owner', 'POST', '/api/plugins/toggle', { id: 'kit', on: true, confirm: true });
  assert.deepEqual(pluginsForRun({ instance: 'pe', instanceHome: inst.home, role: 'builder', allowlistOwnerUid: me }).ids, ['kit']);
});

test('a request the helper would refuse is refused here, before anything is recorded', async () => {
  const inst = instance('pf');
  for (const body of [{ kind: 'plugin', id: 'x', url: 'http://example.com/o/r', sha: 'a'.repeat(40) }, { kind: 'npm', id: 'x', package: 'pkg', version: '^1.0.0' }, { kind: 'plugin', id: 'Bad', url: 'https://example.com/o/r', sha: 'a'.repeat(40) }]) {
    assert.equal((await call(inst, 'pf', 'owner', 'POST', '/api/plugins/fetch', body)).out.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(requests(inst.eventsDb), []);
});
