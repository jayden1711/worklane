// The sandbox helper's GPU (scripts/machine/worklane-testrun.sh, docs/test-runs.md "GPU"), run here as this user
// with root's tools stubbed and its paths moved into a temp dir: off unless root's file lists the instance; when on,
// PrivateDevices=yes kept and exactly the NVIDIA nodes bound and allowed (never uvm-tools, modeset, caps or dri); one
// GPU command per GPU under a flock the helper holds for the whole command; the wait counts against the timeout. The
// real-systemd CI job proves the same against real systemd-run with stand-in device nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { holdFlock } from '../src/os/index.js';
import { gpuFileText, gpuLine } from '../src/testrun/gpu.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const helperSrc = join(repoRoot, 'scripts', 'machine', 'worklane-testrun.sh');
const real = (t: string) => ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map((d) => join(d, t)).find((p) => existsSync(p));

/** The helper as this user can run it: GPU file, /dev and the lock directory in a temp dir; systemd-run recording. */
function gpuHelper(o: { systemd?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tr-gpu-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  const me = userInfo().username;
  const sd = join(dir, 'sd');
  mkdirSync(sd);
  writeFileSync(join(dir, 'sdver'), String(o.systemd ?? 255));
  const lockDir = join(dir, 'run', 'worklane', 'gpu');
  // systemd-run: its argv per call, when it started and ended, and whether GPU 0's lock was held (by another open of
  // the file) while it ran; it sleeps as long as the file `sleep` says.
  stub(
    'systemd-run',
    `[ "$1" = --version ] && { echo "systemd $(cat '${dir}/sdver') (test)"; exit 0; }
n="$(date +%s%N)-$$"
printf '%s\\n' "$@" > "${sd}/$n.argv"
date +%s > "${sd}/$n.start"
[ -e "${lockDir}/0.lock" ] && perl -e 'use Fcntl qw(:flock); open(my $f, "<", $ARGV[0]) or exit 2; print(flock($f, LOCK_EX | LOCK_NB) ? "free" : "held")' "${lockDir}/0.lock" > "${sd}/$n.lock"
sleep "$(cat '${dir}/sleep' 2>/dev/null || echo 0)"
date +%s > "${sd}/$n.end"
echo ran`,
  );
  for (const t of ['systemctl', 'chown']) stub(t, 'exit 0');
  // getent: the GPU group as the file named group says (absent: no group); nothing else.
  stub('getent', `[ "$1" = group ] && [ -f '${dir}/group' ] && { cat '${dir}/group'; exit 0; }; [ "$1" = group ] && exit 2; exit 0`);
  const myGroup = spawnSync('id', ['-gn'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(dir, 'group'), `${myGroup}:x:1234:example-owner\n`);
  stub('id', `[ "$1" = -un ] && { echo '${me}'; exit 0; }; exit 0`);
  stub('runuser', 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  stub('install', `a=(); while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; exec ${real('install')} "\${a[@]}"`);
  const gnuStat = spawnSync(real('stat')!, ['--version']).status === 0;
  // A stat of the locks' directories or files takes as long as the file `slowstat` says: a slow lock-file setup. Each
  // stat of a lock file, once done, is a line of the file `stats`.
  stub(
    'stat',
    `p="\${*: -1}"
case "$p" in '${join(dir, 'run')}'*) sleep "$(cat '${dir}/slowstat' 2>/dev/null || echo 0)" ;; esac
${gnuStat ? `${real('stat')} "$@"` : `[ "$1" = -c ] || exit 9; f="$2"; f="\${f//%U/%Su}"; f="\${f//%G/%Sg}"; f="\${f//%a/%Lp}"; shift 2; ${real('stat')} -f "$f" "$@"`}
rc=$?
case "$p" in *.lock) echo "$p" >> '${dir}/stats' ;; esac
exit $rc`,
  );
  // flock(1): the real one where there is one (Linux); else the same call through perl on the inherited fd.
  if (real('flock')) symlinkSync(real('flock')!, join(bin, 'flock'));
  else
    stub(
      'flock',
      `w=-1; while [ "$#" -gt 1 ]; do case "$1" in -x) shift ;; -n) w=0; shift ;; -w) w="$2"; shift 2 ;; *) break ;; esac; done
exec perl -e 'use Fcntl qw(:flock); open(my $f, "<&=", $ARGV[0]) or exit 2; my $end = time + $ARGV[1]; until (flock($f, LOCK_EX | LOCK_NB)) { exit 1 if $ARGV[1] >= 0 && time >= $end; select(undef, undef, undef, 0.1); } exit 0' "$1" "$w"`,
    );
  for (const t of ['chgrp', 'chmod', 'git', 'cp', 'sha256sum', 'cut', 'mkdir', 'sh', 'cat', 'env', 'awk', 'sed', 'grep', 'tr', 'head', 'tail', 'sort', 'date', 'sleep', 'ls', 'dirname', 'perl', 'rm']) {
    const p = real(t);
    if (p && !existsSync(join(bin, t))) symlinkSync(p, join(bin, t));
  }
  const etc = join(dir, 'etc', 'worklane');
  mkdirSync(etc, { recursive: true, mode: 0o755 });
  chmodSync(join(dir, 'etc'), 0o755);
  chmodSync(etc, 0o755);
  const file = join(etc, 'testrun-gpu.json');
  const dev = join(dir, 'dev');
  mkdirSync(dev);
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
    [/^GPU_FILE=\S+$/m, `GPU_FILE=${file}`],
    [/^GPU_LOCK_DIR=\S+$/m, `GPU_LOCK_DIR=${lockDir}`],
    // The locks' group: this user's own primary group here (only root can chgrp to another).
    [/^GPU_GROUP=\S+$/m, `GPU_GROUP=${myGroup}`],
    [/^DEV=\S+$/m, `DEV=${dev}`],
    // A stand-in node is a plain file here (only root makes device nodes); CI's real-systemd job uses real ones.
    [/^is_char\(\) \{.*$/m, 'is_char() { [ ! -L "$1" ] && [ -e "$1" ]; }'],
  ] as const) {
    assert.match(src, re);
    src = src.replace(re, to);
  }
  const helper = join(dir, 'worklane-testrun');
  writeFileSync(helper, src);
  mkdirSync(join(dir, 'run', 'worklane'), { recursive: true });
  chmodSync(join(dir, 'run'), 0o755);
  rmSync(join(dir, 'run', 'worklane'), { recursive: true });
  mkdirSync(tmpBase, { mode: 0o711 });
  chmodSync(tmpBase, 0o711);
  const runs = new Set<string>();
  const mkRun = (id: string) => {
    if (runs.has(id)) return;
    runs.add(id);
    mkdirSync(join(base, 'shop', 'runs', id, 'work'), { recursive: true });
    const hash = spawnSync('bash', ['-c', `printf '%s/%s' shop ${id} | ${real('sha256sum')} | cut -c1-8`], { encoding: 'utf8' }).stdout.trim();
    mkdirSync(join(tmpBase, hash), { mode: 0o700 });
    chmodSync(join(tmpBase, hash), 0o700);
  };
  const args = (id: string, timeout: number, gpu: boolean, cmd: string) => [helper, 'shop', 'exec', id, String(timeout), ...(gpu ? ['--gpu'] : []), '--', cmd];
  const exec = (id: string, timeout: number, gpu: boolean, cmd = 'nvidia-test') => {
    mkRun(id);
    return spawnSync('/bin/bash', args(id, timeout, gpu, cmd), { encoding: 'utf8', input: '', env: { PATH: '/usr/bin:/bin' }, timeout: 60_000 });
  };
  /** The same, in the background: its exit code, stdout and stderr when it ends. */
  const execAsync = (id: string, timeout: number, gpu: boolean, cmd = 'nvidia-test') => {
    mkRun(id);
    // stdin from /dev/null: no variables, and an EOF that doesn't wait for this process's event loop.
    const c = spawn('/bin/bash', args(id, timeout, gpu, cmd), { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => c.on('close', (status) => res({ status, stdout: out, stderr: err })));
  };
  /** Each systemd-run call (not --version), oldest first: its argv, start, end, and GPU 0's lock as it saw it. */
  const calls = () =>
    spawnSync('ls', [sd], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter((f) => f.endsWith('.argv'))
      .sort()
      .map((f) => {
        const n = f.replace(/\.argv$/, '');
        const r = (x: string) => (existsSync(join(sd, `${n}.${x}`)) ? readFileSync(join(sd, `${n}.${x}`), 'utf8').trim() : '');
        return { argv: r('argv').split('\n'), start: Number(r('start')), end: Number(r('end')), lock: r('lock') };
      });
  const nodes = (...names: string[]) => {
    for (const n of names) {
      mkdirSync(join(dev, n, '..'), { recursive: true });
      writeFileSync(join(dev, n), '');
    }
  };
  const optIn = (instances: Record<string, number[]>, maxMinutes = 20, mode = 0o644) => {
    writeFileSync(file, gpuFileText({ maxMinutes, instances }));
    chmodSync(file, mode);
  };
  /** The systemd-run call of run <id>. */
  const call = (id: string) => calls().find((c) => c.argv.some((x) => x.startsWith(`--unit=worklane-test-shop_${id}_`)))!;
  const setGroup = (line: string | null) => (line === null ? rmSync(join(dir, 'group'), { force: true }) : writeFileSync(join(dir, 'group'), `${line.replace('<g>', myGroup)}\n`));
  const setSlowStat = (s: number) => writeFileSync(join(dir, 'slowstat'), String(s));
  /** How many stats of GPU <i>'s lock file have ended since the last clearStats. */
  const stats = (i: number) => (existsSync(join(dir, 'stats')) ? readFileSync(join(dir, 'stats'), 'utf8').split('\n').filter((l) => l === join(lockDir, `${i}.lock`)).length : 0);
  const clearStats = () => rmSync(join(dir, 'stats'), { force: true });
  return { dir, dev, file, lockDir, myGroup, setGroup, exec, execAsync, calls, call, nodes, optIn, setSleep: (s: number) => writeFileSync(join(dir, 'sleep'), String(s)), setSlowStat, stats, clearStats, done: () => rmSync(dir, { recursive: true, force: true }) };
}

type Call = { argv: string[]; start: number; end: number; lock: string };
const ALL_NODES = ['nvidiactl', 'nvidia-uvm', 'nvidia0', 'nvidia1', 'nvidia-uvm-tools', 'nvidia-modeset', 'nvidia-caps/nvidia-cap1', 'dri/card0', 'dri/renderD128'];
const props = (argv: string[]) => argv.filter((a, i) => argv[i - 1] === '-p');
const deviceProps = (argv: string[]) => props(argv).filter((p) => /^(BindPaths|DeviceAllow)=.*\/dev\//.test(p) || /^DeviceAllow=/.test(p));

test('GPU off by default: no root file, a tier that asks gets "gpu none" and the same sandbox as any run (PrivateDevices=yes, no node bound)', { skip: !posix && 'bash' }, () => {
  const h = gpuHelper();
  try {
    h.nodes(...ALL_NODES);
    const r = h.exec('fast-a-1', 60, true);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^worklane-testrun: gpu none \(GPU test runs are off on this machine \(no \S+testrun-gpu\.json\)\)\n/);
    assert.deepEqual(gpuLine(r.stderr).grant, { granted: false, why: `GPU test runs are off on this machine (no ${h.file})` });
    const [c] = h.calls();
    assert.ok(props(c!.argv).includes('PrivateDevices=yes'));
    assert.deepEqual(deviceProps(c!.argv), [], 'no device bound or allowed');
    assert.ok(props(c!.argv).includes('RuntimeMaxSec=60'));
    assert.ok(!existsSync(h.lockDir), 'no lock taken');
  } finally {
    h.done();
  }
});

test('GPU on for the instance: PrivateDevices=yes kept, exactly nvidiactl, nvidia-uvm and the listed nvidia<N> bound and allowed, never uvm-tools, modeset, caps or dri', { skip: !posix && 'bash' }, () => {
  const h = gpuHelper();
  try {
    h.nodes(...ALL_NODES);
    h.optIn({ other: [1], shop: [0] });
    const r = h.exec('fast-a-1', 60, true);
    assert.equal(r.status, 0, r.stderr);
    const d = (n: string) => join(h.dev, n);
    // max: what is left of the 60 s once the helper got there (a moment on a slow machine); waited: for the lock alone.
    const line = r.stderr.split('\n')[0]!;
    const m = new RegExp(`^worklane-testrun: gpu 0 \\(devices ${d('nvidiactl')} ${d('nvidia-uvm')} ${d('nvidia0')}; max (\\d+) s; waited ([01]) s\\)$`).exec(line);
    assert.ok(m && Number(m[1]) <= 60 && Number(m[1]) >= 55, line);
    const c = h.call('fast-a-1');
    assert.ok(props(c!.argv).includes('PrivateDevices=yes'), 'PrivateDevices=yes kept');
    assert.deepEqual(deviceProps(c!.argv), [`BindPaths=${d('nvidiactl')}`, `DeviceAllow=${d('nvidiactl')} rw`, `BindPaths=${d('nvidia-uvm')}`, `DeviceAllow=${d('nvidia-uvm')} rw`, `BindPaths=${d('nvidia0')}`, `DeviceAllow=${d('nvidia0')} rw`]);
    // The nodes' device group (scripts/setup/gpu-devices.sh), for this unit alone; never the locks' group.
    assert.deepEqual(props(c!.argv).filter((p) => p.startsWith('SupplementaryGroups=')), ['SupplementaryGroups=worklane-gpu-dev']);
    const all = c!.argv.join('\n');
    for (const never of ['nvidia-uvm-tools', 'nvidia-modeset', 'nvidia-caps', '/dri', 'nvidia1']) assert.ok(!all.includes(never), `${never} is never in the unit`);
    // The GPU locks are inaccessible to every run, GPU or not.
    assert.ok(props(c!.argv).some((p) => p.startsWith('InaccessiblePaths=') && p.includes(`-${h.lockDir}`)));
    // The GPU's max runtime caps the unit; the tier's timeout_s caps it when that is shorter.
    h.exec('fast-a-2', 5000, true);
    assert.ok(props(h.call('fast-a-2').argv).includes('RuntimeMaxSec=1200'), 'max_minutes 20');
    // The same instance's command that doesn't ask: no device, no lock, no GPU line.
    const plain = h.exec('fast-a-3', 60, false);
    assert.doesNotMatch(plain.stderr, /gpu/);
    assert.deepEqual(deviceProps(h.call('fast-a-3').argv), []);
    assert.ok(!props(h.call('fast-a-3').argv).some((p) => p.startsWith('SupplementaryGroups=')), 'no device group for a run that does not ask');
    // After the command, the lock's note is emptied and it is free.
    assert.equal(readFileSync(join(h.lockDir, '0.lock'), 'utf8'), '');
  } finally {
    h.done();
  }
});

test('#968: "waited" is the wait for the lock alone, never its file\'s setup: a slow setup of a free lock waits 0 s', { skip: !posix && 'bash' }, () => {
  const h = gpuHelper();
  try {
    h.nodes('nvidiactl', 'nvidia-uvm', 'nvidia0');
    h.optIn({ shop: [0] });
    // The lock's five stats take 3 s in all; nobody holds it.
    h.setSlowStat(0.6);
    const r = h.exec('fast-a-1', 60, true);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr.split('\n')[0]!, /^worklane-testrun: gpu 0 \(devices .*; waited [01] s\)$/);
  } finally {
    h.done();
  }
});

test('#968: "waited" sums the waits of every GPU the run locks, not only the last one\'s or the longest', { skip: !posix && 'bash' }, async () => {
  const h = gpuHelper();
  try {
    h.nodes('nvidiactl', 'nvidia-uvm', 'nvidia0', 'nvidia1');
    h.optIn({ shop: [0, 1] });
    assert.equal(h.exec('fast-x-0', 30, true).status, 0, 'the locks made');
    h.clearStats();
    // Both held; each let go 3 s after the helper's last check of its file (two stats of it: then it opens and waits),
    // however long the setup took. The helper takes GPU 0, then GPU 1, so it waits about 3 s on each.
    const held = [await holdFlock(join(h.lockDir, '0.lock'), 'exclusive'), await holdFlock(join(h.lockDir, '1.lock'), 'exclusive')];
    const run = h.execAsync('fast-a-1', 60, true);
    for (const [i, lock] of held.entries()) {
      for (let n = 0; n < 600 && h.stats(i) < 2; n++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(h.stats(i), 2, `the helper checked GPU ${i}'s lock file`);
      await new Promise((r) => setTimeout(r, 3000));
      await lock.release();
    }
    const r = await run;
    assert.equal(r.status, 0, r.stderr);
    const line = r.stderr.split('\n')[0]!;
    assert.match(line, /^worklane-testrun: gpu 0,1 \(devices /);
    // Each wait is 3 s or 4 s in whole seconds: 6 or more in all, where the last or the longest alone is at most 4.
    assert.ok(Number(/waited (\d+) s/.exec(line)![1]) >= 5, line);
  } finally {
    h.done();
  }
});

test('GPU refused, the command run without it and the line saying why: a file not root-0644, not in the script\'s form, another instance only, systemd older than 255, no driver node', { skip: !posix && 'bash' }, () => {
  const cases: [string, (h: ReturnType<typeof gpuHelper>) => void, RegExp, number?][] = [
    ['mode 0664', (h) => h.optIn({ shop: [0] }, 20, 0o664), /is \S+ 664, not \S+'s and 0644/],
    ['hand-edited', (h) => (writeFileSync(h.file, JSON.stringify({ version: 1, max_minutes: 20, instances: { shop: { devices: [0] } } })), chmodSync(h.file, 0o644)), /not in the form scripts\/setup\/testrun-gpu\.sh writes/],
    ['max over 120', (h) => (writeFileSync(h.file, gpuFileText({ maxMinutes: 121, instances: { shop: [0] } })), chmodSync(h.file, 0o644)), /max_minutes: 1 to 120/],
    ['another instance', (h) => h.optIn({ other: [0] }), /not on for shop in /],
    ['systemd 254', (h) => h.optIn({ shop: [0] }), /systemd 254 is older than 255/, 254],
    ['no nvidiactl', (h) => (h.optIn({ shop: [0] }), rmSync(join(h.dev, 'nvidiactl'))), /no \S+\/nvidiactl: the NVIDIA driver isn't loaded/],
    ['no listed GPU', (h) => (h.optIn({ shop: [3] }), undefined), /none of the listed GPUs' nodes exist \(\S+\/nvidia3\)/],
  ];
  for (const [what, set, why, systemd] of cases) {
    const h = gpuHelper(systemd ? { systemd } : {});
    try {
      h.nodes(...ALL_NODES);
      set(h);
      const r = h.exec('fast-a-1', 60, true);
      assert.equal(r.status, 0, `${what}: ${r.stderr}`);
      const line = r.stderr.split('\n')[0]!;
      assert.match(line, /^worklane-testrun: gpu none \(/, what);
      assert.match(line, why, what);
      assert.deepEqual(deviceProps(h.calls()[0]!.argv), [], `${what}: no device`);
    } finally {
      h.done();
    }
  }
});

test('GPU: a listed GPU with no node is skipped and said; the others are granted', { skip: !posix && 'bash' }, () => {
  const h = gpuHelper();
  try {
    h.nodes('nvidiactl', 'nvidia-uvm', 'nvidia0');
    h.optIn({ shop: [1, 0] });
    const r = h.exec('fast-a-1', 60, true);
    assert.match(r.stderr.split('\n')[0]!, /^worklane-testrun: gpu 0 \(devices .*; max (60|5\d) s; waited [01] s; skipped \S+\/nvidia1 \(no node\)\)$/);
    assert.ok(!h.calls()[0]!.argv.join('\n').includes('nvidia1'));
  } finally {
    h.done();
  }
});

test('one GPU command per GPU: the helper holds GPU 0\'s lock for the whole command; a second waits for it, its wait counts against its timeout; a run that doesn\'t ask never waits', { skip: !posix && 'bash' }, async () => {
  const h = gpuHelper();
  try {
    h.nodes('nvidiactl', 'nvidia-uvm', 'nvidia0');
    h.optIn({ shop: [0] });
    // Long enough that B (started once A's unit runs) gets to the lock before A ends, even on a slow, loaded machine.
    h.setSleep(5);
    const a = h.execAsync('fast-a-1', 60, true);
    // Until A's systemd-run is running.
    for (let i = 0; i < 100 && !h.calls().length; i++) await new Promise((r) => setTimeout(r, 100));
    const b = h.execAsync('fast-b-1', 40, true);
    const plain = h.exec('fast-c-1', 30, false, 'no-gpu');
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 0, ra.stderr);
    assert.equal(rb.status, 0, rb.stderr);
    assert.equal(plain.status, 0, plain.stderr);
    const calls = h.calls();
    assert.equal(calls.length, 3);
    const [ca, cb, cc] = ['fast-a-1', 'fast-b-1', 'fast-c-1'].map((id) => h.call(id)) as [Call, Call, Call];
    assert.equal(ca.lock, 'held', 'GPU 0 was locked while A ran');
    assert.equal(cb.lock, 'held', 'and while B ran');
    assert.ok(cb.start >= ca.end, `B started (${cb.start}) only once A ended (${ca.end})`);
    assert.ok(cc.start < ca.end, 'the run that asked for no GPU did not wait');
    const waited = Number(/waited (\d+) s/.exec(rb.stderr)![1]);
    assert.ok(waited >= 1, rb.stderr);
    const left = Number(props(cb.argv).find((p) => p.startsWith('RuntimeMaxSec='))!.split('=')[1]);
    assert.ok(left <= 40 - waited && left >= 40 - waited - 5, `B's unit got what was left of its 40 s after waiting ${waited} s: ${left}`);
  } finally {
    h.done();
  }
});

test('a GPU command still waiting at its timeout fails, saying who holds the GPU, and nothing runs', { skip: !posix && 'bash' }, async () => {
  const h = gpuHelper();
  try {
    h.nodes('nvidiactl', 'nvidia-uvm', 'nvidia0');
    h.optIn({ shop: [0] });
    // Another holder of GPU 0 (as `gpu hold` takes it: read-only, exclusive), with the note another run's helper writes.
    h.exec('fast-x-0', 30, true);
    writeFileSync(join(h.lockDir, '0.lock'), 'other/fast-x-9 since 2026-10-15T00:00:00Z\n');
    const held = await holdFlock(join(h.lockDir, '0.lock'), 'exclusive');
    try {
      const before = h.calls().length;
      const r = h.exec('fast-a-1', 2, true);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /^worklane-testrun: gpu 0: still held after [23] s, the run's timeout \(held by other\/fast-x-9 since 2026-10-15T00:00:00Z\)\n/);
      assert.deepEqual(gpuLine(r.stderr).grant?.granted, false);
      assert.equal(h.calls().length, before, 'systemd-run never ran');
    } finally {
      await held.release();
    }
  } finally {
    h.done();
  }
});

test('the helper refuses --gpu anywhere but right before --', { skip: !posix && 'bash' }, () => {
  const h = gpuHelper();
  try {
    for (const bad of [['--gpu', '60', '--', 'x'], ['60', '--', '--gpu', 'x', 'y'], ['60', '--gpu', '--gpu', '--', 'x']]) {
      const r = spawnSync('/bin/bash', [join(h.dir, 'worklane-testrun'), 'shop', 'exec', 'fast-a-1', ...bad], { encoding: 'utf8', input: '', env: { PATH: '/usr/bin:/bin' } });
      assert.equal(r.status, 2, bad.join(' '));
    }
    assert.equal(h.calls().length, 0);
  } finally {
    h.done();
  }
});

test('the GPU locks are root\'s and the GPU group\'s alone (0750 directory, 0640 locks), set so even when an older helper made them open; no group, or a harness user in it: no GPU', { skip: !posix && 'bash' }, () => {
  const h = gpuHelper();
  const mode = (p: string) => spawnSync('stat', process.platform === 'darwin' ? ['-f', '%Lp %Sg', p] : ['-c', '%a %G', p], { encoding: 'utf8' }).stdout.trim();
  try {
    h.nodes('nvidiactl', 'nvidia-uvm', 'nvidia0');
    h.optIn({ shop: [0] });
    // As the helper before the group left them: the directory 0755, the lock 0644.
    mkdirSync(h.lockDir, { recursive: true, mode: 0o755 });
    chmodSync(join(h.lockDir, '..'), 0o755);
    chmodSync(h.lockDir, 0o755);
    writeFileSync(join(h.lockDir, '0.lock'), '');
    chmodSync(join(h.lockDir, '0.lock'), 0o644);
    const r = h.exec('fast-a-1', 60, true);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr.split('\n')[0]!, /^worklane-testrun: gpu 0 \(devices /);
    assert.equal(mode(h.lockDir), `750 ${h.myGroup}`);
    assert.equal(mode(join(h.lockDir, '0.lock')), `640 ${h.myGroup}`);
    // A new lock is made that way too.
    rmSync(join(h.lockDir, '0.lock'));
    assert.equal(h.exec('fast-a-2', 60, true).status, 0);
    assert.equal(mode(join(h.lockDir, '0.lock')), `640 ${h.myGroup}`);
    for (const [group, why] of [[null, /^worklane-testrun: gpu none \(no \S+ group \(scripts\/setup\/testrun-gpu\.sh makes it\)\)$/], ['<g>:x:1234:example-owner,wl-test-shop', /^worklane-testrun: gpu none \(the \S+ group has a harness user \(example-owner,wl-test-shop\): only the owner may hold a GPU\)$/]] as const) {
      h.setGroup(group);
      const n = h.exec('fast-a-3', 60, true);
      assert.equal(n.status, 0, n.stderr);
      assert.match(n.stderr.split('\n')[0]!, why);
      assert.deepEqual(deviceProps(h.call('fast-a-3').argv), []);
    assert.ok(!props(h.call('fast-a-3').argv).some((p) => p.startsWith('SupplementaryGroups=')), 'no device group for a run that does not ask');
      rmSync(join(h.dir, 'sd'), { recursive: true });
      mkdirSync(join(h.dir, 'sd'));
    }
  } finally {
    h.done();
  }
});
