// A tier stopped at its own cap (test_run.tiers[].timeout_s): the sandbox's unit ends at its RuntimeMaxSec, and the
// tier's check says it timed out, after how long, naming the tier, instead of looking like any other failure. Each
// tier's unit gets that tier's own cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { localHost, sandboxHost, systemdRunStats, type RunHost } from '../src/testrun/host.js';
import { runTestRun, type TestRunDeps } from '../src/testrun/run.js';
import { timedOutLine } from '../src/testrun/timeout.js';
import { exampleProject } from './helpers.js';

const posix = process.platform !== 'win32';
const hasPerl = posix && (() => {
  try {
    execFileSync('perl', ['-e', '1']);
    return true;
  } catch {
    return false;
  }
})();

// systemd 255's lines for a unit stopped at its RuntimeMaxSec (src/run/run.c), as systemd-run --wait prints them.
const TIMED_OUT = 'Finished with result: timeout\nMain processes terminated with: code=killed/status=TERM\nService runtime: 30.003s\nCPU time consumed: 12ms\nMemory peak: 1.5M\n';
const FINISHED = 'Finished with result: success\nMain processes terminated with: code=exited/status=0\nService runtime: 41ms\nCPU time consumed: 12ms\nMemory peak: 1.5M\n';

test('systemd-run\'s result is read from its final summary only, never from a line the run printed', () => {
  assert.equal(systemdRunStats(`Running as unit: worklane-test-shop-x-1.service\nsome output\n${TIMED_OUT}`).result, 'timeout');
  assert.equal(systemdRunStats(`Finished with result: timeout\n${FINISHED}`).result, 'success', 'a planted line before the real summary');
  assert.equal(systemdRunStats('no summary at all\n').result, null);
});

test('the line a timed-out step\'s check starts with', () => {
  assert.equal(timedOutLine('tier e2e', 1800, 'its timeout_s in tests.yaml test_run'), 'tier e2e timed out after 30 min (its timeout_s in tests.yaml test_run, 1800)');
  assert.equal(timedOutLine('tier e2e', 30, 'x'), 'tier e2e timed out after 30 s (x, 30)');
  assert.equal(timedOutLine('tier e2e', 90, 'x'), 'tier e2e timed out after 1.5 min (x, 90)');
});

/**
 * The coordinator's sandbox host against a stand-in helper: its exec prints what systemd-run prints for a unit that
 * ran past its RuntimeMaxSec (and exits 1, as systemd-run does), for a command with "stuck" in it; workspaces and
 * wipes are the local host's.
 */
function rig(testRun: unknown) {
  const p = exampleProject();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.dir, encoding: 'utf8' }).trim();
  const base = mkdtempSync(join(tmpdir(), 'tr-cap-'));
  const slots = join(base, 'slots');
  mkdirSync(slots);
  writeFileSync(join(slots, 'config.json'), JSON.stringify({ max_agents: 2, max_test_runs: 2 }));
  const lockPath = join(base, 'full-run.lock');
  writeFileSync(lockPath, '');
  const calls = join(base, 'exec-calls');
  const helper = join(base, 'helper');
  writeFileSync(helper, `#!/bin/bash
[ "$2" = exec ] || exit 9
printf '%s %s\\n' "$3" "$4" >> "${calls}"
cmd="\${!#}"
echo "Running as unit: worklane-test-shop-$3-1.service" >&2
case "$cmd" in
  *stuck*) echo "still going"; printf '%s' '${TIMED_OUT}' >&2; exit 1 ;;
  *) echo "done"; printf '%s' '${FINISHED}' >&2; exit 0 ;;
esac
`);
  chmodSync(helper, 0o755);
  const sudo = join(base, 'sudo');
  writeFileSync(sudo, '#!/bin/sh\n[ "$1" = -n ] || exit 9\nshift\nexec "$@"\n');
  chmodSync(sudo, 0o755);
  const local = localHost(join(base, 'host'), { docker: '/nonexistent/docker' });
  const sandbox = sandboxHost('shop', helper, sudo);
  const host: RunHost = { ...local, exec: sandbox.exec };
  const log = new EventLog(join(base, 'events.db'));
  const deps: TestRunDeps = { config: TestRunConfig.parse(testRun), host, repo: p.dir, log, actor: 'test', logDir: join(base, 'logs'), lockPath, slotsDir: slots, slotPollMs: 50 };
  const execCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  return { ...p, sha, base, deps, execCalls };
}

test('regression: a tier stopped at its own cap says it timed out, after how long, naming the tier; the next tier gets its own cap', { skip: !hasPerl && 'perl for the flock holder' }, async () => {
  const r = rig({
    tiers: [
      { name: 'e2e', command: 'npm run e2e # stuck', kind: 'fast', timeout_s: 30 },
      { name: 'unit', command: 'npm test', kind: 'fast', timeout_s: 45 },
      { name: 'lint', command: 'npm run lint', kind: 'fast' },
    ],
  });
  const res = await runTestRun(r.deps, { repo: r.dir, sha: r.sha, kind: 'fast', prs: [1] });
  assert.deepEqual(res.tiers.map((t) => [t.tier, t.ok]), [['e2e', false], ['unit', true], ['lint', true]]);
  const e2e = res.tiers[0]!.summary;
  assert.match(e2e, /^tier e2e timed out after 30 s \(its timeout_s in tests\.yaml test_run, 30\)\n/, e2e);
  assert.match(e2e, /still going/, 'and its last lines');
  assert.doesNotMatch(res.tiers[1]!.summary, /timed out/);
  // Each tier's unit is capped at that tier's own timeout_s (1800 when unset), not one cap for the run.
  assert.deepEqual(r.execCalls().map((c) => c.split(' ')[1]), ['30', '45', '1800']);
  assert.equal(res.outcome, 'done', 'a timeout is the tier\'s verdict, not a run that couldn\'t go ahead');
  assert.ok(!existsSync(join(r.base, 'host', 'runs', res.id)), 'and the run is wiped');
});

test('a setup step stopped at its cap says so too, and every tier fails with it', { skip: !hasPerl && 'perl' }, async () => {
  const r = rig({ setup: ['npm ci # stuck'], tiers: [{ name: 'unit', command: 'npm test', kind: 'fast' }] });
  const res = await runTestRun(r.deps, { repo: r.dir, sha: r.sha, kind: 'fast', prs: [1] });
  assert.equal(res.ok, false);
  assert.match(res.tiers[0]!.summary, /^setup step 1 \(npm ci # stuck\) timed out after 30 min \(the setup steps' cap, 1800\):/);
  assert.equal(res.setup?.detail, 'timed out after 30 min');
  assert.deepEqual(r.execCalls().map((c) => c.split(' ')[1]), ['1800'], 'no tier ran');
});
