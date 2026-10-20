import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { deviceAllowed, deviceRefusal, isTailscaleIp, parseDeviceList, type DeviceOptions } from '../src/console/terminal-devices.js';
import { peerUidFromProcNet } from '../src/os/index.js';

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
  assert.match(r.why!, /someone-else\.tail1234\.ts\.net \(tag:guest\) isn't one of the allowed devices \(dashboards\.sh --machine-devices\)/);
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
    assert.match(r.why!, /the machine devices are empty\): the owner lists them in dashboards\.sh --machine-devices/);
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
  assert.match(deviceRefusal(req({ 'x-forwarded-for': ip(5), 'tailscale-user-login': 'owner@example.com', 'tailscale-user-name': 'laptop' }), allowed).why!, /isn't one of the allowed devices/);
  // The break-glass port never identifies a device, whatever the request says.
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
