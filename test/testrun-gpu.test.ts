// GPU test runs, the engine's side (src/testrun/gpu.ts, docs/test-runs.md "GPU"): root's file as the engine reads it
// (planning and display only), the helper's line, the sandbox host's --gpu, doctor, the Machine page's view, the root
// script that writes the file, and `gpu hold`. The helper's own side: test/testrun-gpu-helper.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gpuCheck } from '../src/doctor.js';
import { EventLog } from '../src/events/log.js';
import { gpuHoldCommand, parseGpuHold } from '../src/gpu-hold.js';
import { flockHeld, holdFlock } from '../src/os/index.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { gpuFileText, gpuLine, gpuOptIn, gpuRunsNotToRepeat, gpuStopped, parseGpuFile, readGpuFile } from '../src/testrun/gpu.js';
import { sandboxHost } from '../src/testrun/host.js';
import { testRunsView } from '../src/testrun/status.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const uid = process.getuid?.() ?? 0;
const hasPerl = posix && spawnSync('perl', ['-e', '1']).status === 0;
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

test('tests.yaml: gpu is a tier\'s own ask, off unless set', () => {
  const c = TestRunConfig.parse({ tiers: [{ name: 'a', command: 'x', kind: 'fast' }, { name: 'b', command: 'y', kind: 'fast', gpu: true }] });
  assert.deepEqual(c.tiers.map((t) => t.gpu), [false, true]);
  assert.throws(() => TestRunConfig.parse({ tiers: [{ name: 'a', command: 'x', kind: 'fast', gpu: 'yes' }] }));
});

test('root\'s file: exactly the script\'s form; anything else is no file the helper reads', () => {
  const f = { maxMinutes: 20, instances: { shop: [0], ci: [0, 1] } };
  const text = gpuFileText(f);
  assert.equal(text, '{\n  "version": 1,\n  "max_minutes": 20,\n  "instances": {\n    "shop": { "devices": [0] },\n    "ci": { "devices": [0, 1] }\n  }\n}\n');
  assert.deepEqual(parseGpuFile(text), f);
  assert.equal(gpuFileText({ maxMinutes: 5, instances: {} }), '{\n  "version": 1,\n  "max_minutes": 5,\n  "instances": {}\n}\n');
  for (const bad of [JSON.stringify({ version: 1, max_minutes: 20, instances: { shop: { devices: [0] } } }), text.replace('20', '121'), text.replace('"shop"', '"Shop"'), text.replace('[0]', '[]'), text.replace('"version": 1', '"version": 2'), `${text}\n`, text.replace('[0, 1]', '[0,1]'), 'not json']) {
    assert.ok('error' in parseGpuFile(bad), bad);
  }
});

test('root\'s file for an instance: on (its GPUs, the cap), off (absent, another instance, not root-0644, not the form), unknown (can\'t be read); planned unless off', { skip: !posix && 'POSIX modes' }, () => {
  const dir = tmp('gpu-file-');
  const file = join(dir, 'testrun-gpu.json');
  try {
    assert.deepEqual(gpuOptIn('shop', file, uid), { state: 'off', why: 'GPU test runs are off on this machine (no root opt-in file)' });
    writeFileSync(file, gpuFileText({ maxMinutes: 15, instances: { shop: [1, 0, 1] } }));
    chmodSync(file, 0o644);
    assert.deepEqual(gpuOptIn('shop', file, uid), { state: 'on', devices: [0, 1], maxMinutes: 15 });
    assert.deepEqual(gpuOptIn('other', file, uid), { state: 'off', why: 'not on for other' });
    // Not root's (here: a uid that isn't this user's): the helper grants nothing, so off.
    assert.equal(gpuOptIn('shop', file, uid + 1).state, 'off');
    chmodSync(file, 0o664);
    assert.match((gpuOptIn('shop', file, uid) as { why: string }).why, /not root's and 0644/);
    chmodSync(file, 0o644);
    writeFileSync(file, '{"version":1}');
    assert.match((gpuOptIn('shop', file, uid) as { why: string }).why, /not in the form scripts\/setup\/testrun-gpu\.sh writes/);
    if (uid !== 0) {
      rmSync(file);
      mkdirSync(join(dir, 'locked'), { mode: 0o000 });
      assert.equal(gpuOptIn('shop', join(dir, 'locked', 'testrun-gpu.json'), uid).state, 'unknown');
      chmodSync(join(dir, 'locked'), 0o700);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the helper\'s GPU line: only as the very first line of an exec\'s stderr; granted, none, or still held at the timeout', () => {
  const ok = 'worklane-testrun: gpu 0,1 (devices /dev/nvidiactl /dev/nvidia-uvm /dev/nvidia0 /dev/nvidia1; max 1200 s; waited 3 s)\nRunning as unit: x\n';
  assert.deepEqual(gpuLine(ok), { grant: { granted: true, indices: [0, 1], devices: ['/dev/nvidiactl', '/dev/nvidia-uvm', '/dev/nvidia0', '/dev/nvidia1'], maxS: 1200, waitedS: 3, note: '' }, own: [[0, ok.indexOf('\n') + 1]] });
  assert.deepEqual(gpuLine('worklane-testrun: gpu none (not on for shop in /etc/worklane/testrun-gpu.json)\n').grant, { granted: false, why: 'not on for shop in /etc/worklane/testrun-gpu.json' });
  const held = 'worklane-testrun: gpu 0: still held after 300 s, the run\'s timeout (held by ci/fast-x since 2026-10-15T00:00:00Z; pid 9 (root: bash))\n';
  assert.deepEqual(gpuLine(held), { grant: { granted: false, why: "still held after 300 s, the run's timeout (held by ci/fast-x since 2026-10-15T00:00:00Z; pid 9 (root: bash))" }, own: [] }, 'kept in the output: the check says who held it');
  // A run's own output that looks like it, anywhere but first, is the run's.
  assert.deepEqual(gpuLine(`Running as unit: x\n${ok}`), { grant: null, own: [] });
  // Stopped: granted, and the cap or a kill ended it; never our own cancel or a GPU not granted.
  const g = gpuLine(ok).grant;
  assert.equal(gpuStopped(g, { code: 1, timedOut: true }, false), true);
  assert.equal(gpuStopped(g, { code: null }, false), true);
  assert.equal(gpuStopped(g, { code: 137, unitResult: 'signal' }, false), true);
  assert.equal(gpuStopped(g, { code: 1, unitResult: 'exit-code' }, false), false);
  assert.equal(gpuStopped(g, { code: null }, true), false);
  assert.equal(gpuStopped({ granted: false, why: 'x' }, { code: null, timedOut: true }, false), false);
});

test('the runs never to repeat: planned as GPU runs and then cut off (no end, or interrupted) or stopped; not one that ended or was cancelled', () => {
  const log = new EventLog(join(tmp('gpu-ev-'), 'events.db'));
  const sha = 'a'.repeat(40);
  const run = (id: string, gpu: boolean, end?: Record<string, unknown>) => {
    log.append('testrun.queued', { id, sha, kind: 'full', prs: [], shard: null }, 't');
    log.append('testrun.started', { id, slot: 's', lock_wait_ms: 0, ...(gpu ? { gpu: 'planned' as const } : {}) }, 't');
    if (end) log.append('testrun.finished', { id, sha, kind: 'full', prs: [], ok: false, results: [], detail: '', outcome: 'done', ...end } as never, 't');
  };
  run('cut', true);
  run('interrupted', true, { outcome: 'interrupted' });
  run('stopped', true, { gpu_stopped: true });
  run('ended', true, { outcome: 'done' });
  run('cancelled', true, { outcome: 'cancelled' });
  run('no-gpu', false);
  const evs = log.read(0);
  assert.deepEqual(gpuRunsNotToRepeat(evs), ['cut', 'interrupted', 'stopped']);
  assert.deepEqual(gpuRunsNotToRepeat(evs, 'b'.repeat(40)), []);
  log.close();
});

test('the sandbox host passes --gpu only when a command asks, takes the helper\'s line out of the output, and returns what it granted', { skip: !posix && 'POSIX sh' }, async () => {
  const dir = tmp('gpu-host-');
  const log = join(dir, 'calls');
  const helper = join(dir, 'helper');
  writeFileSync(
    helper,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
cat > /dev/null
case "$*" in
  *--gpu*) echo 'worklane-testrun: gpu 0 (devices /dev/nvidiactl /dev/nvidia-uvm /dev/nvidia0; max 600 s; waited 1 s)' >&2 ;;
esac
echo out-line
echo 'Running as unit: worklane-test-shop-fast-a-1-1.service' >&2
echo 'worklane-testrun: gpu 9 (devices /dev/fake; max 1 s; waited 0 s)' >&2
printf 'Finished with result: success\\nMain processes terminated with: code=exited/status=0\\n' >&2
`,
  );
  chmodSync(helper, 0o755);
  const sudo = join(dir, 'sudo');
  writeFileSync(sudo, '#!/bin/sh\n[ "$1" = -n ] || exit 9\nshift\nexec "$@"\n');
  chmodSync(sudo, 0o755);
  try {
    const host = sandboxHost('shop', helper, sudo);
    const g = await host.exec('fast-a-1', 'nvidia-test', {}, 60_000, undefined, { gpu: true });
    const plain = await host.exec('fast-a-1', 'lint', {}, 60_000);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['shop exec fast-a-1 60 --gpu -- nvidia-test', 'shop exec fast-a-1 60 -- lint']);
    assert.deepEqual(g.gpu, { granted: true, indices: [0], devices: ['/dev/nvidiactl', '/dev/nvidia-uvm', '/dev/nvidia0'], maxS: 600, waitedS: 1, note: '' });
    assert.doesNotMatch(g.out, /gpu 0 \(devices/, 'the helper\'s own line is not the run\'s output');
    assert.match(g.out, /gpu 9 \(devices \/dev\/fake/, 'a run\'s look-alike line stays the run\'s');
    assert.equal(plain.gpu, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: nothing while GPU test runs are off; a warning when on and a node the runs need is missing; ok when every one is there', { skip: !posix && 'POSIX modes' }, () => {
  const dir = tmp('gpu-doc-');
  const file = join(dir, 'testrun-gpu.json');
  try {
    assert.equal(gpuCheck(file, () => true, uid), null);
    writeFileSync(file, gpuFileText({ maxMinutes: 20, instances: {} }));
    chmodSync(file, 0o644);
    assert.equal(gpuCheck(file, () => true, uid), null, 'on for no instance');
    writeFileSync(file, gpuFileText({ maxMinutes: 20, instances: { shop: [0] } }));
    const missing = gpuCheck(file, (p) => p !== '/dev/nvidia-uvm', uid);
    assert.equal(missing?.level, 'warn');
    assert.match(missing!.detail, /^on for shop \(GPU 0; at most 20 min a GPU command\), but \/dev\/nvidia-uvm is missing: those runs run without the GPU/);
    assert.equal(gpuCheck(file, () => true, uid)?.level, 'ok');
    chmodSync(file, 0o666);
    assert.equal(gpuCheck(file, () => true, uid)?.level, 'warn', 'a file the helper would refuse');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Machine page\'s test runs: root\'s GPU opt-in for this instance, read-only, with the root command that changes it; a viewer gets none of it', () => {
  const base = { events: [], configured: true, cap: 2, slots: [], lock: { path: '/x', holders: [] }, instance: 'shop' };
  const on = testRunsView({ ...base, writer: true, gpu: { state: 'on', devices: [0], maxMinutes: 20 } }) as { gpu?: Record<string, unknown> };
  assert.deepEqual(on.gpu, { state: 'on', devices: [0], maxMinutes: 20, change: 'sudo bash /opt/worklane/current/scripts/setup/testrun-gpu.sh disable shop', status: 'sudo bash /opt/worklane/current/scripts/setup/testrun-gpu.sh status' });
  const off = testRunsView({ ...base, writer: true, gpu: { state: 'off', why: 'not on for shop' } }) as { gpu?: Record<string, unknown> };
  assert.equal(off.gpu?.change, 'sudo bash /opt/worklane/current/scripts/setup/testrun-gpu.sh enable shop --devices 0 --max-minutes 20');
  assert.equal('gpu' in testRunsView({ ...base, writer: false, gpu: { state: 'on', devices: [0], maxMinutes: 20 } }), false);
});

/** testrun-gpu.sh as this user: root's tools stubbed, its files in a temp dir. */
function gpuScript() {
  const dir = tmp('gpu-sh-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  const real = (t: string) => ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map((d) => join(d, t)).find((p) => existsSync(p));
  stub('id', `[ "$1" = -u ] && [ "$#" -eq 1 ] && { echo 0; exit 0; }; [ "$1" = -u ] && [ "$2" = wl-test-shop ] && exit 0; [ "$1" = -u ] && exit 1; exit 0`);
  stub('install', `a=(); while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; exec ${real('install')} "\${a[@]}"`);
  stub('systemd-tmpfiles', `printf '%s\\n' "$*" >> "${dir}/tmpfiles.calls"`);
  for (const t of ['cat', 'mv', 'rm', 'sed', 'sort', 'cut', 'tr', 'paste', 'dirname', 'basename', 'chmod', 'grep', 'head']) {
    const p = real(t);
    if (p) symlinkSync(p, join(bin, t));
  }
  const setup = join(dir, 'setup');
  mkdirSync(setup);
  writeFileSync(join(setup, 'lib.sh'), readFileSync(join(repoRoot, 'scripts', 'setup', 'lib.sh'), 'utf8'));
  const file = join(dir, 'etc', 'worklane', 'testrun-gpu.json');
  const tmpfiles = join(dir, 'tmpfiles.d', 'worklane-gpu.conf');
  mkdirSync(join(dir, 'tmpfiles.d'));
  let src = readFileSync(join(repoRoot, 'scripts', 'setup', 'testrun-gpu.sh'), 'utf8');
  for (const [re, to] of [
    [/^GPU_FILE=\S+$/m, `GPU_FILE=${file}`],
    [/^TMPFILES=\S+$/m, `TMPFILES=${tmpfiles}`],
  ] as const) {
    assert.match(src, re);
    src = src.replace(re, to);
  }
  writeFileSync(join(setup, 'testrun-gpu.sh'), src);
  const run = (...args: string[]) => spawnSync('/bin/bash', [join(setup, 'testrun-gpu.sh'), ...args], { encoding: 'utf8', env: { PATH: bin } });
  return { dir, file, tmpfiles, run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('testrun-gpu.sh: enable and disable write exactly the form the helper and the engine read, root 0644, and the boot-time locks; bad arguments change nothing', { skip: !posix && 'bash' }, () => {
  const s = gpuScript();
  try {
    assert.match(s.run('status').stdout, /GPU test runs: off on this machine \(no /);
    for (const bad of [['enable'], ['enable', 'Bad'], ['enable', 'shop', '--devices', 'x'], ['enable', 'shop', '--max-minutes', '0'], ['enable', 'shop', '--max-minutes', '121'], ['disable', 'shop', '--devices', '0'], ['frob']]) {
      assert.equal(s.run(...bad).status, 2, bad.join(' '));
    }
    assert.equal(s.run('enable', 'nouser').status, 1, 'no test user: set up its test runs first');
    assert.ok(!existsSync(s.file), 'nothing written');
    const r = s.run('enable', 'shop', '--devices', '1,0', '--max-minutes', '15');
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(s.file, 'utf8');
    assert.equal(text, gpuFileText({ maxMinutes: 15, instances: { shop: [0, 1] } }));
    assert.deepEqual(readGpuFile(s.file, uid), { maxMinutes: 15, instances: { shop: [0, 1] } }, 'the engine reads what it wrote');
    assert.equal(spawnSync('stat', process.platform === 'darwin' ? ['-f', '%Lp', s.file] : ['-c', '%a', s.file], { encoding: 'utf8' }).stdout.trim(), '644');
    assert.equal(readFileSync(s.tmpfiles, 'utf8'), [
      '# Written by scripts/setup/testrun-gpu.sh: the GPU test runs\' locks (one per GPU), root\'s, readable by all.',
      'd /run/worklane 0755 root root -',
      'd /run/worklane/gpu 0755 root root -',
      'f /run/worklane/gpu/0.lock 0644 root root -',
      'f /run/worklane/gpu/1.lock 0644 root root -',
      '',
    ].join('\n'));
    assert.match(r.stdout, /GPU test runs: on for 1 instance\(s\); max 15 min per GPU command\n {2}shop: GPU 0,1/);
    // Default GPU 0; the cap kept; disable leaves the others.
    assert.equal(s.run('enable', 'shop').status, 0);
    assert.equal(readFileSync(s.file, 'utf8'), gpuFileText({ maxMinutes: 15, instances: { shop: [0] } }));
    assert.equal(s.run('disable', 'shop').status, 0);
    assert.equal(readFileSync(s.file, 'utf8'), gpuFileText({ maxMinutes: 15, instances: {} }));
    // A file in any other form is refused, changing nothing.
    writeFileSync(s.file, '{"version": 1}\n');
    const refused = s.run('enable', 'shop');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not in the form this script writes/);
    assert.equal(readFileSync(s.file, 'utf8'), '{"version": 1}\n');
  } finally {
    s.done();
  }
});

test('gpu hold: the arguments; refused when no GPU test runs are on (nothing to hold against) or a lock file is missing; nothing runs then', async () => {
  assert.deepEqual(parseGpuHold(['--gpu', '1', '--gpu', '0', '--', 'python', 'train.py', '--root', 'x']), { gpus: [0, 1], command: ['python', 'train.py', '--root', 'x'] });
  for (const bad of [[], ['python'], ['--'], ['--gpu', 'x', '--', 'a'], ['--wait', '--', 'a']]) assert.ok('error' in parseGpuHold(bad), bad.join(' '));
  const dir = tmp('gpu-hold-');
  const said: string[] = [];
  try {
    const marker = join(dir, 'ran');
    assert.equal(await gpuHoldCommand(['--', 'touch', marker], { file: join(dir, 'none.json'), rootUid: uid, err: (l) => void said.push(l) }), 2);
    assert.match(said.at(-1)!, /no instance's test runs may use a GPU here/);
    assert.equal(await gpuHoldCommand(['--gpu', '0', '--', 'touch', marker], { lockPath: (i) => join(dir, `${i}.lock`), err: (l) => void said.push(l) }), 2);
    assert.match(said.at(-1)!, /no lock file for GPU 0/);
    assert.ok(!existsSync(marker));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gpu hold: takes the same per-GPU lock the helper takes, waits while it is held, holds it for the whole command, gives the command\'s exit code', { skip: !hasPerl && 'perl for the flock holder' }, async () => {
  const dir = tmp('gpu-hold-');
  const lock = (i: number) => join(dir, `${i}.lock`);
  const file = join(dir, 'testrun-gpu.json');
  try {
    writeFileSync(file, gpuFileText({ maxMinutes: 20, instances: { shop: [0] } }));
    chmodSync(file, 0o644);
    writeFileSync(lock(0), 'shop/fast-a-1 since 2026-10-15T00:00:00Z\n');
    const said: string[] = [];
    // A test run's helper holds GPU 0.
    const run = await holdFlock(lock(0), 'exclusive');
    const probe = join(dir, 'probe');
    // The command records whether GPU 0's lock was held (by someone else's open of the file) while it ran.
    const cmd = ['perl', '-e', 'use Fcntl qw(:flock); open(my $f, "<", $ARGV[0]) or exit 2; open(my $o, ">", $ARGV[1]); print $o (flock($f, LOCK_EX | LOCK_NB) ? "free" : "held"); exit 7', lock(0), probe];
    const hold = gpuHoldCommand(['--', ...cmd], { file, rootUid: uid, lockPath: lock, err: (l) => void said.push(l) });
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!existsSync(probe), 'not run while the test run holds the GPU');
    assert.match(said.join('\n'), /gpu hold: waiting for \S+0\.lock \(held by shop\/fast-a-1 since 2026-10-15T00:00:00Z/);
    await run.release();
    assert.equal(await hold, 7, 'the command\'s exit code');
    assert.equal(readFileSync(probe, 'utf8'), 'held', 'GPU 0 locked for the whole command');
    assert.equal(flockHeld(lock(0)), false, 'and let go after');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('src/ never runs nvidia-smi or asks the driver: GPU access is root\'s file, the nodes and the lock', () => {
  const files = execFileSync('git', ['ls-files', 'src', 'scripts/machine/worklane-testrun.sh', 'scripts/setup/testrun-gpu.sh'], { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n');
  const hits = files.filter((f) => existsSync(join(repoRoot, f)) && /nvidia-smi|nvidia-uvm-tools"|nvidia-modeset"|BindPaths=\/dev\/dri/.test(readFileSync(join(repoRoot, f), 'utf8').split('\n').filter((l) => !/^\s*(#|\/\/|\*)/.test(l)).join('\n')));
  assert.deepEqual(hits, []);
});
