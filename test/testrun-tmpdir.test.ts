// A test run's TMPDIR: short enough for a Unix socket under it, the test user's own 0700 directory, never one that
// was already there, and wiped with the run. Regression: every browser suite in a sandboxed run died with Chrome's
// FATAL "Socket path too long: /var/lib/<cli>-test/<name>/runs/<id>/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const helperSrc = join(repoRoot, 'scripts', 'machine', 'worklane-testrun.sh');
// Chrome's ProcessSingleton: a directory made with mkdtemp under TMPDIR, the socket in it.
const CHROME_SOCKET = '/org.chromium.Chromium.XXXXXX/SingletonSocket';
// sun_path is 108 bytes on Linux, its NUL included.
const SUN_PATH_MAX = 107;
// The longest instance name and run id the helper takes (its name regex and valid_id).
const LONGEST_NAME = 'a' + 'b-'.repeat(10);
const LONGEST_ID = 'fast-' + 'c'.repeat(43);

const fnBody = (src: string, name: string) => {
  const at = src.indexOf(`\n${name}() {`);
  if (at < 0) return '';
  const lineEnd = src.indexOf('\n', at + 1);
  // A one-line function ends on its own line; any other at the first "}" alone on a line.
  if (src.slice(at + 1, lineEnd).endsWith('}')) return src.slice(at + 1, lineEnd + 1);
  return src.slice(at + 1, src.indexOf('\n}\n', at) + 3);
};

test('regression: the longest TMPDIR a sandboxed run can get leaves room for Chrome\'s SingletonSocket (under 107 bytes)', { skip: !posix && 'bash' }, () => {
  const src = readFileSync(helperSrc, 'utf8');
  // The name and id are the longest the helper accepts.
  assert.ok(src.includes('[[ "$name" =~ ^[a-z][a-z0-9-]{0,20}$ ]]'), 'the instance name is at most 21 characters');
  assert.equal(LONGEST_NAME.length, 21);
  assert.ok(src.includes('valid_id() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,47}$ ]]'), 'a run id is at most 48 characters');
  assert.equal(LONGEST_ID.length, 48);
  // What exec_run gives the run as TMPDIR, evaluated as the helper evaluates it, with its own fixed paths.
  const exec = fnBody(src, 'exec_run');
  const expr = /--setenv=TMPDIR=(\S+)/.exec(exec)?.[1];
  assert.ok(expr, 'exec sets TMPDIR');
  const consts = ['BASE', 'TMP_BASE'].map((k) => new RegExp(`^${k}=\\S+$`, 'm').exec(src)?.[0] ?? '').join('\n');
  const script = `set -euo pipefail\n${consts}\nname=${LONGEST_NAME}\nroot="$BASE/$name"\nid=${LONGEST_ID}\n${fnBody(src, 'run_dir')}${fnBody(src, 'run_tmp')}d="$(run_dir "$id")"\nif declare -F run_tmp >/dev/null; then t="$(run_tmp "$id")"; fi\nprintf '%s' ${expr}\n`;
  const tmp = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.ok(tmp.startsWith('/'), tmp);
  // Regression: the coordinator calls the helper from a unit with PrivateTmp=yes, where /tmp and /var/tmp are not
  // the host's; systemd, binding the directory into the run's sandbox, looked in the host's and the run died (226).
  assert.doesNotMatch(tmp, /^\/(var\/)?tmp(\/|$)/, `${tmp} is under a directory PrivateTmp replaces`);
  const socket = tmp + CHROME_SOCKET;
  assert.ok(Buffer.byteLength(socket) < SUN_PATH_MAX, `${socket} is ${Buffer.byteLength(socket)} bytes`);
  // Tools that read TMP or TEMP instead get the same directory.
  for (const v of ['TMP', 'TEMP']) assert.ok(exec.includes(`--setenv=${v}=${expr}`), `${v} is the same directory`);
});

/** The helper, runnable as this user: its root-only tools stubbed, its paths in a temp dir, systemd-run logging its arguments. */
function helperCopy(o: { user?: string; helperUser?: string; tmpBase?: 'absent' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tr-tmp-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  const real = (t: string) => ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map((d) => join(d, t)).find((p) => existsSync(p));
  const sdLog = join(dir, 'systemd-run.log');
  stub('systemd-run', `[ "$1" = --version ] && { echo 'systemd 255 (test)'; exit 0; }\nprintf '%s\\n' "$@" > "${sdLog}"`);
  for (const t of ['systemctl', 'getent', 'chown']) stub(t, 'exit 0');
  // id -un: who the helper runs as (root on a machine; here this user, or a stand-in). Any other id: the user exists.
  stub('id', `[ "$1" = -un ] && { echo '${o.helperUser ?? userInfo().username}'; exit 0; }; exit 0`);
  stub('runuser', 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  // As this user: no chown to the test user, and rm without GNU's --one-file-system where it has none.
  stub('install', `a=(); while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; exec ${real('install')} "\${a[@]}"`);
  stub('rm', `a=(); for x in "$@"; do [ "$x" = --one-file-system ] || a+=("$x"); done; exec ${real('rm')} "\${a[@]}"`);
  const gnuStat = spawnSync(real('stat')!, ['--version']).status === 0;
  stub('stat', gnuStat ? `exec ${real('stat')} "$@"` : `[ "$1" = -c ] || exit 9; f="$2"; f="\${f//%U/%Su}"; f="\${f//%a/%Lp}"; shift 2; exec ${real('stat')} -f "$f" "$@"`);
  for (const t of ['git', 'sha256sum', 'cut', 'mkdir', 'sh', 'cat', 'env', 'awk', 'sed', 'grep', 'tr', 'head', 'tail', 'dirname', 'ls', 'touch', 'mktemp', 'date']) {
    const p = real(t);
    if (p) symlinkSync(p, join(bin, t));
  }
  const base = join(dir, 'base');
  const tmpBase = join(dir, 't');
  if (o.tmpBase !== 'absent') {
    mkdirSync(tmpBase);
    chmodSync(tmpBase, 0o711);
  }
  const user = o.user ?? userInfo().username;
  let src = readFileSync(helperSrc, 'utf8');
  for (const [re, to] of [
    [/^export PATH=\S+$/m, `export PATH=${bin}`],
    [/^BASE=\S+$/m, `BASE=${base}`],
    [/^TMP_BASE=\S+$/m, `TMP_BASE=${tmpBase}`],
    [/^user="wl-test-\$name"$/m, `user=${user}`],
  ] as const) {
    assert.match(src, re);
    src = src.replace(re, to);
  }
  const helper = join(dir, 'worklane-testrun');
  writeFileSync(helper, src);
  const name = 'shop';
  const run = (args: string[], input?: Buffer) => spawnSync('/bin/bash', [helper, name, ...args], { encoding: 'utf8', input, env: { PATH: '/usr/bin:/bin' } });
  const runTmp = (id: string) => join(tmpBase, execFileSync('bash', ['-c', `printf '%s/%s' "$1" "$2" | ${real('sha256sum') ?? 'sha256sum'} | cut -c1-8`, '_', name, id], { encoding: 'utf8' }).trim());
  /** create, from a real bundle of one commit under the run's refs. */
  const create = (id: string) => {
    const repo = mkdtempSync(join(dir, `repo-${id}-`));
    const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).trim();
    g('init', '-q');
    writeFileSync(join(repo, 'f.txt'), id);
    g('add', 'f.txt');
    g('commit', '-q', '-m', 'x');
    for (const r of ['head', 'base']) g('update-ref', `refs/worklane/test-run/${id}/${r}`, 'HEAD');
    const bundle = join(repo, "x.bundle");
    g('bundle', 'create', '--quiet', bundle, `refs/worklane/test-run/${id}/head`, `refs/worklane/test-run/${id}/base`);
    const sha = g('rev-parse', 'HEAD');
    return run(['create', id, 'main', `refs/worklane/test-run/${id}/head`, `refs/worklane/test-run/${id}/base`, sha, sha], readFileSync(bundle));
  };
  const runDir = (id: string) => join(base, name, 'runs', id);
  const sdArgs = () => (existsSync(sdLog) ? readFileSync(sdLog, 'utf8').trim().split('\n') : []);
  return { dir, tmpBase, run, create, runTmp, runDir, sdArgs, user, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

test('a run\'s TMPDIR is made by create as the run\'s user, 0700, and exec gives it as TMPDIR, TMP and TEMP, bound into the sandbox', { skip: !posix && 'bash' }, () => {
  const h = helperCopy();
  try {
    const id = 'fast-abc-1';
    const c = h.create(id);
    assert.equal(c.status, 0, c.stderr);
    const t = h.runTmp(id);
    assert.ok(lstatSync(t).isDirectory() && !lstatSync(t).isSymbolicLink(), `${t} is a real directory`);
    assert.equal(statSync(t).uid, process.getuid!(), 'owned by the run\'s user');
    assert.equal(mode(t), '700');
    assert.ok(!existsSync(join(h.runDir(id), 'tmp')), 'no TMPDIR under the run\'s directory any more');
    const e = h.run(['exec', id, '60', '--', 'true']);
    assert.equal(e.status, 0, e.stderr);
    const a = h.sdArgs();
    for (const v of ['TMPDIR', 'TMP', 'TEMP']) assert.ok(a.includes(`--setenv=${v}=${t}`), `${v}: ${a.join(' ')}`);
    assert.ok(a.includes(`BindPaths=${t}`) && a.includes(`ReadWritePaths=${t}`), 'bound in and writable under ProtectSystem=strict');
    assert.ok(a.includes(`TemporaryFileSystem=${h.tmpBase}:ro`), 'no other run\'s TMPDIR is in the sandbox');
    assert.ok(a.includes('PrivateTmp=yes'), '/tmp stays private');
  } finally {
    h.done();
  }
});

test('the base of the runs\' TMPDIRs is made by the helper itself, 0711 and its own user\'s; any other base is refused', { skip: !posix && 'bash' }, () => {
  // A machine installed before the base existed: the first create makes it, with no setup step.
  const h = helperCopy({ tmpBase: 'absent' });
  try {
    assert.ok(!existsSync(h.tmpBase));
    const c = h.create('fast-abc-8');
    assert.equal(c.status, 0, c.stderr);
    assert.ok(lstatSync(h.tmpBase).isDirectory());
    assert.equal(mode(h.tmpBase), '711');
    assert.equal(statSync(h.tmpBase).uid, process.getuid!());
    // Again, with it there: idempotent.
    assert.equal(h.create('fast-abc-9').status, 0);
    chmodSync(h.tmpBase, 0o777);
    let bad = h.create('fast-abc-10');
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, / is \S+ 777, not \S+ and 0711/);
    assert.ok(!existsSync(h.runDir('fast-abc-10')), 'no run was made');
    rmSync(h.tmpBase, { recursive: true });
    const target = join(h.dir, 'elsewhere');
    mkdirSync(target);
    symlinkSync(target, h.tmpBase);
    bad = h.create('fast-abc-10');
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, /is a symlink/);
  } finally {
    h.done();
  }
  // Not the helper's own user's (root's, on a machine): refused.
  const other = helperCopy({ helperUser: 'root-stand-in' });
  try {
    const bad = other.create('fast-abc-11');
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, /not root-stand-in's and 0711/);
  } finally {
    other.done();
  }
});

test('create refuses a TMPDIR that is already there, a directory or a symlink, and leaves it as it was', { skip: !posix && 'bash' }, () => {
  const h = helperCopy();
  try {
    const id = 'fast-abc-2';
    const t = h.runTmp(id);
    mkdirSync(t, { mode: 0o700 });
    writeFileSync(join(t, 'planted'), 'x');
    let c = h.create(id);
    assert.equal(c.status, 2, c.stderr);
    assert.match(c.stderr, /exists; refusing a temporary directory this run didn't make/);
    assert.equal(readFileSync(join(t, 'planted'), 'utf8'), 'x', 'what was there is untouched');
    assert.ok(!existsSync(h.runDir(id)), 'and no run was made');
    rmSync(t, { recursive: true });
    const target = join(h.dir, 'elsewhere');
    mkdirSync(target);
    symlinkSync(target, t);
    c = h.create(id);
    assert.equal(c.status, 2, c.stderr);
    assert.match(c.stderr, /exists; refusing/);
    assert.ok(lstatSync(t).isSymbolicLink(), 'the symlink is left');
    assert.ok(!existsSync(h.runDir(id)));
  } finally {
    h.done();
  }
});

test('a TMPDIR that isn\'t the run\'s user\'s own 0700 directory is refused, by create and again by exec', { skip: !posix && 'bash' }, () => {
  // Not the user's: create checks the owner and mode of what mkdir made.
  const other = helperCopy({ user: 'someone-else' });
  try {
    const c = other.create('fast-abc-3');
    assert.equal(c.status, 2, c.stderr);
    assert.match(c.stderr, /is \S+ 700, not someone-else's and 0700/);
  } finally {
    other.done();
  }
  const h = helperCopy();
  try {
    const id = 'fast-abc-4';
    assert.equal(h.create(id).status, 0);
    const t = h.runTmp(id);
    chmodSync(t, 0o755);
    let e = h.run(['exec', id, '60', '--', 'true']);
    assert.equal(e.status, 2, e.stderr);
    assert.match(e.stderr, /the run's TMPDIR: .* 755, not .* 0700/);
    rmSync(t, { recursive: true });
    const target = join(h.dir, 'elsewhere');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, t);
    e = h.run(['exec', id, '60', '--', 'true']);
    assert.equal(e.status, 2, e.stderr);
    assert.match(e.stderr, /the run's TMPDIR: .* is not a directory/);
    assert.deepEqual(h.sdArgs(), [], 'systemd-run never ran');
  } finally {
    h.done();
  }
});

test('wipe removes the run\'s TMPDIR with its directory, after a failed or timed-out run too; a symlink there goes, never what it points at', { skip: !posix && 'bash' }, () => {
  const h = helperCopy();
  try {
    const id = 'fast-abc-5';
    assert.equal(h.create(id).status, 0);
    const t = h.runTmp(id);
    // What a run killed at its timeout leaves: Chrome's socket directory, files, nested directories.
    mkdirSync(join(t, 'org.chromium.Chromium.abc123', 'deep'), { recursive: true });
    writeFileSync(join(t, 'org.chromium.Chromium.abc123', 'deep', 'f'), 'x');
    let w = h.run(['wipe', id]);
    assert.equal(w.status, 0, w.stderr);
    assert.ok(!existsSync(t) && !existsSync(h.runDir(id)), 'both gone');
    // A create that failed after making it (no run directory left): wipe still removes it.
    const id2 = 'fast-abc-6';
    const t2 = h.runTmp(id2);
    mkdirSync(t2, { mode: 0o700 });
    w = h.run(['wipe', id2]);
    assert.equal(w.status, 0, w.stderr);
    assert.ok(!existsSync(t2));
    // A symlink at its path: only the link goes.
    const target = join(h.dir, 'elsewhere');
    mkdirSync(target);
    writeFileSync(join(target, 'keep'), 'x');
    symlinkSync(target, t2);
    w = h.run(['wipe', id2]);
    assert.equal(w.status, 0, w.stderr);
    assert.ok(!existsSync(t2) && readFileSync(join(target, 'keep'), 'utf8') === 'x');
  } finally {
    h.done();
  }
  // Another instance's directory at that path (neither this test user's nor the helper's own) was never the run's:
  // wipe leaves it, and doesn't count it as left over.
  const other = helperCopy({ user: 'someone-else', helperUser: 'root-stand-in' });
  try {
    const t = other.runTmp('fast-abc-7');
    mkdirSync(t, { mode: 0o700 });
    const w = other.run(['wipe', 'fast-abc-7']);
    assert.equal(w.status, 0, w.stderr);
    assert.ok(existsSync(t));
  } finally {
    other.done();
  }
});

test('regression: the CI step that calls the helper from inside the coordinator\'s sandbox takes every setting from the generated unit', { skip: !posix && 'bash' }, () => {
  // The helper passed every check from a plain shell and failed on the machine, where the coordinator's unit
  // (PrivateTmp=yes, ProtectSystem=full) calls it. The step's transient unit must be that unit's sandbox, not a copy.
  const printed = execFileSync('bash', [join(repoRoot, 'scripts', 'setup', 'service.sh'), 'ci', '--print'], { encoding: 'utf8' });
  const unit = printed.slice(printed.indexOf('# /etc/systemd/system/worklane-ci.service'));
  const service = unit.slice(unit.indexOf('[Service]\n') + '[Service]\n'.length, unit.indexOf('\n[Install]'));
  const settings = service.split('\n').filter((l) => /^[A-Za-z]+=/.test(l));
  // What the unit starts and when it restarts is the unit's alone; everything else goes to the transient unit.
  const want = settings.filter((l) => !/^(ExecStart|Type|Restart|RestartSec)=/.test(l));
  const props = execFileSync('bash', [join(repoRoot, 'scripts', 'ci', 'coordinator-unit-props.sh'), 'ci'], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(props, want);
  for (const p of ['User=wl-ci', 'PrivateTmp=yes', 'ProtectSystem=full']) assert.ok(props.includes(p), p);
  const wf = readFileSync(join(repoRoot, '.github', 'workflows', 'ci-slow.yml'), 'utf8');
  const at = wf.indexOf('      - name: "regression: the helper works when called from inside the coordinator\'s own unit sandbox');
  assert.ok(at > 0, 'the step is there');
  const step = wf.slice(at, wf.indexOf('\n      - name:', at + 1));
  assert.ok(step.includes('mapfile -t props < <(bash scripts/ci/coordinator-unit-props.sh ci)'));
  assert.ok(step.includes('args=(); for p in "${props[@]}"; do args+=(-p "$p"); done'));
  assert.ok(step.includes('inside() { sudo systemd-run --wait --pipe --collect --quiet "${args[@]}" "$@"; }'), 'no setting of its own');
  assert.doesNotMatch(step, /systemd-run[^\n]* -p [A-Z]/, 'no -p written in the step');
  // check, a run made, a command in it and its wipe all go through that unit; the old helper must fail there with 226.
  for (const call of ['inside sudo -n "$H" ci check', 'inside sudo -n "$H" ci create ', 'inside sudo -n "$H" ci exec ', 'inside sudo -n "$H" ci wipe ']) assert.ok(step.includes(call), call);
  assert.ok(step.includes('grep -q \'^FAIL in the sandbox (exit 226)\' "$RUNNER_TEMP/old-inside.log"'));
});
