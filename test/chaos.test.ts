// Chaos tests: the machine faults of the weekend of 2026-11-07, each injected, with what the engine must do about it:
// detect it, stop cleanly, report it, and never retry it blindly (docs/testing-in-production.md, item d). The faults
// come in where they reach the engine: a step's exit and output (a wrapped run host), and the event log a restarted
// coordinator reads (a machine that hung mid-run and was power-cycled).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { localHost, type ExecResult, type RunHost } from '../src/testrun/host.js';
import { runTestRun, type TestRunDeps, type TestRunResult } from '../src/testrun/run.js';
import { gpuRunsNotToRepeat, type GpuGrant } from '../src/testrun/gpu.js';
import { FAULT_LINE, outputFault, selfMatchingWait } from '../src/testrun/faults.js';
import { INTERRUPT_LIMIT, PrTestRuns, interruptedLine, type OpenPr } from '../src/coordinator/test-runs.js';
import { exampleProject } from './helpers.js';

const posix = process.platform !== 'win32';
const hasPerl = posix && (() => {
  try {
    execFileSync('perl', ['-e', '1'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const skip = !hasPerl && 'perl for the flock holder';

const GRANT: GpuGrant = { granted: true, indices: [0], devices: ['/dev/nvidiactl', '/dev/nvidia-uvm', '/dev/nvidia0'], maxS: 900, waitedS: 0, note: '' };
/** What the driver and nvidia-smi print once a GPU fell off the bus (PCIe fatal, Xid 79). */
const GPU_GONE = 'NVRM: Xid (PCI:0000:01:00): 79, pid=4242, GPU has fallen off the bus.\nNo devices were found\n';
const HOST_KEY = '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.\n';
const UNREACHABLE = 'ssh: connect to host 192.0.2.7 port 22: Connection timed out\n';
const DISK = "Error: ENOSPC: no space left on device, write\n";

/** A run on a scratch project; `faults` maps a tier command to what the injected fault makes it return. */
function rig(tiers: unknown[], faults: Record<string, Partial<ExecResult>> = {}) {
  const p = exampleProject();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.dir, encoding: 'utf8' }).trim();
  const base = mkdtempSync(join(tmpdir(), 'chaos-'));
  const slots = join(base, 'slots');
  mkdirSync(slots);
  writeFileSync(join(slots, 'config.json'), JSON.stringify({ max_agents: 2, max_test_runs: 2 }));
  const lockPath = join(base, 'full-run.lock');
  writeFileSync(lockPath, '');
  const log = new EventLog(join(base, 'events.db'));
  const real = localHost(join(base, 'host'));
  const ran: string[] = [];
  const host: RunHost = {
    ...real,
    exec: async (id, command, env, ms, signal, eo = {}) => {
      ran.push(command);
      const f = faults[command];
      if (f) return { code: 1, out: '', ...(eo.gpu ? { gpu: GRANT } : {}), ...f };
      const r = await real.exec(id, command, env, ms, signal, eo);
      return eo.gpu ? { ...r, gpu: GRANT } : r;
    },
  };
  const deps: TestRunDeps = { config: TestRunConfig.parse({ tiers }), host, repo: p.dir, log, actor: 'test', logDir: join(base, 'logs'), lockPath, slotsDir: slots, slotPollMs: 50, gpuOptIn: () => ({ state: 'on', devices: [0], maxMinutes: 15 }) };
  const events = <T extends Parameters<EventLog['read']>[1] extends (infer U)[] | undefined ? U : never>(t: T) => log.read(0, [t]).map((e) => e.payload as EventPayload<T>);
  const run = () => runTestRun(deps, { repo: p.dir, sha, kind: 'fast', prs: [7] });
  return { sha, log, ran, events, run };
}

test('chaos: GPU loss mid-run (Xid 79, "No devices were found") stops the GPU work, says so, and the run is never repeated', { skip }, async () => {
  const r = rig(
    [
      { name: 'train', command: 'train', kind: 'fast', gpu: true },
      { name: 'eval', command: 'echo eval', kind: 'fast', gpu: true },
      { name: 'lint', command: 'echo lint', kind: 'fast' },
    ],
    { train: { code: 6, out: GPU_GONE } },
  );
  const res = await r.run();
  // Detect, and stop cleanly: the later GPU tier never runs; the CPU tier still does.
  assert.deepEqual(r.ran, ['train', 'echo lint']);
  assert.deepEqual(res.tiers.map((t) => [t.tier, t.ok]), [['train', false], ['eval', false], ['lint', true]]);
  assert.equal(res.tiers[1]!.summary, 'not run: the GPU was lost in tier train');
  // Report: on the check (first line) and in the log.
  assert.ok(res.tiers[0]!.summary.startsWith(`${FAULT_LINE.gpu_lost}: `), res.tiers[0]!.summary);
  assert.deepEqual(r.events('testrun.fault').map((f) => [f.tier, f.fault]), [['train', 'gpu_lost']]);
  // Never retried blindly: a stopped GPU run, which nothing runs again by itself.
  assert.equal(res.gpuStopped, true);
  assert.equal(r.events('testrun.finished')[0]!.gpu_stopped, true);
  assert.deepEqual(gpuRunsNotToRepeat(r.log.read(0, ['testrun.queued', 'testrun.started', 'testrun.finished'])), [res.id]);
});

test('chaos: a step that only prints a fault word and passes is no fault (a test of the GPU-loss path, say)', { skip }, async () => {
  const r = rig([{ name: 'unit', command: 'echo "No devices were found"; echo "Host key verification failed"', kind: 'fast', gpu: true }]);
  const res = await r.run();
  assert.equal(res.ok, true, JSON.stringify(res.tiers));
  assert.equal(r.events('testrun.fault').length, 0);
  assert.equal(res.gpuStopped, undefined);
});

test('chaos: an SSH host key change and an unreachable host are reported as such on the check, recorded, and the run is done (not rerun)', { skip }, async () => {
  const r = rig(
    [
      { name: 'deploy-check', command: 'ssh-check', kind: 'fast' },
      { name: 'remote', command: 'ssh-remote', kind: 'fast' },
    ],
    { 'ssh-check': { code: 255, out: HOST_KEY }, 'ssh-remote': { code: 255, out: UNREACHABLE } },
  );
  const res = await r.run();
  assert.equal(res.outcome, 'done', 'a verdict: a failed check, not an interrupted run a restart would run again');
  assert.ok(res.tiers[0]!.summary.startsWith(`${FAULT_LINE.host_key_changed}: @    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!`), res.tiers[0]!.summary);
  assert.ok(res.tiers[1]!.summary.startsWith(`${FAULT_LINE.host_unreachable}: ssh: connect to host 192.0.2.7`), res.tiers[1]!.summary);
  assert.deepEqual(r.events('testrun.fault').map((f) => f.fault), ['host_key_changed', 'host_unreachable']);
  assert.deepEqual(r.ran, ['ssh-check', 'ssh-remote'], 'each ran once: no retry');
});

test('chaos: the engine never accepts an unknown or changed SSH host key by itself: no such option anywhere in src/', () => {
  const src = fileURLToPath(new URL('../../src', import.meta.url));
  const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith('.js') ? [join(d, n)] : []));
  const bad = /StrictHostKeyChecking\s*=?\s*(?:no|off|accept-new)|UserKnownHostsFile\s*=?\s*\/dev\/null|ssh-keyscan[^\n]*>>\s*\S*known_hosts/i;
  const hits = files(src).filter((f) => bad.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
});

test('chaos: a disk that fills during a step is reported on the check and recorded, and the step is not run again', { skip }, async () => {
  const r = rig([{ name: 'build', command: 'build', kind: 'fast' }], { build: { code: 1, out: `writing dist\n${DISK}` } });
  const res = await r.run();
  assert.equal(res.outcome, 'done');
  assert.ok(res.tiers[0]!.summary.startsWith(`${FAULT_LINE.disk_full}: Error: ENOSPC`), res.tiers[0]!.summary);
  assert.deepEqual(r.events('testrun.fault').map((f) => f.fault), ['disk_full']);
  assert.deepEqual(r.ran, ['build']);
  // Below the free-disk floor nothing starts at all: test/disk-full.test.ts ("below the free-disk floor no test run starts").
});

test('chaos: a self-matching waiter (`until ! pgrep -f X`, `while ps | grep X`) is refused before it runs, and says what to wait on instead', { skip }, async () => {
  const waits = ['until ! pgrep -f trainer; do sleep 5; done', 'while true; do\n  ps aux | grep -q "[t]rain.py" || break\n  sleep 10\ndone'];
  const r = rig([
    { name: 'w1', command: waits[0], kind: 'fast' },
    { name: 'w2', command: waits[1], kind: 'fast' },
    { name: 'ok', command: 'until ! pgrep -x trainer; do sleep 1; done; echo fine', kind: 'fast' },
  ]);
  const res = await r.run();
  assert.deepEqual(r.ran, ['until ! pgrep -x trainer; do sleep 1; done; echo fine'], 'the waiters never ran; an exact-name wait did');
  assert.deepEqual(res.tiers.map((t) => [t.tier, t.ok]), [['w1', false], ['w2', false], ['ok', true]]);
  assert.equal(res.tiers[0]!.summary, `${FAULT_LINE.self_matching_wait}: \`pgrep -f trainer\``);
  assert.match(res.tiers[1]!.summary, /`ps aux \| grep -q "\[t\]rain\.py"`$/);
  assert.deepEqual(r.events('testrun.fault').map((f) => [f.tier, f.fault]), [['w1', 'self_matching_wait'], ['w2', 'self_matching_wait']]);
});

test('faults: the classifiers, on the real texts and their near misses', () => {
  assert.equal(outputFault(GPU_GONE)?.fault, 'gpu_lost');
  assert.equal(outputFault('NVRM: Xid (PCI:0000:3b:00): 79, pid=1')?.fault, 'gpu_lost');
  assert.equal(outputFault('NVRM: Xid (PCI:0000:3b:00): 13, Graphics Exception')?.fault, undefined, 'another Xid is not a lost GPU');
  assert.equal(outputFault(HOST_KEY)?.fault, 'host_key_changed');
  assert.equal(outputFault('Host key for 192.0.2.7 has changed and you have requested strict checking.')?.fault, 'host_key_changed');
  assert.equal(outputFault(UNREACHABLE)?.fault, 'host_unreachable');
  assert.equal(outputFault('ssh: connect to host h port 22: No route to host')?.fault, 'host_unreachable');
  assert.equal(outputFault(DISK)?.fault, 'disk_full');
  assert.equal(outputFault('cp: error writing x: No space left on device')?.evidence, 'cp: error writing x: No space left on device');
  assert.equal(outputFault('1 test failed: expected 3, got 4'), null);
  assert.equal(selfMatchingWait('while pgrep -af "python train" >/dev/null; do sleep 2; done'), 'pgrep -af "python train" >/dev/null');
  assert.equal(selfMatchingWait('until ! pgrep --full x; do sleep 1; done'), 'pgrep --full x');
  assert.equal(selfMatchingWait('until ! ps -ef | grep x; do sleep 1; done'), 'ps -ef | grep x');
  assert.equal(selfMatchingWait('pgrep -f x && echo running'), null, 'one look, no loop: it ends');
  assert.equal(selfMatchingWait('until ! pgrep -x trainer; do sleep 1; done'), null, 'an exact name never matches the shell');
  assert.equal(selfMatchingWait('until test -f done.pid; do sleep 1; done'), null);
  assert.equal(selfMatchingWait('while read -r f; do grep -q x "$f"; done < list'), null);
});

/** A coordinator's PR test runs over a log, with the runs it starts and the checks it posts recorded. */
function prRig(log: EventLog) {
  let prs: OpenPr[] = [];
  let now = 0;
  const started: number[] = [];
  const posted: { sha: string; r: TestRunResult }[] = [];
  const host = { wipe: async () => ({ ok: true, left: [] }) } as unknown as RunHost;
  const runs = new PrTestRuns({
    log,
    actor: 'test',
    repo: '/r',
    remote: 'origin',
    host,
    listPrs: async () => prs,
    fetchPr: (pr) => pr.headSha,
    changed: () => ['a.ts'],
    now: () => now,
    pollMs: 1000,
    fastTiers: () => ['unit'],
    start: (req, o) =>
      new Promise((resolve) => {
        started.push(req.prs[0]!);
        o.signal.addEventListener('abort', () => resolve({ id: 'x', sha: req.sha, kind: 'fast', ok: false, tiers: [], outcome: 'cancelled' }));
      }),
    post: async (sha, r) => void posted.push({ sha, r }),
  });
  const pr = (number: number, headSha: string): OpenPr => ({ number, headSha, base: 'main', author: 'someone', bot: false });
  return { runs, started, posted, pr, setPrs: (p: OpenPr[]) => (prs = p), advance: (ms: number) => (now += ms) };
}

test(`chaos: a reboot that hangs: a head whose run was cut off ${INTERRUPT_LIMIT} times (the machine hung and was power-cycled each time) is never run again by itself, and its PR is told`, async () => {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'chaos-prs-')), 'events.db'));
  const [a, b] = ['a'.repeat(40), 'b'.repeat(40)];
  // Head a: cut off once already (recorded at the last start), then run again and the machine hung again.
  log.append('testrun.queued', { id: 'fast-a-1', sha: a, kind: 'fast', prs: [1], shard: null }, 'test');
  log.append('testrun.started', { id: 'fast-a-1', slot: 'test-0', lock_wait_ms: 0 }, 'test');
  log.append('testrun.finished', { id: 'fast-a-1', sha: a, kind: 'fast', prs: [1], ok: false, outcome: 'interrupted', results: [], detail: 'the coordinator stopped during the run; wiped at start' }, 'test');
  log.append('testrun.queued', { id: 'fast-a-2', sha: a, kind: 'fast', prs: [1], shard: null }, 'test');
  log.append('testrun.started', { id: 'fast-a-2', slot: 'test-0', lock_wait_ms: 0 }, 'test');
  // Head b: cut off once, the first time: it runs again (one interruption may be the machine's, not the run's).
  log.append('testrun.queued', { id: 'fast-b-1', sha: b, kind: 'fast', prs: [2], shard: null }, 'test');
  log.append('testrun.started', { id: 'fast-b-1', slot: 'test-1', lock_wait_ms: 0 }, 'test');
  const r = prRig(log);
  assert.deepEqual((await r.runs.recover()).sort(), ['fast-a-2', 'fast-b-1']);
  assert.deepEqual(r.posted.map((p) => [p.sha, p.r.ok, p.r.tiers[0]?.summary]), [[a, false, interruptedLine(INTERRUPT_LIMIT)]], 'head a gets a failing check saying why; b none');
  r.setPrs([r.pr(1, a), r.pr(2, b)]);
  r.advance(5000);
  assert.deepEqual((await r.runs.tick()).started, [2], 'head a is not run a third time; b is run again');
  r.runs.stop();
  // After yet another restart, it still holds (counted from the log).
  const again = prRig(log);
  again.setPrs([again.pr(1, a)]);
  again.advance(5000);
  assert.deepEqual((await again.runs.tick()).started, []);
  again.runs.stop();
});
