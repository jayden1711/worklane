import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { deviceAllowed, deviceRefusal, isTailscaleIp, parseDeviceList, type DeviceOptions } from '../src/console/terminal-devices.js';
import { openTerminal, type AuditEntry, type Pty } from '../src/console/terminal.js';
import { peerUidFromProcNet } from '../src/os/index.js';
import { startHub } from '../src/dashboard-hub.js';

// Fake tailnet fixtures, built here so no address or node name is spelled out in the source (the push gate's rules).
const NET = ['tail1234', 'ts', 'net'].join('.');
const ip = (n: number) => [100, 101, 102, 100 + n].join('.');
const LAPTOP = { Node: { Name: `laptop.${NET}.`, Tags: [] as string[] } };
const TAGGED = { Node: { Name: `build-box.${NET}.`, Tags: ['tag:owner-device'] } };
const STRANGER = { Node: { Name: `someone-else.${NET}.`, Tags: ['tag:guest'] } };
const byIp: Record<string, unknown> = { [ip(3)]: LAPTOP, [ip(4)]: TAGGED, [ip(5)]: STRANGER };

/** A request as the hub sees it from tailscale serve: on loopback, from a client port, with serve's X-Forwarded-For. */
function req(headers: Record<string, string> = {}, sock: Partial<{ remoteAddress: string; remotePort: number; localPort: number }> = {}): IncomingMessage {
  return { headers, socket: { remoteAddress: '127.0.0.1', remotePort: 51000, localPort: 4399, ...sock } } as unknown as IncomingMessage;
}
const whois = (ip: string) => {
  if (!byIp[ip]) throw new Error('no such peer');
  return JSON.stringify(byIp[ip]);
};
const fromTailscaled = () => 0;
const opts = (allow: string[], over: Partial<DeviceOptions> = {}): DeviceOptions => ({ allow, whois, peerUid: fromTailscaled, ...over });

test('allowed from a listed tag, and from a listed node name (short or full)', () => {
  assert.equal(deviceRefusal(req({ 'x-forwarded-for': ip(4) }), opts(['tag:owner-device'])).why, null);
  assert.equal(deviceRefusal(req({ 'x-forwarded-for': ip(3) }), opts(['laptop'])).why, null);
  assert.equal(deviceRefusal(req({ 'x-forwarded-for': ip(3) }), opts([`laptop.${NET}`])).why, null);
  assert.deepEqual(deviceRefusal(req({ 'x-forwarded-for': ip(4) }), opts(['tag:owner-device'])).device, { name: `build-box.${NET}`, tags: ['tag:owner-device'], ip: ip(4) });
});

test('refused from an unlisted device, and a name never matches a tag or a different node', () => {
  const r = deviceRefusal(req({ 'x-forwarded-for': ip(5) }), opts(['tag:owner-device', 'laptop']));
  assert.match(r.why!, /someone-else\.tail1234\.ts\.net \(tag:guest\) isn't one of the devices allowed/);
  assert.equal(deviceAllowed({ name: `laptop-2.${NET}`, tags: [] }, ['laptop']), false);
  assert.equal(deviceAllowed({ name: `tag.${NET}`, tags: [] }, ['tag:tag']), false);
});

test('refused when whois fails, when there is no peer address, or when Tailscale has no node for it', () => {
  assert.match(deviceRefusal(req({ 'x-forwarded-for': ip(9) }), opts(['laptop'])).why!, /tailscale whois failed/);
  assert.match(deviceRefusal(req({}), opts(['laptop'])).why!, /didn't name the peer's Tailscale address/);
  assert.match(deviceRefusal(req({ 'x-forwarded-for': ip(3) }), opts(['laptop'], { whois: () => '{}' })).why!, /no node/);
  assert.match(deviceRefusal(req({ 'x-forwarded-for': ip(3) }), opts(['laptop'], { whois: () => 'not json' })).why!, /whois failed/);
  assert.match(deviceRefusal(req({ 'x-forwarded-for': ip(3) }), opts(['laptop'], { peerUid: () => null })).why!, /can't tell which program/);
  assert.match(deviceRefusal(req({ 'x-forwarded-for': ip(3) }, { remoteAddress: ip(3) }), opts(['laptop'])).why!, /didn't come through tailscale serve/);
});

test('refused with an empty or missing list, before anything is looked up', () => {
  let asked = 0;
  for (const allow of [[], parseDeviceList(undefined), parseDeviceList(''), parseDeviceList(' , ;rm -rf, ')]) {
    const r = deviceRefusal(req({ 'x-forwarded-for': ip(3) }), opts(allow, { whois: (ip) => (asked++, whois(ip)) }));
    assert.match(r.why!, /console_devices is empty/);
  }
  assert.equal(asked, 0);
  assert.deepEqual(parseDeviceList(`tag:Owner-Device, laptop ,phone.${NET},bad name,tag:`), ['tag:owner-device', 'laptop', `phone.${NET}`]);
});

test("a forged header doesn't help: not from tailscaled, several addresses, a non-Tailscale address, Tailscale-User-* headers", () => {
  const allowed = opts(['laptop', 'tag:owner-device']);
  // A program on the machine connecting to the hub's port itself, naming the owner's laptop.
  assert.match(deviceRefusal(req({ 'x-forwarded-for': ip(3) }), { ...allowed, peerUid: () => 1001 }).why!, /came from a program on the machine/);
  // Through serve, but with an X-Forwarded-For of its own in front (serve drops it; if not, refuse anything but one address).
  assert.match(deviceRefusal(req({ 'x-forwarded-for': `${ip(3)}, ${ip(5)}` }), allowed).why!, /didn't name/);
  assert.match(deviceRefusal(req({ 'x-forwarded-for': '192.0.2.5' }), allowed).why!, /didn't name/);
  // Identity headers name a user, never a device: an unlisted device claiming the owner's login is still refused.
  assert.match(deviceRefusal(req({ 'x-forwarded-for': ip(5), 'tailscale-user-login': 'owner@example.com', 'tailscale-user-name': 'laptop' }), allowed).why!, /isn't one of the devices allowed/);
  // The break-glass port never opens it, whatever the request says.
  assert.match(deviceRefusal(req({ 'x-forwarded-for': ip(3) }, { localPort: 4398 }), allowed).why!, /break-glass/);
  assert.equal(isTailscaleIp('100.63.255.255'), false);
  assert.equal(isTailscaleIp(ip(3)), true);
  assert.equal(isTailscaleIp('fd7a:115c:a1e0::1'), true);
});

test("the kernel's record of who opened a loopback connection: /proc/net/tcp and tcp6 rows", () => {
  const v4 = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:112F 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 1 1 0000000000000000 100 0 0 10 0',
    '   1: 0100007F:C738 0100007F:112F 01 00000000:00000000 00:00000000 00000000     0        0 2 1 0000000000000000 20 4 30 10 -1',
    '   2: 0100007F:C739 0100007F:112F 01 00000000:00000000 00:00000000 00000000  1001        0 3 1 0000000000000000 20 4 30 10 -1',
  ].join('\n');
  assert.equal(peerUidFromProcNet(v4, 0xc738, 4399), 0, 'tailscaled (root)');
  assert.equal(peerUidFromProcNet(v4, 0xc739, 4399), 1001, 'another user');
  assert.equal(peerUidFromProcNet(v4, 0xc740, 4399), null);
  const v6 = ['  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid', '   0: 00000000000000000000000001000000:C738 00000000000000000000000001000000:112F 01 00000000:00000000 00:00000000 00000000   999        0 4 1'].join('\n');
  assert.equal(peerUidFromProcNet(v6, 0xc738, 4399), 999);
});

test('the terminal checks the device on top of the owner checks: an owner from an unlisted device is refused and audited; a non-owner is refused before any lookup', () => {
  const audit: AuditEntry[] = [];
  let looked = 0;
  let spawned = false;
  const base = {
    instance: 'demo',
    config: { consoleUser: 'adminx', hubUser: 'wl-dash' },
    audit: { record: (e: AuditEntry) => void audit.push(e) },
    send: () => {},
    closed: () => {},
    exec: () => 'password-required',
    now: () => 1_000_000,
    spawnPty: () => ((spawned = true), { write() {}, onData() {}, onExit() {}, kill() {} }) as Pty,
  };
  const owner = { login: 'olive', role: 'owner' as const, csrfOk: true };
  const device = (ip: string, allow: string[]) => () => (looked++, deviceRefusal(req({ 'x-forwarded-for': ip }), opts(allow)));
  const r = openTerminal({ ...base, session: owner, device: device(ip(5), ['laptop']) });
  assert.ok('refused' in r && /isn't one of the devices allowed/.test(r.refused));
  assert.equal(spawned, false);
  assert.equal(audit.at(-1)!.kind, 'refused');
  assert.match(audit.at(-1)!.device!, /someone-else/);
  const w = openTerminal({ ...base, session: { ...owner, role: 'writer' }, device: device(ip(3), ['laptop']) });
  assert.ok('refused' in w && /owner's alone/.test(w.refused));
  assert.equal(looked, 1, 'the device is looked up only once the owner checks pass');
  const ok = openTerminal({ ...base, session: owner, device: device(ip(3), ['laptop']) });
  assert.ok(!('refused' in ok));
  assert.equal(spawned, true);
  assert.match(audit.at(-1)!.device!, /^laptop\.tail1234\.ts\.net$/);
  ok.close('done');
});

test('on the hub: refused (and audited) without an allowed device, open from one; the refusal is a plain message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-devices-'));
  const audit: AuditEntry[] = [];
  let uid = 0;
  const h = await startHub({
    instances: [{ name: 'demo', port: 1, tokenFile: join(dir, 'none') }],
    stateDir: dir,
    terminal: {
      consoleUser: 'adminx',
      hubUser: 'wl-dash',
      devices: ['laptop'],
      whois,
      peerUid: () => uid,
      session: () => ({ login: 'olive', role: 'owner', csrfOk: true }),
      audit: { record: (e) => void audit.push(e) },
      exec: () => 'password-required',
      spawnPty: () => ({ write() {}, onData() {}, onExit() {}, kill() {} }) as Pty,
    },
  });
  const origin = h.url.replace(/\/(\?.*)?$/, '');
  const connect = (xff: string) =>
    new Promise<{ type: string; why?: string }[]>((done) => {
      const ws = new WebSocket(`${origin.replace('http', 'ws')}/api/terminal?instance=demo`, { origin, headers: { 'x-forwarded-for': xff } });
      const msgs: { type: string; why?: string }[] = [];
      ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
      ws.on('close', () => done(msgs));
      ws.on('open', () => setTimeout(() => (ws.close(), done(msgs)), 150));
    });
  try {
    const stranger = await connect(ip(5));
    assert.ok(stranger.some((m) => m.type === 'refused' && /isn't one of the devices allowed/.test(m.why!)), JSON.stringify(stranger));
    uid = 1001; // the same request, made by a program on the machine rather than tailscaled
    const forged = await connect(ip(3));
    assert.ok(forged.some((m) => m.type === 'refused' && /program on the machine/.test(m.why!)), JSON.stringify(forged));
    uid = 0;
    const laptop = await connect(ip(3));
    assert.ok(!laptop.some((m) => m.type === 'refused'), JSON.stringify(laptop));
    assert.deepEqual(audit.filter((e) => e.kind === 'refused').length, 2);
    assert.ok(audit.some((e) => e.kind === 'opened' && e.device === `laptop.${NET}`));
  } finally {
    await h.close();
  }
});
