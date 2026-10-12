// scripts/bootstrap.sh: its arguments, its plan (a dry run), its checks and its idempotence, against stand-in
// tools on a PATH of their own: nothing here downloads or installs anything. The real run is the CI job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
  assert.match(help.out, /bootstrap\.sh <repo-dir>/);
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
  assert.match(r.out, new RegExp(`would run: worklane install --root ${m.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
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
  const calls = m.calls().filter((c) => !/--version|^node |^gitleaks |^claude /.test(c));
  assert.deepEqual(calls, [`worklane install --root ${m.repo}`, `worklane doctor --root ${m.repo}`, `worklane install --root ${m.repo}`, `worklane doctor --root ${m.repo}`], 'the same steps each time, and no install');
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
  assert.deepEqual(passing.calls().filter((c) => c.startsWith('worklane ') && !c.includes('--version')).map((c) => c.split(' ')[1]), ['install', 'doctor'], 'nothing past install and doctor');
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
  assert.deepEqual(steps, ['node.sh v24.21.0', 'machine.sh', 'tools.sh 2.1.296', 'instance.sh shop', 'engine.sh v0.4.1 shop acme/shop']);
  assert.match(r.out, /credentials\.sh shop github-app/);
  const after = m.run('--hardened', '--dry-run', '--after-credentials', 'shop', 'acme/shop');
  assert.deepEqual([...after.out.matchAll(/would run: bash \S+\/setup\/(\S+)(.*)/g)].map((x) => `${x[1]}${x[2]}`.trim()), ['checkout.sh shop acme/shop', 'service.sh shop', 'check.sh shop']);
  assert.match(m.run('--hardened', 'shop', 'acme/shop').out, /run it with sudo|y\/N/, 'a real run needs root (or asks before each script)');
});

test('the Dockerfile: a pinned base image, a non-root user, the same bootstrap; the CI job runs the bootstrap on Linux', () => {
  const d = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
  assert.match(d, /^FROM debian:bookworm-slim@sha256:[0-9a-f]{64}$/m, 'the base image by digest');
  assert.match(d, /^USER \S+$/m);
  assert.match(d, /bootstrap\.sh --no-repo/);
  assert.doesNotMatch(d, /curl[^\n]*\|\s*(ba)?sh/, 'nothing piped into a shell');
  const ci = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')) as { jobs: Record<string, { strategy?: { matrix?: { os?: string[] } }; steps: { run?: string }[] }> };
  const job = ci.jobs.bootstrap!;
  assert.deepEqual(job.strategy?.matrix?.os, ['ubuntu-latest']);
  const runs = job.steps.map((s) => s.run ?? '').join('\n');
  assert.match(runs, /scripts\/bootstrap\.sh/);
  assert.match(runs, /worklane demo/);
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
