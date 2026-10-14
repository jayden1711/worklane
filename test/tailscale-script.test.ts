// scripts/setup/tailscale.sh, with the machine stood in for (the real one runs in CI's "add-project (real systemd)"
// job, where the install is Tailscale's real signed repository): stand-ins for tailscale itself
// (scripts/ci/tailscale-stand-in.cjs), curl and gpg (a key file that names its fingerprints), apt-get and dpkg-query,
// systemctl and dashboards.sh. Checked: nothing runs on a machine without tailscale; the install is refused unless the
// fetched key is exactly the pinned one, and asks apt for the pinned version with signatures required; `up` takes no
// auth key and its login link reaches one 0400 file and nothing else; serve forwards 443 to the hub's sign-in port
// only; public-url reruns dashboards.sh with the hub's own settings; every other argument list is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setupDir = join(repoRoot, 'scripts', 'setup');
const libText = readFileSync(join(setupDir, 'lib.sh'), 'utf8');
const pin = (name: string) => new RegExp(`^${name}=(\\S+)$`, 'm').exec(libText)![1]!;
const FPR = pin('TAILSCALE_SIGNER_FPR');
const VERSION = pin('TAILSCALE_VERSION');
// Put together here so the repo holds no tailnet name, even a made-up one (the denylist's rule).
const NET = ['tail0example', 'ts', 'net'].join('.');
const NAME = `box.${NET}`;
const HUB = 'http://127.0.0.1:4399';
const RUNNING = { BackendState: 'Running', Self: { DNSName: `${NAME}.` }, CertDomains: [NAME] };
const serving = (target: string, host = NAME) => ({ TCP: { 443: { HTTPS: true } }, Web: { [`${host}:443`]: { Handlers: { '/': { Proxy: target } } } } });
const hubUnit = (url: string, extra = '') => `[Service]\nExecStart=/usr/local/bin/worklane dashboard --hub alpha=/a,beta=/b --service --client-id Iv1.signin0001 --public-url ${url} --signin-dir /x${extra}\n`;

interface Step {
  step: string;
  state: string;
  detail: string;
}

function machine(o: { installed?: boolean } = {}) {
  const T = mkdtempSync(join(tmpdir(), 'tailscale-'));
  const s = join(T, 'scripts', 'setup');
  for (const d of ['scripts/setup', 'bin', 'sbin', 'users', 'owners', 'ts']) mkdirSync(join(T, d), { recursive: true });
  copyFileSync(join(setupDir, 'tailscale.sh'), join(s, 'tailscale.sh'));
  writeFileSync(
    join(s, 'lib.sh'),
    `source ${JSON.stringify(join(setupDir, 'lib.sh'))}
T=${JSON.stringify(T)}
PATH="$T/bin:$PATH"
as_root() { :; }
user_exists() { [ -e "$T/users/$1" ]; }
# No root here: the file and its mode as the script asked, and who it asked to own it, recorded.
put_file() { cat > "$4.tmp"; chmod "$3" "$4.tmp"; echo "$1 $2 $3" > "$T/owners/$(basename "$4")"; mv -f "$4.tmp" "$4"; }
TAILSCALE_BIN="$T/sbin/tailscale" TAILSCALE_DIR="$T/var" TAILSCALE_LOCK="$T/lock" TAILSCALE_KEYRING="$T/keyring.gpg" TAILSCALE_LIST="$T/tailscale.list"
OS_RELEASE="$T/os-release" HUB_UNIT="$T/hub.service"
TAILSCALE_UP_SECONDS="\${TEST_UP_SECONDS:-20}" TAILSCALE_SERVE_SECONDS=5
export TAILSCALE_STAND_IN_DIR="$T/ts"
`,
  );
  const exe = (path: string, body: string) => {
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  };
  const standIn = readFileSync(join(repoRoot, 'scripts', 'ci', 'tailscale-stand-in.cjs'), 'utf8');
  exe(join(T, 'standin-tailscale'), standIn);
  if (o.installed !== false) exe(join(T, 'sbin', 'tailscale'), standIn);
  const sh = (name: string, body: string) => exe(join(T, 'bin', name), `#!/usr/bin/env bash\nT=${JSON.stringify(T)}\necho "${name} $*" >> "$T/calls"\n${body}\n`);
  // curl ... -o <file> <url>: the key file the "repository" serves (key-served), unless there is none.
  sh('curl', `out=""; while [ "$#" -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\n[ -f "$T/key-served" ] || exit 22\ncp "$T/key-served" "$out"`);
  // gpg --show-keys --with-colons <file>: a key file here is "KEY <primary fingerprint> [<another primary>...]"; a subkey after each.
  sh('gpg', `f="\${@: -1}"\nfor k in $(sed 's/^KEY//' "$f"); do printf 'pub:-:255:22:%s:1580000000:::-:::scSC::::::23::0:\\nfpr:::::::::%s:\\nuid:-::::1580000000::X::Tailscale Inc.::::::::::0:\\nsub:-:255:18:AAAA:1580000000::::::e::::::23:\\nfpr:::::::::2F625B3A774B946822EDDBEEB1547A3DDAAF03C6:\\n' "\${k: -16}" "$k"; done`);
  // apt-get: update succeeds; install tailscale=<version> puts the stand-in where the package would, and dpkg then has that version.
  sh('apt-get', `case " $* " in\n  *" update "*) [ ! -e "$T/apt-update-fails" ] || exit 100 ;;\n  *" install "*) v="$(printf '%s\\n' "$@" | sed -n 's/^tailscale=//p')"; [ -n "$v" ] || exit 0; cp "$T/standin-tailscale" "$T/sbin/tailscale"; chmod 0755 "$T/sbin/tailscale"; echo "$v" > "$T/dpkg-version" ;;\nesac`);
  sh('dpkg-query', `cat "$T/dpkg-version" 2>/dev/null || exit 1`);
  sh('systemctl', ':');
  sh('timeout', 'shift; exec "$@"');
  // dashboards.sh: what it was run with; the hub's unit then has that --public-url, as the real one writes it.
  exe(join(s, 'dashboards.sh'), `#!/usr/bin/env bash\nT=${JSON.stringify(T)}\necho "$*" >> "$T/dashboards-calls"\n[ ! -e "$T/dashboards-fails" ] || exit 1\nurl=""; a=("$@"); for i in "\${!a[@]}"; do [ "\${a[$i]}" = --public-url ] && url="\${a[$((i + 1))]}"; done\nsed -i.bak "s# --public-url [^ ]*# --public-url $url#" "$T/hub.service"\n`);
  writeFileSync(join(T, 'os-release'), 'NAME="Ubuntu"\nID=ubuntu\nVERSION_CODENAME=noble\n');
  writeFileSync(join(T, 'key-served'), `KEY ${FPR}\n`);
  writeFileSync(join(T, 'users', 'wl-alpha'), '');
  const env = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: T, ...extra });
  const script = join(s, 'tailscale.sh');
  const run = (args: string[], extra: Record<string, string> = {}) => spawnSync('bash', [script, ...args], { encoding: 'utf8', env: env(extra), timeout: 60_000 });
  const text = (f: string) => (existsSync(join(T, f)) ? readFileSync(join(T, f), 'utf8') : '');
  const lines = (f: string) => text(f).split('\n').filter(Boolean);
  const steps = () => lines('var/steps.jsonl').map((l) => JSON.parse(l) as Step);
  const tsCalls = () => lines('ts/calls').map((l) => JSON.parse(l) as { args: string[]; authkey_env: boolean });
  const set = (f: string, v: unknown) => writeFileSync(join(T, 'ts', f), JSON.stringify(v));
  return { T, script, env, run, text, lines, steps, tsCalls, set };
}

/** Wait until a check passes (polling), or fail after a while. */
async function until(what: string, ok: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('a machine without tailscale: status says so and changes nothing; up, serve and public-url do nothing and the hub keeps its URL', { skip: !posix }, () => {
  const m = machine({ installed: false });
  writeFileSync(join(m.T, 'hub.service'), hubUnit('https://hub.example.test'));
  const st = m.run(['status', '--json']);
  assert.equal(st.status, 0, st.stderr);
  assert.deepEqual(JSON.parse(st.stdout), { installed: false, version: '', pinned_version: VERSION, state: '', name: '', https: false, serve: false, other_443: false, break_glass_forwarded: false, funnel: false, hub_url: 'https://hub.example.test' });
  assert.match(m.run(['status']).stdout, /^tailscale: not installed \(optional/);
  assert.ok(!existsSync(join(m.T, 'var')), 'status writes nothing');
  for (const step of ['up', 'serve', 'public-url']) {
    const r = m.run([step]);
    assert.equal(r.status, 1, step);
    assert.match(m.steps().at(-1)!.detail, /tailscale isn't installed on this machine/);
  }
  assert.equal(m.text('hub.service'), hubUnit('https://hub.example.test'), 'the hub keeps its URL');
  assert.equal(m.text('dashboards-calls'), '');
  assert.deepEqual(m.lines('calls'), [], 'no apt, no curl, no systemctl');
});

test('install: Tailscale\'s signed apt repository, the fetched key exactly the pinned one, the pinned version, signatures required', { skip: !posix }, () => {
  const m = machine({ installed: false });
  const r = m.run(['install']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(m.steps().map((s) => `${s.step} ${s.state}`), ['install started', 'install running', 'install running', 'install done']);
  const calls = m.lines('calls');
  // The key, over https only, from Tailscale's repository for this distribution; no script is fetched.
  const curls = calls.filter((c) => c.startsWith('curl '));
  assert.equal(curls.length, 1);
  assert.match(curls[0]!, /^curl -fsSL --proto =https --tlsv1\.2 --max-time 60 -o \S+\/key\.gpg https:\/\/pkgs\.tailscale\.com\/stable\/ubuntu\/noble\.noarmor\.gpg$/);
  assert.equal(m.text('keyring.gpg'), `KEY ${FPR}\n`);
  assert.equal(m.text('owners/keyring.gpg'), 'root root 0644\n');
  assert.match(m.text('tailscale.list'), new RegExp(`^deb \\[signed-by=${join(m.T, 'keyring.gpg').replace(/[/.]/g, '\\$&')}\\] https://pkgs\\.tailscale\\.com/stable/ubuntu noble main$`, 'm'));
  const apt = calls.filter((c) => c.startsWith('apt-get '));
  assert.equal(apt.length, 2);
  const strict = '-o Acquire::AllowInsecureRepositories=false -o Acquire::AllowDowngradeToInsecureRepositories=false -o APT::Get::AllowUnauthenticated=false';
  assert.ok(apt[0]!.startsWith(`apt-get ${strict} `) && apt[0]!.endsWith(' update -q'), apt[0]);
  assert.equal(apt[1], `apt-get ${strict} install -y -q --no-install-recommends tailscale=${VERSION}`);
  assert.doesNotMatch(calls.join('\n'), /allow-unauthenticated|--force-yes|trusted=yes|=true|=yes/i);
  assert.ok(calls.includes('systemctl enable --now tailscaled'));
  assert.match(m.steps().at(-1)!.detail, new RegExp(`^tailscale ${VERSION.replace(/\./g, '\\.')} installed from .*signed by the pinned key`));
  // Again: it is there, so nothing is fetched or installed.
  const before = m.lines('calls').length;
  assert.equal(m.run(['install']).status, 0);
  assert.match(m.steps().at(-1)!.detail, /already installed; left as it is/);
  assert.equal(m.lines('calls').length, before);
});

test('install is refused, with nothing installed and no source left, unless the key is the one pinned', { skip: !posix }, () => {
  const other = 'A'.repeat(40);
  for (const [why, key] of [
    ['another key', `KEY ${other}\n`],
    ['the pinned key and another', `KEY ${FPR} ${other}\n`],
    ['another key first', `KEY ${other} ${FPR}\n`],
    ['no key', 'KEY\n'],
  ] as const) {
    const m = machine({ installed: false });
    writeFileSync(join(m.T, 'key-served'), key);
    const r = m.run(['install']);
    assert.equal(r.status, 1, why);
    assert.match(m.steps().at(-1)!.detail, /the signing key fetched isn't the pinned one .*nothing installed/, why);
    assert.deepEqual(m.lines('calls').filter((c) => c.startsWith('apt-get ')), [], `${why}: apt never ran`);
    assert.ok(!existsSync(join(m.T, 'keyring.gpg')) && !existsSync(join(m.T, 'tailscale.list')) && !existsSync(join(m.T, 'sbin', 'tailscale')), `${why}: nothing left`);
  }
  // The key can't be fetched; apt can't verify the index; another distribution: the same.
  const cases: [string, (T: string) => void, RegExp][] = [
    ['no key served', (T) => rmSync(join(T, 'key-served')), /couldn't fetch the signing key/],
    ['apt update fails', (T) => writeFileSync(join(T, 'apt-update-fails'), ''), /apt couldn't verify Tailscale's index/],
    ['fedora', (T) => writeFileSync(join(T, 'os-release'), 'ID=fedora\nVERSION_CODENAME=""\n'), /the pinned install is for Ubuntu and Debian/],
    ['an odd codename', (T) => writeFileSync(join(T, 'os-release'), 'ID=ubuntu\nVERSION_CODENAME=../x\n'), /no release codename/],
  ];
  for (const [why, arrange, want] of cases) {
    const m = machine({ installed: false });
    arrange(m.T);
    assert.equal(m.run(['install']).status, 1, why);
    assert.match(m.steps().at(-1)!.detail, want, why);
    assert.ok(!existsSync(join(m.T, 'keyring.gpg')) && !existsSync(join(m.T, 'tailscale.list')) && !existsSync(join(m.T, 'sbin', 'tailscale')), `${why}: nothing left`);
    assert.ok(!m.lines('calls').some((c) => /^apt-get .* install .*tailscale/.test(c)), `${why}: tailscale never installed`);
  }
});

test('the script fetches no install script and pipes nothing to a shell', () => {
  const src = readFileSync(join(setupDir, 'tailscale.sh'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'nothing piped to a shell');
  assert.doesNotMatch(code, /install\.sh|tailscale\.com\/install/);
  assert.deepEqual([...code.matchAll(/curl [^\n]*/g)].length, 1, 'one download: the key');
  assert.doesNotMatch(code, /--auth-?key/i, 'no auth key option anywhere');
  // tailscale itself is run in exactly these ways: two reads, `up` with a timeout, and the one fixed serve. No funnel
  // command, no flag that turns Funnel on, no other serve target, no other `up` flag.
  const runs = [...code.matchAll(/(?:\bts|"\$TAILSCALE_BIN") ([a-z][^|)\n]*)/g)].map((m) => m[1]!.replace(/ 2>.*$/, '').trim());
  assert.deepEqual([...new Set(runs)].sort(), ['serve --bg --https=443 "http://127.0.0.1:$HUB_PORT"', 'serve status --json', 'status --json', 'up --timeout="${TAILSCALE_UP_SECONDS}s"', 'version']);
  assert.ok(!/(\bts|TAILSCALE_BIN"?) +funnel|--funnel/.test(code), 'tailscale is never given a funnel command or flag');
  assert.deepEqual([...new Set([...code.matchAll(/tailscale funnel [a-z]+/g)].map((m) => m[0]))], ['tailscale funnel reset'], 'the only funnel command named is the one an admin is told to run to turn it off');
  assert.doesNotMatch(code, /--(advertise|ssh|accept-routes|exit-node|login-server|operator|set-path|tcp|tls-terminated|http=)/);
  assert.match(libText, /^HUB_PORT=4399$/m);
  // The pins: a full fingerprint and an exact version, in lib.sh only.
  assert.match(FPR, /^[0-9A-F]{40}$/);
  assert.match(VERSION, /^[0-9]+\.[0-9]+\.[0-9]+$/);
});

test('up: no auth key; the login link reaches one 0400 file for the asking coordinator and nothing else, and is gone when up ends', { skip: !posix }, async () => {
  const m = machine();
  let out = '';
  // An auth key in the environment is dropped, not passed on.
  const p = spawn('bash', [m.script, 'up', '--for', 'alpha'], { env: m.env({ TS_AUTHKEY: 'tskey-auth-kFromEnv-0123456789', TS_AUTH_KEY: 'tskey-auth-kFromEnv-0123456789' }), stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d: Buffer) => (out += d.toString()));
  p.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const done = new Promise<number | null>((resolve) => p.on('close', resolve));
  const file = join(m.T, 'var', 'login-url');
  await until('the login link', () => existsSync(file));
  const url = readFileSync(file, 'utf8').trim();
  assert.match(url, /^https:\/\/login\.tailscale\.com\/a\/[0-9a-f]{16}$/);
  assert.equal(url, m.text('ts/last-url').trim(), "it is tailscale's own link");
  assert.equal(statSync(file).mode & 0o777, 0o400);
  assert.equal(m.text('owners/login-url'), 'wl-alpha root 0400\n', "the asking coordinator's user alone");
  await until('the waiting step', () => m.steps().some((s) => s.state === 'waiting'));
  assert.match(m.steps().at(-1)!.detail, /the login link is in alpha's dashboard, shown to machine owners only/);
  // The owner logs in.
  m.set('login.json', RUNNING);
  assert.equal(await done, 0, out);
  assert.ok(!existsSync(file), 'the link is deleted once up ends');
  assert.deepEqual(m.steps().map((s) => `${s.step} ${s.state}`), ['up started', 'up running', 'up waiting', 'up done']);
  assert.equal(m.steps().at(-1)!.detail, `on the tailnet as ${NAME}`);
  // The link is in no output and no progress line; only the link's file ever held it.
  const id = url.split('/').at(-1)!;
  for (const [where, text] of [['the output', out], ['steps.jsonl', m.text('var/steps.jsonl')], ['the commands run', m.text('calls')]] as const) assert.ok(!text.includes(id) && !text.includes('login.tailscale.com'), where);
  assert.deepEqual(readdirSync(join(m.T, 'var')), ['steps.jsonl']);
  // tailscale up was given a timeout and nothing else, and saw no key in its environment.
  const up = m.tsCalls().filter((c) => c.args[0] === 'up');
  assert.deepEqual(up, [{ args: ['up', '--timeout=20s'], authkey_env: false }]);
  assert.ok(!JSON.stringify(m.tsCalls()).includes('tskey') && !out.includes('tskey'));
  // Already on the tailnet: nothing is run again.
  assert.equal(m.run(['up', '--for', 'alpha']).status, 0);
  assert.equal(m.steps().at(-1)!.detail, `already on the tailnet as ${NAME}`);
  assert.equal(m.tsCalls().filter((c) => c.args[0] === 'up').length, 1);
});

test('up: nobody logs in, so it fails at its timeout with the link gone; without --for and without a terminal the link is shown nowhere', { skip: !posix }, () => {
  const m = machine();
  const r = m.run(['up', '--for', 'alpha'], { TEST_UP_SECONDS: '1' });
  assert.equal(r.status, 1);
  assert.match(m.steps().at(-1)!.detail, /tailscale up ended without a login/);
  assert.ok(!existsSync(join(m.T, 'var', 'login-url')));
  const id = m.text('ts/last-url').trim().split('/').at(-1)!;
  assert.ok(id.length === 16 && !(r.stdout + r.stderr + m.text('var/steps.jsonl')).includes(id));
  const n = machine();
  const t = n.run(['up'], { TEST_UP_SECONDS: '1' });
  assert.equal(t.status, 1);
  assert.ok(n.steps().some((s) => s.state === 'waiting' && /this isn't a terminal to show it in/.test(s.detail)));
  assert.ok(!existsSync(join(n.T, 'owners', 'login-url')), 'no file either');
  assert.ok(!(t.stdout + t.stderr + n.text('var/steps.jsonl')).includes(n.text('ts/last-url').trim().split('/').at(-1)!));
});

test('up: a link that is not Tailscale\'s login page, or that carries a key, is never passed on or logged', { skip: !posix }, () => {
  for (const odd of ['https://login.tailscale.com.evil.example.test/a/abcdef123456', 'http://login.tailscale.com/a/abcdef123456', 'https://login.tailscale.com/a/abcdef123456?key=tskey-auth-kOdd-0123456789abcdef', 'https://login.tailscale.com/admin/settings/keys', 'https://example.test/a/abcdef123456']) {
    const m = machine();
    writeFileSync(join(m.T, 'ts', 'odd-url'), `${odd}\n`);
    const r = m.run(['up', '--for', 'alpha'], { TEST_UP_SECONDS: '1' });
    assert.equal(r.status, 1, odd);
    assert.ok(!existsSync(join(m.T, 'owners', 'login-url')), `${odd}: never written`);
    assert.ok(m.steps().some((s) => /a link that isn't its login page, so it wasn't passed on/.test(s.detail)), odd);
    const all = r.stdout + r.stderr + m.text('var/steps.jsonl');
    assert.ok(!all.includes('abcdef123456') && !all.includes('tskey') && !all.includes('evil'), `${odd}: not logged`);
  }
});

test('every other argument list is refused before anything runs: no auth key, flag, URL, port or version', { skip: !posix }, () => {
  const m = machine();
  writeFileSync(join(m.T, 'hub.service'), hubUnit('https://hub.example.test'));
  const bad = [
    [],
    ['up', '--auth-key=tskey-auth-kExample-abcdef'],
    ['up', '--auth-key', 'tskey-auth-kExample-abcdef'],
    ['up', '--authkey', 'tskey-auth-kExample-abcdef'],
    ['up', 'tskey-auth-kExample-abcdef'],
    ['up', '--login-server=https://example.test'],
    ['up', '--for'],
    ['up', '--for', 'Alpha'],
    ['up', '--for', 'alpha;id'],
    ['up', '--for', 'dash'],
    ['up', '--for', 'nobody'],
    ['up', '--for', 'alpha', '--auth-key=tskey-auth-x'],
    ['serve', '4398'],
    ['serve', '--https=443', 'http://127.0.0.1:4398'],
    ['serve', '--for', 'alpha'],
    ['public-url', 'https://elsewhere.example.test'],
    ['public-url', '--public-url', 'https://elsewhere.example.test'],
    ['install', '1.0.0'],
    ['install', '--json'],
    ['status', '--for', 'alpha'],
    ['logout'],
    ['down'],
    ['funnel'],
    // Funnel, a target or port of the caller's, and anything that changes what `up` exposes.
    ['funnel', '443'],
    ['funnel', '--bg', '--https=443', 'http://127.0.0.1:4399'],
    ['serve', '--funnel'],
    ['serve', 'funnel'],
    ['serve', '--bg', '--https=443', 'http://127.0.0.1:4399'],
    ['serve', '--https=8443'],
    ['serve', '--set-path=/x', 'http://127.0.0.1:4398'],
    ['serve', '--set-path', '/', 'http://203.0.113.5:80'],
    ['serve', 'http://0.0.0.0:4399'],
    ['serve', '--tcp=22', 'tcp://127.0.0.1:22'],
    ['up', '--advertise-exit-node'],
    ['up', '--advertise-routes=198.51.100.0/24'],
    ['up', '--ssh'],
    ['up', '--accept-routes'],
    ['up', '--exit-node=203.0.113.1'],
    ['up', '--reset'],
    ['up', '--timeout=1s'],
    ['up', '--for', 'alpha', '--ssh'],
    ['public-url', '--name', 'other'],
    ['public-url', 'box.example.test'],
  ];
  for (const a of bad) {
    const r = m.run(a);
    assert.equal(r.status, 2, JSON.stringify(a));
  }
  assert.deepEqual(m.tsCalls(), [], 'tailscale was never run');
  assert.ok(!existsSync(join(m.T, 'var')), 'nothing written');
  assert.equal(m.text('hub.service'), hubUnit('https://hub.example.test'));
});

test('serve: https 443 to the hub\'s sign-in port and nothing else; refused off a tailnet, without certificates, over another 443, and with the break-glass forwarded', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run(['serve']).status, 1);
  assert.match(m.steps().at(-1)!.detail, /isn't on a tailnet yet: run the up step first/);
  m.set('state.json', { ...RUNNING, CertDomains: null });
  assert.equal(m.run(['serve']).status, 1);
  assert.match(m.steps().at(-1)!.detail, /doesn't issue an HTTPS certificate for box\.tail0example\.ts\.net yet: turn on MagicDNS and HTTPS certificates/);
  m.set('state.json', { ...RUNNING, CertDomains: [`other.${NET}`] });
  assert.equal(m.run(['serve']).status, 1, "another machine's certificate isn't this one's");
  assert.ok(!m.tsCalls().some((c) => c.args[0] === 'serve' && c.args[1] === '--bg'), 'serve never started');

  m.set('state.json', RUNNING);
  const r = m.run(['serve']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(m.tsCalls().filter((c) => c.args[0] === 'serve' && c.args[1] === '--bg').map((c) => c.args), [['serve', '--bg', '--https=443', HUB]]);
  assert.equal(m.steps().at(-1)!.detail, `https 443 on ${NAME} forwards to the hub's sign-in port (4399), and to nothing else`);
  assert.ok(!r.stdout.includes(`https://${NAME}`), "tailscale's own output is logged without its links");
  assert.equal(JSON.parse(m.run(['status', '--json']).stdout).serve, true);
  // Again: already forwarding, nothing run.
  assert.equal(m.run(['serve']).status, 0);
  assert.match(m.steps().at(-1)!.detail, /already forwards to the hub's sign-in port/);
  assert.equal(m.tsCalls().filter((c) => c.args[0] === 'serve' && c.args[1] === '--bg').length, 1);

  // 443 already goes somewhere else: left as it is.
  m.set('serve.json', serving('http://127.0.0.1:3000'));
  assert.equal(m.run(['serve']).status, 1);
  assert.match(m.steps().at(-1)!.detail, /already forwards https 443 somewhere else; left as it is/);
  // Anything at all forwarding to the break-glass port: refused, whatever else is there.
  for (const cfg of [serving('http://127.0.0.1:4398'), { ...serving(HUB), TCP: { 443: { HTTPS: true }, 8443: { TCPForward: '127.0.0.1:4398' } } }, { TCP: { 443: { HTTPS: true }, 10000: { HTTPS: true } }, Web: { ...serving(HUB).Web, [`${NAME}:10000`]: { Handlers: { '/': { Proxy: 'http://localhost:4398' } } } } }]) {
    m.set('serve.json', cfg);
    assert.equal(m.run(['serve']).status, 1, JSON.stringify(cfg));
    assert.match(m.steps().at(-1)!.detail, /forwards to the break-glass port 4398, which must never be forwarded/);
    assert.equal(JSON.parse(m.run(['status', '--json']).stdout).break_glass_forwarded, true);
  }
  assert.equal(m.tsCalls().filter((c) => c.args[0] === 'serve' && c.args[1] === '--bg').length, 1, 'never run again');
});

test('public-url: the hub\'s URL becomes this machine\'s tailnet name through dashboards.sh, with the hub\'s own settings; only once serve forwards to the hub', { skip: !posix }, () => {
  const m = machine();
  const old = hubUnit('https://hub.example.test', ' --console-user admin --console-devices tag:owner-laptop,box');
  writeFileSync(join(m.T, 'hub.service'), old);
  const refused = (want: RegExp) => {
    assert.equal(m.run(['public-url']).status, 1);
    assert.match(m.steps().at(-1)!.detail, want);
    assert.equal(m.text('hub.service'), old, 'the hub keeps its URL');
    assert.equal(m.text('dashboards-calls'), '');
  };
  refused(/isn't on a tailnet yet: run the up step first; the hub keeps its URL/);
  m.set('state.json', RUNNING);
  refused(/tailscale serve doesn't forward to the hub yet, so the new URL would reach nothing/);
  m.set('serve.json', serving('http://127.0.0.1:3000'));
  refused(/tailscale serve doesn't forward to the hub yet/);
  // A name that isn't a ts.net name is no name: never a URL.
  m.set('serve.json', serving(HUB, 'box.example.test'));
  m.set('state.json', { ...RUNNING, Self: { DNSName: 'box.example.test.' }, CertDomains: ['box.example.test'] });
  refused(/isn't on a tailnet yet/);
  m.set('state.json', { ...RUNNING, Self: { DNSName: 'x --client-id evil.ts.net' } });
  refused(/isn't on a tailnet yet/);

  m.set('state.json', RUNNING);
  m.set('serve.json', serving(HUB));
  const r = m.run(['public-url']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(m.lines('dashboards-calls'), [`--client-id Iv1.signin0001 --public-url https://${NAME} --console-user admin --console-devices tag:owner-laptop,box alpha beta`]);
  assert.equal(m.steps().at(-1)!.detail, `the hub's URL is now https://${NAME} (it was https://hub.example.test). To sign in there, set the sign-in App's callback URL to exactly https://${NAME}/auth/callback`);
  assert.equal(JSON.parse(m.run(['status', '--json']).stdout).hub_url, `https://${NAME}`);
  // Again: already that URL, dashboards.sh isn't run.
  assert.equal(m.run(['public-url']).status, 0);
  assert.match(m.steps().at(-1)!.detail, /already https:\/\/box\.tail0example\.ts\.net/);
  assert.equal(m.lines('dashboards-calls').length, 1);

  // No hub on the machine: nothing to set, and it says how to make one.
  const n = machine();
  n.set('state.json', RUNNING);
  n.set('serve.json', serving(HUB));
  assert.equal(n.run(['public-url']).status, 1);
  assert.match(n.steps().at(-1)!.detail, /no dashboard hub on this machine yet: set it up first \(credentials\.sh dashboard-signin, then dashboards\.sh/);
  assert.equal(n.text('dashboards-calls'), '');
});

test('Funnel is read and never changed: with it on, status says so, and serve and public-url do nothing', { skip: !posix }, () => {
  const funnel = { AllowFunnel: { [`${NAME}:443`]: true } };
  const shapes = [
    { ...serving(HUB), ...funnel },
    { ...funnel },
    { TCP: { 8443: { HTTPS: true } }, Web: { [`${NAME}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } }, AllowFunnel: { [`${NAME}:8443`]: true } },
    { Foreground: { abc123: { ...serving('http://127.0.0.1:3000'), AllowFunnel: { [`${NAME}:443`]: true } } } },
  ];
  for (const cfg of shapes) {
    const m = machine();
    const unit = hubUnit('https://hub.example.test');
    writeFileSync(join(m.T, 'hub.service'), unit);
    m.set('state.json', RUNNING);
    m.set('serve.json', cfg);
    const st = JSON.parse(m.run(['status', '--json']).stdout) as { funnel: boolean };
    assert.equal(st.funnel, true, JSON.stringify(cfg));
    assert.match(m.run(['status']).stdout, /Tailscale Funnel \(the public internet\): ON; nothing here changes it/);
    for (const step of ['serve', 'public-url']) {
      assert.equal(m.run([step]).status, 1, `${step}: ${JSON.stringify(cfg)}`);
      assert.match(m.steps().at(-1)!.detail, /Tailscale Funnel is on for this machine, which publishes to the public internet\. This step never turns Funnel on or off, and does nothing while it is on/);
    }
    // Nothing was run but the reads: serve was never started or reset, Funnel never touched, the hub's URL kept.
    assert.deepEqual([...new Set(m.tsCalls().map((c) => c.args.join(' ')))].sort(), ['serve status --json', 'status --json', 'version']);
    assert.deepEqual(JSON.parse(m.text('ts/serve.json')), cfg, 'the serve config is as it was');
    assert.equal(m.text('hub.service'), unit);
    assert.equal(m.text('dashboards-calls'), '');
  }
  // Funnel off (an entry that is false, or none): not flagged, and serve goes ahead.
  const m = machine();
  m.set('state.json', RUNNING);
  m.set('serve.json', { AllowFunnel: { [`${NAME}:443`]: false } });
  assert.equal((JSON.parse(m.run(['status', '--json']).stdout) as { funnel: boolean }).funnel, false);
  assert.match(m.run(['status']).stdout, /Tailscale Funnel \(the public internet\): off/);
  assert.equal(m.run(['serve']).status, 0);
  // What serve wrote has no Funnel in it.
  assert.doesNotMatch(m.text('ts/serve.json'), /AllowFunnel/);
});
