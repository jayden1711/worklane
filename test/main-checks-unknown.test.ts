// #731: after an auto-merge, main's required checks that never report (no answer, a read that never answers, a GitHub
// error) are not green. At the timeout the engine fails closed: auto-merge stops on the instance with the stop file and a
// reason naming the checks and the merge commit, and resumes only as a red main's stop does (#776): main measured green
// on its tip, or an owner's typed acknowledgement. It never comments "Auto-merge goes on" again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommitCheck } from '../src/backlog/types.js';
import { Coordinator } from '../src/coordinator.js';
import { MAIN_CHECKS_MIN_POLLS, MAIN_CHECKS_TIMEOUT_MS } from '../src/coordinator/wait-caps.js';
import { clearAutoMergeStop } from '../src/dashboard.js';
import type { EventPayload } from '../src/events/types.js';
import { agents, approve, commitAll, fixture, git, passing, skip, type Fixture } from './repro-state-graph/harness.js';

type Inner = { watchMerges(): Promise<void>; stopFor(reason: string, n: number | null, sha: string, revert: string | null): void; mainChecksReadMs: number; mainChecksNow: () => number };

const body = (what: string) => `${what}.\n\n\`\`\`done_when\n- test: test/price.test.js\n\`\`\`\n`;

/** PR mode, auto-merge on, `ci` required: two ready tasks, each a PR changing its own file. Then A merges for real. */
async function world() {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = ['ci'];
  // Its PRs each add a module with no test, and these cases are about main's checks after a merge, not the vacuity
  // gate (#784, test/merge-vacuity-*.test.ts cover it): its app code is somewhere these PRs never touch.
  f.cfg.tests.vacuity = { ...f.cfg.tests.vacuity!, app_paths: ['app/**'] };
  mkdirSync(f.stateDir, { recursive: true });
  const a = f.backlog.open({ title: 'Add the order notes', body: body('Add src/notes-a.js'), author: 'example-owner', labels: ['ready'] });
  const b = f.backlog.open({ title: 'Add the refund notes', body: body('Add src/notes-b.js'), author: 'example-owner', labels: ['ready'] });
  const runner = agents({
    worker: (req) => {
      const file = /notes-a/.test(req.prompt) ? 'notes-a.js' : 'notes-b.js';
      writeFileSync(join(req.cwd, 'src', file), `export const notes = '${file}';\n`);
      commitAll(req.cwd, `Add src/${file}`);
      return { summary: 'done' };
    },
    'evaluator-verdict': approve(),
  });
  const make = () => new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, prPollMs: 0, autoMerge: () => true });
  let c = make();
  for (let i = 0; i < 12 && f.log.read(0, ['pr.opened']).length < 2; i++) {
    await c.tick();
    await c.idle();
  }
  const opened = f.log.read(0, ['pr.opened']).map((e) => e.payload as EventPayload<'pr.opened'>);
  assert.equal(opened.length, 2, 'both PRs open');
  const prA = opened.find((o) => o.issue === a)!;
  const prB = opened.find((o) => o.issue === b)!;
  f.backlog.mergeWith = (pr) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'gh-merge-')), 'c');
    git(f.base, 'clone', '-q', f.remote, dir);
    git(dir, 'fetch', '-q', 'origin', pr.head);
    git(dir, '-c', 'user.email=gh@example.com', '-c', 'user.name=GitHub', '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', '-m', `Merge pull request #${pr.number}`, pr.headSha);
    git(dir, 'push', '-q', 'origin', 'main');
    return git(dir, 'rev-parse', 'HEAD');
  };
  const headOf = (n: number) => f.backlog.prs().find((p) => p.number === n)!.headSha;
  // A's required check green on its head: it auto-merges. B's has not reported yet, so B waits.
  f.backlog.setChecks(headOf(prA.number), passing);
  await c.tick();
  await c.idle();
  const merged = f.log.read(0, ['merge.done']).map((e) => e.payload as EventPayload<'merge.done'>);
  assert.equal(merged.length, 1, `A auto-merged (${JSON.stringify(f.log.read(0, ['merge.decided', 'merge.failed', 'merge.deferred']).map((e) => e.payload))})`);
  assert.equal(merged[0]!.number, prA.number);
  const sha = merged[0]!.sha;
  assert.equal(git(f.remote, 'rev-parse', 'main'), sha, "A's merge commit is main's tip");
  return {
    f,
    prA,
    prB,
    sha,
    headOf,
    get c() {
      return c;
    },
    inner: () => c as unknown as Inner,
    /** A restart: a new coordinator over the same state directory and event log. */
    restart: () => {
      c = make();
      return c;
    },
  };
}
type World = Awaited<ReturnType<typeof world>>;

const stopFile = (f: Fixture) => join(f.stateDir, 'auto-merge-stopped.json');
const stopOf = (f: Fixture) => JSON.parse(readFileSync(stopFile(f), 'utf8')) as { reason: string; by: string; sha: string; number: number | null };
const of = <T>(f: Fixture, type: Parameters<Fixture['log']['read']>[1] extends (infer U)[] | undefined ? U : never) => f.log.read(0, [type]).map((e) => e.payload as T);
const commentsOn = (f: Fixture, n: number) => f.backlog.prs().find((p) => p.number === n)!.comments.map((c) => c.body);

/** `p`, or 'hung' when it hasn't settled in `ms` (a never-answered read must never hold the coordinator). */
async function bounded<T>(p: Promise<T>, ms: number): Promise<T | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'hung'>((done) => {
    timer = setTimeout(() => done('hung'), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Polls main's checks after the merge, `n` times, each bounded. */
async function polls(w: World, n: number) {
  for (let i = 0; i < n; i++) assert.notEqual(await bounded(w.inner().watchMerges(), 5000), 'hung', `poll ${i + 1} of main's checks answered`);
}

/** The next ready PR, B, with a perfect verdict: its check green on its head, then the PR watch looks at it. */
async function bReady(w: World) {
  w.f.backlog.setChecks(w.headOf(w.prB.number), passing);
  await w.c.tick();
  await w.c.idle();
}
const bMerged = (w: World) => of<EventPayload<'merge.done'>>(w.f, 'merge.done').some((m) => m.number === w.prB.number);

test("#731: a required check that never reports on the auto-merge's commit stops auto-merge at the timeout; the next ready PR is held, naming the check and the commit; never \"Auto-merge goes on\"", { skip }, async () => {
  const w = await world();
  // Before the timeout: still waiting, nothing stopped.
  await polls(w, MAIN_CHECKS_MIN_POLLS - 2);
  assert.ok(!existsSync(stopFile(w.f)), 'not stopped before the timeout');
  assert.equal(of(w.f, 'merge.main_result').length, 0);
  await polls(w, 5);
  // At the timeout: not green, so stopped, with the stop file, and why.
  const result = of<EventPayload<'merge.main_result'>>(w.f, 'merge.main_result');
  assert.deepEqual(result.map((r) => [r.sha, r.outcome, r.failed]), [[w.sha, 'timed_out', ['ci']]]);
  assert.ok(existsSync(stopFile(w.f)), 'the stop file is written');
  const stop = stopOf(w.f);
  assert.equal(stop.sha, w.sha);
  assert.equal(stop.number, w.prA.number);
  assert.notEqual(stop.by, 'owner', 'a stop that waits for green main');
  assert.match(stop.reason, new RegExp(`ci never reported on .*${w.sha.slice(0, 8)}`));
  const stopped = of<EventPayload<'merge.stopped'>>(w.f, 'merge.stopped');
  assert.equal(stopped.length, 1, 'one stop, logged');
  assert.equal(stopped[0]!.by, stop.by);
  assert.match(w.c.autoMergeStopped() ?? '', /ci never reported/);
  // The PR comment says auto-merge is stopped, and never that it goes on.
  const said = commentsOn(w.f, w.prA.number).filter((c) => /never reported on the merge commit/.test(c));
  assert.equal(said.length, 1);
  assert.doesNotMatch(said[0]!, /Auto-merge goes on/);
  assert.doesNotMatch(said[0]!, /check them yourself/);
  assert.match(said[0]!, /Auto-merge is stopped on this instance/);
  // Later polls stop nothing more.
  await polls(w, 3);
  assert.equal(of(w.f, 'merge.stopped').length, 1);
  // The next ready PR, with a perfect verdict, is held, and the hold names the check and the merge commit.
  await bReady(w);
  assert.ok(!bMerged(w), 'B is not auto-merged');
  const decided = of<EventPayload<'merge.decided'>>(w.f, 'merge.decided').filter((d) => d.number === w.prB.number).at(-1)!;
  assert.equal(decided.auto, false);
  assert.ok(decided.reasons.some((r) => r.startsWith('auto-merge is stopped: ') && r.includes('ci never reported') && r.includes(w.sha.slice(0, 8))), decided.reasons.join(' | '));
});

test('#731: the operator clearing the stop file while main is still unknown gets it written back; once main is green on its tip, clearing it resumes auto-merge (merge.resumed), as for a red main', { skip }, async () => {
  const w = await world();
  await polls(w, MAIN_CHECKS_MIN_POLLS + 1);
  assert.ok(existsSync(stopFile(w.f)));
  // Deleted by hand while the check still hasn't reported on main's tip: written back.
  unlinkSync(stopFile(w.f));
  assert.ok(w.c.autoMergeStopped(), 'held until the coordinator looks');
  await polls(w, 1);
  assert.ok(existsSync(stopFile(w.f)), 'written back');
  assert.equal(of(w.f, 'merge.resumed').length, 0);
  // The check reports green on main's tip: clearing it now resumes.
  w.f.backlog.setChecks(w.sha, passing);
  unlinkSync(stopFile(w.f));
  await polls(w, 1);
  assert.ok(!existsSync(stopFile(w.f)));
  assert.match(of<EventPayload<'merge.resumed'>>(w.f, 'merge.resumed').at(-1)!.detail, new RegExp(`green on ${w.sha.slice(0, 8)}`));
  assert.equal(w.c.autoMergeStopped(), null);
  await bReady(w);
  assert.ok(bMerged(w), 'B auto-merges again');
});

test("#731: an owner's typed acknowledgement on the dashboard resumes it while main is still unknown, recorded with who and why", { skip }, async () => {
  const w = await world();
  await polls(w, MAIN_CHECKS_MIN_POLLS + 1);
  assert.ok(existsSync(stopFile(w.f)));
  // A plain request: main isn't green, so it stays stopped.
  const plain = clearAutoMergeStop({ stateDir: w.f.stateDir, eventsDb: join(w.f.base, 'events.db'), by: 'example-owner' });
  assert.equal(plain.ok, true);
  await polls(w, 1);
  assert.ok(existsSync(stopFile(w.f)), 'a request without an acknowledgement waits for green main');
  assert.match(of<EventPayload<'merge.main_measured'>>(w.f, 'merge.main_measured').at(-1)!.why ?? '', /ci: missing/);
  const ack = 'CI is down for maintenance; checked main by hand';
  const r = clearAutoMergeStop({ stateDir: w.f.stateDir, eventsDb: join(w.f.base, 'events.db'), by: 'example-owner', ack });
  assert.equal(r.ok, true);
  await polls(w, 1);
  assert.ok(!existsSync(stopFile(w.f)), 'resumed on the acknowledgement');
  const resumed = of<EventPayload<'merge.resumed'>>(w.f, 'merge.resumed').at(-1)!.detail;
  assert.match(resumed, /^@example-owner resumed auto-merge from the dashboard, acknowledging main isn't green/);
  assert.ok(resumed.includes(ack));
});

test('#731: a check that reports green before the timeout leaves auto-merge running', { skip }, async () => {
  const w = await world();
  await polls(w, 5);
  w.f.backlog.setChecks(w.sha, passing);
  await polls(w, MAIN_CHECKS_MIN_POLLS + 5);
  assert.deepEqual(of<EventPayload<'merge.main_result'>>(w.f, 'merge.main_result').map((r) => r.outcome), ['green']);
  assert.ok(!existsSync(stopFile(w.f)));
  assert.equal(of(w.f, 'merge.stopped').length, 0);
  assert.equal(w.c.autoMergeStopped(), null);
  await bReady(w);
  assert.ok(bMerged(w), 'B auto-merges');
});

test("#731: a GitHub error reading main's checks is no answer: every poll counts, nothing throws out of the step, and at the timeout auto-merge stops, saying the checks couldn't be read", { skip }, async () => {
  const w = await world();
  const real = w.f.backlog.checks.bind(w.f.backlog);
  w.f.backlog.checks = async (sha: string, ...rest: unknown[]): Promise<CommitCheck[]> => {
    if (sha === w.sha) throw new Error('GitHub answered 502 Bad Gateway');
    return (real as (s: string, ...r: unknown[]) => Promise<CommitCheck[]>)(sha, ...rest);
  };
  await polls(w, MAIN_CHECKS_MIN_POLLS + 2);
  assert.ok(existsSync(stopFile(w.f)), 'stopped');
  const stop = stopOf(w.f);
  assert.equal(stop.sha, w.sha);
  assert.match(stop.reason, /ci .*couldn't be read.*502 Bad Gateway/);
  assert.deepEqual(of<EventPayload<'merge.main_result'>>(w.f, 'merge.main_result').map((r) => [r.outcome, r.failed]), [['timed_out', ['ci']]]);
  assert.match(w.c.autoMergeStopped() ?? '', /502/);
});

test("#731: a read of main's checks that never answers is bounded: each poll ends, counts as no answer, and at the timeout auto-merge stops", { skip }, async () => {
  const w = await world();
  const real = w.f.backlog.checks.bind(w.f.backlog);
  w.f.backlog.checks = (sha: string, ...rest: unknown[]): Promise<CommitCheck[]> => (sha === w.sha ? new Promise<CommitCheck[]>(() => undefined) : (real as (s: string, ...r: unknown[]) => Promise<CommitCheck[]>)(sha, ...rest));
  w.inner().mainChecksReadMs = 20;
  await polls(w, MAIN_CHECKS_MIN_POLLS + 2);
  assert.ok(existsSync(stopFile(w.f)), 'stopped');
  assert.match(stopOf(w.f).reason, /ci .*couldn't be read.*no answer/);
});

test('#731: the timeout counts from the merge, so a restart does not start it again: past it, the first poll after a restart stops auto-merge', { skip }, async () => {
  const w = await world();
  await polls(w, 3);
  assert.ok(!existsSync(stopFile(w.f)));
  // A restart forgets the poll count; the merge was logged more than MAIN_CHECKS_TIMEOUT_MS ago.
  w.restart();
  const later = Date.now() + MAIN_CHECKS_TIMEOUT_MS + 60_000;
  w.inner().mainChecksNow = () => later;
  await polls(w, 1);
  assert.ok(existsSync(stopFile(w.f)), 'stopped on the first poll after the restart');
  assert.match(stopOf(w.f).reason, /ci never reported/);
});

test("#731: a stop in force that resumes as before (by: owner) is replaced by one that waits for green main, so clearing it can't skip the check", { skip }, async () => {
  const w = await world();
  writeFileSync(stopFile(w.f), JSON.stringify({ reason: 'paused by the owner', by: 'owner', number: null, sha: null, revert: null }));
  await polls(w, MAIN_CHECKS_MIN_POLLS + 1);
  const stop = stopOf(w.f);
  assert.notEqual(stop.by, 'owner');
  assert.equal(stop.sha, w.sha);
  assert.match(stop.reason, /ci never reported/);
  // The dashboard's clear is now a request, not an at-once resume: main isn't green, so it stays stopped.
  const r = clearAutoMergeStop({ stateDir: w.f.stateDir, eventsDb: join(w.f.base, 'events.db'), by: 'example-owner' });
  assert.equal(r.ok, true);
  await polls(w, 1);
  assert.ok(existsSync(stopFile(w.f)), 'still stopped');
  assert.equal(of(w.f, 'merge.resumed').length, 0);
});

test("#731: a stop already in force that waits for green main is kept as it is (its kind and reason), and the comment says auto-merge stays stopped", { skip }, async () => {
  const w = await world();
  w.inner().stopFor(`main's required checks failed (ci) on \`${w.sha.slice(0, 8)}\``, null, w.sha, null);
  const before = readFileSync(stopFile(w.f), 'utf8');
  await polls(w, MAIN_CHECKS_MIN_POLLS + 1);
  assert.equal(readFileSync(stopFile(w.f), 'utf8'), before, 'the stop in force is untouched');
  assert.equal(of(w.f, 'merge.stopped').length, 1);
  const said = commentsOn(w.f, w.prA.number).filter((c) => /never reported on the merge commit/.test(c));
  assert.equal(said.length, 1);
  assert.doesNotMatch(said[0]!, /Auto-merge goes on/);
  assert.match(said[0]!, /Auto-merge stays stopped on this instance/);
});

test('#982: a stop file in force that can not be parsed names no cause, so it waits for green main and is kept as it is', { skip }, async () => {
  const w = await world();
  writeFileSync(stopFile(w.f), '{"reason": ');
  await polls(w, MAIN_CHECKS_MIN_POLLS + 1);
  assert.equal(readFileSync(stopFile(w.f), 'utf8'), '{"reason": ', 'the stop in force is untouched');
  assert.equal(of(w.f, 'merge.stopped').length, 0, 'no new stop replaces it');
  const said = commentsOn(w.f, w.prA.number).filter((c) => /never reported on the merge commit/.test(c));
  assert.equal(said.length, 1);
  assert.match(said[0]!, /Auto-merge stays stopped on this instance \(the stop file .* is unreadable\)/);
});
