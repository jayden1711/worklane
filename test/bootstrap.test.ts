// scripts/bootstrap.sh: its arguments, its plan (a dry run), its checks and its idempotence, against stand-in
// tools on a PATH of their own: nothing here downloads or installs anything. The real run is the CI job.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

/** The engine's own repo (owner/name), as package.json names it. */
const ENGINE_REPO = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { repository: { url: string } }).repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)![1]!;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const skip = process.platform === 'win32' && 'bash scripts (macOS and Linux)';
const script = join(repoRoot, 'scripts', 'bootstrap.sh');
const TOOLS = ['bash', 'sed', 'cat', 'mkdir', 'tr', 'cut', 'dirname', 'basename', 'mktemp', 'rm', 'head', 'git', 'id', 'ln', 'tar', 'install', 'env', 'sh', 'sha256sum', 'shasum', 'perl'];

/** A machine of stand-ins: `uname` says what it is, and only the given commands exist (plus basic tools). */
function machine(o: { os?: 'Linux' | 'Darwin'; arch?: string; have?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const t of TOOLS) {
    const p = which(t);
    if (p) symlinkSync(p, join(bin, t));
  }
  const log = join(dir, 'calls.log');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('uname', `case "$1" in -s) echo ${o.os ?? 'Linux'} ;; -m) echo ${o.arch ?? 'x86_64'} ;; esac`);
  for (const [name, body] of Object.entries(o.have ?? {})) stub(name, body);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  const prefix = join(dir, 'prefix');
  const run = (...args: string[]) => {
    const r = spawnSync(join(bin, 'bash'), [script, ...args], { encoding: 'utf8', env: { PATH: bin, HOME: dir, WORKLANE_PREFIX: prefix } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l && !l.startsWith('uname ')) : []);
  return { dir, bin, repo, prefix, run, calls, stub };
}

/** The pinned release recorded as installed (so a run never fetches it). */
function released(m: ReturnType<typeof machine>) {
  mkdirSync(join(m.prefix, 'share', 'worklane-bootstrap'), { recursive: true });
  writeFileSync(join(m.prefix, 'share', 'worklane-bootstrap', 'engine'), 'release:v0.4.1:9c24a10eb91ffac894e24f0b0a54d8407f23d423\n');
  return m;
}

/** Everything already installed at the right versions; the engine stub records its subcommands. */
const installed = (over: Record<string, string> = {}) => ({
  node: 'echo v24.21.0',
  gitleaks: 'echo 8.30.1',
  claude: 'echo "2.1.296 (Claude Code)"',
  worklane: 'case "$1" in --version) echo 0.4.1 ;; *) exit 0 ;; esac',
  npm: 'exit 0',
  ...over,
});

test('bootstrap: parses with bash -n; --help, unknown options and a missing repo', { skip }, () => {
  const n = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(n.status, 0, n.stderr);
  const m = machine();
  const help = m.run('--help');
  assert.equal(help.code, 0);
  assert.match(help.out, /bootstrap\.sh \[--mode local\] <repo-dir>/);
  assert.equal(m.run('--bogus').code, 2);
  assert.match(m.run().out, /give the repo to set up, or --no-repo/);
  assert.equal(m.run().code, 2);
  assert.match(m.run(join(m.dir, 'nowhere')).out, /no directory/);
  assert.equal(m.run('--engine').code, 1, '--engine needs a value');
  assert.match(machine({ os: 'Darwin', arch: 'sparc64' }).run('--no-repo').out, /unsupported architecture/);
});

test('bootstrap: a dry run on a bare Linux machine plans every step, pinned and checked, and changes nothing', { skip }, () => {
  const m = machine();
  const r = m.run('--dry-run', m.repo);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /would download node-v24\.21\.0-linux-x64\.tar\.xz \(sha256 fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6\)/);
  assert.match(r.out, /would download gitleaks_8\.30\.1_linux_x64\.tar\.gz \(sha256 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb\)/);
  assert.match(r.out, /would run: npm install -g --prefix \S+ --no-audit --no-fund @anthropic-ai\/claude-code@2\.1\.296/);
  assert.match(r.out, new RegExp(`would fetch https://github\\.com/${esc(ENGINE_REPO)}\\.git at 9c24a10eb91ffac894e24f0b0a54d8407f23d423 \\(v0\\.4\\.1\\), check the commit, and pack it`), 'the engine at its release commit, not main');
  assert.match(r.out, /would run: npm install -g --prefix \S+ --ignore-scripts --no-audit --no-fund \S+engine\.tgz/);
  assert.match(r.out, new RegExp(`would run: worklane init --mode local ${m.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'the guided checklist, in local mode');
  assert.match(r.out, /would run: worklane doctor --root/);
  assert.ok(!existsSync(m.prefix), 'nothing was created');
  assert.deepEqual(m.calls(), [], 'no tool was run');
  assert.match(machine({ arch: 'aarch64' }).run('--dry-run', '--no-repo').out, /node-v24\.21\.0-linux-arm64\.tar\.xz \(sha256 6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2\)/);
});

test('bootstrap: on a Mac, Node comes from Homebrew (never a piped installer); without Homebrew it stops and says so', { skip }, () => {
  const bare = machine({ os: 'Darwin', arch: 'arm64' });
  const r = bare.run('--dry-run', bare.repo);
  assert.equal(r.code, 1);
  assert.match(r.out, /no Node\.js 22\.13\+ and no Homebrew: install Homebrew/);
  const brew = machine({ os: 'Darwin', arch: 'arm64', have: { brew: 'echo /opt/homebrew/opt/node@24' } });
  const b = brew.run('--dry-run', brew.repo);
  assert.equal(b.code, 0, b.out);
  assert.match(b.out, /would run: brew install node@24/);
  assert.match(b.out, /gitleaks_8\.30\.1_darwin_arm64\.tar\.gz \(sha256 b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5\)/);
  assert.match(machine({ os: 'Darwin', arch: 'x86_64', have: { brew: 'true' } }).run('--dry-run', '--no-repo').out, /darwin_x64\.tar\.gz \(sha256 dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709\)/);
  const old = machine({ os: 'Darwin', arch: 'arm64', have: { node: 'echo v22.12.0', brew: 'true' } });
  assert.match(old.run('--dry-run', old.repo).out, /would run: brew install node@24/, 'Node 22.12 is too old: Node 24 LTS is installed');
  const supported = machine({ os: 'Darwin', arch: 'arm64', have: { node: 'echo v22.13.0', brew: 'true' } });
  const s = supported.run('--dry-run', supported.repo);
  assert.match(s.out, /ok: node v22\.13\.0/, 'Node 22.13 is supported and kept, not replaced by 24');
  assert.doesNotMatch(s.out, /brew install node/);
});

test('bootstrap: a download that does not match its pinned checksum is refused and removed', { skip }, () => {
  const m = machine({ have: { curl: 'while [ $# -gt 0 ]; do [ "$1" = -o ] && { echo tampered > "$2"; }; shift; done' } });
  const r = m.run('--no-repo');
  assert.equal(r.code, 1);
  assert.match(r.out, /checksum mismatch for https:\/\/nodejs\.org\/dist\/v24\.21\.0\/node-v24\.21\.0-linux-x64\.tar\.xz/);
  assert.ok(!existsSync(join(m.prefix, 'lib', 'node-v24.21.0-linux-x64')), 'nothing installed');
});

test('bootstrap: idempotent: with everything in place it installs nothing, sets the repo up and ends with doctor', { skip }, () => {
  const m = machine({ have: installed({ npm: 'echo "npm must not run" >&2; exit 9' }) });
  mkdirSync(join(m.prefix, 'share', 'worklane-bootstrap'), { recursive: true });
  writeFileSync(join(m.prefix, 'share', 'worklane-bootstrap', 'engine'), 'release:v0.4.1:9c24a10eb91ffac894e24f0b0a54d8407f23d423\n');
  for (let i = 0; i < 2; i++) {
    const r = m.run(m.repo);
    assert.equal(r.code, 0, r.out);
    for (const what of ['node v24.21.0', 'gitleaks 8.30.1', 'claude 2.1.296', 'worklane 0.4.1']) assert.match(r.out, new RegExp(`ok: ${what}`));
  }
  const calls = m.calls().filter((c) => !/--version|--help|^node |^gitleaks |^claude /.test(c));
  assert.deepEqual(calls, [`worklane init --mode local ${m.repo}`, `worklane doctor --root ${m.repo}`, `worklane init --mode local ${m.repo}`, `worklane doctor --root ${m.repo}`], 'the same steps each time, and no install');
});

test('bootstrap: the engine is installed once per source (recorded), and again only when the source changes', { skip }, () => {
  // A local tarball here (the release path fetches from GitHub; its dry run is above and the CI job runs it).
  const m = machine({ have: installed() });
  const npm = () => m.calls().filter((c) => c.startsWith('npm '));
  const tgz = join(m.dir, 'engine.tgz');
  writeFileSync(tgz, 'a');
  assert.equal(m.run('--engine', tgz, m.repo).code, 0);
  assert.equal(m.run('--engine', tgz, m.repo).code, 0);
  assert.equal(npm().length, 1, 'one engine install over two runs');
  assert.match(npm()[0]!, /--ignore-scripts --no-audit --no-fund \S+engine\.tgz/);
  writeFileSync(tgz, 'b');
  m.run('--engine', tgz, m.repo);
  assert.equal(npm().length, 2, 'new content, installed again');
  m.run('--engine', 'some-spec@1.0.0', m.repo);
  m.run('--engine', 'some-spec@1.0.0', m.repo);
  assert.equal(npm().length, 3, 'an npm spec: once');
});

test("bootstrap: doctor's result is the script's; on success it ends with the next steps, by hand", { skip }, () => {
  const failing = released(machine({ have: installed({ worklane: 'case "$1" in --version) echo 0.4.1 ;; doctor) exit 1 ;; *) exit 0 ;; esac' }) }));
  assert.equal(failing.run(failing.repo).code, 1);
  const passing = released(machine({ have: installed() }));
  const r = passing.run(passing.repo);
  assert.equal(r.code, 0);
  assert.match(r.out, /next: worklane up --root/);
  assert.match(r.out, /Setting up a project by\s+hand/);
  assert.deepEqual(passing.calls().filter((c) => c.startsWith('worklane ') && !/--version|--help/.test(c)).map((c) => c.split(' ')[1]), ['init', 'doctor'], 'nothing past init and doctor');
  // init stopping (a login missing, say) is the script's result, and doctor doesn't run after it.
  const stopped = released(machine({ have: installed({ worklane: 'case "$1" in --version) echo 0.4.1 ;; init) exit 1 ;; *) exit 0 ;; esac' }) }));
  const s = stopped.run(stopped.repo);
  assert.equal(s.code, 1);
  assert.match(s.out, /init stopped \(exit 1\): fix what it says, then run this again; it picks up where it stopped/);
  assert.ok(!stopped.calls().some((c) => c.startsWith('worklane doctor')), 'no doctor after init stopped');
});

/** WHY: an engine with the wizard (`dashboard --detach`, src/dashboard-detach.ts), standing in: it prints the URL last. */
const wizardEngine = (more = '') => `case "$1" in --version) echo 0.5.0 ;; --help) echo "  dashboard --detach [--port n] [--no-open]" ;; ${more} dashboard) echo "dashboard for $4"; echo "http://127.0.0.1:4317/first-run" ;; *) exit 0 ;; esac`;
const engineCalls = (m: ReturnType<typeof machine>) => m.calls().filter((c) => c.startsWith('worklane ') && !/--version|--help/.test(c));

test('bootstrap, local: ends with the one wizard URL from the dashboard in the background; no checklist in the terminal; a rerun prints the same and installs nothing', { skip }, () => {
  const m = released(machine({ have: installed({ npm: 'echo "npm must not run" >&2; exit 9', worklane: wizardEngine() }) }));
  const outs = [m.run(m.repo), m.run(m.repo)];
  for (const r of outs) {
    assert.equal(r.code, 0, r.out);
    const lines = r.out.trim().split('\n');
    assert.equal(lines.at(-1), 'http://127.0.0.1:4317/first-run', 'the last line is the URL');
    assert.equal(lines.filter((l) => /:\/\//.test(l)).length, 1, 'and the only URL printed');
    assert.doesNotMatch(r.out, /no first-run wizard/);
  }
  assert.deepEqual(engineCalls(m), [`worklane dashboard --detach --root ${m.repo} --no-open`, `worklane dashboard --detach --root ${m.repo} --no-open`], 'no terminal here: no browser; and no init or doctor');
  // The dashboard's own failure (a port another program holds, say) is the script's.
  const busy = released(machine({ have: installed({ worklane: wizardEngine('dashboard) echo "dashboard --detach: port 4317 answers" >&2; exit 1 ;;') }) }));
  assert.equal(busy.run(busy.repo).code, 1);
  // A dry run plans it, and starts nothing.
  const dry = released(machine({ have: installed({ worklane: wizardEngine() }) }));
  assert.match(dry.run('--dry-run', dry.repo).out, /would run: worklane dashboard --detach --root \S+ --no-open/);
  assert.deepEqual(engineCalls(dry), []);
});

test('bootstrap, local, an engine without the wizard (an older pinned release): the checklist runs in the terminal, and it says why', { skip }, () => {
  const m = released(machine({ have: installed() }));
  const r = m.run(m.repo);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /this engine \(0\.4\.1\) has no first-run wizard to open yet: the checklist runs here instead/);
  assert.deepEqual(engineCalls(m).map((c) => c.split(' ')[1]), ['init', 'doctor']);
});

test('bootstrap --config: unattended, the same end: init --yes with the file\'s answers, doctor, then the same one URL; the file is data, never run', { skip }, () => {
  const m = released(machine({ have: installed({ worklane: wizardEngine() }) }));
  const cfg = join(m.dir, 'setup.conf');
  const pwned = join(m.dir, 'pwned');
  writeFileSync(cfg, ['# the wizard, as a file', 'mode=local', 'answer=package-manager=npm', 'answer=test-command=custom:make test', ''].join('\r\n'));
  for (let i = 0; i < 2; i++) {
    const r = m.run('--config', cfg, m.repo);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.out.trim().split('\n').at(-1), 'http://127.0.0.1:4317/first-run', 'the same URL as the wizard path');
  }
  const once = [`worklane init --mode local --yes --answer package-manager=npm --answer test-command=custom:make test ${m.repo}`, `worklane doctor --root ${m.repo}`, `worklane dashboard --detach --root ${m.repo} --no-open`];
  assert.deepEqual(engineCalls(m), [...once, ...once]);
  assert.doesNotMatch(m.run('--config', cfg, m.repo).out, /no terminal to ask on/, 'its mode counts as given');

  const bad = (text: string) => (writeFileSync(cfg, text), m.run('--config', cfg, m.repo));
  assert.match(bad('mode=local\nbogus=1\n').out, /setup\.conf:2: unknown key bogus/);
  assert.match(bad('mode=cloud\n').out, /setup\.conf:1: mode is local or server, not cloud/);
  assert.match(bad('answer=nothing\n').out, /answer is <question id>=<choice>/);
  const evil = bad(`$(touch ${pwned})\nmode=$(touch ${pwned})\n`);
  assert.notEqual(evil.code, 0);
  assert.equal(existsSync(pwned), false, 'nothing in the file runs');
  assert.match(m.run('--config', join(m.dir, 'none.conf'), m.repo).out, /--config: no readable file/);
  assert.match(bad('mode=server\n').out, /server mode is the hardened multi-user Linux setup/, 'server mode is --hardened, from the file too');
});

test('bootstrap --mode: local is this path; server is the hardened one; with no terminal to ask on, local, said so', { skip }, () => {
  const m = released(machine({ have: installed() }));
  const quiet = m.run(m.repo);
  assert.equal(quiet.code, 0, quiet.out);
  assert.match(quiet.out, /no --mode, and no terminal to ask on: local mode/);
  assert.doesNotMatch(m.run('--mode', 'local', m.repo).out, /no terminal to ask on/, 'given: not asked, not defaulted');
  const yes = m.run('--mode', 'local', '--yes', m.repo);
  assert.ok(m.calls().includes(`worklane init --mode local --yes ${m.repo}`), `--yes reaches init: ${yes.out}`);
  const server = m.run('--mode', 'server', m.repo);
  assert.equal(server.code, 1);
  assert.match(server.out, /server mode is the hardened multi-user Linux setup: sudo bash scripts\/bootstrap\.sh --hardened <instance-name> <owner\/repo>/);
  assert.match(m.run('--hardened', '--mode', 'local', 'shop', 'acme/shop').out, /--hardened is server mode, not local/);
  assert.match(m.run('--mode', 'cloud', m.repo).out, /--mode is local or server, not cloud/);
  assert.match(m.run('--mode').out, /--mode needs local or server/);
});

test('bootstrap --hardened: Linux with apt and systemd only; the setup scripts in order, then the credentials by hand', { skip }, () => {
  assert.match(machine({ os: 'Darwin', arch: 'arm64' }).run('--hardened', 'shop', 'acme/shop').out, /--hardened is for Linux servers/);
  assert.match(machine().run('--hardened', '--dry-run', 'shop', 'acme/shop').out, /needs apt-get and systemd/);
  const m = machine({ have: { 'apt-get': 'true', systemctl: 'true' } });
  assert.match(m.run('--hardened', '--dry-run', 'shop').out, /usage: bootstrap\.sh --hardened <instance-name> <owner\/repo>/);
  assert.match(m.run('--hardened', '--dry-run', 'Shop!', 'acme/shop').out, /instance name must be/);
  const r = m.run('--hardened', '--dry-run', 'shop', 'acme/shop');
  assert.equal(r.code, 0, r.out);
  const steps = [...r.out.matchAll(/would run: bash \S+\/setup\/(\S+)(.*)/g)].map((x) => `${x[1]}${x[2]}`.trim());
  assert.deepEqual(steps, ['node.sh v24.21.0', 'machine.sh', 'machine-owners.sh --first <login>', 'tools.sh 2.1.296', 'instance.sh shop', 'engine.sh v0.4.1 shop acme/shop']);
  assert.match(r.out, /credentials\.sh shop github-app/);
  const after = m.run('--hardened', '--dry-run', '--after-credentials', 'shop', 'acme/shop');
  assert.deepEqual([...after.out.matchAll(/would run: bash \S+\/setup\/(\S+)(.*)/g)].map((x) => `${x[1]}${x[2]}`.trim()), ['checkout.sh shop acme/shop', 'service.sh shop', 'check.sh shop']);
  assert.match(m.run('--hardened', 'shop', 'acme/shop').out, /run it with sudo|y\/N/, 'a real run needs root (or asks before each script)');
});

test('bootstrap --hardened, the first install: the person installing becomes the first machine owner (from gh, or given), and it ends with one URL that answers, or none, the reason and the fix', { skip }, () => {
  // A stand-in root: `id -u` says 0 and chown does nothing. Tailscale names the machine (its own name comes first)
  // only once its status is written; systemctl, curl and dashboards.sh are stand-ins with state in files.
  const net = ['tail1234', 'ts', 'net'].join('.');
  const box = `box.${net}`;
  const m = machine({ have: { 'apt-get': 'true', chown: 'true', gh: 'echo ada-lovelace' } });
  const ts = join(m.dir, 'tailscale.json');
  const active = join(m.dir, 'active');
  const answering = join(m.dir, 'answering');
  writeFileSync(active, '');
  writeFileSync(answering, '');
  m.stub('tailscale', `[ -f "${ts}" ] && cat "${ts}"`);
  m.stub('systemctl', `[ "$1" = is-active ] && grep -qxF "$3" "${active}"`);
  // WHY: the printed URL must answer: curl says 200 only for a URL listed as answering, else 000 (nothing listening).
  m.stub('curl', `for u; do :; done; if grep -qxF "$u" "${answering}"; then printf 200; else printf 000; fi`);
  const viewer = join(m.dir, 'viewer');
  const signin = join(viewer, '.config', 'dashboard-signin');
  m.stub('getent', `[ "$2" = wl-dash ] && echo "wl-dash:x:990:990::${viewer}:/usr/sbin/nologin"`);
  rmSync(join(m.bin, 'id'));
  m.stub('id', 'case "$1" in -u) echo 0 ;; *) exit 1 ;; esac');
  for (const t of ['mv', 'chmod', 'grep']) symlinkSync(which(t)!, join(m.bin, t));
  // A stand-in engine checkout: this bootstrap, the real machine-owners.sh and lib.sh (its owners file moved off
  // /etc), and every other setup script a stand-in that records its arguments; dashboards.sh starts its unit.
  const eng = join(m.dir, 'engine', 'scripts');
  const setup = join(eng, 'setup');
  mkdirSync(setup, { recursive: true });
  copyFileSync(script, join(eng, 'bootstrap.sh'));
  copyFileSync(join(repoRoot, 'scripts', 'setup', 'machine-owners.sh'), join(setup, 'machine-owners.sh'));
  const owners = join(m.dir, 'machine-owners.json');
  const lib = readFileSync(join(repoRoot, 'scripts', 'setup', 'lib.sh'), 'utf8');
  assert.match(lib, /^MACHINE_OWNERS=\/etc\/worklane\/machine-owners\.json$/m);
  writeFileSync(join(setup, 'lib.sh'), lib.replace(/^MACHINE_OWNERS=.*$/m, `MACHINE_OWNERS=${owners}`));
  const ran = join(m.dir, 'steps.log');
  for (const s of ['node.sh', 'machine.sh', 'tools.sh', 'instance.sh', 'engine.sh']) writeFileSync(join(setup, s), `echo "${s} $*" >> "${ran}"\n`);
  writeFileSync(join(setup, 'dashboards.sh'), `echo "dashboards.sh $*" >> "${ran}"\ncase "$1" in --setup) echo worklane-dashboard-hub-setup.service >> "${active}" ;; --no-instances) echo worklane-dashboard-hub.service >> "${active}" ;; esac\n`);
  const run = (...args: string[]) => {
    const r = spawnSync(join(m.bin, 'bash'), [join(eng, 'bootstrap.sh'), '--hardened', '--yes', ...args], { encoding: 'utf8', env: { PATH: m.bin, HOME: m.dir } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const steps = () => readFileSync(ran, 'utf8').trim().split('\n').map((l) => l.trim());
  const dash = () => steps().filter((s) => s.startsWith('dashboards.sh'));
  const end = (out: string) => out.slice(out.lastIndexOf('\n== the dashboard')).trim().split('\n');
  const urls = (out: string) => end(out).filter((l) => /:\/\//.test(l));
  const answer = (...u: string[]) => writeFileSync(answering, u.map((x) => `${x}\n`).join(''));

  // A fresh machine with no https origin (no Tailscale yet, no --public-url): installed, but no URL: why, and the fix.
  const r = run('shop', 'acme/shop');
  assert.equal(r.code, 4, r.out);
  assert.match(m.calls().join('\n'), /gh api user --jq \.login/, 'the login, from gh');
  assert.match(r.out, /first machine owner: @ada-lovelace/);
  assert.equal(readFileSync(owners, 'utf8'), '{"owners":["ada-lovelace"]}\n', 'written as the first machine owner');
  assert.deepEqual(steps(), ['node.sh v24.21.0', 'machine.sh', 'tools.sh 2.1.296', 'instance.sh shop', 'engine.sh v0.4.1 shop acme/shop']);
  assert.match(r.out, /no URL to open yet: the sign-in App is made through the hub's setup mode, which needs this machine's https origin, and there is none yet\.\n {3}fix: turn on Tailscale[\s\S]*--public-url https:\/\/<machine>\.<tailnet>\.ts\.net shop acme\/shop\n?$/);
  assert.doesNotMatch(r.out, /\n(https?:\/\/\S+)\n?$/, 'no URL last');

  // Tailscale names it: the hub's setup mode starts (dashboards.sh --setup), but tailscale serve doesn't reach it yet.
  writeFileSync(ts, `{\n  "Self": {\n    "DNSName": "${box}.",\n  },\n  "Peer": {\n    "k": {\n      "DNSName": "other.${net}.",\n    }\n  }\n}\n`);
  const unserved = run('shop', 'acme/shop');
  assert.equal(unserved.code, 4, unserved.out);
  assert.deepEqual(dash(), [`dashboards.sh --setup --public-url https://${box}`]);
  assert.match(unserved.out, new RegExp(`no URL to open yet: the hub's setup mode runs on this machine \\(port 4399\\), but https://${esc(box)} doesn't reach it\\.\\n {3}fix: sudo tailscale serve --bg --https=443 http://127\\.0\\.0\\.1:4399, then run this again`));

  // Served: the setup-mode hub's URL, checked first, the only one; its token from a 0600 file, never in the URL.
  answer(`https://${box}/`);
  for (let i = 0; i < 2; i++) {
    const s = run('shop', 'acme/shop');
    assert.equal(s.code, 0, s.out);
    assert.equal(end(s.out).at(-1), `https://${box}/`);
    assert.deepEqual(urls(s.out), [`https://${box}/`], 'the only URL it ends with');
    assert.match(s.out, /one-time setup token: sudo cat \S+\/\.local\/state\/worklane\/dashboard-hub\/setup-token/);
  }
  assert.equal(dash().length, 1, 'a rerun leaves the running setup mode (and its token) alone');

  // A rerun with someone else keeps the list as it is.
  const again = run('--machine-owner', 'grace', 'shop', 'acme/shop');
  assert.match(again.out, /machine owners already set, kept as they are/);
  assert.equal(readFileSync(owners, 'utf8'), '{"owners":["ada-lovelace"]}\n');

  // Setup mode made the sign-in App (and stored its client id and the origin) and turned itself off: the hub alone
  // starts (dashboards.sh --no-instances), and its https origin's wizard is the URL, the same on a rerun.
  rmSync(ts);
  mkdirSync(signin, { recursive: true });
  for (const [f, v] of [['client-secret', 'x'], ['client-id', 'Iv1.example0001'], ['public-url', 'https://hub.example.test']]) writeFileSync(join(signin, f!), v!);
  writeFileSync(active, '');
  answer('https://hub.example.test/first-run', 'http://127.0.0.1:4398/first-run');
  for (let i = 0; i < 2; i++) {
    const s = run('shop', 'acme/shop');
    assert.equal(s.code, 0, s.out);
    assert.equal(end(s.out).at(-1), 'https://hub.example.test/first-run');
    assert.equal(urls(s.out).length, 1);
    assert.match(s.out, /sign in with GitHub as @ada-lovelace/);
  }
  assert.deepEqual(dash().slice(1), ['dashboards.sh --no-instances'], 'started once');

  // The origin doesn't reach the hub: the owner's break-glass, which answers; the hub's key stays in its file.
  answer('http://127.0.0.1:4398/first-run');
  const glass = run('--public-url', 'https://hub.example.test', 'shop', 'acme/shop');
  assert.equal(glass.code, 0, glass.out);
  assert.equal(end(glass.out).at(-1), 'http://127.0.0.1:4398/first-run');
  assert.equal(urls(glass.out).length, 1, 'the only URL, though the origin is named');
  assert.match(glass.out, /ssh -N -L 4398:127\.0\.0\.1:4398 <you>@<this-host>/);
  assert.match(glass.out, /asks once for the hub's key: it is in \S+\/\.local\/state\/worklane\/dashboard-hub\/dashboard-token/);

  // Nothing answers: no URL, never one that answers nothing.
  answer();
  const down = run('shop', 'acme/shop');
  assert.equal(down.code, 4, down.out);
  assert.match(down.out, /no URL to open yet: the hub doesn't answer on this machine\.\n {3}fix: sudo systemctl status worklane-dashboard-hub\.service/);
  assert.doesNotMatch(down.out, /\n(https?:\/\/\S+)\n?$/);

  // The App made by hand (no client id on file) and no hub: the command that starts it.
  rmSync(join(signin, 'client-id'));
  writeFileSync(active, '');
  const byHand = run('shop', 'acme/shop');
  assert.equal(byHand.code, 4, byHand.out);
  assert.match(byHand.out, /fix: sudo bash scripts\/setup\/dashboards\.sh --no-instances --client-id <the App's client id>/);

  // With nobody to name (gh not signed in) and no one to ask, it stops before any script runs.
  rmSync(owners);
  m.stub('gh', 'exit 1');
  const nobody = run('shop', 'acme/shop');
  assert.notEqual(nobody.code, 0);
  assert.match(nobody.out, /give your GitHub login with --machine-owner <login>/);
  assert.equal(existsSync(owners), false);
  assert.match(run('--machine-owner', 'not a login', 'shop', 'acme/shop').out, /isn't a GitHub login/);
});

test('the Dockerfile: a pinned base image, a non-root user, the same bootstrap; the CI job runs the bootstrap on Linux', () => {
  const d = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
  assert.match(d, /^FROM debian:bookworm-slim@sha256:[0-9a-f]{64}$/m, 'the base image by digest');
  assert.match(d, /^USER \S+$/m);
  assert.match(d, /bootstrap\.sh --no-repo/);
  assert.doesNotMatch(d, /curl[^\n]*\|\s*(ba)?sh/, 'nothing piped into a shell');
  const ci = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'ci-slow.yml'), 'utf8')) as { jobs: Record<string, { strategy?: { matrix?: { os?: string[] } }; steps: { run?: string }[] }> };
  const job = ci.jobs.bootstrap!;
  assert.deepEqual(job.strategy?.matrix?.os, ['ubuntu-latest', 'macos-latest'], 'local mode end to end on Linux and on a Mac');
  const runs = job.steps.map((s) => s.run ?? '').join('\n');
  assert.match(runs, /scripts\/bootstrap\.sh --mode local --yes/);
  assert.match(runs, /scripts\/ci\/stand-ins/, 'no GitHub: a stand-in gh and claude');
  assert.match(runs, /worklane doctor --root/);
  assert.match(runs, /worklane up --root[\s\S]*launchctl print[\s\S]*worklane down --root/, 'the coordinator as a launchd service, up and down');
  assert.match(runs, /worklane demo/);
  const win = ci.jobs['bootstrap-windows']! as { name?: string; 'runs-on'?: string; steps: { run?: string; uses?: string; with?: Record<string, unknown> }[] };
  assert.equal(win.name, 'bootstrap (windows-wsl)');
  assert.equal(win['runs-on'], 'windows-latest');
  const wsl = win.steps.find((s) => s.uses?.startsWith('Vampire/setup-wsl@'));
  assert.match(wsl?.uses ?? '', /@[0-9a-f]{40}$/, 'the WSL action pinned by commit');
  assert.equal(String(wsl?.with?.['wsl-version']), '2', 'WSL2, the documented route');
  const winRuns = win.steps.map((s) => s.run ?? '').join('\n');
  assert.match(winRuns, /scripts\/bootstrap\.sh" --mode local --yes/);
  assert.match(winRuns, /worklane doctor --root[\s\S]*os: windows-wsl/, 'doctor names the OS as WSL');
  assert.match(winRuns, /worklane up --root[\s\S]*systemctl --user is-enabled[\s\S]*worklane down --root/, 'the coordinator as a systemd --user unit, up and down');
  assert.doesNotMatch(readFileSync(script, 'utf8'), /curl[^\n]*\|\s*(ba)?sh/, 'the bootstrap pipes nothing into a shell');
});

test('the installed package carries what `demo` copies (examples/basic), so the demo works from an install', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, r.stderr);
  const files = (JSON.parse(r.stdout) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path);
  for (const f of ['examples/basic/.worklane/config.yaml', 'examples/basic/src/price.js', 'examples/basic/test/price.test.js']) assert.ok(files.includes(f), f);
  assert.match(readFileSync(join(repoRoot, 'src', 'demo.ts'), 'utf8'), /'\.\.\/\.\.\/examples\/basic'/, 'the path the demo copies from');
});

test("bootstrap: the release comes from the repo its package.json names; with none beside it, it asks for --engine", { skip }, () => {
  const m = machine();
  const alone = join(m.dir, 'alone');
  mkdirSync(alone);
  writeFileSync(join(alone, 'bootstrap.sh'), readFileSync(script));
  const r = spawnSync(join(m.bin, 'bash'), [join(alone, 'bootstrap.sh'), '--dry-run', '--no-repo'], { encoding: 'utf8', env: { PATH: m.bin, HOME: m.dir, WORKLANE_PREFIX: m.prefix } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /can't tell the engine's repo .* pass --engine/);
  writeFileSync(join(alone, 'package.json'), JSON.stringify({ repository: { type: 'git', url: 'git+https://github.com/example-org/engine-fork.git' } }));
  const f = spawnSync(join(m.bin, 'bash'), [join(alone, 'bootstrap.sh'), '--dry-run', '--no-repo'], { encoding: 'utf8', env: { PATH: m.bin, HOME: m.dir, WORKLANE_PREFIX: m.prefix } });
  assert.match(f.stdout, /would fetch https:\/\/github\.com\/example-org\/engine-fork\.git at 9c24a10eb91ffac894e24f0b0a54d8407f23d423/, 'a package.json beside it, as in the Docker image');
});
