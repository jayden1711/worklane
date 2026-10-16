// The experiment jobs' root helper (scripts/machine/worklane-exp.sh), run here as this user with root's tools stubbed
// and its paths moved into a temp dir: root's file and the spec decide everything; each step is its own unit with no
// network and only what it needs bound; the scorer never gets the job's workspace or environment, and a job step
// never gets the labels; the GPU only on train and predict, with the device group on those units only. The engine's
// side (src/experiments/root-file.ts, helper.ts) agrees with it. The real-systemd CI job proves the same for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { EXP_PROTOCOL, evalTreeHash, readRecord, specText, type JobSpec } from '../src/experiments/helper.js';
import { parseRootFile, rootFileText, type RootFile } from '../src/experiments/root-file.js';
import { repoRoot } from './helpers.js';

const helperSrc = join(repoRoot, 'scripts', 'machine', 'worklane-exp.sh');
const testrunSrc = join(repoRoot, 'scripts', 'machine', 'worklane-testrun.sh');
const real = (t: string) => ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map((d) => join(d, t)).find((p) => existsSync(p));
// The helper needs bash 4 (associative arrays) and GNU stat, as on the servers it runs on; macOS's bash 3.2 can't.
const linuxBash = process.platform === 'linux' && spawnSync('bash', ['-c', 'declare -A x=([a]=1)']).status === 0;

test('the helper\'s protocol is the engine\'s', () => {
  assert.equal(readFileSync(helperSrc, 'utf8').match(/^PROTOCOL=(\d+)$/m)?.[1], String(EXP_PROTOCOL));
});

test('one GPU lock for test runs and experiment jobs: the same lock directory, group and lock functions as the test-run helper', () => {
  const fn = (src: string, f: string) => {
    const m = new RegExp(`^${f}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm').exec(src);
    assert.ok(m, `${f} is there`);
    return m[0].replace(/worklane-(testrun|exp): /g, 'HELPER: ');
  };
  const a = readFileSync(helperSrc, 'utf8');
  const b = readFileSync(testrunSrc, 'utf8');
  for (const f of ['gpu_holder', 'gpu_lock_file', 'gpu_lock', 'gpu_unlock']) assert.equal(fn(a, f), fn(b, f), `${f} as the test-run helper has it`);
  for (const v of ['GPU_LOCK_DIR', 'GPU_GROUP', 'GPU_MIN_SYSTEMD']) assert.equal(a.match(new RegExp(`^${v}=(\\S+)$`, 'm'))?.[1], b.match(new RegExp(`^${v}=(\\S+)$`, 'm'))?.[1], v);
});

const file: RootFile = { devices: [0], max_minutes: 60, gpu_hours_per_day: 8, output_gb: 50, env_network: false, sources: { 'train-set': { sha256: 'a'.repeat(64), visibility: 'job' }, 'eval-inputs': { sha256: 'b'.repeat(64), visibility: 'job' }, 'eval-labels': { sha256: 'c'.repeat(64), visibility: 'scorer' } } };

test('root\'s file: exactly the script\'s form reads back; anything else is off', () => {
  const t = rootFileText(file);
  assert.deepEqual(parseRootFile(t), file);
  assert.deepEqual(parseRootFile(rootFileText({ ...file, sources: {} })), { ...file, sources: {} });
  assert.ok('error' in parseRootFile(t.replace('"max_minutes": 60', '"max_minutes":60')), 'another spacing');
  assert.ok('error' in parseRootFile(t.replace('"visibility": "scorer"', '"visibility": "all"')));
  assert.ok('error' in parseRootFile(t.replace('"env_network": false,', '"env_network": false, "extra": 1,')));
});

test('the spec: one line a value, NUL-ended; the record: the last line, its form checked', () => {
  const s: JobSpec = { STUDY: 'example-speed', EVAL: 'e'.repeat(64), MINUTES: 10, GPUS: 1, OUTPUT_GB: 5, WAIT_MAX: 3600, LOCK: 'f'.repeat(64), DATA: ['train-set'], INPUTS: 'eval-inputs', LABELS: 'eval-labels', BUILD: 'true', PREFLIGHT: '', TRAIN: 'python train.py', PREDICT: 'python p.py', SCORE: 'python s.py', CONFIG: { lr: 0.01 }, SEED: 1 };
  assert.match(specText(s), /^STUDY=example-speed\0EVAL=e+\0MINUTES=10\0/);
  assert.match(specText(s), /CONFIG=\{"lr":0\.01\}\0/);
  assert.throws(() => specText({ ...s, TRAIN: 'a\nb' }), /one line/);
  const rec = (o: object) => `x\nworklane-exp: record ${JSON.stringify({ protocol: 1, job: 'j-1', outcome: 'scored', step: null, score: 2.5, gpu_seconds: 600, waited_s: 0, gpus: [0], output_kb: 1, ...o })}\n`;
  assert.equal(readRecord(rec({}))?.score, 2.5);
  assert.equal(readRecord(rec({ outcome: 'scored', score: null })), null, 'scored needs a score');
  assert.equal(readRecord(rec({ outcome: 'crashed', score: 1 })), null, 'a crash has none');
  assert.equal(readRecord(rec({ protocol: 2 })), null);
  assert.equal(readRecord('nothing'), null);
});

/** The helper as this user can run it: root's file, the state and the env dir in a temp dir; systemd-run recording. */
function expHelper() {
  const dir = mkdtempSync(join(tmpdir(), 'exp-h-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  const me = userInfo().username;
  const sd = join(dir, 'sd');
  mkdirSync(sd);
  // systemd-run: its argv per call; a score step prints the score the file `score` says.
  stub(
    'systemd-run',
    `[ "$1" = --version ] && { echo "systemd 255 (test)"; exit 0; }
n="$(date +%s%N)-$$"
printf '%s\\n' "$@" > "${sd}/$n.argv"
case "$*" in *-score-*) cat '${dir}/score' 2>/dev/null ;; esac
exit 0`,
  );
  for (const t of ['systemctl', 'chown', 'chgrp']) stub(t, 'exit 0');
  stub('getent', `[ "$1" = group ] && [ "$2" = worklane-gpu ] && { echo "worklane-gpu:x:1234:example-owner"; exit 0; }; [ "$1" = group ] && [ "$2" = worklane-gpu-dev ] && { echo "worklane-gpu-dev:x:1235:"; exit 0; }; [ "$1" = group ] && exit 2; exit 0`);
  stub('id', `[ "$1" = -un ] && { echo '${me}'; exit 0; }; exit 0`);
  stub('runuser', 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  stub('install', `a=(); while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; exec ${real('install')} "\${a[@]}"`);
  stub('flock', 'exit 0');
  // stat: the real one, but every file is root's group as the helper expects (only root can chgrp here).
  // stat: the real one, with the group each path would have on a server (only root can chgrp here): the GPU locks'
  // group for the locks, the scorer's for the labels, the job user's (and the coordinator's) for the rest.
  stub(
    'stat',
    `out="$(${real('stat')} "$@")" || exit $?; p="\${@: -1}"
case "$p" in *gpu*) g=worklane-gpu ;; *eval-labels*) g=GRPS ;; *) g=GRP ;; esac
printf '%s\\n' "$out" | sed -e "s/^\\([^ ]*\\) [^ ]* \\([0-7][0-7][0-7]\\)$/\\1 $g \\2/"`,
  );
  for (const t of ['git', 'sha256sum', 'cut', 'mkdir', 'sh', 'cat', 'env', 'awk', 'sed', 'grep', 'tr', 'head', 'tail', 'sort', 'date', 'sleep', 'ls', 'dirname', 'rm', 'find', 'du', 'chmod', 'printf', 'touch', 'mv']) {
    const p = real(t);
    if (p && !existsSync(join(bin, t))) symlinkSync(p, join(bin, t));
  }
  const base = join(dir, 'base');
  const etc = join(dir, 'etc');
  mkdirSync(etc, { mode: 0o755 });
  chmodSync(etc, 0o755);
  const dev = join(dir, 'dev');
  mkdirSync(dev);
  for (const n of ['nvidiactl', 'nvidia-uvm', 'nvidia0']) writeFileSync(join(dev, n), '');
  let src = readFileSync(helperSrc, 'utf8');
  for (const [re, to] of [
    [/^export PATH=\S+$/m, `export PATH=${bin}`],
    [/^BASE=\S+$/m, `BASE=${base}`],
    [/^ROOT_DIR=\S+$/m, `ROOT_DIR=${etc}`],
    [/^ENV_DIR=\S+$/m, `ENV_DIR=${join(dir, 'env')}`],
    [/^GPU_LOCK_DIR=\S+$/m, `GPU_LOCK_DIR=${join(dir, 'run', 'gpu')}`],
    [/^DEV=\S+$/m, `DEV=${dev}`],
    [/^is_char\(\) \{.*$/m, 'is_char() { [ ! -L "$1" ] && [ -e "$1" ]; }'],
  ] as const) {
    assert.match(src, re);
    src = src.replace(re, to);
  }
  // The groups the helper checks a directory's owner against: the stub's stat reports GRP for every 0750/0710 one.
  src = src.replace(/^juser=.*$/m, 'juser=GRP').replace(/^suser=.*$/m, 'suser=GRPS').replace(/^coord=.*$/m, 'coord=GRP');
  const helper = join(dir, 'worklane-exp');
  writeFileSync(helper, src);
  mkdirSync(join(dir, 'run'), { mode: 0o755 });
  chmodSync(join(dir, 'run'), 0o755);
  const sha = (s: string) => spawnSync('sha256sum', { input: s, encoding: 'utf8' }).stdout.split(' ')[0]!;
  // Approved sources: a manifest each (root's 0644) and a directory (0750).
  const sources: RootFile['sources'] = {};
  for (const [id, vis] of [['train-set', 'job'], ['eval-inputs', 'job'], ['eval-labels', 'scorer']] as const) {
    mkdirSync(join(base, 'ex', 'data', id), { recursive: true, mode: 0o750 });
    chmodSync(join(base, 'ex', 'data', id), 0o750);
    const m = `${'0'.repeat(64)}  x\n`;
    writeFileSync(join(base, 'ex', 'data', `${id}.manifest`), m, { mode: 0o644 });
    chmodSync(join(base, 'ex', 'data', `${id}.manifest`), 0o644);
    sources[id] = { sha256: sha(m), visibility: vis };
  }
  const writeRoot = (f: Partial<RootFile> = {}) => {
    writeFileSync(join(etc, 'ex.json'), rootFileText({ ...file, sources, ...f }));
    chmodSync(join(etc, 'ex.json'), 0o644);
  };
  writeRoot();
  // A sealed eval copy and a created job (what eval-seal and create leave).
  const tree = 'd'.repeat(64);
  mkdirSync(join(base, 'ex', 'evals', tree, 'files'), { recursive: true });
  writeFileSync(join(base, 'ex', 'evals', tree, '.sealed'), '');
  const job = (id: string, spec: Partial<JobSpec> = {}) => {
    mkdirSync(join(base, 'ex', 'jobs', id, 'work'), { recursive: true });
    mkdirSync(join(base, 'ex', 'jobs', id, 'out'), { recursive: true });
    mkdirSync(join(base, 'ex', 'jobs', id, 'pred'), { recursive: true });
    mkdirSync(join(base, 'ex', 'jobs', id, 'logs'), { recursive: true });
    const s: JobSpec = { STUDY: 'example-speed', EVAL: tree, MINUTES: 10, GPUS: 1, OUTPUT_GB: 5, WAIT_MAX: 60, LOCK: 'f'.repeat(64), DATA: ['train-set'], INPUTS: 'eval-inputs', LABELS: 'eval-labels', BUILD: 'build-env', PREFLIGHT: 'preflight-cmd', TRAIN: 'train-cmd', PREDICT: 'predict-cmd', SCORE: 'score-cmd', CONFIG: { lr: 0.01 }, SEED: 7, ...spec };
    return spawnSync('/bin/bash', [helper, 'ex', 'job', id], { encoding: 'utf8', input: specText(s), env: { PATH: '/usr/bin:/bin' }, timeout: 60_000 });
  };
  const calls = () =>
    readdirSync(sd)
      .filter((f) => f.endsWith('.argv'))
      .sort()
      .map((f) => readFileSync(join(sd, f), 'utf8').trim().split('\n'));
  const clear = () => {
    for (const f of readdirSync(sd)) spawnSync('rm', ['-f', join(sd, f)]);
  };
  return { dir, base, job, calls, clear, writeRoot, score: (s: string) => writeFileSync(join(dir, 'score'), s) };
}

const unitOf = (argv: string[]) => argv.find((a) => a.startsWith('--unit='))!.replace(/^--unit=worklane-exp-ex-[a-z0-9-]+?-(build|preflight|train|predict|score)-\d+$/, '$1');
const props = (argv: string[]) => argv.filter((a, i) => argv[i - 1] === '-p');

test('a job: every step its own unit with no network; the scorer gets the labels and never the job\'s code; a job step never gets the labels', { skip: !linuxBash && 'needs bash 4 and GNU tools (Linux)' }, () => {
  const h = expHelper();
  h.score('score=2.75\n');
  const r = h.job('example-speed-1');
  assert.equal(r.status, 0, r.stderr);
  const rec = readRecord(r.stdout);
  assert.deepEqual([rec?.outcome, rec?.score], ['scored', 2.75]);
  const cs = h.calls();
  assert.deepEqual(cs.map(unitOf), ['build', 'preflight', 'train', 'predict', 'score']);
  const labels = join(h.base, 'ex', 'data', 'eval-labels');
  const work = join(h.base, 'ex', 'jobs', 'example-speed-1', 'work');
  for (const argv of cs) {
    const p = props(argv);
    assert.ok(p.includes('PrivateNetwork=yes'), `${unitOf(argv)}: no network`);
    assert.ok(p.includes(`TemporaryFileSystem=${h.base}:ro`), `${unitOf(argv)}: nothing of the state but its binds`);
    assert.ok(p.includes('PrivateDevices=yes') && p.includes('NoNewPrivileges=yes') && p.includes('ProtectSystem=strict'));
    const s = unitOf(argv);
    if (s === 'score') {
      assert.ok(argv.includes('--uid=wl-score-ex') || argv.some((a) => a === '--uid=GRPS'), 'the scorer user');
      assert.ok(p.includes(`BindReadOnlyPaths=${labels}`));
      assert.ok(!argv.some((a) => a.includes(work) || a.includes('/cache/')), 'no workspace, no environment');
    } else {
      assert.ok(!argv.some((a) => a.includes(labels)), `${s}: no labels`);
      assert.ok(!argv.includes('--uid=GRPS'));
    }
    const gpu = p.some((x) => x.startsWith('DeviceAllow='));
    assert.equal(gpu, s === 'train' || s === 'predict', `${s}: the GPU only on train and predict`);
    assert.equal(p.includes('SupplementaryGroups=worklane-gpu-dev'), gpu, `${s}: the device group only on a granted unit`);
  }
});

test('root\'s file decides: a job above its minutes, an unapproved source, the labels as job data, a scorer that prints no score', { skip: !linuxBash && 'needs bash 4 and GNU tools (Linux)' }, () => {
  const h = expHelper();
  for (const [spec, why] of [
    [{ MINUTES: 61 }, /MINUTES 61 is above root's 60/],
    [{ DATA: ['other-set'] }, /other-set is not approved/],
    [{ DATA: ['eval-labels'] }, /eval-labels is scorer-only, not for the job/],
  ] as Array<[Partial<JobSpec>, RegExp]>) {
    h.clear();
    const r = h.job(`example-speed-${spec.MINUTES ?? spec.DATA![0]}`, spec);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, why);
    assert.equal(h.calls().length, 0, 'nothing ran');
  }
  h.clear();
  h.score('the score is 2.75\n');
  const r = h.job('example-speed-2');
  assert.deepEqual([readRecord(r.stdout)?.outcome, readRecord(r.stdout)?.step], ['crashed', 'score-unreadable']);
});

test('the eval tree\'s hash: the engine and the helper agree', { skip: !linuxBash && 'needs bash 4 and GNU tools (Linux)' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'exp-tree-'));
  const files = { 'score.py': 'print(1)\n', 'eval/predict.py': 'x = 2\n', 'B.txt': 'b' };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, 'files', p, '..'), { recursive: true });
    writeFileSync(join(dir, 'files', p), c);
  }
  const fn = /^tree_hash\(\) \{.*\}$/m.exec(readFileSync(helperSrc, 'utf8'))![0];
  const got = spawnSync('bash', ['-c', `${fn}\ntree_hash "$1"`, '_', dir], { encoding: 'utf8' }).stdout.trim();
  assert.equal(got, evalTreeHash(files));
});
