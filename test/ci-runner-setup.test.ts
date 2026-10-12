import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setup = join(repoRoot, 'scripts', 'setup');
const machine = join(repoRoot, 'scripts', 'machine');
const script = join(setup, 'ci-runner.sh');
const pin = 'postgres@sha256:' + 'a'.repeat(64);
const print = (...a: string[]) => spawnSync('bash', [script, '--print', 'install', 'example-org/example-shop', ...a], { encoding: 'utf8' });

test('ci-runner.sh --print: the slice caps, a sandboxed one-job runner with the lock hooks, rootless Docker, and no token anywhere', { skip: !posix && 'bash' }, () => {
  const r = print('2', '--name', 'shop', '--cpus', '20-23', '--image', `postgres:16=${pin}`, '--no-lock-jobs', 'verdict,audit');
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  // The slice: a hard CPU cap that matches the CPUs it may use, a memory cap without swap, weights below worklane.slice's 20.
  assert.match(out, /# \/etc\/systemd\/system\/worklane-ci\.slice\n\[Unit\][\s\S]*?\[Slice\]\nCPUWeight=10\nIOWeight=10\nAllowedCPUs=20-23\nCPUQuota=400%\nMemoryMax=5G\nMemorySwapMax=0\n/);
  const runner = out.slice(out.indexOf('# /etc/systemd/system/worklane-ci-shop@.service'), out.indexOf('# /usr/local/libexec/worklane-ci/job-started.sh'));
  const docker = out.slice(out.indexOf('# /etc/systemd/system/worklane-ci-shop-docker@.service'), out.indexOf('# /etc/systemd/system/worklane-ci-shop@.service'));
  for (const line of [
    'User=wl-ci-shop', 'Group=wl-ci-shop', 'Slice=worklane-ci.slice',
    // One job per start, then a reset (as root) before the next: what an ephemeral runner gets.
    'ExecStartPre=+/usr/local/libexec/worklane-ci/reset shop %i', 'ExecStart=/bin/bash /var/lib/worklane-ci/shop/%i/runner/run.sh --once', 'Restart=always', 'KillMode=control-group',
    'Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/libexec/worklane-ci/job-started.sh',
    'Environment=ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/usr/local/libexec/worklane-ci/job-completed.sh',
    'Environment=WORKLANE_CI_LOCK=/run/lock/worklane-full-run.lock', 'Environment=WORKLANE_CI_LOCK_WAIT_MIN=45', 'Environment="WORKLANE_CI_NO_LOCK_JOBS=verdict audit"',
    `Environment="WORKLANE_CI_IMAGES=postgres:16=${pin}"`, 'Environment=PATH=/usr/local/libexec/worklane-ci/bin:/usr/local/bin:/usr/bin:/bin',
    'Environment=DOCKER_HOST=unix:///run/worklane-ci-shop-docker-%i/docker.sock', 'Environment=HOME=/home/runner',
    'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=tmpfs', 'BindPaths=/var/lib/worklane-ci/shop/%i/home:/home/runner', 'PrivateDevices=yes', 'PrivateTmp=yes',
    'InaccessiblePaths=-/srv/worklane -/opt/worklane -/var/lib/worklane -/etc/worklane',
    'BindReadOnlyPaths=/opt/worklane-ci/actions-runner-2.338.0/bin:/var/lib/worklane-ci/shop/%i/runner/bin /opt/worklane-ci/actions-runner-2.338.0/externals:/var/lib/worklane-ci/shop/%i/runner/externals',
  ]) assert.ok(runner.split('\n').includes(line), `runner unit: ${line}`);
  for (const line of ['User=wl-ci-shop', 'Slice=worklane-ci.slice', 'ExecStart=/opt/worklane-ci/docker-29.8.2/dockerd-rootless.sh --data-root /var/lib/worklane-ci/shop/%i/docker --ip 127.0.0.1']) assert.ok(docker.split('\n').includes(line), `docker unit: ${line}`);
  assert.doesNotMatch(out, /^(User|Group)=root$|SupplementaryGroups|docker\.sock.*root|AmbientCapabilities/m, 'no root daemon, no extra groups or capabilities');
  // Each runner registers with auto-update off; the token is never an argument.
  for (const i of ['1', '2']) assert.match(out, new RegExp(`^# runner ${i} registers as wl-ci-shop with: config\\.sh --unattended --url https://github\\.com/example-org/example-shop --name \\S+-shop-${i} --labels shop --work /var/lib/worklane-ci/shop/${i}/work --disableupdate --replace \\(the registration token from stdin, in ACTIONS_RUNNER_INPUT_TOKEN\\)$`, 'm'));
  assert.doesNotMatch(out, /--token|--pat\b|ACTIONS_RUNNER_INPUT_TOKEN=\S/);
  // The hooks, the pin wrapper and the reset are printed as they will be installed.
  for (const f of ['worklane-ci-job-hook.sh', 'worklane-ci-docker.sh', 'worklane-ci-reset.sh']) assert.ok(out.includes(readFileSync(join(machine, f), 'utf8')), f);
});

test('ci-runner.sh: the registration token comes in on stdin and goes only into the runner user\'s own environment', () => {
  const sh = readFileSync(script, 'utf8');
  assert.doesNotMatch(sh, /--token\b|set -x|\becho [^\n]*\$token|>>? *[^\n|]*\$token/);
  // Every use of the token: read from stdin, checked, piped (printf is a builtin, so never in an argv), unset.
  const uses = sh.split('\n').filter((l) => /\$token\b|\$\{token/.test(l)).map((l) => l.trim());
  for (const l of uses) assert.match(l, /^IFS= read -r token|^\[ -z "\$token" \] \|\||^\[\[ "\$token" =~|^if \[ -n "\$token" \]|^printf '%s\\n' "\$token" \| run_as "\$user" 'IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN; export ACTIONS_RUNNER_INPUT_TOKEN;/, l);
  assert.match(sh, /if \[ -t 0 \]; then echo "pipe the registration token in/);
  assert.match(sh, /unset token/);
  // Validated with sudo -n sections and the runner's own scripts: no sudoers at all.
  assert.doesNotMatch(sh, /install_sudoers|\/etc\/sudoers\.d\//);
  // Pinned and checked before anything is unpacked.
  assert.match(sh, /^runner_version=\d+\.\d+\.\d+$/m);
  for (const v of ['runner_sha256_x64', 'docker_sha256_x64', 'docker_rootless_sha256_x64']) assert.match(sh, new RegExp(`^${v}=[0-9a-f]{64}$`, 'm'));
  assert.ok(sh.indexOf('sha256sum -c') < sh.indexOf('tar -xzf "$work/runner.tgz"'));
  // The boundaries are checked before anything is registered, and a failed final check stops the runners.
  assert.ok(sh.indexOf('access_checks || { echo "refusing to go on') < sh.indexOf('./config.sh "$@"'));
  assert.match(sh, /if ! check_cmd; then stop_all;/);
});

test('ci-runner.sh refuses bad arguments before doing anything', { skip: !posix && 'bash' }, () => {
  for (const [args, err] of [
    [['1', '--image', 'postgres:16=postgres:16'], /--image: <image>=<name>@sha256/],
    [['0'], /count: 1 to 9/],
    [['1', '--cpus', 'x'], /--cpus: a CPU list/],
    [['1', '--memory-max', '50%'], /--memory-max: a size/],
    [['1', '--cpu-weight', '0'], /weights are 1 to 10000/],
    [['1', '--no-lock-jobs', 'a;b'], /--no-lock-jobs: job ids/],
    [['1', '--name', 'Bad_Name'], /--name: lowercase/],
    [['1', '--bogus'], /unknown option --bogus/],
  ] as const) {
    const r = print(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, err);
  }
  assert.equal(spawnSync('bash', [script, 'install', 'not-a-repo', '1', '--print'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('bash', [script, 'check'], { encoding: 'utf8' }).status, 2);
});

/** A directory with a fake `sudo` first on PATH: it runs the command as this user, fails, or prints junk. */
function fakeSudo(mode: 'run' | 'fail' | 'junk') {
  const dir = mkdtempSync(join(tmpdir(), 'ci-sudo-'));
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
  spawnSync('bash', ['-c', 'source "$1"; shift; deny_check "$@"', '_', join(setup, 'lib.sh'), 'wl-ci-shop', ...paths], { encoding: 'utf8', env: { ...process.env, PATH: `${sudoDir}:/usr/bin:/bin` } });

test('the access checks fail closed: a path the runner user can reach, or a probe that did not run, is a FAIL', { skip: (!posix && 'bash') || (process.getuid?.() === 0 && 'root reads everything') }, () => {
  const d = mkdtempSync(join(tmpdir(), 'ci-protected-'));
  const open = join(d, 'open');
  const closed = join(d, 'closed');
  mkdirSync(open, { mode: 0o755 });
  mkdirSync(closed, { mode: 0o755 });
  chmodSync(closed, 0o000);
  try {
    let r = denyCheck(fakeSudo('run'), closed, join(d, 'missing'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PASS wl-ci-shop can't read, write or enter .*closed$/m);
    r = denyCheck(fakeSudo('run'), closed, open);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^FAIL wl-ci-shop can reach .*open \(open\)$/m);
    // sudo that can't switch, or answers anything but "denied": never read as "denied".
    for (const mode of ['fail', 'junk'] as const) {
      r = denyCheck(fakeSudo(mode), closed);
      assert.equal(r.status, 1, mode);
      assert.match(r.stdout, /^FAIL wl-ci-shop can reach /m, mode);
    }
  } finally {
    chmodSync(closed, 0o755);
    rmSync(d, { recursive: true, force: true });
  }
  // install and check both run these, as the runner user, over every protected path.
  const sh = readFileSync(script, 'utf8');
  assert.match(sh, /deny_acl=\(\/srv\/worklane \/opt\/worklane \/var\/lib\/worklane \/etc\/worklane\)/);
  assert.match(sh, /setfacl -m "u:\$user:---" "\$p"/);
  assert.match(sh, /\[\[ "\$u" == wl-\* && "\$u" != "\$user"/, 'every other wl-* home');
  assert.match(sh, /deny_check "\$user" "\$\{paths\[@\]\}" \|\| fail=1/);
});

const hasFlock = posix && spawnSync('flock', ['--version']).status === 0;

test('the lock hooks: a job holds the full-run lock shared from start to end, waits out an agent\'s exclusive run, and skips it only when named', { skip: !hasFlock && 'needs flock(1) (util-linux)' }, async () => {
  const d = mkdtempSync(join(tmpdir(), 'ci-lock-'));
  const lock = join(d, 'full-run.lock');
  writeFileSync(lock, '');
  const state = join(d, 'state');
  mkdirSync(state);
  for (const n of ['job-started.sh', 'job-completed.sh']) symlinkSync(join(machine, 'worklane-ci-job-hook.sh'), join(d, n));
  const env = (job: string) => ({ ...process.env, WORKLANE_CI_LOCK: lock, WORKLANE_CI_LOCK_WAIT_MIN: '1', WORKLANE_CI_NO_LOCK_JOBS: 'verdict audit', WORKLANE_CI_STATE: state, GITHUB_JOB: job });
  const hook = (n: string, job: string) => spawnSync('bash', [join(d, n)], { encoding: 'utf8', env: env(job), timeout: 70_000 });
  const tryLock = (mode: '-x' | '-s') => spawnSync('flock', ['-n', mode, lock, 'true']).status;
  try {
    // Idle runner: nothing held.
    assert.equal(tryLock('-x'), 0);
    let r = hook('job-started.sh', 'timing');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /holding .* \(shared\) for job timing/);
    // The stand-in job runs: an agent's full run (exclusive) can't start; another CI job (shared) can.
    assert.notEqual(tryLock('-x'), 0, 'an agent full run is kept out while the job runs');
    assert.equal(tryLock('-s'), 0, 'CI jobs do not serialize each other');
    r = hook('job-completed.sh', 'timing');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /released/);
    assert.equal(tryLock('-x'), 0, 'free again once the job is done');
    assert.ok(!existsSync(join(state, 'lock-holder')));

    // A job named in the no-lock list takes nothing.
    r = hook('job-started.sh', 'verdict');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /job verdict doesn't take/);
    assert.equal(tryLock('-x'), 0);
    assert.match(hook('job-completed.sh', 'verdict').stdout, /held no lock/);

    // An agent's full run holds it exclusively: the job waits for it, then holds it.
    const agent = spawn('flock', ['-x', lock, 'sleep', '3']);
    await new Promise((res) => setTimeout(res, 500));
    const t0 = Date.now();
    r = hook('job-started.sh', 'chain');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Date.now() - t0 >= 1500, 'it waited for the agent run');
    assert.notEqual(tryLock('-x'), 0);
    assert.equal(hook('job-completed.sh', 'chain').status, 0);
    agent.kill();

    // No lock file (the machine's locks aren't set up): the job fails rather than runs unlocked.
    rmSync(lock);
    r = hook('job-started.sh', 'timing');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is missing .*not starting job timing/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('the docker wrapper pulls a pinned image by its digest, tags it as the workflow names it, and refuses any other', { skip: !posix && 'bash' }, () => {
  const d = mkdtempSync(join(tmpdir(), 'ci-docker-'));
  const log = join(d, 'log');
  const real = join(d, 'real-docker');
  writeFileSync(real, `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1 $2" = "image inspect" ] && exit 1\nexit 0\n`);
  chmodSync(real, 0o755);
  const run = (...a: string[]) => spawnSync('bash', [join(machine, 'worklane-ci-docker.sh'), ...a], { encoding: 'utf8', env: { ...process.env, WORKLANE_CI_DOCKER: real, WORKLANE_CI_IMAGES: `redis:7=redis@sha256:${'b'.repeat(64)} postgres:16=${pin}` } });
  try {
    let r = run('pull', 'postgres:16');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [`image inspect ${pin}`, `pull -q ${pin}`, `tag ${pin} postgres:16`]);
    writeFileSync(log, '');
    r = run('pull', 'postgres:latest');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a pinned image/);
    assert.equal(readFileSync(log, 'utf8'), '', 'nothing pulled');
    r = run('create', '--name', 'x', 'postgres:16');
    assert.equal(r.status, 0);
    assert.equal(readFileSync(log, 'utf8').trim(), 'create --name x postgres:16');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('the reset removes the last job\'s containers before it remakes the runner, workspace and home', () => {
  const sh = readFileSync(join(machine, 'worklane-ci-reset.sh'), 'utf8');
  const at = (s: string) => sh.indexOf(s);
  assert.ok(at('rm -f -v $ids') > 0 && at('rm -f -v $ids') < at('rm -rf "$base/runner" "$base/work" "$base/home"'));
  assert.match(sh, /bin \| externals\) install -d -o root -g root -m 0755/, 'binaries come only from the read-only binds of the pinned release');
  assert.match(sh, /install -o "\$user" -g "\$user" -m 0600 "\$reg\/\$f"/);
  assert.match(sh, /_tool\/node\/\$v/);
});
