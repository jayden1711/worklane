// Siri on an instance's dashboard (src/siri/instance.ts, src/siri/manage.ts; docs/siri.md). One plain check per
// "never": the gateway token on another route, the dashboard key on a Siri route, a person's header on a Siri route, a
// token in a URL, a token from another device, a revoked token, an expired token, a tell over its limit, Siri off, a
// writer making a token, an owner making one off an allowed device; and that a token is shown once and kept hashed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard, type Who } from '../src/dashboard.js';
import { auditWrite, answerDecision } from '../src/decide.js';
import { EventLog } from '../src/events/log.js';
import { IntakeConfig } from '../src/intake/report.js';
import { siriAnswer, writeSiriAnswer } from '../src/siri/ask.js';
import { SIRI_DEVICE_HEADER, SIRI_GATEWAY_TOKEN_FILE, SIRI_NODE_HEADER, type SiriCaller } from '../src/siri/instance.js';
import { readDevices, TOKEN } from '../src/siri/tokens.js';
import { voiceInboxDir } from '../src/voice.js';
import { asDevicePerson, asPerson, exampleProject, exampleRoles } from './helpers.js';

const OWNER = 'example-owner';
const WRITER = 'example-collaborator';
const NET = ['tail0example', 'ts', 'net'].join('.');
const PHONE = { id: 'nPhone1CNTRL', name: `phone.${NET}` };
const OTHER = { id: 'nOther9CNTRL', name: `other.${NET}` };
const ON = 'version: 1\nsiri:\n  enabled: true\n';

async function server(intake: string | null = ON, o: { instance?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'siri-dash-'));
  const db = join(dir, 'events.db');
  const log = new EventLog(db);
  const { dir: root } = exampleProject();
  const stateDir = join(dir, 'state');
  let intakeFile: string | undefined;
  if (intake !== null) {
    intakeFile = join(dir, 'intake.yaml');
    writeFileSync(intakeFile, intake, { mode: 0o600 });
  }
  const instance = o.instance === undefined ? 'example' : o.instance;
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir, user: OWNER, roleOf: exampleRoles, pollMs: 50, slotsDir: join(dir, 'slots'), ...(instance ? { instance } : {}), ...(intakeFile ? { intakeFile } : {}) });
  const base = d.url.split('/?')[0]!.replace(/\/$/, '');
  const gw = instance ? readFileSync(join(stateDir, SIRI_GATEWAY_TOKEN_FILE), 'utf8').trim() : '';
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  /** As the hub's gateway calls the instance: its token, the device's token, the node it identified. */
  const siri = (path: string, token: string, body?: unknown, node = PHONE, extra: Record<string, string> = {}) =>
    call(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${gw}`, [SIRI_DEVICE_HEADER]: token, [SIRI_NODE_HEADER]: JSON.stringify(node), ...extra }, ...(body !== undefined ? { body } : {}) });
  const as = (login: string, path: string, body?: unknown, device = false) => call(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${d.token}`, ...(device ? asDevicePerson(login) : asPerson(login)) }, ...(body !== undefined ? { body } : {}) });
  const make = async (name = 'Ada phone') => {
    const r = await as(OWNER, '/api/siri-devices', { name }, true);
    assert.equal(r.status, 200);
    return (await r.json()) as { token: string; device: { id: string } };
  };
  return { d, dir, log, stateDir, gw, call, siri, as, make, close: () => d.close() };
}

type Audit = { login: string; role: string; via: string; action: string; detail: Record<string, unknown> };
const audits = (log: EventLog) => log.read(0, ['dashboard.audit']).map((e) => e.payload as Audit);
const inbox = (stateDir: string) => (existsSync(voiceInboxDir(stateDir)) ? readdirSync(voiceInboxDir(stateDir)).filter((f) => f.endsWith('.json')) : []);
const speechOf = async (r: Response) => (await r.json()) as { speech: string; done: boolean; id?: string };

// ---------------------------------------------------------------- the routes' boundaries, one check each

test('the Siri gateway token works on no other route: one try, POST /api/decide with it, is a 401', async () => {
  const s = await server();
  try {
    const r = await s.call('/api/decide', { method: 'POST', headers: { authorization: `Bearer ${s.gw}`, ...asPerson(OWNER) }, body: { id: 'd-1', answer: 'approve' } });
    assert.equal(r.status, 401);
  } finally {
    await s.close();
  }
});

test('the dashboard key never works on a Siri route: one try, the break-glass key on /api/siri/tell, is a 401 and leaves nothing', async () => {
  const s = await server();
  try {
    const { token } = await s.make();
    const r = await s.call('/api/siri/tell', { method: 'POST', headers: { authorization: `Bearer ${s.d.token}`, [SIRI_DEVICE_HEADER]: token, [SIRI_NODE_HEADER]: JSON.stringify(PHONE) }, body: { text: 'an idea' } });
    assert.equal(r.status, 401);
    assert.deepEqual(inbox(s.stateDir), []);
    assert.equal(readDevices(s.stateDir)[0]!.boundNode, null, 'the device token was never checked');
  } finally {
    await s.close();
  }
});

test('a Siri request names no person: one try with a login header is a 400; a token in the URL is refused before anything', async () => {
  const s = await server();
  try {
    const { token } = await s.make();
    assert.equal((await s.siri('/api/siri/tell', token, { text: 'x' }, PHONE, asPerson(OWNER))).status, 400);
    assert.equal((await s.siri('/api/siri/tell?token=abc', token, { text: 'x' })).status, 401);
    assert.deepEqual(inbox(s.stateDir), []);
  } finally {
    await s.close();
  }
});

test('a SiriCaller is not a Who: the type checker refuses it wherever the dashboard acts for a person', () => {
  // Never called: the build (tsc) is the test. Each line fails to compile if a SiriCaller is ever accepted there.
  const never = (c: SiriCaller, log: EventLog) => {
    // @ts-expect-error a Siri request has no login or role: it is never a person
    const who: Who = c;
    // @ts-expect-error it can't be audited as a person, so no route that audits one can take it
    auditWrite(log, c, null, 'x', {});
    // @ts-expect-error it can't answer a decision
    answerDecision(log, { id: 'd', answer: 'approve', who: c, instance: null, repo: 'o/r' });
    return who;
  };
  assert.equal(typeof never, 'function');
});

// ---------------------------------------------------------------- tell and ask

test('tell: the voice inbox, audited with the device, token id and node, never the words; Siri hears it went to the Inbox', async () => {
  const s = await server();
  try {
    const { token, device } = await s.make();
    const r = await s.siri('/api/siri/tell', token, { text: 'the totals page should show tax separately' });
    assert.equal(r.status, 200);
    assert.deepEqual(await speechOf(r), { speech: "Got it. It's in the Inbox for review.", done: true });
    const [f] = inbox(s.stateDir);
    const left = JSON.parse(readFileSync(join(voiceInboxDir(s.stateDir), f!), 'utf8')) as { by: string; text: string };
    assert.deepEqual([left.by, left.text], ['siri:Ada phone', 'the totals page should show tax separately']);
    const told = audits(s.log).find((x) => x.action === 'siri.tell')!;
    assert.deepEqual([told.via, told.role, told.login], ['siri', 'viewer', OWNER]);
    assert.deepEqual(told.detail, { device: 'Ada phone', token: device.id, node: PHONE.name, id: f!.slice(0, -5), chars: 42 });
    assert.ok(audits(s.log).some((x) => x.action === 'siri.bound' && x.detail.nodeId === PHONE.id), 'the first use binds it, audited');
    assert.doesNotMatch(JSON.stringify(s.log.read()), /tax separately/, 'the words stay out of the event log');
  } finally {
    await s.close();
  }
});

test('ask: a question file for the coordinator; pending with its id after the wait, then the spoken answer by that id', async () => {
  const s = await server();
  try {
    const { token } = await s.make();
    const r = await s.siri('/api/siri/ask', token, { text: 'what is waiting on me?' });
    assert.equal(r.status, 202);
    const pending = await speechOf(r);
    assert.equal(pending.done, false);
    assert.match(pending.speech, /taking too long/);
    const q = JSON.parse(readFileSync(join(s.stateDir, 'siri', 'requests', `${pending.id}.json`), 'utf8')) as { question: string; device: string };
    assert.equal(q.question, 'what is waiting on me?');
    writeSiriAnswer(s.stateDir, { id: pending.id!, device: q.device }, { answer: 'Two decisions wait for you: **issue 4** and [PR 7](https://example.test/x).' });
    const again = await s.siri(`/api/siri/ask/${pending.id}`, token);
    assert.deepEqual(await speechOf(again), { speech: 'Two decisions wait for you: issue 4 and PR 7.', done: true, id: pending.id });
    assert.equal(siriAnswer(s.stateDir, pending.id!)!.state, 'answered');
    assert.doesNotMatch(JSON.stringify(s.log.read()), /waiting on me/);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- the token, one check per never

test('a token from another Tailscale device: one try, refused, audited and shown on Settings', async () => {
  const s = await server();
  try {
    const { token } = await s.make();
    assert.equal((await s.siri('/api/siri/tell', token, { text: 'one' })).status, 200);
    assert.equal((await s.siri('/api/siri/tell', token, { text: 'two' }, OTHER)).status, 401);
    assert.match(String(audits(s.log).at(-1)!.detail.why), /bound to phone\./);
    const list = (await (await s.as(OWNER, '/api/siri-devices')).json()) as { devices: { lastForeign: { node: string } | null }[] };
    assert.equal(list.devices[0]!.lastForeign?.node, OTHER.name);
    assert.equal(inbox(s.stateDir).length, 1);
  } finally {
    await s.close();
  }
});

test('a revoked token: one try, refused', async () => {
  const s = await server();
  try {
    const { token, device } = await s.make();
    assert.equal((await s.as(OWNER, `/api/siri-devices/${device.id}/revoke`, {})).status, 200, 'an owner revokes from any browser');
    assert.equal((await s.siri('/api/siri/tell', token, { text: 'after' })).status, 401);
    assert.deepEqual(inbox(s.stateDir), []);
  } finally {
    await s.close();
  }
});

test('a token unused for 60 days: one try, refused as expired', async () => {
  const s = await server();
  try {
    const { token } = await s.make();
    const f = join(s.stateDir, 'siri', 'devices.json');
    const store = JSON.parse(readFileSync(f, 'utf8')) as { devices: { created: string }[] };
    store.devices[0]!.created = new Date(Date.now() - 61 * 24 * 3_600_000).toISOString();
    writeFileSync(f, JSON.stringify(store), { mode: 0o600 });
    const r = await s.siri('/api/siri/tell', token, { text: 'late' });
    assert.equal(r.status, 401);
    assert.match((await speechOf(r)).speech, /expired/);
  } finally {
    await s.close();
  }
});

test('the 21st tell in an hour is refused aloud (the limit is 20)', async () => {
  const s = await server();
  try {
    const { token } = await s.make();
    for (let i = 0; i < 20; i++) assert.equal((await s.siri('/api/siri/tell', token, { text: `idea ${i}` })).status, 200);
    const r = await s.siri('/api/siri/tell', token, { text: 'one more' });
    assert.equal(r.status, 429);
    assert.equal(inbox(s.stateDir).length, 20);
  } finally {
    await s.close();
  }
});

test('off by default: with siri off, one try is refused before the token is checked; a checkout dashboard has no Siri; no trusted Siri senders exist', async () => {
  assert.equal(IntakeConfig.parse({ version: 1 }).siri.enabled, false);
  assert.equal(IntakeConfig.safeParse({ version: 1, trusted: { voice: ['x'] } }).success, false, 'a told idea can never be trusted');
  const s = await server('version: 1\n');
  try {
    const { token } = await s.make();
    const r = await s.siri('/api/siri/tell', token, { text: 'an idea' });
    assert.equal(r.status, 403);
    assert.match((await speechOf(r)).speech, /Siri is off/);
    assert.equal(readDevices(s.stateDir)[0]!.boundNode, null);
  } finally {
    await s.close();
  }
  const local = await server(ON, { instance: null });
  try {
    assert.ok(!existsSync(join(local.stateDir, SIRI_GATEWAY_TOKEN_FILE)), 'no gateway token for a checkout');
  } finally {
    await local.close();
  }
});

// ---------------------------------------------------------------- making tokens

test('a token is made by an owner only, from an allowed device; shown once; kept as a hash, 0600, nowhere else in clear', async () => {
  const s = await server();
  try {
    assert.equal((await s.as(WRITER, '/api/siri-devices', { name: 'w' }, true)).status, 403, 'a writer: refused');
    const noDevice = await s.as(OWNER, '/api/siri-devices', { name: 'o' });
    assert.equal(noDevice.status, 403, 'an owner off an allowed device: refused');
    assert.match(((await noDevice.json()) as { error: string }).error, /allowed Tailscale devices/);
    const { token, device } = await s.make();
    assert.match(token, /^worklane_siri_example_[a-z2-7]{10}_[A-Za-z0-9_-]{43}$/);
    // The secret is base64url, so it can hold '_': take it by the token's structure, never by splitting on '_'.
    const secret = TOKEN.exec(token)![3]!;
    assert.equal(secret.length, 43);
    const list = await (await s.as(WRITER, '/api/siri-devices')).text();
    assert.ok(list.includes(device.id) && !list.includes(secret) && !list.includes('hash'), 'writers read the list, never the token');
    const f = join(s.stateDir, 'siri', 'devices.json');
    assert.match(readFileSync(f, 'utf8'), /"hash": "[0-9a-f]{64}"/);
    if (process.platform !== 'win32') assert.equal(statSync(f).mode & 0o777, 0o600);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const file of walk(s.dir)) assert.ok(!readFileSync(file).toString('latin1').includes(secret), file);
    assert.ok(audits(s.log).some((x) => x.action === 'siri.token_created' && x.detail.token === device.id));
    assert.ok(audits(s.log).some((x) => x.action === 'siri.refused_change'), 'refusals are audited');
  } finally {
    await s.close();
  }
});
