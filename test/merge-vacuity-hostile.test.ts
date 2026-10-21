// #784 round 2: the coverage directory is written by the code under test, so the coordinator reads it as hostile
// input (src/vacuity.ts touchedAppFiles), and the coverage run never runs on the coordinator's tick
// (merge-flow.ts startVacuityRun). Each reader case runs in a child process with a timeout: a reader that blocks on a
// FIFO or reads a device without end would otherwise hang this test process, not fail it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, symlinkSync, writeFileSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { FileBacklog } from '../src/backlog/file.js';
import type { PullRequest } from '../src/backlog/types.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { FakeRunner } from '../src/runner.js';
import { exampleProject, repoRoot } from './helpers.js';
import { knownTip } from './vacuity-tip.js';
import { approve, openPr, passing, skip } from './repro-state-graph/harness.js';

const posix = process.platform === 'win32' && 'POSIX file types (FIFO, /dev/zero)';
const TOKEN = `ghp_${'A1b2C3d4'.repeat(5)}`;
const MODULE = pathToFileURL(join(repoRoot, 'dist', 'src', 'vacuity.js')).href;
/** The child: the reader's answer as JSON, or what it threw (its class and message). */
const PROBE = `const [mod, cov, root] = process.argv.slice(1);
const m = await import(mod);
try { console.log(JSON.stringify({ touched: m.touchedAppFiles(cov, root, ['src/**']) })); }
catch (e) { console.log(JSON.stringify({ threw: e && e.constructor && e.constructor.name, message: String(e && e.message).slice(0, 4000) })); }`;

/** A worktree-like root with src/a.js, and its coverage directory, filled by `fill`. */
function fixture(fill: (cov: string, root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'cov-root-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.js'), 'export function a() { return 1; }\n');
  const cov = join(root, '.cov');
  mkdirSync(cov);
  fill(cov, root);
  return { root, cov };
}

/** The reader over the fixture, in a child that is killed after 10 s; with how long it took. */
function read(f: { root: string; cov: string }, cov = f.cov) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE, MODULE, cov, f.root], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  const ms = performance.now() - t0;
  assert.equal(r.signal, null, `the reader finished on its own (killed after ${Math.round(ms)} ms: it blocked or read without end)`);
  return { ...(JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as { touched?: string[]; threw?: string; message?: string }), ms };
}

// As V8 writes it for src/a.js ('export function a() { return 1; }\n', 34 characters): the module's top level over the
// whole file, and the function a, which ran.
const coverageOf = (root: string, file: string) => JSON.stringify({ result: [{ url: pathToFileURL(join(root, file)).href, functions: [{ functionName: '', ranges: [{ startOffset: 0, endOffset: 34, count: 1 }] }, { functionName: 'a', ranges: [{ startOffset: 7, endOffset: 33, count: 1 }] }] }] });

test('hostile coverage: a FIFO named like a coverage file is refused at once, never waited on', { skip: posix }, () => {
  const f = fixture((cov) => execFileSync('mkfifo', [join(cov, 'evil.json')]));
  const r = read(f);
  assert.deepEqual([r.threw, r.message], ['CoverageUnreadable', 'the coverage directory holds an entry that is not a regular file']);
  assert.ok(r.ms < 5_000, `${r.ms} ms`);
});

test('hostile coverage: a symlink to a device (/dev/zero) is refused, never read', { skip: posix }, () => {
  const f = fixture((cov) => symlinkSync('/dev/zero', join(cov, 'zero.json')));
  const r = read(f);
  assert.deepEqual([r.threw, r.message], ['CoverageUnreadable', 'the coverage directory holds an entry that is not a regular file']);
});

test('hostile coverage: a symlink to a regular file outside the run is refused too (never followed)', { skip: posix }, () => {
  const outside = join(mkdtempSync(join(tmpdir(), 'outside-')), 'secret.json');
  writeFileSync(outside, `${TOKEN}\n`);
  const f = fixture((cov) => symlinkSync(outside, join(cov, 'x.json')));
  const r = read(f);
  assert.deepEqual([r.threw, r.message], ['CoverageUnreadable', 'the coverage directory holds an entry that is not a regular file']);
});

test('hostile coverage: an oversized file is refused by its size, without being read', () => {
  const f = fixture((cov) => {
    const fd = openSync(join(cov, 'big.json'), 'w');
    ftruncateSync(fd, 32 * 1024 * 1024 + 1); // sparse: nothing written
    closeSync(fd);
  });
  const r = read(f);
  assert.deepEqual([r.threw, r.message], ['CoverageUnreadable', `the coverage directory holds a file over ${32 * 1024 * 1024} bytes`]);
});

test('hostile coverage: invalid JSON holding a token-looking string fails with fixed text: no content in the message', () => {
  const f = fixture((cov) => writeFileSync(join(cov, 'leak.json'), `${TOKEN} {`));
  const r = read(f);
  assert.deepEqual([r.threw, r.message], ['CoverageUnreadable', 'the coverage directory holds a file that is not valid JSON']);
  assert.ok(!r.message!.includes('ghp_'));
});

test('hostile coverage: a directory that is a symlink, too many files, or JSON not shaped as V8 coverage: each refused', { skip: posix }, () => {
  const real = fixture((cov, root) => writeFileSync(join(cov, 'c.json'), coverageOf(root, 'src/a.js')));
  const link = join(real.root, '.cov-link');
  symlinkSync(real.cov, link);
  assert.deepEqual([read(real, link).threw, read(real, link).message], ['CoverageUnreadable', 'the coverage directory is not a plain directory']);
  const many = fixture((cov) => {
    for (let i = 0; i < 257; i++) writeFileSync(join(cov, `c${i}.json`), '{"result":[]}');
  });
  assert.deepEqual([read(many).threw, read(many).message], ['CoverageUnreadable', 'the coverage directory holds more than 256 coverage files']);
  const shape = fixture((cov) => writeFileSync(join(cov, 'c.json'), '{"result": 5}'));
  assert.deepEqual([read(shape).threw, read(shape).message], ['CoverageUnreadable', 'the coverage directory holds a file that is not V8 coverage']);
});

test('hostile coverage: a well-formed coverage directory still reads (control)', () => {
  const f = fixture((cov, root) => writeFileSync(join(cov, 'c.json'), coverageOf(root, 'src/a.js')));
  assert.deepEqual(read(f).touched, ['src/a.js']);
});

// ---- through the coordinator

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
type Run = { tests: string[]; appPaths: string[] };
type Gate = { mergeDecisionFor(n: number, number: number, pr: PullRequest): { auto: boolean; reasons: string[]; vacuityRun?: Run }; vacuityRun(w: EventPayload<'pr.opened'>, pr: PullRequest, run: Run): Promise<void> };
const PRICE = '// Prices are integer cents.\nexport function totalCents(items) {\n  return items.reduce((s, { cents, qty }) => s + cents * qty, 0) + 0;\n}\n';

/** A ready PR over the example project at a head that writes `files`, decided by a coordinator of its own. */
function prWith(files: Record<string, string>) {
  const dir = exampleProject().dir;
  const base = git(dir, 'rev-parse', 'HEAD');
  const commit = (fs: Record<string, string>) => {
    for (const [p, text] of Object.entries(fs)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'change');
    return git(dir, 'rev-parse', 'HEAD');
  };
  const head = commit(files);
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  const log = new EventLog(join(dir, '..', 'events.db'));
  log.append('issue.claimed', { issue: 7, instance: 'i', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'i');
  const w = { issue: 7, number: 9, url: 'u', head, draft: false };
  log.append('pr.opened', w, 'i');
  const verdict = (h: string) => log.append('eval.verdict', { issue: 7, head: h, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
  verdict(head);
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true }) as unknown as Gate;
  knownTip(c, dir, base);
  const prAt = (h: string): PullRequest => ({ number: 9, url: 'u', head: 'b', base: 'main', headSha: h, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' });
  return { c, w, log, head, prAt, commit, verdict };
}

test('coordinator: a test that writes invalid JSON with a token into its coverage directory holds the PR, and the token reaches no event and no reason', async () => {
  const leaky = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { totalCents } from '../src/price.js';\ntest('t', () => {\n  mkdirSync(process.env.NODE_V8_COVERAGE, { recursive: true });\n  writeFileSync(join(process.env.NODE_V8_COVERAGE, 'leak.json'), ${JSON.stringify(`${TOKEN} {`)});\n  assert.equal(totalCents([{ cents: 1, qty: 1 }]), 1);\n});\n`;
  const t = prWith({ 'src/price.js': PRICE, 'test/leak.test.js': leaky });
  const first = t.c.mergeDecisionFor(7, 9, t.prAt(t.head));
  assert.ok(first.vacuityRun);
  await t.c.vacuityRun(t.w, t.prAt(t.head), first.vacuityRun);
  const then = t.c.mergeDecisionFor(7, 9, t.prAt(t.head));
  assert.deepEqual([then.auto, then.reasons], [false, ['design: vacuity: its coverage run failed: the coverage directory holds a file that is not valid JSON']]);
  assert.ok(!JSON.stringify(t.log.read()).includes('ghp_'), 'no event carries the token');
});

test('coordinator: a result measured at one head is never applied to the head after it (control)', async () => {
  const touches = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { totalCents } from '../src/price.js';\ntest('t', () => { assert.equal(totalCents([{ cents: 2, qty: 3 }]), 6); });\n";
  const t = prWith({ 'src/price.js': PRICE, 'test/more.test.js': touches });
  const first = t.c.mergeDecisionFor(7, 9, t.prAt(t.head));
  await t.c.vacuityRun(t.w, t.prAt(t.head), first.vacuityRun!);
  assert.deepEqual(t.c.mergeDecisionFor(7, 9, t.prAt(t.head)).reasons, [], 'measured and clear at its own head');
  const next = t.commit({ 'src/price.js': `${PRICE}// moved\n` });
  t.verdict(next);
  const d = t.c.mergeDecisionFor(7, 9, t.prAt(next));
  // Unmeasured at the new head: a run is asked for again (the head the harness didn't push also holds it, as a doubt).
  assert.deepEqual([d.auto, d.vacuityRun?.tests], [false, ['test/more.test.js']]);
});

test('watch: a coverage run that sleeps never holds up the PR watch: the pass ends at once, the PR waits unmerged and unannounced', { skip }, async () => {
  // Its checks pass as the task's verification runs them; once the PR is open, the scratch worktree's setup sleeps 30 s
  // first, so the gate's coverage run does (#784 round 6: runner.one takes no reporter module that could sleep).
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  t.f.cfg.tests.worktree.setup = ['sleep 30'];
  const ticks = t.f.log.read(0, ['coordinator.tick']).length;
  t.f.backlog.setChecks(t.pr().headSha, passing);
  const t0 = performance.now();
  await t.c.tick(); // one pass, exactly (the harness's green would wait for the run)
  const ms = performance.now() - t0;
  try {
    assert.ok(ms < 15_000, `the pass took ${Math.round(ms)} ms: it waited on the coverage run`);
    assert.equal(t.f.log.read(0, ['coordinator.tick']).length, ticks + 1, 'the whole tick finished, every step after the PR watch too');
    assert.equal(t.f.log.read(0, ['vacuity.started']).length, 1, 'the run started');
    assert.equal(t.f.log.read(0, ['merge.done']).length, 0, 'not merged while it runs');
    assert.equal(t.f.log.read(0, ['merge.decided']).length, 0, 'and not sent to the owner either');
    await t.c.tick();
    assert.equal(t.f.log.read(0, ['vacuity.started']).length, 1, 'one run per PR at a time, not one per pass');
    assert.equal(t.f.log.read(0, ['merge.done']).length, 0);
  } finally {
    (t.c as unknown as { stop(): void }).stop(); // kills the sleeping run (a setup step aborts on shutdown)
    await t.c.idle();
  }
  assert.equal(t.f.log.read(0, ['vacuity.measured']).length, 0, 'a run a shutdown cut short records nothing');
});

test('coordinator: a PR test whose body sleeps never holds the coordinator\'s thread or its decisions, and a shutdown kills the test run and records nothing', async () => {
  // #784 round 7: the sleeping test run itself (the case above sleeps in the worktree's setup).
  const sleeps = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { totalCents } from '../src/price.js';\ntest('t', async () => {\n  await new Promise((r) => setTimeout(r, 30_000));\n  assert.equal(totalCents([{ cents: 2, qty: 3 }]), 6);\n});\n";
  const t = prWith({ 'src/price.js': PRICE, 'test/sleeps.test.js': sleeps });
  const first = t.c.mergeDecisionFor(7, 9, t.prAt(t.head));
  assert.ok(first.vacuityRun);
  let stall = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    stall = Math.max(stall, now - last);
    last = now;
  }, 10);
  const run = t.c.vacuityRun(t.w, t.prAt(t.head), first.vacuityRun);
  try {
    await new Promise((r) => setTimeout(r, 2_000));
    // Decided meanwhile, at once: still waiting for its run, never merged.
    const t0 = performance.now();
    const d = t.c.mergeDecisionFor(7, 9, t.prAt(t.head));
    assert.ok(performance.now() - t0 < 1_000);
    assert.deepEqual([d.auto, d.reasons], [false, ['design: vacuity: its tests have not yet been run under coverage at this head']]);
  } finally {
    const t1 = performance.now();
    (t.c as unknown as { stop(): void }).stop();
    await run;
    clearInterval(tick);
    assert.ok(performance.now() - t1 < 10_000, `the run took ${Math.round(performance.now() - t1)} ms to stop`);
  }
  assert.ok(stall < 1_000, `the event loop was held ${Math.round(stall)} ms`);
  assert.equal(t.log.read(0, ['vacuity.measured']).length, 0, 'a run a shutdown cut short records nothing');
});
