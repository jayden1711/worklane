// The engine and its root-owned sandbox helper speak one protocol: an engine that finds an older helper (one installed
// before an engine update changed its arguments) starts no test run, raises one incident and posts a check that says
// how to fix it; a setup step that fails says which, with its stderr, in the check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config/load.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { postChecks } from '../src/testrun/checks.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { checkHelper, HELPER_PROTOCOL, helperFix } from '../src/testrun/helper.js';
import { sandboxHost } from '../src/testrun/host.js';
import { checkNamesFor, startTestRun, useTestRuns } from '../src/testrun/index.js';
import { runTestRun } from '../src/testrun/run.js';
import { setupTestRuns } from '../src/testrun/setup.js';
import { testRunStatus } from '../src/testrun/status.js';
import { readIncidents } from '../src/watchdog/incidents.js';
import { INSTANCE_KINDS, instanceFindings, reconcile } from '../src/watchdog/probes.js';
import { exampleProject, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const machineDir = join(repoRoot, 'scripts', 'machine');
const currentHelper = join(machineDir, 'worklane-testrun.sh');
/** The helper as installed before db-start took max_connections: sha256 0da4b260..., byte for byte. */
const oldHelper = join(repoRoot, 'test', 'fixtures', 'testrun-helper-protocol-1.sh');
const pin = 'postgres:16@sha256:' + 'a'.repeat(64);
const SHA = 'c'.repeat(40);

/**
 * A helper source made runnable here as it runs on a server: its tools stubbed (the test user "exists"), its paths in
 * a temp dir, and a stand-in sudo that logs each call's arguments and runs it.
 */
function stubbedHelper(src: string) {
  const dir = mkdtempSync(join(tmpdir(), 'helper-proto-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  for (const t of ['systemd-run', 'systemctl', 'git', 'getent', 'install', 'stat', 'id']) stub(t, 'exit 0');
  stub('runuser', 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  for (const t of ['od', 'tr', 'seq', 'sed', 'head', 'sleep', 'env', 'cat']) {
    const real = ['/usr/bin', '/bin'].map((d) => join(d, t)).find((p) => existsSync(p));
    if (real) symlinkSync(real, join(bin, t));
  }
  let text = readFileSync(src, 'utf8');
  for (const [re, to] of [
    [/^export PATH=\S+$/m, `export PATH=${bin}`],
    [/^BASE=\S+$/m, `BASE=${join(dir, 'base')}`],
  ] as const) {
    assert.match(text, re);
    text = text.replace(re, to);
  }
  const helper = join(dir, 'worklane-testrun');
  writeFileSync(helper, text);
  chmodSync(helper, 0o755);
  const log = join(dir, 'calls');
  const sudo = join(dir, 'sudo');
  writeFileSync(sudo, `#!/bin/sh\n[ "$1" = -n ] || exit 9\nshift\nshift\nprintf '%s\\n' "$*" >> "${log}"\nexec /bin/bash "${helper}" "$@"\n`);
  chmodSync(sudo, 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return { dir, helper, sudo, calls, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const testRun = {
  setup: ['npm ci'],
  tiers: [
    { name: 'chain', command: 'npm run chain', kind: 'fast', database: true },
    { name: 'lint', command: 'npm run lint', kind: 'fast' },
  ],
  database: { image: pin },
  checks: { chain: 'test / chain', lint: 'test / lint' },
};

function fakeGitHub() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify({ id: 1 }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls, outputs: () => calls.map((c) => c.body.output as { title: string; summary: string }) };
}

test('the helper\'s PROTOCOL is the engine\'s HELPER_PROTOCOL, and `version` prints it before anything else is checked', { skip: !posix && 'bash' }, () => {
  const src = readFileSync(currentHelper, 'utf8');
  assert.equal(/^PROTOCOL=(\d+)$/m.exec(src)?.[1], String(HELPER_PROTOCOL), 'scripts/machine/worklane-testrun.sh PROTOCOL and src/testrun/helper.ts HELPER_PROTOCOL change together');
  const h = stubbedHelper(currentHelper);
  try {
    const r = spawnSync('/bin/bash', [h.helper, 'shop', 'version'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${HELPER_PROTOCOL}\n`);
    assert.equal(spawnSync('/bin/bash', [h.helper, 'shop', 'version', 'x'], { encoding: 'utf8' }).status, 2, 'version takes no argument');
    // Only its own instance's coordinator may ask, as for every command.
    const other = spawnSync('/bin/bash', [h.helper, 'shop', 'version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', SUDO_USER: 'wl-other' } });
    assert.equal(other.status, 2);
    assert.match(other.stderr, /wl-other may not use shop's test runs/);
  } finally {
    h.done();
  }
});

test('an old helper with no `version` (it dies "unknown command") is outdated, and so is one of another protocol', { skip: !posix && 'bash' }, async () => {
  const old = stubbedHelper(oldHelper);
  try {
    const host = sandboxHost('shop', old.helper, old.sudo);
    const v = await host.helperVersion();
    assert.equal(v.version, null);
    assert.match(v.stderr, /unknown command version/);
    const s = await checkHelper(host, 'shop');
    assert.equal(s.ok, false);
    assert.equal(s.have, null);
    assert.equal(s.need, HELPER_PROTOCOL);
    assert.match(s.detail, /older than this engine \(it has no version command/);
    assert.ok(s.detail.endsWith(helperFix('shop')), s.detail);
  } finally {
    old.done();
  }
  const dir = mkdtempSync(join(tmpdir(), 'helper-proto-'));
  const sudo = join(dir, 'sudo');
  writeFileSync(sudo, '#!/bin/sh\necho 1\n');
  chmodSync(sudo, 0o755);
  const s = await checkHelper(sandboxHost('shop', '/nowhere', sudo), 'shop');
  assert.deepEqual([s.ok, s.have], [false, 1]);
  assert.match(s.detail, new RegExp(`speaks protocol 1, this engine needs ${HELPER_PROTOCOL}`));
  writeFileSync(sudo, `#!/bin/sh\necho ${HELPER_PROTOCOL}\n`);
  assert.equal((await checkHelper(sandboxHost('shop', '/nowhere', sudo), 'shop')).ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test('a helper that takes db-start with 4 arguments only (installed before max_connections): no run starts, one incident, a check that says the fix', { skip: !posix && 'bash' }, async () => {
  const old = stubbedHelper(oldHelper);
  const p = exampleProject();
  const base = mkdtempSync(join(tmpdir(), 'helper-proto-'));
  const log = new EventLog(join(base, 'events.db'));
  const incidents = join(base, 'incidents');
  try {
    // The fixture really is that helper: 5 arguments are refused with its 4-argument usage.
    const dbStart = spawnSync('/bin/bash', [old.helper, 'shop', 'db-start', 'fast-x-1', pin, 'test', '60', '200'], { encoding: 'utf8' });
    assert.equal(dbStart.status, 2);
    assert.match(dbStart.stderr, /usage: db-start <id> <image@sha256:\.\.\.> <db> <ready_s>$/m);

    const host = sandboxHost('shop', old.helper, old.sudo);
    const config = TestRunConfig.parse(testRun);
    const cfg = { tests: { test_run: config } } as unknown as Config;
    const runs = await setupTestRuns(cfg, { instance: 'shop', repo: 'example-org/example-shop', token: async () => 't', host }, { log, actor: 'shop', root: p.dir, stateDir: p.stateDir });
    assert.ok(runs, 'set up, so each PR still gets a check');
    const helperEv = log.read(0, ['testrun.helper']).map((e) => e.payload as EventPayload<'testrun.helper'>);
    assert.equal(helperEv.length, 1);
    assert.deepEqual([helperEv[0]!.ok, helperEv[0]!.have, helperEv[0]!.need], [false, null, HELPER_PROTOCOL]);
    assert.equal(log.read(0, ['testrun.sandbox']).length, 0, "the outdated helper's own check is not taken as this engine's");

    // Two PRs' runs: neither starts anything; each result says why.
    const gh = fakeGitHub();
    for (const pr of [1, 2]) {
      const result = await startTestRun({ repo: p.dir, sha: SHA, kind: 'fast', prs: [pr] });
      assert.equal(result.ok, false);
      assert.equal(result.outcome, 'error');
      assert.equal(result.setup?.step, 'helper');
      await postChecks({ repo: 'example-org/example-shop', token: async () => 't', log, actor: 'shop', fetch: gh.f, api: 'https://gh.test' }, SHA, result, checkNamesFor(config));
    }
    assert.deepEqual(old.calls(), ['shop version'], 'the helper was asked its version once, and nothing else: no create, no db-start');
    assert.equal(log.read(0, ['testrun.started']).length, 0, 'no run started');
    assert.deepEqual(log.read(0, ['testrun.finished']).map((e) => (e.payload as EventPayload<'testrun.finished'>).outcome), ['error', 'error']);

    // The checks: one per check name per run, each saying exactly what is wrong and the fix; never "0 s".
    assert.equal(gh.calls.length, 4);
    for (const c of gh.calls) assert.equal(c.body.conclusion, 'failure');
    for (const o of gh.outputs()) {
      assert.equal(o.title, 'Not run: the test sandbox helper is outdated');
      assert.ok(o.summary.includes(helperFix('shop')), o.summary);
      assert.match(o.summary, /older than this engine \(it has no version command/);
      assert.match(o.summary, /worklane-testrun: unknown command version/, "the helper's own words, from its stderr");
      assert.doesNotMatch(o.summary, /\(0 s\)/);
    }
    assert.equal(helperFix('shop'), 'sudo bash /opt/worklane/current/scripts/setup/test-user.sh update-helper, then restart the instance: sudo systemctl restart worklane-shop.service');

    // The watchdog: one helper_outdated incident for the instance, however many passes, with the same fix.
    for (let i = 0; i < 3; i++) reconcile(instanceFindings({ instance: 'shop', events: log.read(0), now: Date.now(), stop: null, auth: null, githubTokenError: null, emergency: false }), { kinds: INSTANCE_KINDS, instance: 'shop' }, { dir: incidents });
    const open = readIncidents(incidents).incidents.filter((x) => !x.resolvedAt);
    assert.deepEqual(open.map((x) => [x.kind, x.key, x.instance, x.severity]), [['helper_outdated', 'shop', 'shop', 'red']]);
    assert.equal(open[0]!.fix, helperFix('shop'));
    assert.match(testRunStatus(log.read(0)).problems[0]!, /^Test runs are off: the test sandbox helper is older than this engine/);

    // Reinstalled (the current helper) and the instance restarted: ok, and the incident resolves.
    const cur = stubbedHelper(currentHelper);
    try {
      await setupTestRuns(cfg, { instance: 'shop', repo: 'example-org/example-shop', token: async () => 't', host: sandboxHost('shop', cur.helper, cur.sudo) }, { log, actor: 'shop', root: p.dir, stateDir: p.stateDir });
      assert.equal((log.read(0, ['testrun.helper']).at(-1)!.payload as EventPayload<'testrun.helper'>).ok, true);
      reconcile(instanceFindings({ instance: 'shop', events: log.read(0), now: Date.now(), stop: null, auth: null, githubTokenError: null, emergency: false }), { kinds: INSTANCE_KINDS, instance: 'shop' }, { dir: incidents });
      assert.equal(readIncidents(incidents).incidents.filter((x) => !x.resolvedAt && x.kind === 'helper_outdated').length, 0);
    } finally {
      cur.done();
    }
  } finally {
    useTestRuns(null);
    old.done();
    rmSync(base, { recursive: true, force: true });
  }
});

test('a db-start that fails: the check names the step and shows the last 20 lines of its stderr, redacted, never its stdout', { skip: !posix && 'POSIX sh' }, async () => {
  const p = exampleProject();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.dir, encoding: 'utf8' }).trim();
  const dir = mkdtempSync(join(tmpdir(), 'helper-proto-'));
  const helper = join(dir, 'helper');
  const pw = 'f'.repeat(32);
  const token = `ghp_${'A'.repeat(36)}`;
  // A helper whose db-start prints a password on stdout (as a successful one does) and then fails, saying 30 lines
  // and two secrets on stderr.
  writeFileSync(
    helper,
    `#!/bin/sh
case "$2" in
  version) echo ${HELPER_PROTOCOL} ;;
  create) cat > /dev/null; echo "$4/runs/$3/work" ;;
  db-start)
    echo "45678 ${pw}"
    i=1; while [ $i -le 30 ]; do echo "db-start line $i" >&2; i=$((i + 1)); done
    echo "pulling with token ${token}" >&2
    echo "worklane-testrun: worklane-test-shop-$3 wasn't ready after 60s (postgres://postgres:hunter2pass@127.0.0.1:45678/test)" >&2
    exit 1 ;;
  wipe) echo "wiped $3" ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(helper, 0o755);
  const sudo = join(dir, 'sudo');
  writeFileSync(sudo, '#!/bin/sh\n[ "$1" = -n ] || exit 9\nshift\nexec "$@"\n');
  chmodSync(sudo, 0o755);
  const slots = join(dir, 'slots');
  mkdirSync(slots);
  writeFileSync(join(slots, 'config.json'), JSON.stringify({ max_agents: 1, max_test_runs: 1 }));
  const log = new EventLog(join(dir, 'events.db'));
  const host = sandboxHost('shop', helper, sudo);
  const config = TestRunConfig.parse(testRun);
  try {
    const result = await runTestRun(
      { config, host, repo: p.dir, log, actor: 'shop', logDir: join(dir, 'logs'), slotsDir: slots, slotPollMs: 20, lock: async () => ({ release: async () => {} }), helper: await checkHelper(host, 'shop') },
      { repo: p.dir, sha, kind: 'fast', prs: [7] },
    );
    assert.equal(result.outcome, 'error');
    assert.equal(result.setup?.step, 'db-start');
    const gh = fakeGitHub();
    await postChecks({ repo: 'example-org/example-shop', token: async () => 't', log, actor: 'shop', fetch: gh.f, api: 'https://gh.test' }, '0'.repeat(40), result, checkNamesFor(config));
    for (const o of gh.outputs()) {
      assert.equal(o.title, 'Failed in setup: db-start');
      assert.match(o.summary, /Setup failed at \*\*db-start\*\*: starting run [a-z0-9-]+'s database failed \(exit 1\)\n/);
      assert.match(o.summary, /The last lines of its stderr \(redacted\):/);
      // The last 20 lines: 18 numbered ones (13..30) and the two with secrets.
      assert.match(o.summary, /db-start line 13\n/);
      assert.match(o.summary, /db-start line 30\n/);
      assert.doesNotMatch(o.summary, /db-start line 12\n/);
      assert.match(o.summary, /wasn't ready after 60s/);
      assert.ok(!o.summary.includes(pw), 'never the stdout (the password db-start prints)');
      assert.ok(!o.summary.includes(token), 'a token is redacted');
      assert.ok(!o.summary.includes('hunter2pass'), "a connection string's password is redacted");
      assert.match(o.summary, /- not run: (chain|lint)\n/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
