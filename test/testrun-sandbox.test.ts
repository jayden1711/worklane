import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestsConfig } from '../src/config/schema.js';
import { checkName, MAX_CONNECTIONS, TestRunConfig } from '../src/testrun/config.js';
import { Readable } from 'node:stream';
import { sparseDirProblem } from '../src/checkout.js';
import { localHost, newRunId, RUN_ID, sandboxHost, type RunHost } from '../src/testrun/host.js';
import { workspaceExclude } from '../src/testrun/run.js';
import { cloneScript, createWorkspace, runEnv, wipeWorkspace } from '../src/testrun/workspace.js';
import { exampleProject, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setup = join(repoRoot, 'scripts', 'setup');
const machine = join(repoRoot, 'scripts', 'machine');
const helperSrc = join(machine, 'worklane-testrun.sh');
const pin = 'postgres:16@sha256:' + 'a'.repeat(64);

const baseTestRun = {
  setup: ['npm ci'],
  tiers: [
    { name: 'chain', command: 'npm run chain', kind: 'fast' },
    { name: 'affected', command: 'node plan.js {changed_files}', kind: 'fast', database: true },
    { name: 'suite', command: 'npm test -- --shard={shard_index}/{shard_total}', kind: 'full', database: true, shardable: true },
  ],
  database: { image: pin },
  caches: [{ name: 'npm', env: 'npm_config_cache', key: ['package-lock.json'] }],
  checks: { chain: 'test / chain' },
};

test('tests.yaml test_run: tiers, database, caches and the check mapping parse, with defaults', () => {
  const c = TestRunConfig.parse(baseTestRun);
  assert.deepEqual(c.tiers.map((t) => [t.name, t.kind, t.database, t.shardable, t.timeout_s]), [
    ['chain', 'fast', false, false, 1800],
    ['affected', 'fast', true, false, 1800],
    ['suite', 'full', true, true, 1800],
  ]);
  assert.equal(c.database?.name, 'test');
  assert.equal(checkName(c, 'chain'), 'test / chain');
  assert.equal(checkName(c, 'suite'), 'test-run/suite');
  // It is a section of tests.yaml, optional.
  const tests = { version: 1, runner: { kind: 'command', changed: 'npm test', full: 'npm test' } };
  assert.equal(TestsConfig.parse(tests).test_run, undefined);
  assert.equal(TestsConfig.parse({ ...tests, test_run: baseTestRun }).test_run?.tiers.length, 3);
});

test('tests.yaml test_run takes a project\'s CI as it is: tiers of one kind sharing a check, short shard placeholders, a shared port registry', () => {
  const c = TestRunConfig.parse({
    tiers: [
      { name: 'chain', command: 'npm run chain', kind: 'fast' },
      { name: 'ledger', command: 'npm run ledger', kind: 'fast', database: true },
      { name: 'lockfile-audit', command: 'npm run audit:lockfile', kind: 'fast' },
      { name: 'changed', command: 'npm test -- --changed --tier=isolated,db,timing', kind: 'fast', database: true },
      { name: 'isolated-db', command: 'npm test -- --tier=isolated,db', kind: 'full', database: true },
      { name: 'chain-full', command: 'npm run chain', kind: 'full' },
      { name: 'timing', command: 'npm test -- --tier=timing --shard {shard}/{total}', kind: 'full', shardable: true },
    ],
    database: { image: pin },
    shared: [{ name: 'ports', env: 'TEST_PORTS_DIR' }],
    checks: { 'isolated-db': 'suite', 'chain-full': 'suite', timing: 'suite' },
  });
  assert.deepEqual([...new Set(c.tiers.map((t) => checkName(c, t.name)))], ['test-run/chain', 'test-run/ledger', 'test-run/lockfile-audit', 'test-run/changed', 'suite']);
  assert.deepEqual(c.shared, [{ name: 'ports', env: 'TEST_PORTS_DIR' }]);
});

test('tests.yaml test_run refuses what would make a run unpinned, ambiguous or leaky', () => {
  const bad: [unknown, RegExp][] = [
    [{ ...baseTestRun, database: { image: 'postgres:16' } }, /pinned to its digest/],
    [{ ...baseTestRun, database: undefined }, /needs test_run.database/],
    [{ ...baseTestRun, tiers: [{ name: 'x', command: 'npm test', kind: 'full', shardable: true }] }, /\{shard_index\} and \{shard_total\}/],
    [{ ...baseTestRun, tiers: [{ name: 'x', command: 'npm test {shard}', kind: 'full', shardable: true }] }, /\{shard\} and \{total\}/],
    [{ ...baseTestRun, tiers: [{ name: 'x', command: 'a {shard_index} {shard_total}', kind: 'fast', shardable: true }] }, /only a full tier/],
    [{ ...baseTestRun, tiers: [baseTestRun.tiers[0], baseTestRun.tiers[0]] }, /duplicate tier chain/],
    [{ ...baseTestRun, checks: { nope: 'x' } }, /no tier named nope/],
    [{ ...baseTestRun, checks: { chain: 'same', suite: 'same' } }, /the check "same" has fast and full tiers/],
    [{ ...baseTestRun, shared: [{ name: 'ports', env: 'npm_config_cache' }] }, /npm_config_cache is set twice/],
    [{ ...baseTestRun, env: { GITHUB_TOKEN: 'x' } }, /set by the harness/],
    [{ ...baseTestRun, env: { STRIPE_SECRET: 'x' } }, /looks like a secret/],
    [{ ...baseTestRun, env: { DATABASE_URL: 'postgres://prod' } }, /set by the run/],
    [{ ...baseTestRun, caches: [{ name: 'npm', env: 'NPM_TOKEN', key: ['package-lock.json'] }] }, /looks like a secret/],
    [{ ...baseTestRun, caches: [{ name: 'npm', env: 'npm_config_cache', key: ['../x'] }] }, /inside the repo/],
  ];
  for (const [v, why] of bad) {
    const r = TestRunConfig.safeParse(v);
    assert.equal(r.success, false, JSON.stringify(v));
    assert.match(r.error!.issues.map((i) => i.message).join('; '), why);
  }
});

const printInstall = (...a: string[]) => spawnSync('bash', [join(setup, 'test-user.sh'), '--print', 'install', 'shop', ...a], { encoding: 'utf8' });

test('test-user.sh --print: the slice caps below the instances, rootless Docker as the test user, a sudoers rule for its own instance only', { skip: !posix && 'bash' }, () => {
  const r = printInstall('--cpus', '16-23', '--memory-max', '5G');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /# \/etc\/systemd\/system\/worklane-test\.slice\n\[Unit\][\s\S]*?\[Slice\]\nCPUWeight=10\nIOWeight=10\nAllowedCPUs=16-23\nCPUQuota=800%\nMemoryMax=5G\nMemorySwapMax=0\n/);
  const docker = r.stdout.slice(r.stdout.indexOf('# /etc/systemd/system/worklane-test-shop-docker.service'), r.stdout.indexOf('# sudoers rule'));
  for (const line of ['User=wl-test-shop', 'Group=wl-test-shop', 'Slice=worklane-test.slice', 'ExecStart=/opt/worklane-test/docker-29.8.2/dockerd-rootless.sh --data-root /var/lib/worklane-test/shop/docker --ip 127.0.0.1 --exec-opt native.cgroupdriver=cgroupfs']) {
    assert.ok(docker.split('\n').includes(line), `docker unit: ${line}`);
  }
  assert.match(r.stdout, /^wl-shop ALL=\(root\) NOPASSWD: \/usr\/local\/libexec\/worklane-testrun shop \*$/m, 'the coordinator reaches its own test user only');
  assert.doesNotMatch(r.stdout, /^(User|Group)=root$|SupplementaryGroups|AmbientCapabilities/m);
  assert.ok(r.stdout.includes(readFileSync(helperSrc, 'utf8')), 'the helper is printed as it will be installed');
});

test('regression: the Docker unit\'s PATH has /usr/sbin and /sbin (dockerd-rootless.sh runs sysctl from there)', { skip: !posix && 'bash' }, () => {
  // Without them the unit exited 127: "failed to execute sysctl: No such file or directory".
  const r = printInstall();
  assert.equal(r.status, 0, r.stderr);
  const docker = r.stdout.slice(r.stdout.indexOf('# /etc/systemd/system/worklane-test-shop-docker.service'), r.stdout.indexOf('# sudoers rule'));
  const path = /^Environment=PATH=(.+)$/m.exec(docker)?.[1]?.split(':') ?? [];
  for (const dir of ['/usr/sbin', '/sbin', '/usr/bin', '/bin']) assert.ok(path.includes(dir), `PATH has ${dir}: ${path.join(':')}`);
});

test('regression: rootless Docker\'s containers get cgroups of their own inside the unit\'s delegated subtree, not a user session\'s', { skip: !posix && 'bash' }, () => {
  // With Docker's default systemd driver, db-start failed on a host where the test user has no session:
  // "open /sys/fs/cgroup/user.slice/user-<uid>.slice/cgroup.controllers: no such file or directory".
  const r = printInstall();
  assert.equal(r.status, 0, r.stderr);
  const docker = r.stdout.slice(r.stdout.indexOf('# /etc/systemd/system/worklane-test-shop-docker.service'), r.stdout.indexOf('# sudoers rule'));
  const lines = docker.split('\n');
  const execStart = lines.find((l) => l.startsWith('ExecStart=')) ?? '';
  assert.match(execStart, / --exec-opt native\.cgroupdriver=cgroupfs( |$)/, 'the cgroupfs driver, never the systemd one');
  assert.doesNotMatch(lines.filter((l) => !l.startsWith('#')).join('\n'), /native\.cgroupdriver=systemd|--cgroup-parent|user\.slice/);
  // runc puts a container beside its own cgroup: the daemon in <unit>/daemon, so containers in <unit>/<id>.
  assert.ok(lines.includes('DelegateSubgroup=daemon'), 'the daemon runs in the unit\'s subgroup daemon');
  const delegate = lines.filter((l) => l.startsWith('Delegate='));
  assert.equal(delegate.length, 1, delegate.join(' | '));
  assert.deepEqual(delegate[0]!.slice('Delegate='.length).split(' ').sort(), ['cpu', 'io', 'memory', 'pids']);
  assert.ok(lines.includes('Slice=worklane-test.slice'), 'under the test runs\' one shared cap');
  // check fails unless the daemon is in that subgroup with those controllers.
  const sh = readFileSync(join(setup, 'test-user.sh'), 'utf8');
  const checks = sh.slice(sh.indexOf('service_checks() {'), sh.indexOf('\n}\n', sh.indexOf('service_checks() {')));
  assert.match(checks, /^\s*docker_cgroup_check \|\| fail=1$/m, 'check runs the Docker cgroup check');
  const fn = sh.slice(sh.indexOf('docker_cgroup_check() {'), sh.indexOf('\n}\n', sh.indexOf('docker_cgroup_check() {')));
  assert.match(fn, /"\$own" == "\$cg\/daemon"/);
  assert.match(fn, /for c in cpu io memory pids;/);
});

test('regression: check, run as root through sudo, calls the helper as root, not as the admin who ran sudo', { skip: !posix && 'bash' }, () => {
  // `sudo bash test-user.sh check <name>` leaves SUDO_USER=<admin>; the helper read that as its caller and refused
  // ("<admin> may not use <name>'s test runs"). The helper's own refusal for other users stays.
  const sh = readFileSync(join(setup, 'test-user.sh'), 'utf8');
  const helperCalls = sh.split('\n').filter((l) => /"\$helper" "\$name" check/.test(l));
  assert.ok(helperCalls.length > 0, 'check calls the helper');
  for (const l of helperCalls) assert.match(l, /env -u SUDO_USER "\$helper" "\$name" check/, l.trim());
  const refused = spawnSync('bash', [helperSrc, 'shop', 'check'], { encoding: 'utf8', env: { ...process.env, SUDO_USER: 'admin' } });
  assert.match(refused.stderr, /admin may not use shop's test runs/, 'still refused when a real sudo caller is someone else');
});

test('install stops, naming the journal, when the Docker unit isn\'t active', { skip: !posix && 'bash' }, () => {
  const sh = readFileSync(join(setup, 'test-user.sh'), 'utf8');
  const install = sh.slice(sh.indexOf('install_cmd() {'), sh.indexOf('\n}\n', sh.indexOf('install_cmd() {')));
  assert.match(install, /systemctl is-active -q "\$docker_unit_name" \|\| \{[^}]*journalctl -u "?\$docker_unit_name[^}]*exit 1; \}/, 'install fails right after starting Docker if it is not running');
});

test('test-user.sh refuses bad arguments before doing anything', { skip: !posix && 'bash' }, () => {
  for (const [args, err] of [
    [['--cpus', 'x'], /--cpus: a CPU list/],
    [['--memory-max', '50%'], /--memory-max: a size/],
    [['--cpu-weight', '0'], /weights are 1 to 10000/],
    [['--bogus'], /unknown option --bogus/],
  ] as const) {
    const r = printInstall(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, err);
  }
  for (const a of [['install', 'Bad_Name'], ['install', 'dash'], ['check'], ['remove', 'shop', 'extra'], ['frob', 'shop']]) {
    assert.equal(spawnSync('bash', [join(setup, 'test-user.sh'), ...a], { encoding: 'utf8' }).status, 2, a.join(' '));
  }
  const sh = readFileSync(join(setup, 'test-user.sh'), 'utf8');
  // The boundaries are checked before anything else is installed, and install fails if the final check does.
  assert.ok(sh.indexOf('access_checks || { echo "refusing to go on') < sh.indexOf('fetch "https://download.docker.com'));
  assert.match(sh, /check_cmd \|\| \{ echo "fix the FAIL lines/);
  assert.match(sh, /deny_acl=\(\/srv\/worklane \/opt\/worklane \/var\/lib\/worklane \/etc\/worklane\)/);
  assert.match(sh, /\[\[ "\$u" == wl-\* && "\$u" != "\$user"/, 'every other wl-* home');
});

/** A directory with a fake `sudo` first on PATH: it runs the command as this user, fails, or prints junk. */
function fakeSudo(mode: 'run' | 'fail' | 'junk') {
  const dir = mkdtempSync(join(tmpdir(), 'tr-sudo-'));
  const body = {
    run: 'while [ "$#" -gt 0 ]; do case "$1" in -n) shift ;; -u) shift 2 ;; *) break ;; esac; done\nexec "$@"\n',
    fail: 'echo "sudo: a password is required" >&2\nexit 1\n',
    junk: 'echo maybe\n',
  }[mode];
  writeFileSync(join(dir, 'sudo'), `#!/bin/sh\n${body}`);
  chmodSync(join(dir, 'sudo'), 0o755);
  return dir;
}
const denyCheck = (sudoDir: string, ...paths: string[]) =>
  spawnSync('bash', ['-c', 'source "$1"; shift; deny_check "$@"', '_', join(setup, 'lib.sh'), 'wl-test-shop', ...paths], { encoding: 'utf8', env: { ...process.env, PATH: `${sudoDir}:/usr/bin:/bin` } });

test('isolation: the test user\'s access checks fail closed; a path it can reach, or a probe that did not run, is a FAIL', { skip: (!posix && 'bash') || (process.getuid?.() === 0 && 'root reads everything') }, () => {
  const d = mkdtempSync(join(tmpdir(), 'tr-protected-'));
  const open = join(d, 'open');
  const closed = join(d, 'closed');
  mkdirSync(open, { mode: 0o755 });
  mkdirSync(closed, { mode: 0o755 });
  chmodSync(closed, 0o000);
  try {
    let r = denyCheck(fakeSudo('run'), closed, join(d, 'missing'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PASS wl-test-shop can't read, write or enter .*closed$/m);
    r = denyCheck(fakeSudo('run'), closed, open);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^FAIL wl-test-shop can reach .*open \(open\)$/m);
    for (const mode of ['fail', 'junk'] as const) {
      r = denyCheck(fakeSudo(mode), closed);
      assert.equal(r.status, 1, mode);
      assert.match(r.stdout, /^FAIL wl-test-shop can reach .*\((the probe did not run|maybe)\)$/m, mode);
    }
  } finally {
    chmodSync(closed, 0o755);
    rmSync(d, { recursive: true, force: true });
  }
  // The helper's own check probes the same paths as the test user and again inside the sandbox, where a probe
  // that printed nothing (didn't run) is a FAIL too.
  const helper = readFileSync(helperSrc, 'utf8');
  assert.match(helper, /if \[ "\$out" = denied \]; then echo "PASS/);
  assert.match(helper, /if probe_passed "\$rc" "\$out"; then echo "PASS a sandboxed run reaches none of them, and reads the object store without writing it"/);
  assert.match(helper, /2>"\$err"\)" \|\| rc=\$\?/, 'the probe\'s stdout apart from systemd-run\'s stderr');
});

/** The helper's argument checks, run alone (the helper itself needs root and the test user). */
function helperFn(fn: string, ...args: string[]) {
  const src = readFileSync(helperSrc, 'utf8');
  const body = (name: string) => src.slice(src.indexOf(`${name}() {`), src.indexOf('\n}\n', src.indexOf(`${name}() {`)) + 3);
  const die = /^die\(\) \{.*\}$/m.exec(src)![0];
  return spawnSync('bash', ['-c', `set -euo pipefail\n${die}\n${body(fn)}${fn} "$@" && echo accepted`, '_', ...args], { encoding: 'utf8' });
}

test('isolation: the sandbox helper gives a run no secret or harness variable, and only its own instance may call it', { skip: !posix && 'bash' }, () => {
  for (const ok of ['DATABASE_URL=postgres://postgres:x@127.0.0.1:5/test', 'npm_config_cache=/x', 'TZ=UTC', 'EMPTY=']) assert.match(helperFn('valid_env', ok).stdout, /accepted/, ok);
  for (const bad of ['GITHUB_TOKEN=x', 'GH_TOKEN=x', 'ANTHROPIC_API_KEY=x', 'npm_token=x', 'STRIPE_SECRET_KEY=x', 'AWS_SESSION_TOKEN=x', 'PGPASSWORD=x', 'PATH=/tmp', 'HOME=/', 'LD_PRELOAD=/x.so', 'NODE_OPTIONS=--require=x', 'DOCKER_HOST=unix:///x', 'WORKLANE_HOME=/x', 'SSH_AUTH_SOCK=/x', 'BAD-NAME=x', 'NOVALUE']) {
    const r = helperFn('valid_env', bad);
    assert.equal(r.status, 2, bad);
    assert.doesNotMatch(r.stdout, /accepted/, bad);
  }
  for (const bad of ['', 'UPPER', '../x', 'a b', 'x'.repeat(49)]) assert.equal(helperFn('valid_id', bad).status, 2, bad);
  // An instance's coordinator may not use another's test runs (sudo sets SUDO_USER); checked before anything else.
  const r = spawnSync('bash', [helperSrc, 'shop', 'check'], { encoding: 'utf8', env: { ...process.env, SUDO_USER: 'wl-other' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /wl-other may not use shop's test runs/);
  assert.equal(spawnSync('bash', [helperSrc, 'Bad;name', 'check'], { encoding: 'utf8' }).status, 2);
  // exec: a transient unit as the test user in the test slice, with nothing of the caller's environment (systemd-run
  // starts it clean) beyond the fixed variables and the run's checked ones (from a root-only file), and no Docker socket.
  const src = readFileSync(helperSrc, 'utf8');
  const exec = src.slice(src.indexOf('exec_run() {'), src.indexOf('\n}\n', src.indexOf('exec_run() {')));
  for (const s of ['--slice="$SLICE" --uid="$user" --gid="$user"', '-p NoNewPrivileges=yes', '-p ProtectSystem=strict', '-p ProtectHome=tmpfs', '-p PrivateTmp=yes', '-p TemporaryFileSystem="$root/runs:ro" -p BindPaths="$d"', 'inaccessible="-$sock_dir -$root/docker -$root/docker-home -$GPU_LOCK_DIR"', 'envfile=(-p "EnvironmentFile=$ENV_FILE")']) {
    assert.ok(exec.includes(s), s);
  }
  assert.doesNotMatch(exec, /--setenv=[A-Z_]*=\$\{?[A-Z]/, 'no variable passed through from the caller');
  assert.doesNotMatch(exec, /systemd-run[^\n]*-E\b|--property=Environment/);
  // The run's own variables never on systemd-run's argv: only the fixed ones are --setenv, each a literal or a path.
  assert.deepEqual([...exec.matchAll(/--setenv=([A-Z_]+)=/g)].map((m) => m[1]), ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'PATH', 'LANG', 'CI', 'USER', 'LOGNAME']);
  assert.doesNotMatch(exec, /--setenv=\$|--setenv="\$|RUN_ENV\[@\][^\n]*systemd-run|envs\+=/);
});

/**
 * A stand-in `docker` with the semantics the runs rely on: unique container names, a port the daemon picks for
 * `127.0.0.1::5432` (refusing a fixed host port that is taken), labels, and rm. State in $HOME/state.json.
 */
function fakeDocker(): { bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tr-docker-'));
  const js = join(dir, 'docker.cjs');
  writeFileSync(
    js,
    `const fs = require('fs'), path = require('path');
const f = path.join(process.env.HOME, 'state.json');
fs.mkdirSync(process.env.HOME, { recursive: true });
// One call at a time, as one daemon serializes them.
const lock = f + '.lock';
for (;;) { try { fs.mkdirSync(lock); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } }
process.on('exit', () => fs.rmdirSync(lock));
const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { containers: {}, next: 41000 };
const save = () => fs.writeFileSync(f, JSON.stringify(s));
const a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(n); return i < 0 ? null : a[i + 1]; };
const bySelector = (sel) => Object.keys(s.containers).filter((n) => !sel || s.containers[n].label === sel.replace(/^label=/, ''));
switch (a[0]) {
  case 'image': case 'pull': case 'exec': break;
  case 'run': {
    const name = flag('--name'), spec = flag('-p');
    if (s.containers[name]) { console.error('Conflict. The container name "/' + name + '" is already in use'); process.exit(125); }
    const m = /^127\\.0\\.0\\.1:(\\d*):5432$/.exec(spec);
    if (!m) { console.error('bad -p ' + spec); process.exit(125); }
    const used = new Set(Object.values(s.containers).map((c) => c.port));
    let port = m[1] ? Number(m[1]) : s.next++;
    if (used.has(port)) { console.error('Bind for 127.0.0.1:' + port + ' failed: port is already allocated'); process.exit(125); }
    s.containers[name] = { label: flag('--label'), port, args: a };
    save(); console.log(name); break;
  }
  case 'port': { const c = s.containers[a[1]]; if (!c) process.exit(1); console.log('127.0.0.1:' + c.port); break; }
  case 'ps': console.log(bySelector(flag('--filter')).join('\\n')); break;
  case 'rm': for (const n of a.slice(1).filter((x) => !x.startsWith('-'))) delete s.containers[n]; save(); break;
  case 'volume': break;
  default: process.exit(2);
}
`,
  );
  const bin = join(dir, 'docker');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(bin, 0o755);
  return { bin };
}

function project() {
  const p = exampleProject();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.dir, encoding: 'utf8' }).trim();
  return { ...p, sha };
}

test('isolation: a wipe leaves nothing behind (workspace, temp files, home, containers)', { skip: !posix && 'a POSIX shell for the stand-in docker' }, async () => {
  const p = project();
  const base = mkdtempSync(join(tmpdir(), 'tr-host-'));
  const docker = fakeDocker();
  const host = localHost(base, { docker: docker.bin });
  const id = newRunId('fast', p.sha);
  assert.match(id, RUN_ID);
  const ws = await createWorkspace(host, p.dir, p.sha, id);
  assert.ok(existsSync(join(ws.workdir, '.worklane', 'config.yaml')), 'the commit\'s tree');
  assert.equal(readFileSync(join(ws.workdir, '.git', 'objects', 'info', 'alternates'), 'utf8'), `${join(base, 'store', 'objects')}\n`, 'objects from the host\'s own store, never the coordinator\'s');
  const db = await host.startDb(id, { image: pin, name: 'test', readyS: 5, maxConnections: 300 });
  const started = Object.values(JSON.parse(readFileSync(join(base, 'docker-home', 'state.json'), 'utf8')).containers as Record<string, { args: string[] }>)[0]!.args;
  assert.deepEqual(started.slice(started.indexOf(pin)), [pin, '-c', 'max_connections=300'], 'Postgres starts with the run\'s max_connections');
  const r = await host.exec(id, 'echo leftover > "$TMPDIR/t"; echo cached > "$HOME/h"; mkdir -p node_modules/x && echo 1 > node_modules/x/y; echo ok', runEnv({}, {}, db), 30_000);
  assert.equal(r.code, 0, r.out);
  const dockerHome = join(base, 'docker-home', 'state.json');
  assert.equal(Object.keys(JSON.parse(readFileSync(dockerHome, 'utf8')).containers).length, 1);
  const ports = await host.shared('ports');
  writeFileSync(join(ports, '5433'), id);
  await wipeWorkspace(host, id);
  assert.ok(!existsSync(join(base, 'runs', id)), 'workspace, temp and home gone');
  assert.equal(readFileSync(join(ports, '5433'), 'utf8'), id, 'the shared port registry is outside the run and stays');
  assert.deepEqual(readdirSync(join(base, 'runs')), []);
  assert.deepEqual(JSON.parse(readFileSync(dockerHome, 'utf8')).containers, {}, 'its database is gone');
  // A wipe that can't remove something says what is left, and wipeWorkspace refuses to call it done.
  const stuck = { ...host, wipe: async () => ({ ok: false, left: ['container x'] }) };
  await assert.rejects(wipeWorkspace(stuck, id), /was not wiped: container x/);
  rmSync(base, { recursive: true, force: true });
});

test('isolation: two runs at once get their own database, by a unique name and a port the daemon picks', { skip: !posix && 'a POSIX shell for the stand-in docker' }, async () => {
  const p = project();
  const base = mkdtempSync(join(tmpdir(), 'tr-host-'));
  const docker = fakeDocker();
  const host = localHost(base, { docker: docker.bin });
  const ids = [newRunId('fast', p.sha), newRunId('fast', p.sha)];
  assert.notEqual(ids[0], ids[1], 'two runs of one commit never share an id');
  await Promise.all(ids.map((id) => createWorkspace(host, p.dir, p.sha, id)));
  const dbs = await Promise.all(ids.map((id) => host.startDb(id, { image: pin, name: 'test', readyS: 5, maxConnections: 200 })));
  assert.notEqual(dbs[0]!.port, dbs[1]!.port);
  assert.notEqual(dbs[0]!.container, dbs[1]!.container);
  const seen = await Promise.all(ids.map((id, i) => host.exec(id, 'printf %s "$DATABASE_URL"', runEnv({}, {}, dbs[i]!), 30_000)));
  assert.deepEqual(seen.map((s) => new URL(s.out).port), dbs.map((d) => String(d.port)), 'each run sees its own database in DATABASE_URL');
  assert.notEqual(new URL(seen[0]!.out).password, new URL(seen[1]!.out).password, 'and its own password');
  for (const id of ids) await wipeWorkspace(host, id);
  // The sandbox helper starts it the same way: loopback, no fixed host port, a name with the run's id.
  const helper = readFileSync(helperSrc, 'utf8');
  assert.match(helper, /c="worklane-test-\$name-\$id"/);
  assert.match(helper, /-p 127\.0\.0\.1::5432 /);
  assert.doesNotMatch(helper, /-p [0-9.]*:\d+:5432/);
  rmSync(base, { recursive: true, force: true });
});

test('isolation: no secret or credential variable of the coordinator\'s reaches a run', { skip: !posix && 'POSIX env' }, async () => {
  const p = project();
  const base = mkdtempSync(join(tmpdir(), 'tr-host-'));
  const host = localHost(base, { docker: '/nonexistent/docker' });
  const id = newRunId('fast', p.sha);
  await createWorkspace(host, p.dir, p.sha, id);
  const planted = { GITHUB_TOKEN: 'ghs_planted', GH_TOKEN: 'gho_planted', ANTHROPIC_API_KEY: 'sk-ant-planted', AWS_SECRET_ACCESS_KEY: 'planted', WORKLANE_APP_KEY: 'planted', SSH_AUTH_SOCK: '/planted', NPM_TOKEN: 'planted' };
  const saved = { ...process.env };
  Object.assign(process.env, planted);
  try {
    // Even a project env or cache map that names them (the config refuses that already) can't pass them on.
    const env = runEnv({ CI_WORKERS: '4', GITHUB_TOKEN: 'x', NPM_TOKEN: 'y' }, { npm_config_cache: '/c', GH_TOKEN: 'z' }, null);
    assert.deepEqual(Object.keys(env).sort(), ['CI_WORKERS', 'npm_config_cache']);
    const r = await host.exec(id, 'env', env, 30_000);
    assert.equal(r.code, 0, r.out);
    const names = r.out.split('\n').map((l) => l.split('=')[0]);
    for (const k of Object.keys(planted)) assert.ok(!names.includes(k), `${k} reached the run`);
    assert.doesNotMatch(r.out, /planted/);
    assert.match(r.out, /^CI_WORKERS=4$/m);
  } finally {
    for (const k of Object.keys(planted)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  await wipeWorkspace(host, id);
  rmSync(base, { recursive: true, force: true });
});

test('the sandbox host calls the helper with sudo -n for its own instance, and passes the run\'s variables on stdin, never in argv', { skip: !posix && 'POSIX sh' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-helper-'));
  const log = join(dir, 'calls');
  const helper = join(dir, 'helper');
  writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncase "$2" in db-start) echo "45678 ${'b'.repeat(32)}" ;; wipe) echo wiped ;; store-tips) printf '%s\\nnot-a-sha\\n%s\\n' ${'c'.repeat(40)} ${'d'.repeat(64)} ;; create) cat > /dev/null; echo /runs/x/work ;; exec) cat > "${log}.exec-stdin"; echo /runs/x/work ;; *) echo /runs/x/work ;; esac\n`);
  chmodSync(helper, 0o755);
  const sudo = join(dir, 'sudo');
  writeFileSync(sudo, '#!/bin/sh\n[ "$1" = -n ] || exit 9\nshift\nexec "$@"\n');
  chmodSync(sudo, 0o755);
  const host = sandboxHost('shop', helper, sudo);
  assert.throws(() => sandboxHost('Shop;x'), /not an instance name/);
  const db = await host.startDb('fast-abc-1', { image: pin, name: 'test', readyS: 5, maxConnections: 250 });
  assert.deepEqual(db, { url: `postgres://postgres:${'b'.repeat(32)}@127.0.0.1:45678/test`, port: 45678, container: 'worklane-test-shop-fast-abc-1' });
  await host.exec('fast-abc-1', 'npm test', { DATABASE_URL: db.url }, 60_000);
  assert.deepEqual(await host.wipe('fast-abc-1'), { ok: true, left: [] });
  await assert.rejects(host.startDb('fast-abc-1', { image: 'postgres:16', name: 'test', readyS: 5, maxConnections: 200 }), /pinned to its digest/);
  await assert.rejects(host.exec('../x', 'id', {}, 1000), /not a run id/);
  // create: the two commits in full, then each directory left out; the store's tips, only full commit ids taken.
  const refs = { branch: 'main', head: 'refs/worklane/test-run/fast-abc-1/head', base: 'refs/worklane/test-run/fast-abc-1/base', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
  assert.deepEqual(await host.create('fast-abc-1', Readable.from([]), { ...refs, exclude: ['docs/design', 'art'] }), { workdir: '/runs/x/work' });
  assert.deepEqual(await host.storeTips(), ['c'.repeat(40), 'd'.repeat(64)]);
  for (const [bad, why] of [[{ exclude: ['../x'] }, /a directory inside the repo/], [{ exclude: ['-rf'] }, /a directory inside the repo/], [{ headSha: 'HEAD' }, /not full commit ids/], [{ baseSha: 'a'.repeat(39) }, /not full commit ids/], [{ exclude: Array.from({ length: 33 }, (_, i) => `d${i}`) }, /at most 32/]] as const) {
    await assert.rejects(host.create('fast-abc-1', Readable.from([]), { ...refs, exclude: [] as readonly string[], ...(bad as object) }), why);
  }
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
    `shop db-start fast-abc-1 ${pin} test 5 250`,
    'shop exec fast-abc-1 60 -- npm test',
    'shop wipe fast-abc-1',
    `shop create fast-abc-1 main refs/worklane/test-run/fast-abc-1/head refs/worklane/test-run/fast-abc-1/base ${'a'.repeat(40)} ${'b'.repeat(40)} docs/design art`,
    'shop store-tips',
  ]);
  // The run's variables (the database password in DATABASE_URL) went on stdin, NUL-ended, and in no argv.
  assert.equal(readFileSync(`${log}.exec-stdin`, 'utf8'), `DATABASE_URL=${db.url}\0`);
  assert.ok(!readFileSync(log, 'utf8').includes(db.url) && !readFileSync(log, 'utf8').includes('postgres://'), 'no URL, so no password, in any argv');
  rmSync(dir, { recursive: true, force: true });
});

/** The example project with history: a commit on main, then a PR head on a branch. */
function projectWithHead() {
  const p = exampleProject();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: p.dir, encoding: 'utf8' }).trim();
  const main = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(p.dir, 'feature.txt'), 'the change\n');
  git('add', 'feature.txt');
  git('commit', '-q', '-m', 'the change');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  return { ...p, git, main, head };
}

/** Everything about a repo a run could change: its refs, config, objects and files. */
function repoState(dir: string) {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  return { refs: git('for-each-ref', '--format=%(refname) %(objectname)'), config: readFileSync(join(dir, '.git', 'config'), 'utf8'), objects: git('count-objects', '-v'), status: git('status', '--porcelain'), files: readdirSync(join(dir, '.git')).sort().join(',') };
}

test('a run\'s workspace is a git clone of its own: the head checked out, main and origin/main present, git log main works', { skip: !posix && 'POSIX shell' }, async () => {
  const p = projectWithHead();
  const host = localHost(mkdtempSync(join(tmpdir(), 'tr-git-')), { docker: '/nonexistent/docker' });
  const id = newRunId('fast', p.head);
  const ws = await createWorkspace(host, p.dir, p.head, id);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: ws.workdir, encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), p.head);
  assert.equal(git('rev-parse', 'main'), p.main);
  assert.equal(git('rev-parse', 'origin/main'), p.main);
  assert.match(git('log', '--format=%s', 'main'), /init/);
  assert.deepEqual(git('diff', '--name-only', 'origin/main...HEAD').split('\n'), ['feature.txt']);
  assert.equal(git('status', '--porcelain'), '', 'a clean checkout');
  assert.ok(!existsSync(join(ws.workdir, '..', 'tree.bundle')), 'the bundle is removed once cloned');
  // The run sees it the same way.
  const r = await host.exec(id, 'git log --oneline main | wc -l && git rev-parse --abbrev-ref origin/HEAD', {}, 30_000);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /origin\/main/);
  await wipeWorkspace(host, id);
  assert.ok(!existsSync(ws.workdir));
});

test('isolation: the workspace\'s git has no remote, no credential helper, no hooks, no alternates, nothing of the coordinator\'s config', { skip: !posix && 'POSIX shell' }, async () => {
  const p = projectWithHead();
  // The coordinator's clone has a remote with a credential helper and hooks: none of it may reach a run.
  p.git('remote', 'add', 'origin', 'https://github.com/example-org/example-shop.git');
  p.git('config', 'credential.helper', '!/usr/local/bin/harness git-credential');
  p.git('config', 'core.hooksPath', '.githooks');
  p.git('update-ref', 'refs/remotes/origin/main', p.main);
  const hostBase = mkdtempSync(join(tmpdir(), 'tr-git-'));
  const host = localHost(hostBase, { docker: '/nonexistent/docker' });
  const id = newRunId('fast', p.head);
  const ws = await createWorkspace(host, p.dir, p.head, id);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: ws.workdir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  assert.equal(git('remote'), '', 'no remote');
  const config = readFileSync(join(ws.workdir, '.git', 'config'), 'utf8');
  assert.doesNotMatch(config, /\[remote|url\s*=|github\.com|git-credential|\.githooks/);
  assert.equal(git('config', '--get', 'credential.helper'), '', 'the credential helper is set empty');
  assert.equal(git('config', '--get', 'core.hooksPath'), '/dev/null');
  const alternates = readFileSync(join(ws.workdir, '.git', 'objects', 'info', 'alternates'), 'utf8');
  assert.equal(alternates, `${join(hostBase, 'store', 'objects')}\n`, 'the one alternate is the host\'s own object store');
  assert.ok(!alternates.includes(p.dir), 'never the coordinator\'s objects');
  assert.equal(spawnSync('git', ['-C', join(hostBase, 'store'), 'remote'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout, '', 'the store has no remote either');
  assert.ok(statSync(join(ws.workdir, '.git')).isDirectory(), 'its own .git, not a worktree link into the coordinator\'s');
  assert.equal(git('rev-parse', 'origin/main'), p.main);
  await wipeWorkspace(host, id);
});

test('isolation: the coordinator\'s repo is unchanged after a run that tries to write to it', { skip: !posix && 'POSIX shell' }, async () => {
  const p = projectWithHead();
  p.git('remote', 'add', 'origin', p.dir);
  const before = repoState(p.dir);
  const host = localHost(mkdtempSync(join(tmpdir(), 'tr-git-')), { docker: '/nonexistent/docker' });
  const id = newRunId('fast', p.head);
  await createWorkspace(host, p.dir, p.head, id);
  // Everything a run could try from its workspace's git: push to whatever remote it has, write through
  // alternates or a worktree's gitdir link, commit and move refs locally.
  const attack = [
    'set +e',
    'git -c user.name=x -c user.email=x@x commit -q --allow-empty -m evil',
    'git push -q origin HEAD:refs/heads/evil 2>/dev/null',
    'for r in $(git remote); do git push -q "$r" HEAD:refs/heads/evil; done 2>/dev/null',
    'if [ -f .git/objects/info/alternates ]; then while read -r d; do echo evil > "$d/evil"; done < .git/objects/info/alternates; fi',
    'if [ -f .git ]; then d=$(sed -n "s/^gitdir: //p" .git); git --git-dir="$d" update-ref refs/heads/evil HEAD; fi',
    'git update-ref refs/heads/main HEAD',
    'exit 0',
  ].join('\n');
  const r = await host.exec(id, attack, {}, 60_000);
  assert.equal(r.code, 0, r.out);
  await wipeWorkspace(host, id);
  assert.deepEqual(repoState(p.dir), before, 'refs, config, objects and files as they were, and the run\'s temporary bundle refs gone');
});

test('the sandbox helper clones exactly as the engine does', () => {
  const helper = readFileSync(helperSrc, 'utf8');
  const clone = /^CLONE='([\s\S]*?)'$/m.exec(helper)?.[1];
  assert.equal(clone, cloneScript());
  assert.match(helper, /\[ "\$head" = "refs\/worklane\/test-run\/\$id\/head" \] && \[ "\$base" = "refs\/worklane\/test-run\/\$id\/base" \]/);
  assert.match(helper, /runuser -u "\$user" -- env -i PATH=[^ ]+ HOME="\$d\/home" LANG=C\.UTF-8 bash -c "\$CLONE" _ "\$d\/tree\.bundle" "\$d\/work" "\$branch" "\$head" "\$base" "\$hsha" "\$bsha" "\$store" "\$@"/, 'as the test user, with nothing of the caller\'s environment');
  // The store is the test user's own, 0700, under the instance's state; a run's exec can write only its own directory,
  // the caches and the shared directories, so never the store.
  assert.match(helper, /install -d -o "\$user" -g "\$user" -m 0700 "\$store"/);
  const exec = helper.slice(helper.indexOf('exec_run() {'), helper.indexOf('\n}\n', helper.indexOf('exec_run() {')));
  assert.match(exec, /-p ProtectSystem=strict/);
  assert.deepEqual([...exec.matchAll(/ReadWritePaths=("?)([^"\s]+)/g)].map((m) => m[2]), ['$d', '$t', '-$root/cache'], 'its directory and its own TMPDIR');
  assert.ok(exec.includes('"ReadWritePaths=-$root/cache -$root/shared"'));
  assert.doesNotMatch(exec, /store/);
  // The check's sandbox probe: systemd-run expands ${...} in its command itself (as ExecStart= does), so the probe has
  // none, and it checks the store it found is the instance's own (an empty path would make the write test vacuous).
  const probe = helper.slice(helper.indexOf('out="$(exec_run "$id" 60 --'), helper.indexOf('\n', helper.indexOf('out="$(exec_run "$id" 60 --')));
  assert.doesNotMatch(probe, /\$\{/);
  assert.ok(probe.includes(`[ "$s" = "'"$store"'" ] || { echo "not the store: $s"; n=1; }`));
});

/** A host that records how many bytes each run's bundle had, passing the bundle on unchanged. */
function measured(host: RunHost) {
  const bytes: number[] = [];
  const wrapped: RunHost = {
    ...host,
    async create(id, bundle, refs) {
      const chunks: Buffer[] = [];
      for await (const c of bundle) chunks.push(Buffer.from(c as Buffer));
      const all = Buffer.concat(chunks);
      bytes.push(all.length);
      return host.create(id, Readable.from(all.length ? [all] : []), refs);
    },
  };
  return { host: wrapped, bytes };
}

test('the object store: the first run takes every object, a run of a commit the store has takes none, a new commit takes only its own', { skip: !posix && 'POSIX shell' }, async () => {
  const p = projectWithHead();
  // Some history worth not sending twice: a large file on main.
  writeFileSync(join(p.dir, 'big.bin'), randomBytes(400_000));
  p.git('add', 'big.bin');
  p.git('commit', '-q', '-m', 'big');
  const main = p.git('rev-parse', 'HEAD');
  p.git('checkout', '-q', 'feature');
  p.git('merge', '-q', '--no-edit', 'main');
  const head = p.git('rev-parse', 'HEAD');
  p.git('checkout', '-q', 'main');
  const base = mkdtempSync(join(tmpdir(), 'tr-store-'));
  const m = measured(localHost(base, { docker: '/nonexistent/docker' }));
  const look = async (id: string, want: string) => {
    const g = (...a: string[]) => execFileSync('git', a, { cwd: join(base, 'runs', id, 'work'), encoding: 'utf8' }).trim();
    assert.equal(g('rev-parse', 'HEAD'), want);
    assert.equal(g('rev-parse', 'main'), main);
    assert.equal(g('rev-parse', 'origin/main'), main);
    assert.equal(g('status', '--porcelain'), '', 'a clean checkout');
    assert.match(g('log', '--format=%s', 'main'), /big[\s\S]*init/, 'the whole history');
    assert.equal(g('merge-base', 'HEAD', 'origin/main'), main);
    assert.equal(readFileSync(join(base, 'runs', id, 'work', 'big.bin')).length, 400_000);
  };
  const ids = [newRunId('fast', head), newRunId('fast', head)];
  const first = await createWorkspace(m.host, p.dir, head, ids[0]!);
  assert.equal(first.bundleRefs, 2);
  assert.ok(m.bytes[0]! > 300_000, `the first bundle carries the history (${m.bytes[0]} bytes)`);
  await look(ids[0]!, head);
  await wipeWorkspace(m.host, ids[0]!);
  // The same commit again, after the first run is wiped: the store kept everything, so nothing is sent.
  const again = await createWorkspace(m.host, p.dir, head, ids[1]!);
  assert.deepEqual([again.bundleRefs, m.bytes[1]], [0, 0]);
  await look(ids[1]!, head);
  // A new commit on the PR: only its own objects.
  p.git('checkout', '-q', 'feature');
  writeFileSync(join(p.dir, 'feature.txt'), 'the change, again\n');
  p.git('commit', '-q', '-am', 'again');
  const next = p.git('rev-parse', 'HEAD');
  p.git('checkout', '-q', 'main');
  const id3 = newRunId('fast', next);
  const third = await createWorkspace(m.host, p.dir, next, id3);
  assert.equal(third.bundleRefs, 1, 'main is in the store already');
  assert.ok(m.bytes[2]! < 5_000, `only the new commit's objects (${m.bytes[2]} bytes)`);
  await look(id3, next);
  const r = await m.host.exec(id3, 'git diff --name-only origin/main...HEAD && git log --oneline -3 | wc -l', {}, 30_000);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^feature\.txt$/m);
  // Both runs read one store at once; wiping one leaves the other's checkout whole.
  await wipeWorkspace(m.host, ids[1]!);
  await look(id3, next);
  assert.deepEqual(new Set(await m.host.storeTips()), new Set([head, main, next]));
  await wipeWorkspace(m.host, id3);
  assert.deepEqual(readdirSync(join(base, 'runs')), []);
  assert.ok(existsSync(join(base, 'store', 'HEAD')), 'the store outlives the runs');
  rmSync(base, { recursive: true, force: true });
});

test('the object store: runs that start at once on a new instance all get their workspace (one makes the store, the others wait for it)', { skip: !posix && 'POSIX shell' }, async () => {
  const p = projectWithHead();
  const base = mkdtempSync(join(tmpdir(), 'tr-store-'));
  const host = localHost(base, { docker: '/nonexistent/docker' });
  const ids = Array.from({ length: 4 }, () => newRunId('fast', p.head));
  const made = await Promise.all(ids.map((id) => createWorkspace(host, p.dir, p.head, id)));
  for (const ws of made) assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws.workdir, encoding: 'utf8' }).trim(), p.head);
  for (const id of ids) await wipeWorkspace(host, id);
  rmSync(base, { recursive: true, force: true });
});

test('the object store: a run still gets its commit when the store\'s tips are unknown here or the store can\'t be read', { skip: !posix && 'POSIX shell' }, async () => {
  const p = projectWithHead();
  const base = mkdtempSync(join(tmpdir(), 'tr-store-'));
  const host = localHost(base, { docker: '/nonexistent/docker' });
  // Tips this repo never had (another project's, a rewritten history): ignored, a full bundle sent.
  const strange: RunHost = { ...host, storeTips: async () => ['f'.repeat(40), 'not a sha'] };
  const a = await createWorkspace(strange, p.dir, p.head, newRunId('fast', p.head));
  assert.equal(a.bundleRefs, 2);
  const broken: RunHost = { ...host, storeTips: async () => Promise.reject(new Error('store unreadable')) };
  const b = await createWorkspace(broken, p.dir, p.head, newRunId('fast', p.head));
  assert.equal(b.bundleRefs, 2);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: b.workdir, encoding: 'utf8' }).trim(), p.head);
  // A store that says it has the commits but doesn't: the run fails, saying so, and is wiped like any other.
  const emptyBase = mkdtempSync(join(tmpdir(), 'tr-store-'));
  const empty = localHost(emptyBase, { docker: '/nonexistent/docker' });
  const lying: RunHost = { ...empty, storeTips: async () => [p.head, p.main] };
  const id = newRunId('fast', p.head);
  await assert.rejects(createWorkspace(lying, p.dir, p.head, id), /the object store has no commit/);
  await wipeWorkspace(empty, id);
  assert.equal(execFileSync('git', ['-C', p.dir, 'for-each-ref', 'refs/worklane/'], { encoding: 'utf8' }), '', 'no temporary refs left in the coordinator\'s clone');
  rmSync(base, { recursive: true, force: true });
  rmSync(emptyBase, { recursive: true, force: true });
});

test('sparse_exclude in a run: the workspace leaves those directories out, unless a tier of the run sets full_checkout', { skip: !posix && 'POSIX shell' }, async () => {
  const p = projectWithHead();
  for (const f of ['docs/design/shot.png', 'art/games.json', 'web/public/assets/logo.png', 'assets/big.zip']) {
    mkdirSync(join(p.dir, f, '..'), { recursive: true });
    writeFileSync(join(p.dir, f), 'x\n');
  }
  p.git('add', '-A');
  p.git('commit', '-q', '-m', 'binaries');
  const sha = p.git('rev-parse', 'HEAD');
  const host = localHost(mkdtempSync(join(tmpdir(), 'tr-sparse-')), { docker: '/nonexistent/docker' });
  const id = newRunId('fast', sha);
  const ws = await createWorkspace(host, p.dir, sha, id, ['docs/design', 'assets']);
  assert.ok(!existsSync(join(ws.workdir, 'docs', 'design')) && !existsSync(join(ws.workdir, 'assets')));
  assert.ok(existsSync(join(ws.workdir, 'art', 'games.json')) && existsSync(join(ws.workdir, 'web', 'public', 'assets', 'logo.png')));
  const r = await host.exec(id, 'git status --porcelain && git ls-tree -r --name-only HEAD | grep -c "^docs/design/"', {}, 30_000);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.trim(), '1', 'nothing shows as deleted, and the commit still has them');
  await wipeWorkspace(host, id);
  // The run's tiers decide: one that needs everything gets everything, for the whole run.
  const tier = (o: object) => TestRunConfig.parse({ tiers: [{ name: 't', command: 'x', kind: 'fast', ...o }] }).tiers[0]!;
  assert.equal(tier({}).full_checkout, false);
  assert.deepEqual(workspaceExclude([tier({}), tier({ name: 'u' })], ['art']), ['art']);
  assert.deepEqual(workspaceExclude([tier({}), tier({ name: 'u', full_checkout: true })], ['art']), []);
  assert.deepEqual(workspaceExclude([tier({})]), []);
  const full = newRunId('fast', sha);
  const ws2 = await createWorkspace(host, p.dir, sha, full, workspaceExclude([tier({ full_checkout: true })], ['docs/design']));
  assert.ok(existsSync(join(ws2.workdir, 'docs', 'design', 'shot.png')));
  await wipeWorkspace(host, full);
  // The host refuses a directory the config would have refused, before anything runs.
  await assert.rejects(createWorkspace(host, p.dir, sha, newRunId('fast', sha), ['../up']), /a directory inside the repo/);
});

test('regression: a run\'s ${...} is bash\'s, never systemd-run\'s (--expand-environment=no on 254+, each $ as $$ before)', { skip: !posix && 'bash' }, () => {
  const cmd = 'x=hello; echo "got ${x} ${x%lo} $x"';
  // What systemd does with the command line when it expands: $$ is a literal $, ${NAME} and $NAME (a word of its own)
  // its environment's (none of these is set there).
  const systemdExpands = (s: string) => s.replace(/\$\$|\$\{[^}]*\}/g, (m) => (m === '$$' ? '$' : ''));
  const lines = (r: ReturnType<typeof helperFn>) => r.stdout.replace(/accepted\n$/, '').split('\n');
  const bash = (c: string) => spawnSync('bash', ['-c', c], { encoding: 'utf8' }).stdout.trim();
  assert.equal(bash(systemdExpands(cmd)), 'got   hello', 'the bug: systemd blanks the shell-only ${x} forms');
  for (const v of ['254', '255', '258']) {
    const [flag, ...rest] = lines(helperFn('systemd_command', v, cmd));
    assert.equal(flag, '--expand-environment=no', v);
    assert.equal(rest.join('\n'), cmd, `${v}: the command as written`);
  }
  for (const v of ['253', '249', '0']) {
    const [flag, ...rest] = lines(helperFn('systemd_command', v, cmd));
    assert.equal(flag, '', `${v}: no flag (older systemd-run has none)`);
    assert.equal(bash(systemdExpands(rest.join('\n'))), 'got hello hel hello', `${v}: after systemd's own expansion, bash gets the command as written`);
  }
  assert.equal(helperFn('systemd_command', '25x', cmd).status, 2);
  const src = readFileSync(helperSrc, 'utf8');
  const exec = src.slice(src.indexOf('exec_run() {'), src.indexOf('\n}\n', src.indexOf('exec_run() {')));
  assert.ok(exec.includes('cmd="$(systemd_command "$(systemd_version)" "$2")"'));
  assert.ok(exec.includes('  local -a run=(systemd-run --wait --pipe --collect ${noexpand[@]+"${noexpand[@]}"}'));
  assert.ok(exec.includes('    /bin/bash -o pipefail -c "$cmd")\n'), 'the command goes as systemd_command made it');
  // Run as built, on both paths (a GPU command's in the background, so a TERM can stop its unit first).
  assert.ok(exec.includes('    "${run[@]}" || rc=$?\n') && exec.includes('    "${run[@]}" &\n'));
});

test('a directory left out: the helper takes exactly what the engine\'s config takes', { skip: !posix && 'bash' }, () => {
  const cases = ['docs/design', 'art', 'assets', 'a.b/c_d@e+f-g', 'x'.repeat(200), 'x'.repeat(201), '../up', '/abs', 'a/../b', 'a//b', '.', './a', 'a/.', 'docs/*', 'my dir', '-x', '.git', '.git/hooks', '.github', "it's", 'a\\b', 'a;b', '$(id)', ''];
  for (const c of cases) {
    const engine = sparseDirProblem(c) === null;
    const r = helperFn('valid_dir', c);
    assert.equal(r.status === 0 && /accepted/.test(r.stdout), engine, `${JSON.stringify(c)}: engine ${engine ? 'takes' : 'refuses'} it, the helper ${r.status === 0 ? 'takes' : 'refuses'} it`);
  }
});

/** The PATH the helper exports for itself (its first `export PATH=` line). */
const helperPath = () => /^export PATH=(\S+)$/m.exec(readFileSync(helperSrc, 'utf8'))?.[1]?.split(':') ?? [];

test('regression: the helper finds runuser with a minimal caller PATH (runuser is in /usr/sbin on Ubuntu)', { skip: !posix && 'bash' }, () => {
  // Its PATH used to be /usr/local/bin:/usr/bin:/bin, so on the server every probe failed with "runuser: command not found".
  const path = helperPath();
  for (const dir of ['/usr/sbin', '/sbin', '/usr/bin', '/bin']) assert.ok(path.includes(dir), `the helper's PATH has ${dir}: ${path.join(':')}`);
  const runuser = ['/usr/sbin/runuser', '/sbin/runuser', '/usr/bin/runuser'].find((p) => existsSync(p));
  if (!runuser) return; // not on this machine (macOS); the PATH check above still holds
  const r = spawnSync('bash', [helperSrc, 'shop', 'check'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.doesNotMatch(r.stderr, /missing tool|command not found/, r.stderr);
  assert.match(r.stderr, /no user wl-test-shop/, 'it got past the tool check to the user check');
});

test('a tool the helper needs that isn\'t there is one clear "missing tool" line, before any probe', { skip: !posix && 'bash' }, () => {
  const empty = mkdtempSync(join(tmpdir(), 'no-tools-'));
  const copy = join(empty, 'worklane-testrun');
  writeFileSync(copy, readFileSync(helperSrc, 'utf8').replace(/^export PATH=\S+$/m, `export PATH=${empty}`));
  const r = spawnSync('/bin/bash', [copy, 'shop', 'check'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^worklane-testrun: missing tool: runuser \(PATH=/m);
  assert.doesNotMatch(r.stderr, /probe did not run/);
  rmSync(empty, { recursive: true, force: true });
});

test('test-user.sh sets its own PATH with the sbin directories, and checks the sbin tools it needs', { skip: !posix && 'bash' }, () => {
  const sh = readFileSync(join(setup, 'test-user.sh'), 'utf8');
  const path = /^export PATH=(\S+)$/m.exec(sh)?.[1]?.split(':') ?? [];
  for (const dir of ['/usr/sbin', '/sbin', '/usr/bin', '/bin']) assert.ok(path.includes(dir), `test-user.sh PATH has ${dir}`);
  const need = [...sh.matchAll(/^\s*need_tools (.+)$/gm)].flatMap((m) => m[1]!.split(/\s+/));
  for (const t of ['runuser', 'systemd-run', 'useradd', 'usermod', 'setfacl', 'sysctl', 'iptables', 'ip', 'newuidmap', 'slirp4netns', 'systemctl']) assert.ok(need.includes(t), `test-user.sh checks for ${t}`);
});

test('regression: an instance\'s state dir and its runs are root:<its test user> 0710, so other instances\' test users can\'t enter them', { skip: !posix && 'bash' }, () => {
  // They were root:root 0711: any test user could traverse into another instance's /var/lib/worklane-test/<name>.
  const sh = readFileSync(join(setup, 'test-user.sh'), 'utf8');
  const helper = readFileSync(helperSrc, 'utf8');
  assert.match(sh, /install -d -o root -g root -m 0711 \/var\/lib\/worklane-test\n/, 'the base stays 0711');
  assert.match(sh, /install -d -o root -g "\$user" -m 0710 "\$root" "\$root\/runs"/);
  assert.match(sh, /chown root:"\$user" "\$root" "\$root\/runs"; chmod 0710 "\$root" "\$root\/runs"/, 're-running install fixes old 0711 directories');
  assert.match(helper, /install -d -o root -g "\$user" -m 0710 "\$root\/runs"/);
  assert.doesNotMatch(sh + helper, /-m 0711 "\$root/, 'no state dir is 0711 any more');
});

test('regression: install restarts the test Docker unit when its unit changed or it runs in the old cgroup layout, never under a run', { skip: !posix && 'bash' }, () => {
  // enable --now left an already-running dockerd in the old layout after #247, and check failed until a manual restart.
  const sh = readFileSync(join(setup, 'test-user.sh'), 'utf8');
  const install = sh.slice(sh.indexOf('install_cmd() {'), sh.indexOf('\n}\n', sh.indexOf('install_cmd() {')));
  assert.match(sh, /if cmp -s "\$tmp" "\/etc\/systemd\/system\/\$file"; then put_changed=0; else put_changed=1; fi/, 'put knows whether a unit changed');
  assert.match(install, /docker_changed="\$put_changed"/);
  assert.match(install, /\[ "\$docker_changed" = 1 \] \|\| ! docker_layout_ok/, 'a changed unit, or a daemon outside <unit>\/daemon, means a restart');
  assert.match(install, /busy="\$\(active_runs\)"[\s\S]*?test runs of \$name are in progress[\s\S]*?exit 1[\s\S]*?systemctl restart "\$docker_unit_name"/, 'it refuses while runs are in progress, and restarts otherwise');
});

test('regression: test_run.database.max_connections is an integer of 20 to 2000, 200 by default (the image\'s 100 ran out at 22 lanes)', () => {
  // A full run of 22 lanes, each with a pool of 8 plus its ORM's own connections, hit "sorry, too many clients already".
  assert.equal(TestRunConfig.parse(baseTestRun).database?.max_connections, 200);
  assert.deepEqual(MAX_CONNECTIONS, { min: 20, max: 2000, default: 200 });
  for (const n of [20, 250, 2000]) assert.equal(TestRunConfig.parse({ ...baseTestRun, database: { image: pin, max_connections: n } }).database?.max_connections, n);
  for (const n of [19, 2001, 0, -5, 250.5, '250', null]) {
    assert.equal(TestRunConfig.safeParse({ ...baseTestRun, database: { image: pin, max_connections: n } }).success, false, `max_connections ${JSON.stringify(n)} is refused`);
  }
});

/** The sandbox helper, runnable here: its tools stubbed, its paths in a temp dir, a stand-in docker that logs each call. */
async function helperWithStubs() {
  const dir = mkdtempSync(join(tmpdir(), 'tr-dbs-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  for (const t of ['systemd-run', 'systemctl', 'git', 'getent', 'install', 'stat', 'id', 'sha256sum', 'cut', 'mkdir', 'chown']) stub(t, 'exit 0');
  stub('runuser', 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  for (const t of ['od', 'tr', 'seq', 'sed', 'head', 'sleep', 'env', 'cat', 'rm', 'sh']) {
    const real = ['/usr/bin', '/bin'].map((d) => join(d, t)).find((p) => existsSync(p));
    if (real) symlinkSync(real, join(bin, t));
  }
  const log = join(dir, 'docker.log');
  const docker = join(dir, 'docker');
  writeFileSync(docker, `#!/bin/bash\nprintf '%s\\n' "$*" >> "${log}"\ncase "$1" in run) echo cid ;; port) echo 127.0.0.1:45678 ;; esac\nexit 0\n`);
  chmodSync(docker, 0o755);
  const base = join(dir, 'base');
  mkdirSync(join(base, 'shop', 'runs', 'fast-abc-1'), { recursive: true });
  const sock = join(dir, 's');
  mkdirSync(sock);
  const server = createServer();
  await new Promise<void>((res) => server.listen(join(sock, 'docker.sock'), res));
  const helper = join(dir, 'worklane-testrun');
  let src = readFileSync(helperSrc, 'utf8');
  for (const [re, to] of [
    [/^export PATH=\S+$/m, `export PATH=${bin}`],
    [/^BASE=\S+$/m, `BASE=${base}`],
    [/^DOCKER=\S+$/m, `DOCKER=${docker}`],
    [/^sock_dir=.*$/m, `sock_dir=${sock}`],
  ] as const) {
    assert.match(src, re);
    src = src.replace(re, to);
  }
  writeFileSync(helper, src);
  const dbStart = (...a: string[]) => spawnSync('/bin/bash', [helper, 'shop', 'db-start', 'fast-abc-1', pin, 'test', '5', ...a], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const done = () => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dbStart, calls, done };
}

test('regression: the helper\'s db-start takes max_connections as a number of 20 to 2000 only, and refuses anything else before Docker', { skip: !posix && 'bash' }, async () => {
  const h = await helperWithStubs();
  try {
    for (const bad of ['19', '2001', '0', '020', '99999', '-50', '250.5', '2e2', '250 ', ' 250', '250;id', '$(id)', 'max', '']) {
      const r = h.dbStart(bad);
      assert.equal(r.status, 2, `${JSON.stringify(bad)}: ${r.stderr}`);
      assert.match(r.stderr, /max_connections: 20 to 2000, got/, JSON.stringify(bad));
    }
    assert.match(h.dbStart().stderr, /usage: db-start <id> <image@sha256:\.\.\.> <db> <ready_s> <max_connections>/, 'it is required');
    assert.deepEqual(h.calls(), [], 'Docker is never called for a refused value');
    for (const ok of [MAX_CONNECTIONS.min, MAX_CONNECTIONS.max]) {
      const r = h.dbStart(String(ok));
      assert.equal(r.status, 0, `${ok} is in range, as in the schema: ${r.stderr}`);
    }
  } finally {
    h.done();
  }
});

test('regression: the helper starts the run\'s Postgres with -c max_connections=<n>', { skip: !posix && 'bash' }, async () => {
  const h = await helperWithStubs();
  try {
    const r = h.dbStart('250');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^45678 [0-9a-f]{32}$/m);
    const run = h.calls().find((c) => c.startsWith('run '));
    assert.ok(run, h.calls().join('\n'));
    assert.ok(run.endsWith(` ${pin} -c max_connections=250`), run);
  } finally {
    h.done();
  }
});
