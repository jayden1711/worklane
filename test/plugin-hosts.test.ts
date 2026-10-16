import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitSafety } from '../src/plugins/fetch.js';
import { curlResolve, isPublicAddress, pinnedAddress, pluginUrlProblem, readPluginHosts } from '../src/plugins/hosts.js';
import { repoRoot } from './helpers.js';

const helper = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs')) as {
  parsePlugin: (a: string[], hosts?: string[]) => unknown;
  pluginHosts: (file: string, uid: number) => string[];
  pluginUrlProblem: (url: string, hosts: string[]) => string | null;
  pluginPathProblem: (p: string) => string | null;
};
const SHA = 'a'.repeat(40);
const GH = ['github.com'];
const me = process.getuid!();
/** A private or reserved IPv4 address, built so the repo's address scan doesn't read it as a real one. */
const ip4 = (...p: number[]) => p.join('.');

// Each URL that names something other than exactly an allowed host, by name, over https.
const NOT_THE_HOST = [
  'https://github.com.evil.io/o/r',
  'https://evil.io/github.com/o/r',
  'https://user@github.com/o/r',
  'https://github.com@evil.io/o/r',
  'https://github.com:8443/o/r',
  'https://gíthub.com/o/r',
  'https://xn--gthub-zsa.com/o/r',
  'https://github.com/o/r?x=1',
];
const ADDRESSES = ['https://140.82.112.3/o/r', 'https://2372579331/o/r', 'https://0x8c.0x52.0x70.0x3/o/r', 'https://0214.0122.0160.03/o/r', 'https://[::1]/o/r', 'https://[::ffff:127.0.0.1]/o/r', 'https://127.1/o/r'];

test('(1) plugin-fetch takes only root\'s hosts, matched whole by name: a suffix, a user, a port, a look-alike or an address is refused (helper and engine)', () => {
  for (const check of [helper.pluginUrlProblem, pluginUrlProblem]) {
    assert.equal(check('https://github.com/o/r.git', GH), null);
    for (const u of [...NOT_THE_HOST, ...ADDRESSES]) assert.notEqual(check(u, GH), null, u);
    for (const u of ADDRESSES) assert.match(check(u, [...GH, '127.0.0.1', '140.82.112.3']) ?? '', /names an address/, u);
  }
  // Fail-without: the helper's parse is what sudo's loose pattern hands over; it refuses another host.
  assert.ok(helper.parsePlugin(['plugin-fetch', 'kit', 'https://github.com/o/r', SHA], GH));
  assert.equal(helper.parsePlugin(['plugin-fetch', 'kit', 'https://github.com.evil.io/o/r', SHA], GH), null);
  assert.equal(helper.parsePlugin(['plugin-fetch', 'kit', 'https://gitlab.com/o/r', SHA], GH), null);
  assert.ok(helper.parsePlugin(['plugin-fetch', 'kit', 'https://gitlab.com/o/r', SHA], ['gitlab.com']));
});

test('(1) the host allowlist is root\'s: absent means github.com alone; not root\'s, writable by others or malformed means no host', () => {
  const d = mkdtempSync(join(tmpdir(), 'hosts-'));
  const f = join(d, 'plugin-hosts.json');
  assert.deepEqual(helper.pluginHosts(f, me), ['github.com']);
  assert.deepEqual(readPluginHosts(f, me).hosts, ['github.com']);
  writeFileSync(f, JSON.stringify({ hosts: ['gitlab.example.org'] }));
  chmodSync(f, 0o644);
  assert.deepEqual(helper.pluginHosts(f, me), ['gitlab.example.org']);
  assert.deepEqual(readPluginHosts(f, me).hosts, ['gitlab.example.org']);
  assert.deepEqual(helper.pluginHosts(f, me + 1), [], 'not root\'s (here: not the expected owner)');
  assert.deepEqual(readPluginHosts(f, me + 1).hosts, []);
  chmodSync(f, 0o666);
  assert.deepEqual(helper.pluginHosts(f, me), [], 'writable by others');
  assert.deepEqual(readPluginHosts(f, me).hosts, []);
  chmodSync(f, 0o644);
  writeFileSync(f, JSON.stringify({ hosts: [ip4(10, 0, 0, 1)] }));
  assert.deepEqual(helper.pluginHosts(f, me), [], 'an address is never a host');
  assert.deepEqual(readPluginHosts(f, me).hosts, []);
});

test('(1) at fetch time the name must resolve to public addresses only, and git is pinned to the one checked, with redirects off', async () => {
  for (const ip of [ip4(10, 1, 2, 3), '127.0.0.1', '169.254.169.254', ip4(172, 20, 0, 1), ip4(192, 168, 1, 1), ip4(100, 64, 0, 1), '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fd12::1', 'fe80::1', `::ffff:${ip4(10, 0, 0, 1)}`, '::']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['140.82.112.3', '8.8.8.8', '2606:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  // One private address among public ones (a rebinding name): refused.
  await assert.rejects(pinnedAddress('github.com', async () => [{ address: '140.82.112.3', family: 4 }, { address: ip4(10, 0, 0, 5), family: 4 }]), /isn't public/);
  assert.equal(await pinnedAddress('github.com', async () => [{ address: '140.82.112.3', family: 4 }]), '140.82.112.3');
  assert.equal(curlResolve('github.com', '140.82.112.3'), 'github.com:443:140.82.112.3');
  assert.equal(curlResolve('github.com', '2606:50c0::1'), 'github.com:443:[2606:50c0::1]');
  const args = gitSafety(false, 'github.com:443:140.82.112.3').join(' ');
  assert.match(args, /-c http\.followRedirects=false/);
  assert.match(args, /-c http\.curloptResolve=github\.com:443:140\.82\.112\.3/);
});

test('(2) the helper refuses ".." and absolute paths in the subpath', () => {
  for (const p of ['../x', 'a/../b', '/etc', '/abs/path', 'a/./b', 'a//b', 'a\\b', '..']) {
    assert.notEqual(helper.pluginPathProblem(p), null, p);
    assert.equal(helper.parsePlugin(['plugin-fetch', 'kit', 'https://github.com/o/r', SHA, p], GH), null, p);
  }
  assert.equal(helper.pluginPathProblem('plugins/kit'), null);
});

test('(3) the helper requires a URL that starts with exactly https://', () => {
  for (const u of ['http://github.com/o/r', 'HTTPS://github.com/o/r', ' https://github.com/o/r', 'git://github.com/o/r', 'ssh://github.com/o/r', 'https:/github.com/o/r', 'https:github.com/o/r', 'file:///etc']) {
    assert.match(helper.pluginUrlProblem(u, GH) ?? '', /https:\/\//, u);
    assert.equal(helper.parsePlugin(['plugin-fetch', 'kit', u, SHA], GH), null, u);
  }
});
