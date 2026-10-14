// The one start gate in front of every test run (src/testrun/gate.ts): runTestRun, the only function that starts one,
// refuses with TestRunHeld while the disk guard says no (free disk below the floor, or the event log's writes waiting
// in memory), before it records or touches anything; no other code starts a run around it. The paths that start runs
// hold a refused one and run it once there is room: PR runs here; the flaky re-run, fix-forward's probes, the deploy
// gate, previews and batches in their own test files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { PrTestRuns, type OpenPr } from '../src/coordinator/test-runs.js';
import { addStartGate, clearStartGates, HeldTime, passGate, startRefusal, startRefusals, TestRunHeld } from '../src/testrun/gate.js';
import { TestRunConfig } from '../src/testrun/config.js';
import type { RunHost } from '../src/testrun/host.js';
import { runTestRun, type TestRunResult } from '../src/testrun/run.js';
import { GATE_MODES, guardGate } from './gate-helpers.js';
import { repoRoot } from './helpers.js';

const tmpLog = () => new EventLog(join(mkdtempSync(join(tmpdir(), 'gate-run-')), 'events.db'));

test.afterEach(() => clearStartGates());

/** A host every call of which fails the test: a held run must never reach it. */
const untouchable = new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : () => assert.fail(`the host was called (${String(k)}) for a held run`)) }) as RunHost;

for (const mode of GATE_MODES) {
  test(`runTestRun, the one start of a test run, refuses at the gate (${mode === 'floor' ? 'below the free-disk floor' : 'while events wait in memory'}): nothing recorded, the host never touched; it goes on once there is room`, async () => {
    const g = guardGate();
    try {
      const log = tmpLog();
      const d = { config: TestRunConfig.parse({ tiers: [{ name: 'unit', kind: 'fast', command: 'true' }] }), host: untouchable, repo: '/r', log, actor: 't', logDir: '/nowhere', helper: { ok: false, have: null, need: 9, detail: 'the helper is outdated', stderr: '' } };
      const req = { repo: '/r', sha: 'a'.repeat(40), kind: 'fast' as const, prs: [1] };
      g.close(mode);
      await assert.rejects(runTestRun(d, req), (e: unknown) => e instanceof TestRunHeld && /disk/.test(e.reason));
      assert.equal(log.read().length, 0, 'not even queued');
      g.open();
      // WHY: past the gate the run goes on: here to the helper check, which ends it without touching the host.
      const r = await runTestRun(d, req);
      assert.equal(r.setup?.step, 'helper');
      assert.deepEqual(log.read().map((e) => e.type), ['testrun.queued', 'testrun.finished']);
    } finally {
      g.done();
    }
  });
}

/** Every .ts file under src/, with its text. */
function sources(dir = join(repoRoot, 'src')): { file: string; text: string }[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith('.ts') ? [{ file: relative(repoRoot, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }] : [];
  });
}

test('no code starts a test run around the gate: runTestRun is the only start, and only the service and measure call it; a run\'s workspace, database and commands only from it; a preview launches only after the gate', () => {
  const src = sources();
  const callers = (re: RegExp) => src.filter((s) => re.test(s.text)).map((s) => s.file).sort();
  assert.deepEqual(callers(/(?<!function )\brunTestRun\(/), ['src/testrun/index.ts', 'src/testrun/measure.ts'], 'runTestRun is called by the service (startTestRun) and measure only');
  assert.match(readFileSync(join(repoRoot, 'src/testrun/run.ts'), 'utf8'), /export async function runTestRun\([^)]*\)[^{]*\{\n {2}validateRequest\(req\);\n(?: {2}\/\/[^\n]*\n)* {2}passGate\(\);/, 'runTestRun passes the gate before anything else');
  assert.deepEqual(callers(/\bcreateWorkspace\(/), ['src/testrun/run.ts', 'src/testrun/workspace.ts'], 'a run\'s workspace is made only by runTestRun');
  assert.deepEqual(callers(/\.host\.(startDb|exec)\(/), ['src/testrun/run.ts'], 'a run\'s database and commands only by runTestRun');
  const previews = readFileSync(join(repoRoot, 'src/preview/previews.ts'), 'utf8');
  assert.equal(previews.match(/this\.launch\(/g)?.length, 1, 'one launch of a preview');
  assert.match(previews, /if \(startRefusal\(\)\) continue;\n\s*this\.launch\(/, 'and only after the gate');
  assert.equal(previews.match(/this\.run\(/g)?.length, 1, 'a preview runs only from its launch');
  // WHY: the coordinator sets the gate to its disk guard, and clears it on every way out.
  const service = readFileSync(join(repoRoot, 'src/service.ts'), 'utf8');
  assert.match(service, /addStartGate\('disk', \(\) => disk\.held\(\)\);/);
});

test('the gate: a list of named refusal sources (disk, and any other added later); none refusing, nothing held; HeldTime counts only the time held', () => {
  assert.equal(startRefusal(), null);
  assert.doesNotThrow(() => passGate());
  let draining = false;
  const ungateDisk = addStartGate('disk', () => 'the disk is full');
  const ungateDrain = addStartGate('drain', () => (draining ? 'draining for update' : null));
  assert.throws(() => passGate(), (e: unknown) => e instanceof TestRunHeld && e.reason === 'the disk is full' && e.refusals.length === 1);
  draining = true;
  assert.deepEqual(startRefusals(), [{ source: 'disk', reason: 'the disk is full' }, { source: 'drain', reason: 'draining for update' }]);
  assert.equal(startRefusal(), 'the disk is full; draining for update');
  ungateDisk();
  assert.throws(() => passGate(), (e: unknown) => e instanceof TestRunHeld && e.refusals[0]!.source === 'drain');
  ungateDrain();
  assert.equal(startRefusal(), null, 'each source removes only itself');
  const h = new HeldTime();
  h.held('a', 100, true);
  h.held('a', 150, true);
  assert.equal(h.ms('a', 175), 75);
  h.held('a', 200, false);
  h.held('a', 900, true);
  h.held('a', 1000, false);
  assert.equal(h.ms('a', 5000), 200);
  assert.equal(h.ms('b', 5000), 0);
});

/** PrTestRuns whose runs go through the gate as runTestRun does. */
function prRig() {
  const log = tmpLog();
  let now = 0;
  const posted: string[] = [];
  const s = { prs: [] as OpenPr[] };
  const runs = new PrTestRuns({
    log,
    actor: 'test',
    repo: '/r',
    remote: 'origin',
    host: { wipe: async () => ({ ok: true, left: [] }) } as unknown as RunHost,
    listPrs: async () => s.prs,
    fetchPr: (p) => p.headSha,
    changed: () => ['a.ts'],
    now: () => now,
    pollMs: 1000,
    start: async (req) => {
      passGate();
      return { id: `r${req.prs[0]}`, sha: req.sha, kind: 'fast', ok: true, outcome: 'done', tiers: [{ tier: 'unit', ok: true, durationMs: 5, summary: 'ok', logRef: '' }] } as TestRunResult;
    },
    post: async (sha) => void posted.push(sha),
  });
  s.prs = [{ number: 1, headSha: '1'.repeat(40), base: 'main', author: 'x', bot: false }];
  return {
    log,
    posted,
    pass: async () => {
      now += 5000;
      const r = await runs.tick();
      await runs.idle();
      return r.started;
    },
  };
}

for (const mode of GATE_MODES) {
  test(`PR test runs are held at the gate (${mode}) and start once there is room`, async () => {
    const g = guardGate();
    try {
      const t = prRig();
      g.close(mode);
      assert.deepEqual(await t.pass(), []);
      assert.deepEqual(await t.pass(), [], 'still held');
      assert.deepEqual(t.posted, []);
      g.open();
      assert.deepEqual(await t.pass(), [1]);
      assert.deepEqual(t.posted, ['1'.repeat(40)]);
    } finally {
      g.done();
    }
  });
}

test('a PR run refused at its start (the disk filled after the listing) is held: no error, no check, and it runs at the next listing', async () => {
  const t = prRig();
  let calls = 0;
  // WHY: open for the listing's look at the gate, shut by the time the run itself passes it.
  addStartGate('disk', () => (++calls === 2 ? 'the disk is full' : null));
  assert.deepEqual(await t.pass(), [1], 'started, and refused inside');
  assert.deepEqual(t.posted, [], 'no check for a run that never ran');
  assert.equal(t.log.read(0, ['coordinator.error']).length, 0, 'held is not an error');
  assert.deepEqual(await t.pass(), [1], 'its head runs again');
  assert.deepEqual(t.posted, ['1'.repeat(40)]);
});
