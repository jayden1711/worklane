// systemd-run's own output, as the sandbox helper's probe check and the coordinator's sandbox host read it.
//
// test/fixtures/systemd-run-255/ is systemd 255's text (Ubuntu 24.04): probe.stderr is the helper's sandbox probe
// as a server printed it (the unit's name and invocation ID made up); exec.stderr is a run's stderr with lines
// planted to look like systemd's, then the same summary with values in format_timespan's and format_bytes's
// multi-unit forms. The "test-run sandbox (real systemd)" CI job prints the real text and checks its shape
// against probe.stderr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from './script-child-process.js';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBytes, parseTimespan, sandboxHost, systemdRunStats } from '../src/testrun/host.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const fixtures = join(repoRoot, 'test', 'fixtures', 'systemd-run-255');
const fixture = (f: string) => readFileSync(join(fixtures, f), 'utf8');
const helperSrc = join(repoRoot, 'scripts', 'machine', 'worklane-testrun.sh');
const cut = (s: string, own: Array<[number, number]>) => {
  let rest = '';
  let at = 0;
  for (const [a, b] of own) (rest += s.slice(at, a)), (at = b);
  return rest + s.slice(at);
};

test('systemd timespans parse as format_timespan writes them', () => {
  const cases: Array<[string, number | null]> = [
    ['0', 0],
    ['30ms', 0.03],
    ['44ms', 0.044],
    ['1.234s', 1.234],
    ['1.000s', 1],
    ['2s', 2],
    ['1min', 60],
    ['1min 2.345s', 62.345],
    ['2h 3min 4s', 7384],
    ['1d 1h', 90_000],
    ['1w 2d', 777_600],
    ['5us', 5e-6],
    ['5µs', 5e-6],
    ['5μs', 5e-6],
    ['', null],
    ['1.2.3s', null],
    ['1 min', null],
    ['1min  2s', null],
    ['12sec', null],
    ['infinity', null],
  ];
  for (const [s, want] of cases) {
    const got = parseTimespan(s);
    if (want === null) assert.equal(got, null, s);
    else assert.ok(got !== null && Math.abs(got - want) < 1e-9, `${s}: ${got}`);
  }
});

test('systemd byte counts parse as format_bytes writes them (IEC, one digit below the point, B below 1K)', () => {
  const cases: Array<[string, number | null]> = [
    ['0B', 0],
    ['512B', 512 / 1048576],
    ['256.0K', 0.25],
    ['1.5M', 1.5],
    ['1.5G', 1536],
    ['2.0T', 2 * 1024 * 1024],
    ['12K', null],
    ['1.5GB', null],
    ['1.55G', null],
    ['1.5 G', null],
    ['', null],
  ];
  for (const [s, want] of cases) {
    const got = parseBytes(s);
    if (want === null) assert.equal(got, null, s);
    else assert.ok(got !== null && Math.abs(got - want) < 1e-9, `${s}: ${got}`);
  }
});

test('systemd-run 255\'s own lines: the unit line and the final summary are its, and only those', () => {
  const probe = fixture('probe.stderr');
  const p = systemdRunStats(probe);
  assert.deepEqual(p.stats, { cpuS: 0, memPeakMb: 0.3 });
  assert.equal(cut(probe, p.own), '', 'every line of the probe\'s stderr is systemd-run\'s');

  // GitHub's Ubuntu 24.04 runner (systemd 255.4-1ubuntu8.17), captured from the real-systemd job: its unit line has
  // no invocation ID, where the server's does. Both are systemd-run's own.
  const runner = fixture('probe-runner.stderr');
  const r = systemdRunStats(runner);
  assert.deepEqual(r.stats, { cpuS: 0, memPeakMb: 0.3 });
  assert.equal(cut(runner, r.own), '', 'every line of the runner\'s probe stderr is systemd-run\'s');

  // A run's own lines that look like systemd's stay its own; the stats come from the summary at the very end.
  const exec = fixture('exec.stderr');
  const e = systemdRunStats(exec);
  assert.deepEqual(e.stats, { cpuS: 61.3, memPeakMb: 1536 });
  assert.equal(cut(exec, e.own), 'err-line\nMemory peak: 999G\nCPU time consumed: 1h\nFinished with result: success\nMemory peak: 999G\nstill the run\'s\nno newline at the end');
});

test('a run\'s summary-like lines are never stats when systemd-run printed no summary (killed, or --quiet)', () => {
  for (const stderr of [
    'Memory peak: 999G\nCPU time consumed: 1h\n',
    'Finished with result: success\nCPU time consumed: 1h\nMemory peak: 999G\nthen more of the run\n',
    'Finished with result: success\nMemory peak: 999G\nCPU time consumed: 1h\n', // out of systemd's order
    'Finished with result: success\nMemory peak: 999 GB\n', // not format_bytes
  ]) {
    const s = systemdRunStats(stderr);
    assert.deepEqual(s.stats, { cpuS: null, memPeakMb: null }, stderr);
    assert.equal(cut(stderr, s.own), stderr, stderr);
  }
});

function fakeSudo(dir: string, script: string): string {
  const helper = join(dir, 'helper');
  writeFileSync(helper, `#!/bin/sh\n${script}`);
  chmodSync(helper, 0o755);
  const sudo = join(dir, 'sudo');
  writeFileSync(sudo, '#!/bin/sh\n[ "$1" = -n ] || exit 9\nshift\nexec "$@"\n');
  chmodSync(sudo, 0o755);
  return sudo;
}

test('the sandbox host: a run\'s output intact, systemd-run\'s lines out, its stats from the summary only', { skip: !posix && 'POSIX sh' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-sdrun-'));
  try {
    const sudo = fakeSudo(dir, `cat "${join(fixtures, 'exec.stdout')}"; cat "${join(fixtures, 'exec.stderr')}" >&2\n`);
    const host = sandboxHost('shop', join(dir, 'helper'), sudo);
    const r = await host.exec('fast-abc-1', 'npm test', {}, 60_000);
    assert.equal(r.code, 0);
    assert.deepEqual(r.stats, { cpuS: 61.3, memPeakMb: 1536 });
    for (const l of ['out-line', 'more out', 'err-line', 'Memory peak: 999G', 'CPU time consumed: 1h', 'still the run\'s', 'no newline at the end']) assert.ok(r.out.includes(l), l);
    assert.doesNotMatch(r.out, /Running as unit|Main processes terminated|Service runtime|Memory swap peak|1\.5G|1min/);
    assert.equal(r.out.match(/^Finished with result/gm)?.length, 1, 'only the run\'s planted one');

    const killed = fakeSudo(dir, 'echo "Memory peak: 999G" >&2; echo "CPU time consumed: 1h" >&2; exit 1\n');
    const k = await sandboxHost('shop', join(dir, 'helper'), killed).exec('fast-abc-1', 'x', {}, 60_000);
    assert.deepEqual(k.stats, { cpuS: null, memPeakMb: null });
    assert.match(k.out, /Memory peak: 999G/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sandbox host reads what the helper prints for it from stdout, whatever comes on stderr after', { skip: !posix && 'POSIX sh' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-sdrun-'));
  try {
    // git's and the helper's messages are on stderr, and may arrive after the answer on stdout.
    const sudo = fakeSudo(dir, `cat >/dev/null; case "$2" in db-start) echo "/var/lib/wlt/0123abcd/pg ${'b'.repeat(32)}" ;; *) echo /runs/x/work ;; esac; sleep 0.3; echo "warning: a message on stderr" >&2\n`);
    const host = sandboxHost('shop', join(dir, 'helper'), sudo);
    assert.equal(await host.cache('npm', 'a'.repeat(16)), '/runs/x/work');
    assert.equal(await host.shared('ports'), '/runs/x/work');
    assert.equal(await host.changedFiles('fast-abc-1', ['a.ts']), '/runs/x/work');
    const db = await host.startDb('fast-abc-1', { image: `postgres:16@sha256:${'a'.repeat(64)}`, name: 'test', readyS: 5, maxConnections: 200 });
    assert.equal(db.socketDir, '/var/lib/wlt/0123abcd/pg');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The helper's own check(), run with its real body and probe_passed, and stand-ins for everything that needs root:
 * exec_run prints the probe's stdout and systemd-run's stderr as real systemd 255 does.
 */
function helperCheck(execRun: string, extra = 'userns_ok() { USERNS_WHY="no wrapper here (a stand-in)"; return 1; }\nuserns_unsupported() { :; }') {
  const src = readFileSync(helperSrc, 'utf8');
  const body = (name: string) => src.slice(src.indexOf(`${name}() {`), src.indexOf('\n}\n', src.indexOf(`${name}() {`)) + 3);
  const stubs = [
    'user=wl-test-shop',
    'name=shop',
    'store=/nonexistent/store',
    'runuser() { shift 3; "$@"; }',
    'die() { echo "$*" >&2; exit 2; }',
    'id() { echo wl-test-shop; }',
    'sudo() { echo "User wl-test-shop is not allowed to run sudo on this host."; }',
    'protected_paths() { echo /nonexistent/protected; }',
    'probe_bundle() { :; }',
    'create() { cat >/dev/null; }',
    'wipe() { echo "wiped $1"; }',
    `exec_run() { cat >/dev/null; ${execRun}; }`,
    extra,
  ].join('\n');
  return spawnSync('bash', ['-c', `set -euo pipefail\n${stubs}\n${body('probe_passed')}${body('check')}check`, fixtures], { encoding: 'utf8' });
}

test('the helper\'s sandbox probe passes on the probe\'s own stdout, with systemd-run 255\'s lines on stderr', { skip: !posix && 'bash' }, () => {
  const real = 'cat "$0/probe.stdout"; cat "$0/probe.stderr" >&2; return 0';
  let r = helperCheck(real);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS a sandboxed run reaches none of them, and reads the object store without writing it$/m);
  assert.match(r.stdout, /^OK$/m);
  // A path the run reached, a probe that failed, or one that never printed "probed": each a FAIL, showing stderr.
  for (const bad of [
    'echo "open /root"; echo probed; cat "$0/probe.stderr" >&2; return 1',
    'echo "open /root"; echo probed; return 0',
    'echo probed; cat "$0/probe.stderr" >&2; return 1',
    'cat "$0/probe.stderr" >&2; return 0',
    'echo "probed and more"; return 0',
    'echo "systemd-run: failed to start" >&2; return 1',
  ]) {
    r = helperCheck(bad);
    assert.equal(r.status, 1, bad);
    assert.match(r.stdout, /^FAIL in the sandbox \(exit \d+\): /m, bad);
    assert.match(r.stdout, /^FAILED$/m, bad);
  }
  r = helperCheck('echo "systemd-run: failed to start" >&2; return 1');
  assert.match(r.stdout, /^ {2}stderr: systemd-run: failed to start$/m, 'systemd-run\'s stderr is shown');
});

test('#545: the helper\'s check: with the wrapper, a run in a user namespace of its own (only the test user\'s uid, mapped to itself) or a FAIL; without it a NOTE, never a FAIL (a helper the updater installed first keeps test runs on)', { skip: !posix && 'bash' }, () => {
  const own = 'userns_ok() { return 0; }\nid() { if [ "$1" = -u ]; then echo 1003; else echo wl-test-shop; fi; }';
  let r = helperCheck('cat "$0/probe.stdout"; echo "uid_map 1003 1003 1"; return 0', own);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS a sandboxed run is in a user namespace of its own \(only wl-test-shop's uid mapped, to itself\)$/m);
  for (const map of ['uid_map 0 0 4294967295', 'uid_map 0 1003 1', '']) {
    r = helperCheck(`cat "$0/probe.stdout"; echo "${map}"; return 0`, own);
    assert.equal(r.status, 1, map);
    assert.match(r.stdout, /^FAIL a sandboxed run isn't in a user namespace of its own: /m, map);
  }
  r = helperCheck('cat "$0/probe.stdout"; echo "uid_map 0 0 4294967295"; return 0');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^NOTE a sandboxed run shares the host's user namespace \(no wrapper here \(a stand-in\)\), so it can join the namespaces of wl-test-shop's rootless Docker/m);
  assert.doesNotMatch(r.stdout, /^FAIL/m);
  assert.doesNotMatch(r.stdout, /userns-unsupported/, 'a machine that can have the wrapper (install not yet run again) says no more');
});

test('#545 round 9 (c): on a machine that can\'t have the wrapper, the helper\'s check adds NOTE userns-unsupported with the fix, and still passes (test runs stay on); with the wrapper, never', { skip: !posix && 'bash' }, () => {
  const probe = 'cat "$0/probe.stdout"; echo "uid_map 0 0 4294967295"; return 0';
  const old = 'userns_ok() { USERNS_WHY="no wrapper here (a stand-in)"; return 1; }\nuserns_unsupported() { echo "/usr/bin/unshare takes no --map-current-user or --keep-caps"; }';
  let r = helperCheck(probe, old);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^OK$/m);
  assert.doesNotMatch(r.stdout, /^FAIL/m);
  assert.ok(r.stdout.split('\n').includes("NOTE userns-unsupported: this machine's unshare can't be the test runs' wrapper (/usr/bin/unshare takes no --map-current-user or --keep-caps): install util-linux 2.38 or later and setpriv, then run scripts/setup/test-user.sh install shop again"), r.stdout);
  const own = 'userns_ok() { return 0; }\nuserns_unsupported() { echo "never asked"; }\nid() { if [ "$1" = -u ]; then echo 1003; else echo wl-test-shop; fi; }';
  r = helperCheck('cat "$0/probe.stdout"; echo "uid_map 1003 1003 1"; return 0', own);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /userns-unsupported|never asked/);
});
