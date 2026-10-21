// #545 round 9: on a machine whose unshare can't be the test runs' wrapper (util-linux older than 2.38, or no
// setpriv), test runs keep sharing the host's user namespace. The owner's decision: test-user.sh check, run by hand,
// fails and names the fix; install's own check and the helper's check (which keeps test runs on) only note it; doctor
// and the Machine page show it in red. Nothing that turns test runs off, fails install or rolls an update back reads
// it. Stand-ins only: no real unshare, setpriv, systemctl or sudo runs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usernsCheck } from '../src/doctor.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { localHost, sandboxHost, usernsUnsupported } from '../src/testrun/host.js';
import { runTestRun, type TestRunDeps } from '../src/testrun/run.js';
import { SandboxWatch } from '../src/testrun/sandbox-watch.js';
import { sandboxVerdict, testRunStatus, testRunsView, usernsUnsupportedProblem } from '../src/testrun/status.js';
import { exampleProject, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const tuSrc = readFileSync(join(repoRoot, 'scripts', 'setup', 'test-user.sh'), 'utf8');
const helperSrc = readFileSync(join(repoRoot, 'scripts', 'machine', 'worklane-testrun.sh'), 'utf8');
const real = (t: string) => ['/usr/bin', '/bin'].map((d) => join(d, t)).find((p) => existsSync(p));
const fnOf = (s: string, name: string) => {
  const at = s.indexOf(`\n${name}() {`);
  assert.ok(at >= 0, `${name} is defined`);
  return s.slice(at + 1, s.indexOf('\n}\n', at) + 3);
};

const WHY = "this machine's unshare can't be the test runs' wrapper";
const FIX = 'install util-linux 2.38 or later and setpriv, then run';
const OLD_HELP = 'Usage:\n unshare [options] [<program> [<argument>...]]\n -U, --user\n -r, --map-root-user\n';
const NEW_HELP = `${OLD_HELP} -c, --map-current-user\n     --keep-caps\n`;
const OWN = "PASS a sandboxed run is in a user namespace of its own (only wl-test-shop's uid mapped, to itself)\nOK";
const OPEN = "NOTE a sandboxed run shares the host's user namespace (no wrapper here), so it can join the namespaces of wl-test-shop's rootless Docker\nOK";
const NOTE = `NOTE userns-unsupported: ${WHY} (/usr/bin/unshare takes no --map-current-user or --keep-caps): ${FIX} scripts/setup/test-user.sh install shop again`;

/**
 * test-user.sh's check, as it runs from each route: `check` (the script's own dispatch, the case block at its end) or
 * install's last step (its `check_cmd ...` line, verbatim). Its own functions; the machine stubbed: the boundaries,
 * systemctl, Docker's cgroups, the wrapper's owner and ACL, unshare (the help it prints), setpriv (there or not), and
 * the helper's check (what it prints).
 */
function testUserCheck(route: 'check' | 'install', o: { help: string; setpriv: boolean; helperOut: string; helperRc?: number }) {
  const dir = tmp('tu-check-');
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const t of ['grep', 'head', 'cmp', 'env', 'tr', 'awk', 'cat', 'bash']) {
      const p = real(t);
      if (p) symlinkSync(p, join(bin, t));
    }
    if (o.setpriv) {
      writeFileSync(join(bin, 'setpriv'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'setpriv'), 0o755);
    }
    mkdirSync(join(dir, 'machine'));
    const helper = `#!/bin/bash\nprintf '%s\\n' "$HELPER_OUT"\nexit "\${HELPER_RC:-0}"\n`;
    for (const p of [join(dir, 'helper'), join(dir, 'machine', 'worklane-testrun.sh')]) {
      writeFileSync(p, helper);
      chmodSync(p, 0o755);
    }
    writeFileSync(join(dir, 'userns'), 'a stand-in wrapper\n');
    const dispatch = tuSrc.slice(tuSrc.lastIndexOf('\ncase "$cmd" in\n') + 1, tuSrc.indexOf('\nesac', tuSrc.lastIndexOf('\ncase "$cmd" in\n')) + 5);
    assert.match(dispatch, /^case "\$cmd" in\n {2}install\) install_cmd ;;/);
    const installLine = /^ {2}check_cmd\b.*$/m.exec(fnOf(tuSrc, 'install_cmd'))?.[0];
    assert.ok(installLine, 'install runs check_cmd');
    const fns = ['userns_unsupported_why', 'userns_supported', 'service_checks', 'userns_check', 'check_cmd'].map((n) => fnOf(tuSrc, n)).join('');
    const stubs = [
      'set -euo pipefail',
      `PATH=${bin}`,
      `user=wl-test-shop name=shop helper=${dir}/helper machine_dir=${dir}/machine userns_bin=${dir}/userns docker_unit_name=worklane-test-shop-docker.service`,
      'say() { :; }',
      'id() { echo 1003; }',
      'access_checks() { echo "PASS the boundaries (a stand-in)"; }',
      'systemctl() { case "$1" in show) if [ "$2" = worklane.slice ]; then echo 100; else echo 10; fi ;; list-units) : ;; is-active) return 0 ;; esac; }',
      'docker_cgroup_check() { echo "PASS Docker\'s cgroups (a stand-in)"; }',
      'stat() { echo root:root; }',
      'userns_acl_ok() { return 0; }',
      'getfacl() { :; }',
      'unshare() { case "$1" in --help) printf "%s" "$UNSHARE_HELP" ;; --version) echo "unshare from util-linux 2.37.2" ;; esac; }',
      'install_cmd() { echo "not this route"; exit 9; }',
    ].join('\n');
    const call = route === 'check' ? 'cmd=check\n' + dispatch : installLine;
    return spawnSync(real('bash') ?? 'bash', ['-c', `${stubs}\n${fns}\n${call}`], { encoding: 'utf8', env: { UNSHARE_HELP: o.help, HELPER_OUT: o.helperOut, HELPER_RC: String(o.helperRc ?? 0) } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('#545 round 9 (a): test-user.sh check, run by hand, fails on an unshare older than util-linux 2.38 or no setpriv, naming the fix; install\'s own check only notes it, so install goes on', { skip: !posix && 'bash' }, () => {
  // "By hand" is the invocation: the check command's dispatch passes standalone, install's check line doesn't.
  assert.match(tuSrc, /^ {2}check\) check_cmd standalone ;;$/m);
  assert.doesNotMatch(fnOf(tuSrc, 'install_cmd'), /check_cmd standalone/);
  for (const [help, setpriv, why] of [
    [OLD_HELP, true, 'unshare from util-linux 2.37.2: no --map-current-user or --keep-caps'],
    [NEW_HELP, false, 'no setpriv'],
    ['', true, 'unshare from util-linux 2.37.2: no --map-current-user or --keep-caps'],
  ] as const) {
    const fixLine = `${WHY} (${why}): ${FIX} test-user.sh install shop again`;
    const byHand = testUserCheck('check', { help, setpriv, helperOut: `${OPEN}\n${NOTE}` });
    assert.equal(byHand.status, 1, byHand.stdout + byHand.stderr);
    assert.ok(byHand.stdout.split('\n').includes(`FAIL ${fixLine}`), byHand.stdout);
    assert.match(byHand.stderr, /^FAILED: see the FAIL lines above$/m);
    assert.doesNotMatch(byHand.stdout, /^OK: all checks passed$/m);
    const install = testUserCheck('install', { help, setpriv, helperOut: `${OPEN}\n${NOTE}` });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    assert.ok(install.stdout.split('\n').includes(`NOTE ${fixLine}. Until then runs share the host's user namespace (docs/test-runs.md, "Known gap")`), install.stdout);
    assert.doesNotMatch(install.stdout, /^FAIL/m);
    assert.match(install.stdout, /^OK: all checks passed$/m);
  }
  // Where the wrapper can be and runs are in their own user namespace, both routes pass.
  for (const route of ['check', 'install'] as const) {
    const ok = testUserCheck(route, { help: NEW_HELP, setpriv: true, helperOut: OWN });
    assert.equal(ok.status, 0, `${route}: ${ok.stdout}${ok.stderr}`);
    assert.match(ok.stdout, /^PASS .*userns is root:root, and only the test users may run it$/m);
    assert.match(ok.stdout, /^OK: all checks passed$/m);
  }
});

test('#545 round 9 adversarial: check by hand never ends OK while a run shares the host\'s user namespace, whatever the reason (the helper\'s own check passes with a NOTE there); install\'s check stays as it was', { skip: !posix && 'bash' }, () => {
  // The machine can have the wrapper, the wrapper is root's with the right ACL, but the helper still runs in the host's
  // user namespace (e.g. its AppArmor profile isn't loaded where the kernel restricts user namespaces).
  const byHand = testUserCheck('check', { help: NEW_HELP, setpriv: true, helperOut: OPEN });
  assert.equal(byHand.status, 1, byHand.stdout + byHand.stderr);
  assert.ok(byHand.stdout.split('\n').includes("FAIL a sandboxed run shares the host's user namespace (the helper's NOTE above says why), so it can join the namespaces of wl-test-shop's rootless Docker: fix that, then run test-user.sh install shop again"), byHand.stdout);
  const install = testUserCheck('install', { help: NEW_HELP, setpriv: true, helperOut: OPEN });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  assert.match(install.stdout, /^OK: all checks passed$/m);
  // A helper check that failed is a FAIL either way, and gets no second line.
  for (const route of ['check', 'install'] as const) {
    const failed = testUserCheck(route, { help: NEW_HELP, setpriv: true, helperOut: 'FAIL in the sandbox (exit 1): x\nFAILED', helperRc: 1 });
    assert.equal(failed.status, 1, route);
    assert.doesNotMatch(failed.stdout, /^FAIL a sandboxed run shares/m, route);
  }
});

test('#545 round 9 (c): the helper says userns-unsupported only where the machine\'s unshare (read, never run) lacks the options or there\'s no setpriv', { skip: !posix && 'bash' }, () => {
  const dir = tmp('helper-unsupported-');
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    symlinkSync(real('grep')!, join(bin, 'grep'));
    const run = (unshare: string | null, setpriv: boolean) => {
      for (const n of ['unshare', 'setpriv']) rmSync(join(bin, n), { force: true });
      if (unshare !== null) {
        // Bytes as a binary holds its option names: never executed (no shebang, and the helper only greps it).
        writeFileSync(join(bin, 'unshare'), Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1]), Buffer.from(unshare), Buffer.from([0, 0])]));
        chmodSync(join(bin, 'unshare'), 0o755);
      }
      if (setpriv) {
        writeFileSync(join(bin, 'setpriv'), '#!/bin/sh\nexit 0\n');
        chmodSync(join(bin, 'setpriv'), 0o755);
      }
      return spawnSync(real('bash') ?? 'bash', ['-c', `set -euo pipefail\nPATH=${bin}\n${fnOf(helperSrc, 'userns_unsupported')}userns_unsupported`], { encoding: 'utf8' }).stdout.trim();
    };
    assert.equal(run('user\0map-root-user\0map-current-user\0keep-caps\0', true), '');
    assert.equal(run('user\0map-root-user\0', true), `${bin}/unshare takes no --map-current-user or --keep-caps`);
    assert.equal(run('user\0map-current-user\0', true), `${bin}/unshare takes no --map-current-user or --keep-caps`);
    assert.equal(run('user\0map-current-user\0keep-caps\0', false), 'no setpriv');
    assert.equal(run(null, true), 'no unshare');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A stand-in helper whose check prints `out` (exit `code`), behind a stand-in sudo, for the engine's sandbox host. */
function fakeHelper(out: string, code = 0) {
  const dir = tmp('helper-check-');
  const helper = join(dir, 'helper');
  writeFileSync(helper, `printf '%s\\n' '${out.replaceAll("'", "'\\''")}'\nexit ${code}\n`);
  const sudo = join(dir, 'sudo');
  writeFileSync(sudo, `#!/bin/sh\n[ "$1" = -n ] || exit 9\nshift\nshift\nexec /bin/bash "${helper}" "$@"\n`);
  chmodSync(sudo, 0o755);
  return { host: sandboxHost('shop', helper, sudo), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('#545 round 9 (c): the engine reads the helper\'s userns-unsupported line apart from ok: a check that passed stays ok, one that failed stays failed', { skip: !posix && 'bash' }, async () => {
  const why = `${WHY} (/usr/bin/unshare takes no --map-current-user or --keep-caps): ${FIX} scripts/setup/test-user.sh install shop again`;
  assert.equal(usernsUnsupported(`PASS x\n${NOTE}\nOK\n`), why);
  assert.equal(usernsUnsupported(`PASS x\n${OPEN}\n`), null);
  assert.equal(usernsUnsupported(`  ${NOTE}\n`), null, 'its own line only');
  let h = fakeHelper(`PASS a sandboxed run reaches none of them\n${OPEN.split('\n')[0]}\n${NOTE}\nOK`);
  try {
    assert.deepEqual(await h.host.check(), { ok: true, detail: 'all checks passed', unsupported: why });
  } finally {
    h.done();
  }
  h = fakeHelper(`FAIL in the sandbox (exit 1): x\n${NOTE}\nFAILED`, 1);
  try {
    assert.deepEqual(await h.host.check(), { ok: false, detail: 'FAIL in the sandbox (exit 1): x\nFAILED', unsupported: why });
  } finally {
    h.done();
  }
  h = fakeHelper(OWN);
  try {
    assert.deepEqual(await h.host.check(), { ok: true, detail: 'all checks passed' });
  } finally {
    h.done();
  }
});

test('#545 round 9 (c): a check that passed with userns-unsupported keeps test runs on (the watch, a run, the updater\'s verdict) and shows a red problem with the fix (the Machine page, health); doctor fails on it, read-only', { skip: !posix && 'bash' }, async () => {
  const why = `${WHY} (no setpriv): ${FIX} scripts/setup/test-user.sh install shop again`;
  const dir = tmp('userns-unsupported-');
  try {
    const db = join(dir, 'events.db');
    const log = new EventLog(db);
    let passed = 0;
    const w = new SandboxWatch({ check: async () => ({ ok: true, detail: 'all checks passed', unsupported: why }), log, actor: 'shop', passed: () => void passed++, timer: () => ({ cancel() {} }) });
    assert.equal(await w.check(), true);
    assert.equal(w.ok, true, 'the gate a run reads is open');
    assert.equal(passed, 1, 'the runs are told to go on');
    // The same result again writes nothing new; the machine fixed (no line) is a change, recorded.
    await w.check();
    const events = log.read(0, ['testrun.sandbox', 'testrun.helper']);
    assert.deepEqual(events.map((e) => e.payload as EventPayload<'testrun.sandbox'>), [{ ok: true, detail: 'all checks passed', unsupported: why }]);
    // The updater's verdict (the sandbox-status command's `last`) and its comparison across an update: a pass.
    const last = sandboxVerdict(events);
    assert.deepEqual(last && { ok: last.ok, detail: last.detail }, { ok: true, detail: 'all checks passed' });
    const u = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as { sandboxVerdict(b: unknown, a: unknown, t: number): string };
    const before = { configured: true, last: { ok: true, detail: 'all checks passed', at: new Date(0).toISOString() } };
    assert.equal(u.sandboxVerdict(before, { configured: true, last }, 0), 'pass', 'an update rolls back on nothing here');
    // A run with this watch as its gate runs (the engine's local host, an example project): started, and passed.
    const p = exampleProject();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.dir, encoding: 'utf8' }).trim();
    const slots = join(dir, 'slots');
    mkdirSync(slots);
    writeFileSync(join(slots, 'config.json'), JSON.stringify({ max_agents: 2, max_test_runs: 2 }));
    writeFileSync(join(dir, 'full-run.lock'), '');
    const config = TestRunConfig.parse({ tiers: [{ name: 'unit', command: 'echo unit ok', kind: 'fast' }], checks: { unit: 'test / unit' } });
    const deps: TestRunDeps = { config, host: localHost(join(dir, 'host')), repo: p.dir, log, actor: 'shop', logDir: join(dir, 'logs'), lockPath: join(dir, 'full-run.lock'), slotsDir: slots, slotPollMs: 50, sandbox: w };
    const ran = await runTestRun(deps, { repo: p.dir, sha, kind: 'fast', prs: [1] });
    assert.equal(ran.setup?.step, undefined, JSON.stringify(ran.setup));
    assert.equal(ran.ok, true, JSON.stringify(ran));
    assert.equal(log.read(0, ['testrun.started']).length, 1, 'the run started');
    // Fail-without of this harness: the same run with a gate that failed starts nothing.
    const off = await runTestRun({ ...deps, sandbox: { ok: false, detail: 'FAIL x' } }, { repo: p.dir, sha, kind: 'fast', prs: [2] });
    assert.equal(off.setup?.step, 'sandbox');
    assert.equal(log.read(0, ['testrun.started']).length, 1);
    // Shown, in red: the Machine page's problems (health's suggestions take the same list), with the fix.
    const st = testRunStatus(events);
    assert.equal(st.sandbox?.ok, true);
    assert.equal(st.sandbox?.unsupported, why);
    assert.deepEqual(st.problems, [usernsUnsupportedProblem(why)]);
    assert.match(st.problems[0]!, /share the host's user namespace[\s\S]*install util-linux 2\.38 or later and setpriv, then run scripts\/setup\/test-user\.sh install shop again\. Test runs go on meanwhile; this doesn't turn them off\.$/);
    assert.doesNotMatch(st.problems[0]!, /Test runs are off/);
    const view = testRunsView({ events, configured: true, writer: true, cap: 2, slots: [], lock: { path: '/x', holders: [] } }) as { problems: string[] };
    assert.deepEqual(view.problems, [usernsUnsupportedProblem(why)]);
    assert.equal((testRunsView({ events, configured: true, writer: false, cap: 2, slots: [], lock: { path: '/x', holders: [] } }) as { problems?: string[] }).problems, undefined, 'never a viewer\'s');
    // doctor: a failing check with the same line, read from the instance's log read-only.
    log.close();
    const c = usernsCheck('shop', db);
    assert.deepEqual(c, { name: 'test runs shop', level: 'fail', detail: usernsUnsupportedProblem(why) });
    assert.equal(usernsCheck('shop', join(dir, 'none.db')), null, 'no log: nothing');
    assert.equal(existsSync(join(dir, 'none.db')), false, 'and none made');
    // The newest check decides: once the machine is fixed (no line), neither doctor nor the page says it.
    const log2 = new EventLog(db);
    log2.append('testrun.sandbox', { ok: true, detail: 'all checks passed' }, 'shop');
    assert.deepEqual(testRunStatus(log2.read(0)).problems, []);
    log2.close();
    assert.equal(usernsCheck('shop', db), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
