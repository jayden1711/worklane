import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setup = join(repoRoot, 'scripts', 'setup');
const files = join(setup, 'ci-runner');
const script = join(setup, 'ci-runner.sh');
const print = (...a: string[]) => spawnSync('bash', [script, '--print', 'install', 'example-org/example-shop', ...a], { encoding: 'utf8' });

test('ci-runner.sh --print: the slice caps, the firewall, a sandboxed one-job runner with the hooks, rootless Docker, and no token anywhere', { skip: !posix && 'bash' }, () => {
  const r = print('2', '--name', 'shop', '--cpus', '20-23', '--label', 'box', '--no-lock-jobs', 'verdict,audit');
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  const part = (from: string, to: string) => out.slice(out.indexOf(from), out.indexOf(to));
  // The slice: a hard CPU cap that matches the CPUs it may use, a memory cap without swap, weights below worklane.slice's 20.
  assert.match(out, /# \/etc\/systemd\/system\/worklane-ci\.slice\n\[Unit\][\s\S]*?\[Slice\]\nCPUWeight=10\nIOWeight=10\nAllowedCPUs=20-23\nCPUQuota=400%\nMemoryMax=5G\nMemorySwapMax=0\n/);
  // The firewall: only the runner user's packets (a jump on its uid), the DNS stub, then loopback, Tailscale, private,
  // link-local and multicast refused, in that order.
  const fw = part('# /etc/worklane-ci/shop.nft', '# /etc/systemd/system/worklane-ci-shop-firewall.service');
  assert.match(fw, /^ {4}type filter hook output priority filter; policy accept;\n {4}meta skuid <uid> jump ci\n {2}\}$/m, 'nothing but the runner user\'s packets is touched');
  const rules = fw.split('\n').map((l) => l.trim());
  const at = (re: RegExp) => rules.findIndex((l) => re.test(l));
  assert.ok(at(/^ip daddr 127\.0\.0\.53 meta l4proto \{ tcp, udp \} th dport 53 accept/) >= 0);
  const lo = at(/^oifname "lo" counter reject with icmpx admin-prohibited/);
  const ts = at(/^oifname "tailscale0" counter reject with icmpx admin-prohibited$/);
  const v4 = at(/^ip daddr \{ 0\.0\.0\.0\/8, 10\.0\.0\.0\/8, 100\.64\.0\.0\/10, 127\.0\.0\.0\/8, 169\.254\.0\.0\/16, 172\.16\.0\.0\/12, 192\.168\.0\.0\/16, 224\.0\.0\.0\/4, 240\.0\.0\.0\/4 \} counter reject with icmpx admin-prohibited$/);
  const v6 = at(/^ip6 daddr \{ ::\/128, ::1\/128, ::ffff:0:0\/96, fc00::\/7, fe80::\/10, ff00::\/8 \} counter reject with icmpx admin-prohibited$/);
  assert.ok(lo > 0 && ts > lo && v4 > ts && v6 > v4, fw);
  for (const l of rules.slice(0, lo)) if (/accept/.test(l) && !/^type /.test(l)) assert.match(l, /th dport 53 accept/, `only DNS goes through before the refusals: ${l}`);
  const runner = part('# /etc/systemd/system/worklane-ci-shop@.service', '# /usr/local/libexec/worklane-ci/job-started.sh');
  const docker = part('# /etc/systemd/system/worklane-ci-shop-docker@.service', '# /etc/systemd/system/worklane-ci-shop-reset@.service');
  const reset = part('# /etc/systemd/system/worklane-ci-shop-reset@.service', '# /etc/systemd/system/worklane-ci-shop@.service');
  // The reset: as root, with no sandbox (so it sees the real directories, not the runner's binds), before every start.
  for (const line of ['Type=oneshot', 'ExecStart=/usr/local/libexec/worklane-ci/reset shop %i', 'Requires=worklane-ci-shop-docker@%i.service', 'After=worklane-ci-shop-docker@%i.service']) assert.ok(reset.split('\n').includes(line), `reset unit: ${line}`);
  assert.doesNotMatch(reset, /^(User|Protect|Private|ReadWritePaths|Bind|Inaccessible|RemainAfterExit)/m, 'no sandbox, and inactive again once done, so the next start runs it again');
  assert.doesNotMatch(runner, /^ExecStartPre=/m, 'no reset inside the runner\'s own namespace');
  for (const line of [
    'User=wl-ci-shop', 'Group=wl-ci-shop', 'Slice=worklane-ci.slice',
    // Never without the firewall, never without its own Docker.
    'BindsTo=worklane-ci-shop-firewall.service',
    // One job per start, then a reset (as root) before the next: what an ephemeral runner gets.
    'Requires=worklane-ci-shop-docker@%i.service worklane-ci-shop-reset@%i.service',
    'After=network-online.target worklane-ci-shop-firewall.service worklane-ci-shop-docker@%i.service worklane-ci-shop-reset@%i.service',
    'ExecStart=/bin/bash /var/lib/worklane-ci/shop/%i/runner/run.sh --once', 'Restart=always', 'KillMode=control-group',
    'Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/libexec/worklane-ci/job-started.sh',
    'Environment=ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/usr/local/libexec/worklane-ci/job-completed.sh',
    'Environment=WORKLANE_CI_REPO=example-org/example-shop', 'Environment=WORKLANE_CI_BRANCH=main',
    'Environment=WORKLANE_CI_LOCK=/run/lock/worklane-full-run.lock', 'Environment=WORKLANE_CI_LOCK_WAIT_MIN=45', 'Environment="WORKLANE_CI_NO_LOCK_JOBS=verdict audit"',
    'Environment=PATH=/opt/worklane-ci/docker-29.8.2:/usr/local/bin:/usr/bin:/bin',
    'Environment=DOCKER_HOST=unix:///run/worklane-ci-shop-docker-%i/docker.sock', 'Environment=HOME=/home/runner',
    'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'ProtectSystem=strict', 'ProtectHome=tmpfs', 'BindPaths=/var/lib/worklane-ci/shop/%i/home:/home/runner',
    'PrivateDevices=yes', 'PrivateTmp=yes', 'ProtectProc=invisible',
    'InaccessiblePaths=-/srv/worklane -/opt/worklane -/var/lib/worklane -/etc/worklane -/var/lib/worklane-test -/var/lib/worklane-ci/shop/reg-%i',
    'BindReadOnlyPaths=/opt/worklane-ci/actions-runner-2.338.0/bin:/var/lib/worklane-ci/shop/%i/runner/bin /opt/worklane-ci/actions-runner-2.338.0/externals:/var/lib/worklane-ci/shop/%i/runner/externals',
  ]) assert.ok(runner.split('\n').includes(line), `runner unit: ${line}`);
  for (const line of [
    'User=wl-ci-shop', 'Slice=worklane-ci.slice', 'BindsTo=worklane-ci-shop-firewall.service', 'Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=true',
    'Delegate=cpu io memory pids', 'DelegateSubgroup=daemon',
    'ExecStart=/opt/worklane-ci/docker-29.8.2/dockerd-rootless.sh --data-root /var/lib/worklane-ci/shop/%i/docker --ip 127.0.0.1 --exec-opt native.cgroupdriver=cgroupfs',
  ]) assert.ok(docker.split('\n').includes(line), `docker unit: ${line}`);
  assert.doesNotMatch(out, /^(User|Group)=root$|SupplementaryGroups|AmbientCapabilities/m, 'no root daemon, no extra groups or capabilities');
  // Each runner registers with auto-update off and the labels given; the token is never an argument.
  for (const i of ['1', '2']) assert.match(out, new RegExp(`^# runner ${i} registers as wl-ci-shop with: config\\.sh --unattended --url https://github\\.com/example-org/example-shop --name \\S+-shop-${i} --labels box --work /var/lib/worklane-ci/shop/${i}/work --disableupdate --replace \\(the registration token you paste, in ACTIONS_RUNNER_INPUT_TOKEN\\)$`, 'm'));
  assert.doesNotMatch(out, /--token|--pat\b|ACTIONS_RUNNER_INPUT_TOKEN=\S/);
  // The hooks and the reset are printed as they will be installed.
  for (const f of ['job-hook.sh', 'reset.sh']) assert.ok(out.includes(readFileSync(join(files, f), 'utf8')), f);
});

test('ci-runner.sh: the registration token is pasted (hidden) or piped, and goes only into the runner user\'s own environment', () => {
  const sh = readFileSync(script, 'utf8');
  assert.doesNotMatch(sh, /--token\b|set -x|\becho [^\n]*\$(token|t)\b|>>? *[^\n|]*\$token/);
  // Every use of the token: read (hidden at a terminal), checked, piped (printf is a builtin, so never in an argv), cleared.
  const uses = sh.split('\n').filter((l) => /\$token\b|\$\{token|printf -v token/.test(l)).map((l) => l.trim());
  assert.ok(uses.length >= 3, uses.join('\n'));
  for (const l of uses) assert.match(l, /^printf -v token '%s' "\$t"$|^if \[ -n "\$token" \]; then$|^printf '%s\\n' "\$token" \| run_as "\$user" 'IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN; export ACTIONS_RUNNER_INPUT_TOKEN;/, l);
  assert.match(sh, /IFS= read -r -s -p "paste the \$what token \(input hidden\), then Enter: " t/);
  assert.match(sh, /token=""; unset token/);
  // Asked for only while a runner is unregistered: a second install needs none.
  assert.match(sh, /\[ -f "\$root\/reg-\$i\/\.runner" \] \|\| missing\+=\("\$i"\)/);
  // No sudoers at all.
  assert.doesNotMatch(sh, /install_sudoers|\/etc\/sudoers\.d\/[a-z.]/);
  // Pinned and checked before anything is unpacked.
  assert.match(sh, /^runner_version=\d+\.\d+\.\d+$/m);
  for (const v of ['runner_sha256_x64', 'docker_sha256_x64', 'docker_rootless_sha256_x64']) assert.match(sh, new RegExp(`^${v}=[0-9a-f]{64}$`, 'm'));
  assert.ok(sh.indexOf('sha256sum -c') < sh.indexOf('tar -xzf "$work/runner.tgz"'));
  // The same Docker release and sums test-user.sh pins.
  const tu = readFileSync(join(setup, 'test-user.sh'), 'utf8');
  for (const v of ['docker_version', 'docker_sha256_x64', 'docker_rootless_sha256_x64']) assert.equal(new RegExp(`^${v}=(\\S+)$`, 'm').exec(sh)?.[1], new RegExp(`^${v}=(\\S+)$`, 'm').exec(tu)?.[1], v);
  // The boundaries are checked before anything is registered, the firewall is up before the runners start, and a
  // failed final check stops the runners.
  assert.ok(sh.indexOf('access_checks || { echo "refusing to go on') < sh.indexOf('./config.sh "$@"'));
  assert.ok(sh.indexOf('nft -c -f') < sh.indexOf('./config.sh "$@"'));
  assert.match(sh, /if ! check_cmd; then stop_all;/);
});

test('ci-runner.sh refuses bad arguments before doing anything', { skip: !posix && 'bash' }, () => {
  for (const [args, err] of [
    [['0'], /count: 1 to 9/],
    [['1', '--cpus', 'x'], /--cpus: a CPU list/],
    [['1', '--memory-max', '50%'], /--memory-max: a size/],
    [['1', '--cpu-weight', '0'], /weights are 1 to 10000/],
    [['1', '--no-lock-jobs', 'a;b'], /--no-lock-jobs: job ids/],
    [['1', '--name', 'Bad_Name'], /--name: lowercase/],
    [['1', '--label', 'box,self-hosted'], /--label: self-hosted is every runner's own label/],
    [['1', '--label', 'a b'], /--label: up to 5/],
    [['1', '--branch', 'a..b'], /--branch: a branch name/],
    [['1', '--deny-interface', 'x;y'], /--deny-interface: interface names/],
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

/** The hooks, as the runner installs them (the name decides which), run with the given job variables. */
function hooks() {
  const d = mkdtempSync(join(tmpdir(), 'ci-hook-'));
  const lock = join(d, 'full-run.lock');
  writeFileSync(lock, '');
  const state = join(d, 'state');
  mkdirSync(state);
  for (const n of ['job-started.sh', 'job-completed.sh']) symlinkSync(join(files, 'job-hook.sh'), join(d, n));
  const trusted = {
    GITHUB_REPOSITORY: 'example-org/example-shop', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'example-org/example-shop/.github/workflows/ci-slow.yml@refs/heads/main', GITHUB_HEAD_REF: '', GITHUB_BASE_REF: '',
  };
  const run = (n: string, job: string, vars: Record<string, string> = {}) =>
    spawnSync('bash', [join(d, n)], {
      encoding: 'utf8', timeout: 70_000,
      env: { PATH: process.env.PATH ?? '', WORKLANE_CI_REPO: 'example-org/example-shop', WORKLANE_CI_BRANCH: 'main', WORKLANE_CI_LOCK: lock, WORKLANE_CI_LOCK_WAIT_MIN: '1', WORKLANE_CI_NO_LOCK_JOBS: 'verdict audit', WORKLANE_CI_STATE: state, GITHUB_JOB: job, ...trusted, ...vars },
    });
  return { d, lock, state, run, done: () => rmSync(d, { recursive: true, force: true }) };
}

const hasFlock = posix && spawnSync('flock', ['--version']).status === 0;

test('the job-started hook runs only trusted jobs: this repo\'s pushes, dispatches and schedules on its branch, from workflows on that branch', { skip: !posix && 'bash' }, () => {
  const h = hooks();
  try {
    // verdict takes no lock, so only the trust decision is tested here.
    for (const vars of [{}, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_EVENT_NAME: 'schedule' }]) {
      const r = h.run('job-started.sh', 'verdict', vars);
      assert.equal(r.status, 0, `${JSON.stringify(vars)}: ${r.stderr}`);
      assert.match(r.stdout, /^ci-trust: .*: trusted$/m);
    }
    for (const [vars, why] of [
      [{ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge', GITHUB_HEAD_REF: 'feature', GITHUB_BASE_REF: 'main' }, /event pull_request/],
      [{ GITHUB_EVENT_NAME: 'pull_request_target' }, /event pull_request_target/],
      [{ GITHUB_EVENT_NAME: 'workflow_run' }, /event workflow_run/],
      [{ GITHUB_EVENT_NAME: 'issue_comment' }, /event issue_comment/],
      [{ GITHUB_EVENT_NAME: '' }, /event unset/],
      [{ GITHUB_REF: 'refs/heads/feature' }, /ref refs\/heads\/feature, not refs\/heads\/main/],
      [{ GITHUB_REF: 'refs/tags/v1' }, /ref refs\/tags\/v1/],
      [{ GITHUB_HEAD_REF: 'feature' }, /a pull request's head or base ref is set/],
      [{ GITHUB_WORKFLOW_REF: 'example-org/example-shop/.github/workflows/ci-slow.yml@refs/heads/feature' }, /workflow .*@refs\/heads\/feature, not one of/],
      [{ GITHUB_WORKFLOW_REF: 'someone/example-shop/.github/workflows/ci-slow.yml@refs/heads/main' }, /workflow someone\//],
      [{ GITHUB_WORKFLOW_REF: '' }, /workflow unset/],
      [{ GITHUB_REPOSITORY: 'someone/example-shop' }, /repository someone\/example-shop, not example-org\/example-shop/],
      [{ GITHUB_REPOSITORY: '' }, /repository unset/],
    ] as const) {
      const r = h.run('job-started.sh', 'verdict', vars);
      assert.equal(r.status, 1, `${JSON.stringify(vars)} must be refused: ${r.stdout}`);
      assert.match(r.stderr, /^ci-trust: not running this job here: /m);
      assert.match(r.stderr, why);
      assert.doesNotMatch(r.stdout, /ci-lock/, 'refused before anything else');
    }
    // A runner whose own settings are missing refuses everything.
    const r = spawnSync('bash', [join(h.d, 'job-started.sh')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WORKLANE_CI_LOCK: h.lock, WORKLANE_CI_STATE: h.state, WORKLANE_CI_LOCK_WAIT_MIN: '1' } });
    assert.notEqual(r.status, 0);
  } finally {
    h.done();
  }
});

test('the lock hooks: a job holds the full-run lock shared from start to end, waits out an agent\'s exclusive run, and skips it only when named', { skip: !hasFlock && 'needs flock(1) (util-linux)' }, async () => {
  const h = hooks();
  const tryLock = (mode: '-x' | '-s') => spawnSync('flock', ['-n', mode, h.lock, 'true']).status;
  try {
    assert.equal(tryLock('-x'), 0);
    let r = h.run('job-started.sh', 'timing');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /holding .* \(shared\) for job timing/);
    assert.notEqual(tryLock('-x'), 0, 'an agent full run is kept out while the job runs');
    assert.equal(tryLock('-s'), 0, 'CI jobs do not serialize each other');
    r = h.run('job-completed.sh', 'timing');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /released/);
    assert.equal(tryLock('-x'), 0, 'free again once the job is done');
    assert.ok(!existsSync(join(h.state, 'lock-holder')));

    r = h.run('job-started.sh', 'verdict');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /job verdict doesn't take/);
    assert.equal(tryLock('-x'), 0);
    assert.match(h.run('job-completed.sh', 'verdict').stdout, /held no lock/);

    const agent = spawn('flock', ['-x', h.lock, 'sleep', '3']);
    await new Promise((res) => setTimeout(res, 500));
    const t0 = Date.now();
    r = h.run('job-started.sh', 'chain');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Date.now() - t0 >= 1500, 'it waited for the agent run');
    assert.notEqual(tryLock('-x'), 0);
    assert.equal(h.run('job-completed.sh', 'chain').status, 0);
    agent.kill();

    rmSync(h.lock);
    r = h.run('job-started.sh', 'timing');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is missing .*not starting job timing/);
  } finally {
    h.done();
  }
});

test('the reset removes the last job\'s containers before it remakes the runner, workspace and home', () => {
  const sh = readFileSync(join(files, 'reset.sh'), 'utf8');
  const at = (s: string) => sh.indexOf(s);
  assert.ok(at('rm -f -v $ids') > 0 && at('rm -f -v $ids') < at('rm -rf "$base/runner" "$base/work" "$base/home"'));
  assert.ok(at('builder prune -af') > 0 && at('builder prune -af') < at('rm -rf "$base/runner"'));
  assert.match(sh, /bin \| externals\) install -d -o root -g root -m 0755/, 'binaries come only from the read-only binds of the pinned release');
  assert.match(sh, /install -o "\$user" -g "\$user" -m 0600 "\$reg\/\$f"/);
  assert.match(sh, /_tool\/node\/\$v/);
  // Only node.sh's own release is seeded: on a machine whose /usr/local/bin/node is a plain file, its prefix would be
  // all of /usr/local (a reset that never ended, on a real runner).
  assert.match(sh, /\[\[ "\$node" =~ \^\/opt\/node-v/);
});

test('the stand-in runner\'s probes reach the internet without a rate-limited API: a container and a docker build each fetch https://github.com/', () => {
  const dir = join(repoRoot, 'scripts', 'ci', 'runner-stand-in');
  // GitHub's unauthenticated API answers 403 once the runner's shared outbound address is over its hourly quota.
  for (const f of ['job.sh', 'run.sh', 'config.sh']) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /api\.github\.com/, `${f} calls GitHub's unauthenticated API`);
  const job = readFileSync(join(dir, 'job.sh'), 'utf8');
  assert.match(job, /docker run --rm "\$img" wget -q -T 10 -O \/dev\/null https:\/\/github\.com\/ 2>&1\)"; then ok "a container reaches the internet/);
  assert.match(job, /printf 'FROM %s\\nRUN wget -q -T 10 -O \/dev\/null https:\/\/github\.com\/\\n' "\$img" > "\$b\/Dockerfile"/);
  assert.match(job, /docker build -q -t ci-probe "\$b" 2>&1\)"; then ok "docker build, with the network"/);
});
