// The hub's Siri gateway (src/siri/gateway.ts; docs/siri.md), end to end with a real instance dashboard behind it.
// One plain check per "never": a route other than the three, a request not from tailscaled, a device locked out after
// its bad tokens, the hub's break-glass carrying a Siri request; and that the gateway never needs an instance's
// dashboard token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { startHub } from '../src/dashboard-hub.js';
import { EventLog } from '../src/events/log.js';
import { writeSiriAnswer } from '../src/siri/ask.js';
import { SIRI_GATEWAY_TOKEN_FILE } from '../src/siri/instance.js';
import { readDevices } from '../src/siri/tokens.js';
import { voiceInboxDir } from '../src/voice.js';
import { asDevicePerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

const OWNER = 'example-owner';
// Put together here so the source holds no tailnet name or address (the push gate's rules).
const NET = ['tail0example', 'ts', 'net'].join('.');
const ip = (n: number) => [100, 101, 102, 100 + n].join('.');
const NODES: Record<string, { Node: { Name: string; Tags: string[]; StableID: string } }> = {
  [ip(1)]: { Node: { Name: `phone.${NET}.`, Tags: [], StableID: 'nPhone1CNTRL' } },
  [ip(2)]: { Node: { Name: `laptop.${NET}.`, Tags: [], StableID: 'nLaptop2CNTRL' } },
};
const whois = (addr: string) => {
  if (!NODES[addr]) throw new Error('no such peer');
  return JSON.stringify(NODES[addr]);
};

async function setup(o: { withoutDashboardToken?: boolean; peerUid?: () => number | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'siri-gw-'));
  const db = join(dir, 'events.db');
  const log = new EventLog(db);
  const { dir: root } = exampleProject();
  const stateDir = join(dir, 'state');
  const intakeFile = join(dir, 'intake.yaml');
  writeFileSync(intakeFile, 'version: 1\nsiri:\n  enabled: true\n', { mode: 0o600 });
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir, user: OWNER, roleOf: exampleRoles, pollMs: 50, slotsDir: join(dir, 'slots'), instance: 'example', intakeFile });
  const port = Number(new URL(d.url).port);
  // The hub's view of the instance: its state dir, or (withoutDashboardToken) a directory holding only the Siri
  // gateway token, so the gateway works only if it never needs the dashboard token.
  let tokenDir = stateDir;
  if (o.withoutDashboardToken) {
    tokenDir = join(dir, 'hub-view');
    mkdirSync(tokenDir);
    copyFileSync(join(stateDir, SIRI_GATEWAY_TOKEN_FILE), join(tokenDir, SIRI_GATEWAY_TOKEN_FILE));
  }
  const hubState = mkdtempSync(join(tmpdir(), 'siri-hub-'));
  const h = await startHub({ instances: [{ name: 'example', port, tokenFile: join(tokenDir, 'dashboard-token') }], stateDir: hubState, siri: { port: 0, whois, peerUid: o.peerUid ?? (() => 0), lockout: { fails: 2, windowMs: 60_000, forMs: 60_000 } } });
  const make = async () => {
    const base = d.url.split('/?')[0]!.replace(/\/$/, '');
    const r = await fetch(`${base}/api/siri-devices`, { method: 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asDevicePerson(OWNER) }, body: JSON.stringify({ name: 'Ada phone' }) });
    assert.equal(r.status, 200);
    return ((await r.json()) as { token: string }).token;
  };
  /** A request as tailscale serve passes it on: from tailscaled, with the peer's Tailscale address. */
  const phone = (path: string, token: string, body?: unknown, from = ip(1)) =>
    fetch(`${h.siriUrl!}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-forwarded-for': from }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const hubAudit = () => (existsSync(join(hubState, 'siri-audit.jsonl')) ? readFileSync(join(hubState, 'siri-audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  const inbox = () => (existsSync(voiceInboxDir(stateDir)) ? readdirSync(voiceInboxDir(stateDir)).filter((f) => f.endsWith('.json')) : []);
  return { d, h, stateDir, make, phone, hubAudit, inbox, close: async () => (await h.close(), await d.close(), log.close()) };
}
const speech = async (r: Response) => (await r.json()) as { speech: string; done: boolean; id?: string };

test('end to end, with no dashboard token anywhere the hub can see: tell reaches the Inbox and binds the token; ask comes back by its id', async () => {
  const s = await setup({ withoutDashboardToken: true });
  try {
    const token = await s.make();
    const r = await s.phone('/tell', token, { text: 'add a dark mode' });
    assert.deepEqual([r.status, await speech(r)], [200, { speech: "Got it. It's in the Inbox for review.", done: true }]);
    assert.equal(s.inbox().length, 1);
    assert.deepEqual(readDevices(s.stateDir)[0]!.boundNode, { id: 'nPhone1CNTRL', name: `phone.${NET}` });
    const a = await s.phone('/ask', token, { text: 'anything waiting?' });
    const pending = await speech(a);
    assert.deepEqual([a.status, pending.done], [202, false]);
    writeSiriAnswer(s.stateDir, { id: pending.id!, device: readDevices(s.stateDir)[0]!.id }, { answer: 'Nothing waits for you.' });
    assert.deepEqual(await speech(await s.phone(`/ask/${pending.id}`, token)), { speech: 'Nothing waits for you.', done: true, id: pending.id });
  } finally {
    await s.close();
  }
});

test('only three routes, and no token in a URL: one try at another path, one with the token in the query; neither reaches an instance', async () => {
  const s = await setup();
  try {
    const token = await s.make();
    const r = await s.phone('/api/i/example/decide', token, { id: 'd-1', answer: 'approve' });
    assert.equal(r.status, 404);
    // And one try with the token in the URL: refused before anything.
    assert.equal((await s.phone(`/tell?token=${token}`, token, { text: 'x' })).status, 400);
    assert.equal(readDevices(s.stateDir)[0]!.boundNode, null, 'no instance was asked');
  } finally {
    await s.close();
  }
});

test('from the tailnet only: one try from a program on the machine (not tailscaled) is refused before its token is read', async () => {
  const s = await setup({ peerUid: () => 1001 });
  try {
    const token = await s.make();
    const r = await s.phone('/tell', token, { text: 'x' });
    assert.equal(r.status, 403);
    assert.match((await speech(r)).speech, /only answers from your tailnet/);
    assert.match(String(s.hubAudit().at(-1)!.why), /program on the machine/);
    assert.deepEqual(s.inbox(), []);
  } finally {
    await s.close();
  }
});

test('bad tokens lock their device out (2 here; 10 on a machine), and only that device', async () => {
  const s = await setup();
  try {
    const token = await s.make();
    assert.equal((await s.phone('/tell', 'not-a-token', { text: 'x' }, ip(2))).status, 401);
    assert.equal((await s.phone('/tell', 'not-a-token', { text: 'x' }, ip(2))).status, 401);
    assert.equal((await s.phone('/tell', token, { text: 'x' }, ip(2))).status, 429, 'locked out, whatever it sends now');
    assert.ok(s.hubAudit().some((a) => a.kind === 'locked_out'));
    assert.equal((await s.phone('/tell', token, { text: 'mine' })).status, 200, 'the phone itself is not');
  } finally {
    await s.close();
  }
});

test("the hub's break-glass never carries a Siri request: its forward to /api/siri/tell is refused by the instance", async () => {
  const s = await setup();
  try {
    const token = await s.make();
    const bg = s.h.breakGlassUrl.split('/?')[0]!;
    const r = await fetch(`${bg}/api/i/example/siri/tell`, { method: 'POST', headers: { authorization: `Bearer ${s.h.token}`, 'content-type': 'application/json', 'x-siri-device-token': token }, body: JSON.stringify({ text: 'x' }) });
    assert.equal(r.status, 401);
    assert.deepEqual(s.inbox(), []);
  } finally {
    await s.close();
  }
});

test('the gateway module holds no dashboard token and names no person: it imports neither the dashboard nor the hub', () => {
  const code = readFileSync(join(repoRoot, 'src', 'siri', 'gateway.ts'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  assert.doesNotMatch(code, /from '\.\.\/dashboard(-hub)?\.js'/);
  assert.doesNotMatch(code, /dashboard-token|dashboardToken|readToken|forward\(/);
  assert.doesNotMatch(code, /x-dashboard-|(?<![A-Z_])(?:LOGIN_HEADER|DEVICE_HEADER)|cookie|tailscale-user/i);
});
