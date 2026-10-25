// The shifted clock of the weekly clock-shift job (test/clock-shift.ts, #687): it moves Date and the file times
// together, a Node process started from a shifted one runs at the same shift, a date-dependent test fails under it,
// and nothing changes without it (the required shards never load it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { parseClockShift } from './clock-shift.js';
import { repoRoot } from './helpers.js';
import { TEST_PRELOAD } from './isolate.js';

const DAY = 86_400_000;
const shiftModule = join(repoRoot, 'dist', 'test', 'clock-shift.js');
/** This environment without the job's two variables (this file runs in the weekly job too), nor the test runner's. */
const { NODE_OPTIONS: _o, TEST_CLOCK_SHIFT: _s, NODE_TEST_CONTEXT: _c, ...plain } = process.env;
/** The weekly job's environment: every Node process loads the shift (.github/workflows/clock-shift.yml). */
const shifted = (shift: string): NodeJS.ProcessEnv => ({ ...plain, TEST_CLOCK_SHIFT: shift, NODE_OPTIONS: `--import=${pathToFileURL(shiftModule).href}` });
/** This process's own shift: Date.now() less it is the real time. */
const OWN_SHIFT_MS = _o?.includes('clock-shift') ? parseClockShift(_s) : 0;

/** Node with these arguments; `timeout` ms, when given, ends one that runs longer (code null). */
async function node(args: string[], env: NodeJS.ProcessEnv, timeout?: number): Promise<{ code: number | null; out: string }> {
  const p = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], ...(timeout ? { timeout } : {}) });
  let out = '';
  p.stdout.on('data', (d: Buffer) => (out += d.toString()));
  p.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const code = await new Promise<number | null>((ok) => p.on('close', (c) => ok(c)));
  return { code, out };
}

/** What a process reads as now: Date in its three forms, a file it just wrote, one it set with utimes, a child's Date. */
const PROBE = `
import { statSync, utimesSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const f = process.argv[1];
writeFileSync(f, 'x');
const written = statSync(f).mtimeMs;
const promised = (await stat(f)).mtimeMs;
const at = new Date(Date.now() - 60_000);
utimesSync(f, at, at);
const set = statSync(f).mtimeMs - at.getTime();
const child = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(Date.now()))'], { encoding: 'utf8' }));
console.log(JSON.stringify({ now: Date.now(), made: new Date().getTime(), called: Date.parse(Date()), isDate: new Date() instanceof Date, written, promised, set, child }));
`;

/** The probe's answer, and the real time just before and just after it ran. */
async function probe(env: NodeJS.ProcessEnv): Promise<{ p: Record<string, number | boolean>; before: number; after: number }> {
  const file = join(mkdtempSync(join(tmpdir(), 'clock-shift-')), 'f');
  const before = Date.now() - OWN_SHIFT_MS;
  const r = await node(['--input-type=module', '-e', PROBE, file], env);
  const after = Date.now() - OWN_SHIFT_MS;
  assert.equal(r.code, 0, r.out);
  return { p: JSON.parse(r.out.trim().split('\n').at(-1)!) as Record<string, number | boolean>, before, after };
}

test('TEST_CLOCK_SHIFT: a shift in ms, s, m, h or d; empty is none; anything else is refused', () => {
  assert.equal(parseClockShift('+45d'), 45 * DAY);
  assert.equal(parseClockShift('-2h'), -2 * 3_600_000);
  assert.equal(parseClockShift(' +400d '), 400 * DAY);
  assert.equal(parseClockShift('+1500ms'), 1500);
  assert.equal(parseClockShift(undefined), 0);
  assert.equal(parseClockShift(''), 0);
  for (const bad of ['45d', '+45', '+45 days', 'tomorrow', '2026-11-03T12:00:00Z', '+d']) assert.throws(() => parseClockShift(bad), /TEST_CLOCK_SHIFT/, bad);
});

test('shifted: Date and the file times move together, by the shift; a Node child runs at the same shift', async () => {
  const { p, before, after } = await probe(shifted('+45d'));
  const near = (v: unknown, what: string) => assert.ok(typeof v === 'number' && v >= before + 45 * DAY - 2000 && v <= after + 45 * DAY + 2000, `${what}: ${v}`);
  for (const k of ['now', 'made', 'called', 'written', 'promised', 'child']) near(p[k], k);
  assert.equal(p.isDate, true, 'a Date is still a Date');
  assert.ok(Math.abs(p.set as number) < 1000, `utimes takes a time on the shifted clock: off by ${p.set} ms`);
});

test('not shifted: without the job\'s preload, or with it and no shift, the clock is the real one', async () => {
  for (const env of [{ ...plain, TEST_CLOCK_SHIFT: '+45d' }, shifted('')]) {
    const { p, before, after } = await probe(env);
    for (const k of ['now', 'written', 'child']) assert.ok((p[k] as number) >= before - 2000 && (p[k] as number) <= after + 2000, `${k}: ${p[k]}`);
  }
});

test('a test that only passes before a date fails on the shifted clock, and passes on the real one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clock-fixture-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  const file = join(dir, 'dated.test.js');
  // A test written today with a 30-day window it doesn't know it has.
  const deadline = new Date(Date.now() - OWN_SHIFT_MS + 30 * DAY).toISOString();
  writeFileSync(file, `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('dated', () => assert.ok(Date.now() < Date.parse('${deadline}'), 'past the date'));\n`);
  const real = await node([...TEST_PRELOAD, '--test', file], { ...plain, TEST_CLOCK_SHIFT: '+45d' });
  assert.equal(real.code, 0, real.out);
  const late = await node([...TEST_PRELOAD, '--test', file], shifted('+45d'));
  assert.equal(late.code, 1, late.out);
  assert.match(late.out, /past the date/);
});

test('shifted: a test that mocks Date.now sees its mock, and a mock calling the clock it found there finishes', async () => {
  // test/dashboard-auth.test.ts's pattern: under the shift it once called itself without end and hung the weekly job.
  const dir = mkdtempSync(join(tmpdir(), 'clock-fixture-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  const file = join(dir, 'mocks-now.test.js');
  const late = Date.now() - OWN_SHIFT_MS + 45 * DAY - 2000;
  writeFileSync(
    file,
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('a fixed mock', (t) => { t.mock.method(Date, 'now', () => 12345); assert.equal(Date.now(), 12345); });",
      'test(\'a mock on the clock it found\', (t) => {',
      '  const wallReal = Date.now.bind(Date);',
      `  assert.ok(wallReal() >= ${late}, 'the clock found is the shifted one');`,
      "  t.mock.method(Date, 'now', () => wallReal() + 5000);",
      '  const ahead = Date.now() - wallReal();',
      '  assert.ok(ahead >= 4900 && ahead <= 5100, `mocked ahead by ${ahead}`);',
      '});',
      `test('the mocks are gone: the shifted clock again', () => assert.ok(Date.now() >= ${late}));`,
      '',
    ].join('\n'),
  );
  const r = await node([...TEST_PRELOAD, '--test', '--test-reporter=tap', file], shifted('+45d'), 60_000);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /# pass 3/);
});

type Step = { name?: string; run?: string; env?: Record<string, string> };
const JOB_GLOB = '"dist/test/**/*.test.js"';

/** The workflow's test steps, one per shift, each with its command line and environment. */
function jobTestSteps(): Step[] {
  const wf = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'clock-shift.yml'), 'utf8')) as { jobs: Record<string, { steps: Step[] }> };
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps).filter((s) => s.env?.TEST_CLOCK_SHIFT !== undefined);
  assert.deepEqual(steps.map((s) => s.env!.TEST_CLOCK_SHIFT), ['+45d', '+400d']);
  for (const s of steps) assert.equal(s.run?.split(JOB_GLOB).length, 2, `${s.name}: runs ${JOB_GLOB} once`);
  return steps;
}

/** A test step's command line as the job runs it, on these files instead of the suite. */
async function runStep(s: Step, files: string[], run = s.run!): Promise<{ code: number | null; out: string }> {
  const p = spawn('bash', ['-c', run.replace(JOB_GLOB, files.map((f) => `'${f}'`).join(' '))], { cwd: repoRoot, env: { ...plain, ...s.env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  let out = '';
  p.stdout.on('data', (d: Buffer) => (out += d.toString()));
  p.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const code = await new Promise<number | null>((ok) => p.on('close', (c) => ok(c)));
  return { code, out };
}

test('the job runs every test of a file, one registered after an await too, at both shifts (#848)', async () => {
  // test/slot-dir-writes.test.ts registers tests after a top-level await. Under --test-force-exit a file's process
  // ended once the tests it knew of were done, so the later ones never ran, and the step still reported 0 fail.
  for (const s of jobTestSteps()) {
    const dir = mkdtempSync(join(tmpdir(), 'clock-job-'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    const marker = join(dir, 'late-ran');
    const file = join(dir, 'late.test.js');
    writeFileSync(
      file,
      [
        "import { test } from 'node:test';",
        "import { writeFileSync } from 'node:fs';",
        "test('early', () => {});",
        'await new Promise((ok) => setTimeout(ok, 200));',
        `test('late', () => writeFileSync(${JSON.stringify(marker)}, 'x'));`,
        '',
      ].join('\n'),
    );
    const r = await runStep(s, [file]);
    assert.equal(r.code, 0, `${s.name}: ${r.out}`);
    assert.ok(existsSync(marker), `${s.name}: the test registered after the await never ran\n${r.out}`);
  }
});

test("the job's flags end a file that keeps a handle open after its tests: cancelled at --test-timeout, named, the step fails (#774)", async () => {
  const [s] = jobTestSteps();
  assert.match(s!.run!, /--test-timeout=\d+ /);
  const dir = mkdtempSync(join(tmpdir(), 'clock-job-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  const file = join(dir, 'open-handle.test.js');
  writeFileSync(file, "import { test } from 'node:test';\nsetInterval(() => {}, 1000);\ntest('done', () => {});\n");
  const r = await runStep(s!, [file], s!.run!.replace(/--test-timeout=\d+ /, '--test-timeout=3000 '));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /open-handle\.test\.js/);
  assert.match(r.out, /timed out after 3000ms/);
});
