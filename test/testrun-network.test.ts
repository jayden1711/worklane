// Network for test runs (docs/test-runs.md "Network"): a run's commands have none unless root's own file grants the
// tier; the fetch phase downloads what the lockfile pins with no repo code run; the run's database is reached on its
// socket only. Here: root's file as the engine reads it, the helper's line, the sandbox host's --network, the config,
// the helper's unit properties (root's tools stubbed, as test/testrun-gpu-helper.test.ts does), the root script, the
// fetch script (real npm, no network needed), doctor and the Machine page's view. The real-systemd CI job
// (scripts/ci/testrun-network-real-systemd.sh) proves the same against real systemd-run, a host listener and Docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { networkCheck } from '../src/doctor.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { npmFetchScript } from '../src/testrun/fetch.js';
import { localHost, postgresSocketUrl, sandboxHost } from '../src/testrun/host.js';
import { networkFileText, networkLine, networkPolicy, networkRecord, networkSummaryLine, parseNetworkFile } from '../src/testrun/network.js';
import { testRunsView } from '../src/testrun/status.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const uid = process.getuid?.() ?? 0;
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const helperSrc = join(repoRoot, 'scripts', 'machine', 'worklane-testrun.sh');
const real = (t: string) => ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin'].map((d) => join(d, t)).find((p) => existsSync(p));
const hasNpm = posix && spawnSync('npm', ['--version'], { encoding: 'utf8' }).status === 0;

test('tests.yaml: network is a tier\'s own ask, off unless set; "setup" is not a tier\'s name; a fetch names an npm_config_cache cache', () => {
  const c = TestRunConfig.parse({ tiers: [{ name: 'a', command: 'x', kind: 'fast' }, { name: 'b', command: 'y', kind: 'fast', network: true }] });
  assert.deepEqual(c.tiers.map((t) => t.network), [false, true]);
  assert.deepEqual([c.fetch, c.setup_network], [[], false]);
  assert.throws(() => TestRunConfig.parse({ tiers: [{ name: 'setup', command: 'x', kind: 'fast' }] }), /the setup steps' name/);
  const npm = { name: 'npm', env: 'npm_config_cache', key: ['package-lock.json'] };
  assert.deepEqual(TestRunConfig.parse({ fetch: [{ npm: 'npm' }], caches: [npm], tiers: [{ name: 'a', command: 'x', kind: 'fast' }] }).fetch, [{ npm: 'npm' }]);
  assert.throws(() => TestRunConfig.parse({ fetch: [{ npm: 'nope' }], caches: [npm], tiers: [{ name: 'a', command: 'x', kind: 'fast' }] }), /no cache named nope/);
  assert.throws(() => TestRunConfig.parse({ fetch: [{ npm: 'npm' }], caches: [{ ...npm, env: 'NPM_DIR' }], tiers: [{ name: 'a', command: 'x', kind: 'fast' }] }), /needs npm_config_cache/);
  assert.throws(() => TestRunConfig.parse({ fetch: [{ pip: 'x' }], tiers: [{ name: 'a', command: 'x', kind: 'fast' }] }));
});

test('root\'s network file: the script\'s exact form only; off when absent, not root\'s 0644, or in any other form', { skip: !posix && 'POSIX modes' }, () => {
  const dir = tmp('net-file-');
  const file = join(dir, 'testrun-network.json');
  try {
    assert.equal(networkPolicy('shop', file, uid).state, 'off');
    const f = { instances: { other: ['e2e'], shop: ['setup', 'e2e'] } };
    writeFileSync(file, networkFileText(f));
    chmodSync(file, 0o644);
    assert.deepEqual(parseNetworkFile(networkFileText(f)), f);
    assert.deepEqual(networkPolicy('shop', file, uid), { state: 'on', tiers: ['setup', 'e2e'] });
    assert.match((networkPolicy('nobody', file, uid) as { why: string }).why, /no tier of nobody has the network/);
    chmodSync(file, 0o666);
    assert.match((networkPolicy('shop', file, uid) as { why: string }).why, /not root's and 0644/);
    chmodSync(file, 0o644);
    writeFileSync(file, JSON.stringify(f));
    assert.equal(networkPolicy('shop', file, uid).state, 'off', 'valid JSON in another layout grants nothing');
    assert.equal(networkFileText({ instances: {} }), '{\n  "version": 1,\n  "instances": {}\n}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the helper\'s network line: read right after any GPU line, taken out of the output; a look-alike from the run stays the run\'s', () => {
  const gpu = 'worklane-testrun: gpu none (off)\n';
  const granted = 'worklane-testrun: network granted (e2e; public addresses and the machine\'s DNS only)\n';
  assert.deepEqual(networkLine(granted), { grant: { granted: true, tier: 'e2e' }, own: [[0, granted.length]] });
  assert.deepEqual(networkLine(`${gpu}${granted}`, gpu.length).own, [[gpu.length, gpu.length + granted.length]]);
  assert.deepEqual(networkLine('worklane-testrun: network none (tier e2e of shop is not granted)\n').grant, { granted: false, why: 'tier e2e of shop is not granted' });
  assert.deepEqual(networkLine(`Running as unit: x\n${granted}`), { grant: null, own: [] });
  assert.deepEqual(networkRecord(false, null), { network: 'none' });
  assert.deepEqual(networkRecord(true, { granted: true, tier: 'e2e' }), { network: 'granted' });
  const denied = networkRecord(true, { granted: false, why: 'tier e2e of shop is not granted the network' });
  assert.equal(denied.network, 'none');
  assert.equal(networkSummaryLine(denied, 'shop', 'e2e'), 'Network: none (asked for the network, not granted: tier e2e of shop is not granted the network). Only root grants it: sudo bash /opt/worklane/current/scripts/setup/testrun-network.sh enable shop --tiers e2e');
});

test('the sandbox host passes --network <tier> only when a command asks, and returns what the helper said; the database URL is its socket', { skip: !posix && 'POSIX sh' }, async () => {
  const dir = tmp('net-host-');
  const log = join(dir, 'calls');
  const helper = join(dir, 'helper');
  writeFileSync(helper, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
cat > /dev/null
case "$*" in
  *db-start*) echo "/var/lib/wlt/0123abcd/pg ${'b'.repeat(32)}"; exit 0 ;;
  *"--network e2e"*) echo 'worklane-testrun: network none (tier e2e of shop is not granted the network in /etc/worklane/testrun-network.json)' >&2 ;;
esac
echo out-line
printf 'Finished with result: success\\nMain processes terminated with: code=exited/status=0\\n' >&2
`);
  chmodSync(helper, 0o755);
  const sudo = join(dir, 'sudo');
  writeFileSync(sudo, '#!/bin/sh\n[ "$1" = -n ] || exit 9\nshift\nexec "$@"\n');
  chmodSync(sudo, 0o755);
  try {
    const host = sandboxHost('shop', helper, sudo);
    const asked = await host.exec('fast-a-1', 'e2e', {}, 60_000, undefined, { network: 'e2e' });
    const plain = await host.exec('fast-a-1', 'lint', {}, 60_000);
    await assert.rejects(host.exec('fast-a-1', 'x', {}, 60_000, undefined, { network: '--gpu' }), /not a tier name/);
    const db = await host.startDb('fast-a-1', { image: `postgres:16@sha256:${'a'.repeat(64)}`, name: 'test', readyS: 5, maxConnections: 200 });
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').slice(0, 2), ['shop exec fast-a-1 60 --network e2e -- e2e', 'shop exec fast-a-1 60 -- lint']);
    assert.deepEqual(asked.network, { granted: false, why: 'tier e2e of shop is not granted the network in /etc/worklane/testrun-network.json' });
    assert.doesNotMatch(asked.out, /network none/, 'the helper\'s line is not the run\'s output');
    assert.equal(plain.network, undefined);
    assert.deepEqual(db, { url: `postgres://postgres:${'b'.repeat(32)}@localhost/test?host=/var/lib/wlt/0123abcd/pg`, socketDir: '/var/lib/wlt/0123abcd/pg', container: 'worklane-test-shop-fast-a-1' });
    assert.throws(() => postgresSocketUrl('relative/dir', 'x', 'test'), /not a socket directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The helper as this user can run it: its root paths in a temp dir, systemd-run recording its argv and exiting 0. */
function netHelper() {
  const dir = tmp('net-helper-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  const me = userInfo().username;
  const sd = join(dir, 'sd');
  mkdirSync(sd);
  stub('systemd-run', `[ "$1" = --version ] && { echo "systemd 255 (test)"; exit 0; }
printf '%s\\n' "$@" > "${sd}/$(date +%s%N)-$$.argv"
echo ran`);
  for (const t of ['systemctl', 'chown']) stub(t, 'exit 0');
  stub('getent', 'exit 0');
  stub('id', `[ "$1" = -un ] && { echo '${me}'; exit 0; }; exit 0`);
  stub('runuser', 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  stub('install', `a=(); while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; exec ${real('install')} "\${a[@]}"`);
  const gnuStat = spawnSync(real('stat')!, ['--version']).status === 0;
  stub('stat', gnuStat ? `exec ${real('stat')} "$@"` : `[ "$1" = -c ] || exit 9; f="$2"; f="\${f//%U/%Su}"; f="\${f//%G/%Sg}"; f="\${f//%a/%Lp}"; shift 2; exec ${real('stat')} -f "$f" "$@"`);
  for (const t of ['git', 'cp', 'sha256sum', 'cut', 'mkdir', 'sh', 'cat', 'env', 'awk', 'sed', 'grep', 'tr', 'head', 'tail', 'sort', 'date', 'sleep', 'ls', 'dirname', 'rm']) {
    const p = real(t);
    if (p && !existsSync(join(bin, t))) symlinkSync(p, join(bin, t));
  }
  if (!existsSync(join(bin, 'sha256sum'))) stub('sha256sum', `exec ${real('shasum')} -a 256 "$@"`);
  const etc = join(dir, 'etc', 'worklane');
  mkdirSync(etc, { recursive: true, mode: 0o755 });
  chmodSync(join(dir, 'etc'), 0o755);
  chmodSync(etc, 0o755);
  const file = join(etc, 'testrun-network.json');
  const resolv = join(dir, 'resolv.conf');
  writeFileSync(resolv, 'nameserver 127.0.0.53\noptions edns0\nnameserver 203.0.113.9 ; not an address alone\n');
  const base = join(dir, 'base');
  const tmpBase = join(dir, 't');
  let src = readFileSync(helperSrc, 'utf8');
  for (const [re, to] of [
    [/^export PATH=\S+$/m, `export PATH=${bin}`],
    [/^BASE=\S+$/m, `BASE=${base}`],
    [/^TMP_BASE=\S+$/m, `TMP_BASE=${tmpBase}`],
    [/^ENV_DIR=\S+$/m, `ENV_DIR=${join(dir, 'env')}`],
    [/^sock_dir=.*$/m, `sock_dir=${join(dir, 's')}`],
    [/^user="wl-test-\$name"$/m, `user=${me}`],
    [/^NET_FILE=\S+$/m, `NET_FILE=${file}`],
    [/^RESOLV_CONF=\S+$/m, `RESOLV_CONF=${resolv}`],
  ] as const) {
    assert.match(src, re);
    src = src.replace(re, to);
  }
  const helper = join(dir, 'worklane-testrun');
  writeFileSync(helper, src);
  mkdirSync(tmpBase, { mode: 0o711 });
  chmodSync(tmpBase, 0o711);
  const mkRun = (id: string) => {
    if (existsSync(join(base, 'shop', 'runs', id))) return;
    mkdirSync(join(base, 'shop', 'runs', id, 'work'), { recursive: true });
    const h = spawnSync('/bin/bash', ['-c', `printf '%s/%s' shop ${id} | ${join(bin, 'sha256sum')} | cut -c1-8`], { encoding: 'utf8', env: { PATH: bin } }).stdout.trim();
    mkdirSync(join(tmpBase, h), { mode: 0o700 });
    chmodSync(join(tmpBase, h), 0o700);
  };
  const run = (...args: string[]) => spawnSync('/bin/bash', [helper, 'shop', ...args], { encoding: 'utf8', input: '', env: { PATH: '/usr/bin:/bin' }, timeout: 60_000 });
  const exec = (id: string, opts: string[], cmd = 'true') => {
    mkRun(id);
    return run('exec', id, '60', ...opts, '--', cmd);
  };
  const grant = (instances: Record<string, string[]>, mode = 0o644) => {
    writeFileSync(file, networkFileText({ instances }));
    chmodSync(file, mode);
  };
  /** The unit's -p properties of the newest systemd-run call. */
  const lastProps = () => {
    const f = spawnSync('ls', [sd], { encoding: 'utf8' }).stdout.split('\n').filter((x) => x.endsWith('.argv')).sort().pop();
    const argv = f ? readFileSync(join(sd, f), 'utf8').trim().split('\n') : [];
    return { argv, props: argv.filter((_, i) => argv[i - 1] === '-p') };
  };
  return { dir, base, file, run, exec, mkRun, grant, lastProps, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// The LAN ranges a granted run or a fetch never reaches (RFC 1918, RFC 6598, ULA), with link-local, multicast and
// 0.0.0.0/8. Built from their first octets: the repo's denylist refuses a literal private address.
const LAN_DENY = `link-local multicast 0.0.0.0/8 ${([[10, '0.0.0/8'], [100, '64.0.0/10'], [172, '16.0.0/12'], [192, '168.0.0/16']] as const).map(([x, y]) => `${x}.${y}`).join(' ')} fc00::/7`;
const NO_NET = ['RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK', 'PrivateNetwork=yes', 'TemporaryFileSystem=/run:ro'];

test('the key claim: a run has no network by default (PrivateNetwork=yes, an empty /run), and a repo\'s ask alone grants none', { skip: !posix && 'bash' }, () => {
  const h = netHelper();
  try {
    // No ask: no line, no network.
    const plain = h.exec('fast-a-1', []);
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(plain.stderr, /network/);
    for (const p of NO_NET) assert.ok(h.lastProps().props.includes(p), `${p} in ${h.lastProps().props.join(' | ')}`);
    assert.ok(!h.lastProps().props.some((p) => p.startsWith('IPAddress')), 'no address rules: no network at all');
    // The tier asks (tests.yaml network: true), and root's file doesn't exist: still none, and the line says why.
    const asked = h.exec('fast-a-2', ['--network', 'e2e']);
    assert.equal(asked.status, 0, asked.stderr);
    assert.match(asked.stderr, /^worklane-testrun: network none \(no tier of any instance has the network on this machine \(no \S+testrun-network\.json\)\)\n/);
    for (const p of NO_NET) assert.ok(h.lastProps().props.includes(p), p);
    // Root grants another instance's e2e and this instance's setup: this instance's e2e still has none.
    h.grant({ other: ['e2e'], shop: ['setup'] });
    const other = h.exec('fast-a-3', ['--network', 'e2e']);
    assert.match(other.stderr, /^worklane-testrun: network none \(tier e2e of shop is not granted the network in /);
    for (const p of NO_NET) assert.ok(h.lastProps().props.includes(p), p);
    // A file root doesn't own at 0644 grants nothing either.
    h.grant({ shop: ['e2e'] }, 0o664);
    assert.match(h.exec('fast-a-4', ['--network', 'e2e']).stderr, /network none \(\S+ is \S+ \d+, not \S+'s and 0644\)/);
    assert.ok(h.lastProps().props.includes('PrivateNetwork=yes'));
  } finally {
    h.done();
  }
});

test('granted by root\'s file: the host\'s network minus the LAN, link-local and multicast; the machine\'s resolvers allowed; nothing else of the sandbox changes', { skip: !posix && 'bash' }, () => {
  const h = netHelper();
  try {
    h.exec('fast-b-0', []);
    const before = h.lastProps().props.filter((p) => !NO_NET.includes(p));
    h.grant({ shop: ['e2e', 'setup'] });
    const r = h.exec('fast-b-1', ['--network', 'e2e']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^worklane-testrun: network granted \(e2e; public addresses and the machine's DNS only\)\n/);
    const { props } = h.lastProps();
    assert.ok(!props.includes('PrivateNetwork=yes'));
    assert.ok(props.includes(`IPAddressDeny=${LAN_DENY}`), props.join(' | '));
    assert.ok(props.includes('IPAddressAllow=127.0.0.53'), 'only a nameserver line\'s address, nothing else from resolv.conf');
    assert.ok(props.includes('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK'));
    // Every other property the same as a run without the network (the unit's name and paths aside).
    const norm = (ps: string[]) => ps.map((p) => p.replace(/fast-b-\d/g, 'ID').replace(/\/t\/[0-9a-f]{8}/g, '/t/HASH'));
    assert.deepEqual(norm(props.filter((p) => !p.startsWith('IPAddress') && !p.startsWith('RestrictAddressFamilies='))), norm(before.filter((p) => !p.startsWith('RestrictAddressFamilies='))));
    // Argument parsing: each option once, a tier's name only.
    for (const bad of [['--network'], ['--network', 'e2e', '--network', 'e2e'], ['--network', 'E2E'], ['--network', '../x'], ['--gpu', '--gpu'], ['--frob']]) {
      const x = h.exec('fast-b-2', bad);
      assert.equal(x.status, 2, `${bad.join(' ')}: ${x.stderr}`);
    }
  } finally {
    h.done();
  }
});

test('fetch: the host\'s network minus its loopback and the LAN; no run\'s TMPDIR; only its own cache writable; npm only, a cache the helper made', { skip: !posix && 'bash' }, () => {
  const h = netHelper();
  try {
    h.mkRun('fast-c-1');
    const key = 'a'.repeat(32);
    assert.match(h.run('fetch', 'fast-c-1', 'npm', 'npm', key, '600').stderr, /no cache npm with key/);
    mkdirSync(join(h.base, 'shop', 'cache', `npm-${key}`), { recursive: true });
    const r = h.run('fetch', 'fast-c-1', 'npm', 'npm', key, '600');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^worklane-testrun: fetch npm \(no script run; public addresses and the machine's DNS only\)\n/);
    const { argv, props } = h.lastProps();
    assert.ok(props.includes(`IPAddressDeny=localhost ${LAN_DENY}`), props.join(' | '));
    assert.ok(props.includes('IPAddressAllow=127.0.0.53'));
    assert.ok(props.includes(`TemporaryFileSystem=${join(h.dir, 't')}:ro`), 'no run\'s TMPDIR, so no database socket');
    assert.deepEqual(props.filter((p) => p.startsWith('ReadWritePaths=')), [`ReadWritePaths=${join(h.base, 'shop', 'runs', 'fast-c-1', 'fetch')}`, `ReadWritePaths=${join(h.base, 'shop', 'cache', `npm-${key}`)}`]);
    assert.ok(argv.includes(`--setenv=npm_config_cache=${join(h.base, 'shop', 'cache', `npm-${key}`)}`));
    for (const bad of [['pip', 'npm', key, '60'], ['npm', 'npm', 'xyz', '60'], ['npm', '../x', key, '60'], ['npm', 'npm', key, '0']]) assert.equal(h.run('fetch', 'fast-c-1', ...bad).status, 2, bad.join(' '));
  } finally {
    h.done();
  }
});

test('the helper\'s FETCH_NPM is the engine\'s npmFetchScript, byte for byte', () => {
  const src = readFileSync(helperSrc, 'utf8');
  assert.equal(/^FETCH_NPM='([\s\S]*?)'$/m.exec(src)?.[1], npmFetchScript());
});

/** A run directory as the local host makes it: work/ with these files, and the fetch's cache key directory. */
async function localRun(files: Record<string, string>) {
  const base = tmp('net-fetch-');
  const host = localHost(base);
  const work = join(base, 'runs', 'fast-d-1', 'work');
  mkdirSync(work, { recursive: true });
  mkdirSync(join(base, 'runs', 'fast-d-1', 'tmp'), { recursive: true });
  for (const [f, t] of Object.entries(files)) writeFileSync(join(work, f), t);
  return { base, work, fetch: () => host.fetch('fast-d-1', 'npm', 'npm', 'b'.repeat(32), 120_000) };
}
const pkg = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'p', version: '1.0.0', ...extra });
const lock = (packages: Record<string, unknown> = {}) => JSON.stringify({ name: 'p', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'p', version: '1.0.0' }, ...packages } });

test('fetch runs none of the repo\'s code: its install scripts don\'t run, and its .npmrc is never read', { skip: !hasNpm && 'npm' }, async () => {
  // Each writes beside the workspace's files (the fetch's own directory goes when it ends).
  const marker = (n: string) => `node -e "require('fs').writeFileSync('../work/${n}', 'ran')"`;
  const r = await localRun({
    'package.json': pkg({ engines: { node: '<1' }, scripts: { preinstall: marker('preinstall-ran'), postinstall: marker('postinstall-ran'), prepare: marker('prepare-ran') } }),
    'package-lock.json': lock(),
    // Read, this would fail the fetch (no node is <1): it is the repo's, and never copied in.
    '.npmrc': 'engine-strict=true\n',
  });
  try {
    const out = await r.fetch();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /fetch: every package package-lock\.json pins is in the cache/);
    for (const m of ['preinstall-ran', 'postinstall-ran', 'prepare-ran']) {
      assert.ok(!existsSync(join(r.work, m)), `${m}: no script of the repo's ran`);
    }
  } finally {
    rmSync(r.base, { recursive: true, force: true });
  }
});

test('fetch refuses a lockfile with a git, file: or link package, or none at all, before npm runs', { skip: !hasNpm && 'npm' }, async () => {
  for (const [what, files, why] of [
    ['a git dependency', { 'package.json': pkg({ dependencies: { x: 'github:example/x' } }), 'package-lock.json': lock({ 'node_modules/x': { version: '1.0.0', resolved: 'git+ssh://git@github.com/example/x.git#0123456789abcdef0123456789abcdef01234567' } }) }, /node_modules\/x resolves to "git\+ssh:.*the fetch takes https:\/\/ tarballs only/],
    ['a workspace link', { 'package.json': pkg({ workspaces: ['w'] }), 'package-lock.json': lock({ 'node_modules/w': { resolved: 'w', link: true } }) }, /node_modules\/w is a link/],
    ['an https tarball with no integrity', { 'package.json': pkg(), 'package-lock.json': lock({ 'node_modules/y': { version: '1.0.0', resolved: 'https://registry.npmjs.org/y/-/y-1.0.0.tgz' } }) }, /node_modules\/y has no integrity hash/],
    ['no lockfile', { 'package.json': pkg() }, /no package-lock\.json/],
  ] as const) {
    const r = await localRun(files);
    try {
      const out = await r.fetch();
      assert.equal(out.code, 3, `${what}: ${out.out}`);
      assert.match(out.out, why, what);
    } finally {
      rmSync(r.base, { recursive: true, force: true });
    }
  }
});

test('doctor and the Machine page show root\'s grants read-only, with the root command; a viewer never sees them', { skip: !posix && 'POSIX modes' }, () => {
  const dir = tmp('net-view-');
  const file = join(dir, 'testrun-network.json');
  try {
    assert.match(networkCheck(file, uid).detail, /^none for any tier \(no testrun-network\.json\); root changes it: sudo bash \S+testrun-network\.sh enable <name> --tiers/);
    writeFileSync(file, networkFileText({ instances: { shop: ['e2e'] } }));
    chmodSync(file, 0o644);
    assert.deepEqual([networkCheck(file, uid).level, networkCheck(file, uid).detail.split(';')[0]], ['ok', 'granted to shop: e2e (every other tier has none)']);
    const base = { events: [], configured: true, cap: 2, slots: [], lock: { path: '/x', holders: [] }, instance: 'shop', network: networkPolicy('shop', file, uid) };
    const w = testRunsView({ ...base, writer: true }) as { network?: unknown };
    assert.deepEqual(w.network, { state: 'on', tiers: ['e2e'], change: 'sudo bash /opt/worklane/current/scripts/setup/testrun-network.sh disable shop', status: 'sudo bash /opt/worklane/current/scripts/setup/testrun-network.sh status' });
    assert.equal((testRunsView({ ...base, writer: false }) as { network?: unknown }).network, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** testrun-network.sh as this user: root's tools stubbed, its file in a temp dir. */
test('testrun-network.sh: enable and disable write exactly the form the helper and the engine read, root 0644; bad arguments change nothing', { skip: !posix && 'bash' }, () => {
  const dir = tmp('net-sh-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  stub('id', '[ "$1" = -u ] && [ "$#" -eq 1 ] && { echo 0; exit 0; }; [ "$1" = -u ] && [ "$2" = wl-test-shop ] && { echo 1001; exit 0; }; [ "$1" = -u ] && exit 1; exit 0');
  stub('install', `a=(); while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; exec ${real('install')} "\${a[@]}"`);
  for (const t of ['cat', 'mv', 'rm', 'sed', 'sort', 'cut', 'tr', 'paste', 'dirname', 'basename', 'chmod', 'grep', 'head']) {
    const p = real(t);
    if (p) symlinkSync(p, join(bin, t));
  }
  const setup = join(dir, 'setup');
  mkdirSync(setup);
  writeFileSync(join(setup, 'lib.sh'), readFileSync(join(repoRoot, 'scripts', 'setup', 'lib.sh'), 'utf8'));
  const file = join(dir, 'etc', 'worklane', 'testrun-network.json');
  let src = readFileSync(join(repoRoot, 'scripts', 'setup', 'testrun-network.sh'), 'utf8');
  assert.match(src, /^NET_FILE=\S+$/m);
  src = src.replace(/^NET_FILE=\S+$/m, `NET_FILE=${file}`);
  writeFileSync(join(setup, 'testrun-network.sh'), src);
  const run = (...args: string[]) => spawnSync('/bin/bash', [join(setup, 'testrun-network.sh'), ...args], { encoding: 'utf8', env: { PATH: bin } });
  try {
    assert.match(run('status').stdout, /none for any tier on this machine \(no /);
    for (const bad of [['enable', 'shop'], ['enable', 'Bad', '--tiers', 'e2e'], ['enable', 'shop', '--tiers', 'E2E'], ['enable', 'shop', '--tiers', 'a;b'], ['disable', 'shop', '--tiers', 'e2e'], ['frob']]) {
      assert.equal(run(...bad).status, 2, bad.join(' '));
    }
    assert.equal(run('enable', 'nouser', '--tiers', 'e2e').status, 1, 'no test user: set up its test runs first');
    assert.ok(!existsSync(file), 'nothing written');
    const r = run('enable', 'shop', '--tiers', 'setup,e2e,e2e');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(file, 'utf8'), networkFileText({ instances: { shop: ['e2e', 'setup'] } }));
    assert.deepEqual(networkPolicy('shop', file, uid), { state: 'on', tiers: ['e2e', 'setup'] }, 'the engine reads what it wrote');
    assert.equal(spawnSync('stat', process.platform === 'darwin' ? ['-f', '%Lp', file] : ['-c', '%a', file], { encoding: 'utf8' }).stdout.trim(), '644');
    assert.equal(run('enable', 'shop', '--tiers', 'e2e').status, 0);
    assert.equal(readFileSync(file, 'utf8'), networkFileText({ instances: { shop: ['e2e'] } }), 'enable replaces the list');
    assert.equal(run('disable', 'shop').status, 0);
    assert.equal(readFileSync(file, 'utf8'), networkFileText({ instances: {} }));
    writeFileSync(file, '{"version": 1}\n');
    const refused = run('enable', 'shop', '--tiers', 'e2e');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not in the form this script writes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
