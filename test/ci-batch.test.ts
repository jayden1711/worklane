// The slow checks on main in batches, and the bisect of a red batch (scripts/ci/batch.mjs, run by
// .github/workflows/ci-batch.yml): the pure decisions, then whole runs of the script against a fake GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

type Verdict = 'good' | 'bad' | 'pending' | 'skip' | 'untested';
type Step = { state: 'found'; culprit: string; good: string | null } | { state: 'wait' | 'test'; sha: string } | { state: 'range'; from: string; to: string };
type FakeGh = { get(path: string): Promise<unknown>; write(method: string, path: string, body?: unknown): Promise<unknown> };
type Run = { id: number; event: string; head_branch: string; head_sha: string; status: string; conclusion: string | null; created_at: string; html_url?: string };
const script = join(repoRoot, 'scripts', 'ci', 'batch.mjs');
const b = (await import(pathToFileURL(script).href)) as {
  SLOW_JOBS: Record<string, string[]>;
  BISECT_PREFIX: string;
  TURN_WAIT_MS: number;
  TURN_POLL_MS: number;
  batchToStart(runs: Run[], head: string, branch?: string): { start: boolean; why: string };
  olderRuns(gh: FakeGh, R: string, runId: number): Promise<number[]>;
  batchStep(o: { gh: FakeGh; R: string; branch: string; runId?: number; first?: { head: string; runs: Run[] } | null; say: (line: string) => void; sleep: (ms: number) => Promise<void> }): Promise<'started' | 'nothing'>;
  lastBatches(runs: Run[], branch?: string): { last: Run | null; green: Run | null };
  firstParentLine(cmp: unknown, good: string, bad: string): { sha: string; subject: string }[] | null;
  verdictOf(runs: { status: string; conclusion: string | null; started_at: string | null; id: number }[], dispatched?: boolean): Verdict;
  nextStep(commits: { sha: string; verdict: Verdict }[]): Step;
};

const sha = (n: number) => n.toString(16).padStart(2, '0').repeat(20);
/** Commits 1..n, oldest first, with these verdicts; the last must be the red batch's (bad). */
const commits = (v: Verdict[]) => v.map((verdict, i) => ({ sha: sha(i + 1), verdict }));

test('nextStep: the culprit is the oldest bad commit whose first parent is good', () => {
  assert.deepEqual(b.nextStep(commits(['bad'])), { state: 'found', culprit: sha(1), good: null }, 'one commit since the green batch: it is the culprit, nothing to run');
  assert.deepEqual(b.nextStep(commits(['good', 'good', 'bad', 'untested', 'bad'])), { state: 'found', culprit: sha(3), good: sha(2) });
  assert.deepEqual(b.nextStep(commits(['bad', 'untested', 'bad'])), { state: 'found', culprit: sha(1), good: null });
  // A flaky pass above the first bad one doesn't move it: the oldest bad commit, with the newest good one below it.
  assert.deepEqual(b.nextStep(commits(['good', 'bad', 'good', 'bad'])), { state: 'found', culprit: sha(2), good: sha(1) });
});

test('nextStep: binary search, the untested commit nearest the middle of the good..bad gap', () => {
  // 7 candidates and the red batch: the middle of -1..7 is 3 (the 4th commit).
  assert.deepEqual(b.nextStep(commits([...Array(7).fill('untested'), 'bad'])), { state: 'test', sha: sha(4) });
  assert.deepEqual(b.nextStep(commits(['untested', 'untested', 'untested', 'good', 'untested', 'untested', 'untested', 'bad'])), { state: 'test', sha: sha(6) });
  assert.deepEqual(b.nextStep(commits(['untested', 'untested', 'untested', 'bad', 'untested', 'untested', 'untested', 'bad'])), { state: 'test', sha: sha(2) });
  // Ties go to the older commit: 2 candidates, the middle of -1..2 is 0.5.
  assert.deepEqual(b.nextStep(commits(['untested', 'untested', 'bad'])), { state: 'test', sha: sha(1) });
  // An untestable commit is passed over for its neighbour.
  assert.deepEqual(b.nextStep(commits(['untested', 'skip', 'untested', 'bad'])), { state: 'test', sha: sha(1) });
});

test('nextStep: waits for a running candidate, and names a range when only untestable commits are left', () => {
  assert.deepEqual(b.nextStep(commits(['untested', 'pending', 'untested', 'bad'])), { state: 'wait', sha: sha(2) });
  assert.deepEqual(b.nextStep(commits(['good', 'skip', 'skip', 'bad'])), { state: 'range', from: sha(2), to: sha(4) });
  assert.deepEqual(b.nextStep(commits(['skip', 'bad'])), { state: 'range', from: sha(1), to: sha(2) });
  // A pending one outside the gap doesn't hold it up.
  assert.deepEqual(b.nextStep(commits(['good', 'bad', 'pending', 'bad'])), { state: 'found', culprit: sha(2), good: sha(1) });
  assert.throws(() => b.nextStep(commits(['good'])), /no bad commit/);
});

test('verdictOf: the newest check run by that name decides; a dispatched step with no run yet is pending', () => {
  const r = (conclusion: string | null, started_at: string, id = 1, status = 'completed') => ({ status, conclusion, started_at, id });
  assert.equal(b.verdictOf([]), 'untested');
  assert.equal(b.verdictOf([], true), 'pending');
  assert.equal(b.verdictOf([r('success', '2026-10-13T01:00:00Z')]), 'good');
  assert.equal(b.verdictOf([r('failure', '2026-10-13T01:00:00Z')]), 'bad');
  assert.equal(b.verdictOf([r('timed_out', '2026-10-13T01:00:00Z')]), 'bad');
  assert.equal(b.verdictOf([r(null, '2026-10-13T01:00:00Z', 1, 'in_progress')]), 'pending');
  assert.equal(b.verdictOf([r('skipped', '2026-10-13T01:00:00Z')]), 'skip');
  assert.equal(b.verdictOf([r('cancelled', '2026-10-13T01:00:00Z')]), 'skip');
  assert.equal(b.verdictOf([r('failure', '2026-10-13T01:00:00Z', 1), r('success', '2026-10-13T02:00:00Z', 2)]), 'good', 'a rerun replaces the older result');
  assert.equal(b.verdictOf([r('success', '2026-10-13T02:00:00Z', 2), r('failure', '2026-10-13T01:00:00Z', 1)]), 'good', 'whatever order GitHub lists them in');
});

const run = (o: Partial<Run> & { head_sha: string; created_at: string }): Run => ({ id: Date.parse(o.created_at) / 1000, event: 'workflow_dispatch', head_branch: 'main', status: 'completed', conclusion: 'success', ...o });

test('batchToStart: once per commit, never while a batch is queued or running; a cancelled batch is redone', () => {
  const head = sha(9);
  assert.equal(b.batchToStart([], head).start, true);
  assert.equal(b.batchToStart([run({ head_sha: sha(8), created_at: '2026-10-13T01:00:00Z' })], head).start, true, 'an older commit had one');
  assert.equal(b.batchToStart([run({ head_sha: head, created_at: '2026-10-13T01:00:00Z', conclusion: 'failure' })], head).start, false, 'a red batch is one');
  assert.equal(b.batchToStart([run({ head_sha: head, created_at: '2026-10-13T01:00:00Z', conclusion: 'cancelled' })], head).start, true);
  assert.equal(b.batchToStart([run({ head_sha: sha(8), created_at: '2026-10-13T01:00:00Z', status: 'in_progress', conclusion: null })], head).start, false, 'one at a time');
  assert.equal(b.batchToStart([run({ head_sha: sha(8), created_at: '2026-10-13T01:00:00Z', status: 'queued', conclusion: null })], head).start, false);
  // A bisect step (on a ci-bisect/ branch), running or done, is not a batch.
  const step = run({ head_sha: head, head_branch: `${b.BISECT_PREFIX}${head}`, created_at: '2026-10-13T01:00:00Z', status: 'in_progress', conclusion: null });
  assert.equal(b.batchToStart([step], head).start, true);
  assert.equal(b.batchToStart([run({ head_sha: head, created_at: '2026-10-13T01:00:00Z', event: 'pull_request', head_branch: 'feature' })], head).start, true, 'a PR run is not a batch');
});

test('batchToStart: no time spacing: a batch that ended a minute ago doesn\'t hold back the next commit\'s', () => {
  const head = sha(9);
  const justEnded = run({ head_sha: sha(8), created_at: new Date(Date.now() - 6 * 60_000).toISOString() });
  assert.deepEqual(b.batchToStart([justEnded], head), { start: true, why: `${head.slice(0, 7)} has had no batch` });
  assert.deepEqual(b.batchToStart([{ ...justEnded, conclusion: 'failure' }], head).start, true, 'whatever it ended as');
  // Still one at a time, and once per commit, however recent.
  assert.match(b.batchToStart([{ ...justEnded, status: 'in_progress', conclusion: null }], head).why, /is in_progress/);
  assert.match(b.batchToStart([{ ...justEnded, head_sha: head }], head).why, /has had its batch/);
});

/**
 * batchStep against an in-process GitHub: `slow` are ci-slow.yml's runs, `mine` this workflow's runs still going
 * (by id), `onSleep` what happens in the world while the step sleeps. `first` is what the run read when it began.
 */
type StepWorld = { head: string; slow: Run[]; mine: number[] };
function stepWorld(o: { head: string; slow: Run[]; mine?: number[]; onSleep?: (w: StepWorld, n: number) => void }) {
  const w: StepWorld = { head: o.head, slow: [...o.slow], mine: [...(o.mine ?? [])] };
  const said: string[] = [];
  const sleeps: number[] = [];
  const dispatched: string[] = [];
  const asked: string[] = [];
  const gh: FakeGh = {
    get: async (path) => {
      asked.push(path);
      if (path === '/r/commits/main') return { sha: w.head };
      if (path.startsWith('/r/actions/workflows/ci-slow.yml/runs?')) return { workflow_runs: [...w.slow] };
      if (path.startsWith('/r/actions/workflows/ci-batch.yml/runs?status=in_progress')) return { workflow_runs: w.mine.map((id) => ({ id, status: 'in_progress' })) };
      if (path.startsWith('/r/actions/workflows/ci-batch.yml/runs?status=queued')) return { workflow_runs: [] };
      throw new Error(`no fake for ${path}`);
    },
    write: async (method, path, body) => {
      assert.equal(`${method} ${path}`, 'POST /r/actions/workflows/ci-slow.yml/dispatches');
      assert.deepEqual(body, { ref: 'main', inputs: { job: 'all', sha: '' } });
      dispatched.push(w.head);
      w.slow.push(run({ head_sha: w.head, created_at: '2026-10-13T02:00:00Z', status: 'queued', conclusion: null }));
      return null;
    },
  };
  const first = { head: w.head, runs: [...w.slow] };
  const step = (runId: number) =>
    b.batchStep({
      gh,
      R: '/r',
      branch: 'main',
      runId,
      first,
      say: (l) => said.push(l),
      sleep: async (ms) => {
        sleeps.push(ms);
        o.onSleep?.(w, sleeps.length);
      },
    });
  return { w, said, sleeps, dispatched, asked, step };
}

test('batchStep: a look when ci ends on main, or when a batch ends, starts the newest commit\'s batch at once; never a second one', async () => {
  // The incident's shape: the last batch ended minutes ago on an older commit; main's tip has had none.
  const s = stepWorld({ head: sha(9), slow: [run({ head_sha: sha(8), created_at: '2026-10-13T01:00:00Z' })] });
  assert.equal(await s.step(500), 'started');
  assert.deepEqual([s.dispatched, s.sleeps], [[sha(9)], []], 'no waiting');
  assert.match(s.said.join('\n'), /batch: started on main/);
  // One running (the last commit of a burst lands meanwhile): nothing now; the look when it ends starts the next.
  const busy = stepWorld({ head: sha(10), slow: [run({ head_sha: sha(9), created_at: '2026-10-13T01:00:00Z', status: 'in_progress', conclusion: null })] });
  assert.equal(await busy.step(501), 'nothing');
  assert.deepEqual([busy.dispatched, busy.asked], [[], []], 'nothing to start: decided on what the run read, nothing more asked');
  busy.w.slow[0] = { ...busy.w.slow[0]!, status: 'completed', conclusion: 'success' };
  const next = stepWorld({ head: sha(10), slow: busy.w.slow });
  assert.equal(await next.step(502), 'started');
  assert.deepEqual(next.dispatched, [sha(10)], 'main\'s newest commit, without the schedule');
  // Already batched: nothing.
  const had = stepWorld({ head: sha(9), slow: [run({ head_sha: sha(9), created_at: '2026-10-13T01:00:00Z', conclusion: 'failure' })] });
  assert.equal(await had.step(503), 'nothing');
  assert.deepEqual(had.dispatched, []);
});

test('batchStep: two looks at once never start a batch each: the newer lets the older finish, then reads again', async () => {
  const slow = [run({ head_sha: sha(8), created_at: '2026-10-13T01:00:00Z' })];
  // A batch ends as ci finishes on main: runs 499 and 500 both read "no batch on the tip, none running". 499 starts
  // it while 500 gives it its turn; 500 then reads again and starts nothing.
  const a = stepWorld({
    head: sha(9),
    slow,
    mine: [499, 500, 777],
    onSleep: (w) => {
      w.slow.push(run({ head_sha: w.head, created_at: '2026-10-13T02:00:00Z', status: 'queued', conclusion: null }));
      w.mine = [500, 777];
    },
  });
  assert.equal(await a.step(500), 'nothing');
  assert.deepEqual([a.dispatched, a.sleeps], [[], [b.TURN_POLL_MS]], 'a newer run (777) and itself (500) are not waited for');
  assert.match(a.said.at(-1)!, /is queued/);
  // The oldest run waits on nobody, but still decides on a fresh read: an older run that finished between this
  // run's first read and now may have started the batch.
  const o = stepWorld({ head: sha(9), slow, mine: [500, 600] });
  o.w.slow.push(run({ head_sha: sha(9), created_at: '2026-10-13T02:00:00Z', status: 'queued', conclusion: null }));
  assert.equal(await o.step(500), 'nothing');
  assert.deepEqual([o.dispatched, o.sleeps], [[], []]);
  // Main moved on while it gave way: the batch goes to the newest commit.
  const m = stepWorld({ head: sha(9), slow, mine: [499, 500], onSleep: (w) => ((w.head = sha(10)), (w.mine = [500])) });
  assert.equal(await m.step(500), 'started');
  assert.deepEqual(m.dispatched, [sha(10)]);
  // An older run stuck for a minute is not waited for any longer: at most TURN_WAIT_MS, then a fresh read decides.
  const stuck = stepWorld({ head: sha(9), slow, mine: [499, 500] });
  assert.equal(await stuck.step(500), 'started');
  assert.equal(stuck.sleeps.reduce((n, x) => n + x, 0), b.TURN_WAIT_MS);
  assert.ok(b.TURN_WAIT_MS <= 60_000, 'a minute at most: the run\'s check on main\'s tip is never in progress for long');
});

test('ci-batch.yml: it looks when ci.yml ends on a push to main, never for a pull request\'s run, and only ever runs main\'s own script', () => {
  const read = (f: string) => readFileSync(join(repoRoot, '.github', 'workflows', f), 'utf8');
  const wf = parse(read('ci-batch.yml')) as {
    on: { schedule: { cron: string }[]; workflow_run: { workflows: string[]; types: string[] } };
    jobs: { batch: { if: string; 'timeout-minutes': number; steps: { uses?: string; with?: Record<string, unknown>; run?: string }[] } };
  };
  const ci = parse(read('ci.yml')) as { name: string; on: { push: { branches: string[] }; workflow_dispatch?: unknown } };
  assert.deepEqual(wf.on.workflow_run, { workflows: [(parse(read('ci-slow.yml')) as { name: string }).name, ci.name], types: ['completed'] });
  assert.deepEqual(ci.on.push.branches, ['main'], 'ci.yml runs on every push to main');
  assert.ok(!('workflow_dispatch' in ci.on), 'the workflow_dispatch clause below can only be a ci-slow.yml batch or bisect run');
  assert.deepEqual(wf.on.schedule, [{ cron: '*/30 * * * *' }], 'the schedule stays, as a backstop');
  // The guard, clause by clause: anything a pull request's run could match is absent.
  const clauses = wf.jobs.batch.if.replace(/\s+/g, ' ').trim();
  assert.equal(
    clauses,
    "github.event_name != 'workflow_run' || github.event.workflow_run.event == 'workflow_dispatch' || (github.event.workflow_run.name == 'ci' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == github.event.repository.default_branch && github.event.workflow_run.head_repository.full_name == github.repository)",
  );
  assert.equal(ci.name, 'ci', 'the name the guard compares');
  // Its code is the default branch's, with no credentials left behind; the triggering run's ref or sha is never used.
  const text = read('ci-batch.yml').replace(/^\s*#.*$/gm, '');
  const checkouts = wf.jobs.batch.steps.filter((x) => (x.uses ?? '').startsWith('actions/checkout@'));
  assert.deepEqual(checkouts.map((x) => x.with), [{ ref: '${{ github.event.repository.default_branch }}', 'persist-credentials': false }]);
  assert.doesNotMatch(text, /workflow_run\.(head_sha|head_commit|pull_requests)|workflow_run\.head_branch \}\}/);
  assert.deepEqual(wf.jobs.batch.steps.map((x) => x.run).filter(Boolean), ['node scripts/ci/batch.mjs']);
  // A short job: its check lands on main's tip, where an in-progress check reads as pending to the updater and a merge.
  assert.equal(wf.jobs.batch['timeout-minutes'], 10);
  assert.ok(b.TURN_WAIT_MS <= 60_000);
});

test('lastBatches: the newest finished batch, and the newest green one before it on another commit', () => {
  const runs = [
    run({ head_sha: sha(1), created_at: '2026-10-13T01:00:00Z' }),
    run({ head_sha: sha(2), created_at: '2026-10-13T01:30:00Z', conclusion: 'failure' }),
    run({ head_sha: sha(3), created_at: '2026-10-13T02:00:00Z' }),
    run({ head_sha: sha(5), created_at: '2026-10-13T02:30:00Z', conclusion: 'cancelled' }),
    run({ head_sha: sha(4), created_at: '2026-10-13T03:00:00Z', conclusion: 'failure' }),
    run({ head_sha: sha(6), created_at: '2026-10-13T03:30:00Z', status: 'in_progress', conclusion: null }),
  ];
  const { last, green } = b.lastBatches(runs);
  assert.equal(last?.head_sha, sha(4), 'running and cancelled batches aside');
  assert.equal(green?.head_sha, sha(3));
  assert.equal(b.lastBatches(runs.slice(0, 2)).green?.head_sha, sha(1));
  assert.equal(b.lastBatches([run({ head_sha: sha(2), created_at: '2026-10-13T01:30:00Z', conclusion: 'failure' })]).green, null);
});

test('firstParentLine: from the red batch back to the green one along first parents, oldest first; null off that line', () => {
  const c = (n: number, ...parents: number[]) => ({ sha: sha(n), parents: parents.map((p) => ({ sha: sha(p) })), commit: { message: `Merge #${n}: change ${n}\n\nbody` } });
  // 1 (green) <- 3 <- 5 (red), each a merge whose second parent is a PR branch commit (2, 4).
  const cmp = { commits: [c(2, 1), c(3, 1, 2), c(4, 3), c(5, 3, 4)] };
  assert.deepEqual(b.firstParentLine(cmp, sha(1), sha(5)), [
    { sha: sha(3), subject: 'Merge #3: change 3' },
    { sha: sha(5), subject: 'Merge #5: change 5' },
  ]);
  assert.equal(b.firstParentLine(cmp, sha(2), sha(5)), null, 'the green batch off the first-parent line');
  assert.equal(b.firstParentLine({ commits: [c(5, 3, 4)] }, sha(1), sha(5)), null, 'a truncated compare');
});

// ---------- whole runs, against a fake GitHub ----------

const REPO = 'example-org/engine';
const RUN_ID = 4242; // this run of ci-batch.yml, as the script and the fake GitHub know it
type Req = { method: string; path: string; body: Record<string, unknown> | null };
type World = {
  head: string;
  line: string[]; // main's first-parent commits, oldest first
  runs: Run[];
  checks: Map<string, { name: string; status: string; conclusion: string | null; started_at: string; id: number }[]>;
  refs: Map<string, string>;
  issues: { title: string; body: string; html_url: string }[];
  comments: { pr: number; body: string }[];
  writes: Req[];
  /** What the failing job gives on a commit, when a bisect step runs it there. */
  result: (sha: string) => 'success' | 'failure' | 'none';
  failing: string;
};

function fakeGitHub(w: World) {
  let id = 1000;
  const json = (res: ServerResponse, code: number, v: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(v === null ? '' : JSON.stringify(v));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const p = u.pathname.replace(`/repos/${REPO}`, '');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      if (req.method !== 'GET') w.writes.push({ method: req.method!, path: p, body });
      if (req.method === 'GET' && p === '') return json(res, 200, { default_branch: 'main' });
      if (req.method === 'GET' && p === '/commits/main') return json(res, 200, { sha: w.head });
      if (req.method === 'GET' && p === '/actions/workflows/ci-slow.yml/runs') return json(res, 200, { workflow_runs: [...w.runs].reverse() });
      if (req.method === 'GET' && p === '/actions/workflows/ci-batch.yml/runs') return json(res, 200, { workflow_runs: u.searchParams.get('status') === 'in_progress' ? [{ id: RUN_ID, status: 'in_progress' }] : [] });
      if (req.method === 'GET' && p === '/git/matching-refs/heads/ci-bisect/') return json(res, 200, [...w.refs].map(([name, s]) => ({ ref: `refs/heads/${name}`, object: { sha: s } })));
      if (req.method === 'GET' && p === '/issues') return json(res, 200, w.issues);
      let m = /^\/actions\/runs\/(\d+)\/jobs$/.exec(p);
      if (m) return json(res, 200, { jobs: [{ name: w.failing, conclusion: 'failure' }, { name: 'scope', conclusion: 'success' }] });
      m = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(p);
      if (m) {
        const from = w.line.indexOf(m[1]!);
        const to = w.line.indexOf(m[2]!);
        return json(res, 200, { commits: w.line.slice(from + 1, to + 1).map((s) => ({ sha: s, parents: [{ sha: w.line[w.line.indexOf(s) - 1] }], commit: { message: `Merge #${w.line.indexOf(s) + 100}: change` } })) });
      }
      m = /^\/commits\/([0-9a-f]{40})\/check-runs$/.exec(p);
      if (m) return json(res, 200, { check_runs: (w.checks.get(m[1]!) ?? []).filter((c) => c.name === u.searchParams.get('check_name')) });
      m = /^\/commits\/([0-9a-f]{40})\/pulls$/.exec(p);
      if (m) return json(res, 200, [{ number: w.line.indexOf(m[1]!) + 100, merge_commit_sha: m[1] }]);
      if (req.method === 'POST' && p === '/actions/workflows/ci-slow.yml/dispatches') {
        const ref = String(body!.ref);
        const inputs = body!.inputs as { job: string; sha: string };
        const at = new Date(Date.parse('2026-10-13T00:00:00Z') + id * 60_000).toISOString();
        if (ref === 'main') w.runs.push({ id: id++, event: 'workflow_dispatch', head_branch: 'main', head_sha: w.head, status: 'queued', conclusion: null, created_at: at });
        else {
          // A bisect step: the job alone, on the commit the branch points at; it ends at once.
          const s = w.refs.get(ref)!;
          assert.equal(inputs.sha, s, 'the step names the commit its branch points at');
          assert.equal(ref, `ci-bisect/${s}`);
          // 'none': the run ended without the job (its workflow refused the dispatch's inputs, say).
          const r = w.result(s);
          w.runs.push({ id: id++, event: 'workflow_dispatch', head_branch: ref, head_sha: s, status: 'completed', conclusion: r === 'none' ? 'failure' : r, created_at: at });
          if (r !== 'none') w.checks.set(s, [...(w.checks.get(s) ?? []), { name: w.failing, status: 'completed', conclusion: r, started_at: at, id: id++ }]);
        }
        return json(res, 204, null);
      }
      if (req.method === 'POST' && p === '/git/refs') {
        const name = String(body!.ref).replace('refs/heads/', '');
        if (w.refs.has(name)) return json(res, 422, { message: 'Reference already exists' });
        w.refs.set(name, String(body!.sha));
        return json(res, 201, {});
      }
      m = /^\/git\/refs\/heads\/(.+)$/.exec(p);
      if (req.method === 'DELETE' && m) return (w.refs.delete(m[1]!), json(res, 204, null));
      if (req.method === 'POST' && p === '/issues') {
        const issue = { title: String(body!.title), body: String(body!.body), html_url: `https://github.com/${REPO}/issues/${w.issues.length + 1}` };
        w.issues.push(issue);
        return json(res, 201, issue);
      }
      m = /^\/issues\/(\d+)\/comments$/.exec(p);
      if (req.method === 'POST' && m) return (w.comments.push({ pr: Number(m[1]), body: String(body!.body) }), json(res, 201, {}));
      json(res, 404, { message: `no fake for ${req.method} ${p}` });
    });
  });
  return server;
}

async function tick(port: number, dry = false): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'ci-batch-'));
  writeFileSync(join(dir, 'summary.md'), '');
  const child = spawn(process.execPath, [script, ...(dry ? ['--dry-run'] : [])], {
    env: { PATH: process.env.PATH ?? '', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: REPO, GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), GITHUB_RUN_ID: String(RUN_ID) },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise<number | null>((r) => child.on('close', r));
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /::error/, out);
  return out;
}

function world(n: number, culprit: number, failing = 'add-project (real systemd)'): World {
  // Commits 0..n on main: 0 had a green batch, n a red one; `culprit` and every later one fail the job.
  const line = Array.from({ length: n + 1 }, (_, i) => sha(i + 1));
  const runs = [run({ id: 1, head_sha: line[0]!, created_at: '2026-10-12T22:00:00Z' }), run({ id: 2, head_sha: line[n]!, created_at: '2026-10-12T23:00:00Z', conclusion: 'failure' })];
  const checks = new Map<string, { name: string; status: string; conclusion: string | null; started_at: string; id: number }[]>([
    [line[0]!, [{ name: failing, status: 'completed', conclusion: 'success', started_at: '2026-10-12T22:01:00Z', id: 1 }]],
    [line[n]!, [{ name: failing, status: 'completed', conclusion: 'failure', started_at: '2026-10-12T23:01:00Z', id: 2 }]],
  ]);
  return { head: line[n]!, line, runs, checks, refs: new Map(), issues: [], comments: [], writes: [], result: (s) => (line.indexOf(s) >= culprit ? 'failure' : 'success'), failing };
}

async function withFake<T>(w: World, f: (port: number) => Promise<T>): Promise<T> {
  const server = fakeGitHub(w);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await f((server.address() as AddressInfo).port);
  } finally {
    server.close();
  }
}

test('a red batch over 7 commits: 3 bisect steps, each on its own ci-bisect/ branch, then the culprit in an issue and on its PR', async () => {
  const w = world(8, 5);
  await withFake(w, async (port) => {
    const steps: string[] = [];
    for (let i = 0; i < 6 && !w.issues.length; i++) {
      const before = w.writes.length;
      await tick(port);
      for (const x of w.writes.slice(before)) if (x.path === '/actions/workflows/ci-slow.yml/dispatches' && x.body!.ref !== 'main') steps.push(String((x.body!.inputs as { sha: string }).sha));
    }
    assert.deepEqual(steps.map((s) => w.line.indexOf(s)), [4, 6, 5], 'binary search: the middle, then the middle of what is left');
    for (const x of w.writes.filter((y) => y.path === '/actions/workflows/ci-slow.yml/dispatches' && y.body!.ref !== 'main')) assert.deepEqual((x.body!.inputs as { job: string }).job, 'add-project-real-systemd', 'the failing job alone');
    assert.equal(w.issues.length, 1);
    const issue = w.issues[0]!;
    assert.equal(issue.title, `CI batch red: "add-project (real systemd)" broke at ${w.line[5]!.slice(0, 7)} (#105)`);
    assert.match(issue.body, new RegExp(`ci-batch-bisect red-batch=${w.line[8]}`));
    assert.match(issue.body, new RegExp(`${w.line[4]!.slice(0, 7)}\\]\\([^)]*\\) good`));
    assert.deepEqual(w.comments.map((c) => c.pr), [105], 'a comment on the culprit\'s PR');
    assert.match(w.comments[0]!.body, /issues\/1/);
    // Reported once: the next run sees the marker and does nothing more; the steps' branches are gone.
    const writes = w.writes.length;
    await tick(port);
    assert.deepEqual(w.writes.slice(writes).filter((x) => x.method !== 'DELETE'), []);
    assert.deepEqual([...w.refs.keys()], []);
  });
});

test('a step that ends without running the job is passed over, never asked again; with only it left, the issue names the range', async () => {
  const w = world(4, 3);
  const result = w.result;
  w.result = (s) => (s === w.line[2] ? 'none' : result(s));
  await withFake(w, async (port) => {
    const steps: number[] = [];
    for (let i = 0; i < 6 && !w.issues.length; i++) {
      const before = w.writes.length;
      await tick(port);
      for (const x of w.writes.slice(before)) if (x.path === '/actions/workflows/ci-slow.yml/dispatches' && x.body!.ref !== 'main') steps.push(w.line.indexOf(String((x.body!.inputs as { sha: string }).sha)));
    }
    assert.deepEqual(steps, [2, 1, 3]);
    assert.equal(w.issues[0]?.title, `CI batch red: "add-project (real systemd)" broke between ${w.line[2]!.slice(0, 7)} and ${w.line[3]!.slice(0, 7)}`);
    assert.match(w.issues[0]!.body, new RegExp(`${w.line[2]!.slice(0, 7)}\\]\\([^)]*\\) skip`));
    assert.deepEqual(w.comments, [], 'no culprit, no PR comment');
  });
});

test('a red batch one commit after the green one: that commit is the culprit, with no bisect run', async () => {
  const w = world(1, 1, 'bootstrap (macos-latest)');
  await withFake(w, async (port) => {
    await tick(port);
    assert.equal(w.writes.filter((x) => x.path.endsWith('/dispatches')).length, 0);
    assert.equal(w.issues[0]?.title, `CI batch red: "bootstrap (macos-latest)" broke at ${w.line[1]!.slice(0, 7)} (#101)`);
  });
});

test('a new main commit with no batch gets one, dispatched on main; a dry run only says so', async () => {
  const w = world(2, 2);
  w.runs[1]!.conclusion = 'success';
  w.line.push(sha(40));
  w.head = sha(40);
  await withFake(w, async (port) => {
    const out = await tick(port, true);
    assert.match(out, /would POST \/repos\/example-org\/engine\/actions\/workflows\/ci-slow\.yml\/dispatches \{"ref":"main","inputs":\{"job":"all","sha":""\}\}/);
    assert.deepEqual(w.writes, []);
    await tick(port);
    assert.deepEqual(w.writes, [{ method: 'POST', path: '/actions/workflows/ci-slow.yml/dispatches', body: { ref: 'main', inputs: { job: 'all', sha: '' } } }]);
    // Queued now: the next run starts nothing.
    await tick(port);
    assert.equal(w.writes.length, 1);
  });
});

test('a whole run minutes after the last batch ended: the new main commit\'s batch is dispatched at once', async () => {
  const w = world(2, 2);
  // The last batch (green) started 6 minutes ago and has ended; main has a newer commit with no batch.
  w.runs[1]!.conclusion = 'success';
  w.runs[1]!.created_at = new Date(Date.now() - 6 * 60_000).toISOString();
  w.line.push(sha(40));
  w.head = sha(40);
  await withFake(w, async (port) => {
    const out = await tick(port);
    assert.match(out, /batch: started on main/);
    assert.doesNotMatch(out, /wait/);
    assert.deepEqual(w.writes, [{ method: 'POST', path: '/actions/workflows/ci-slow.yml/dispatches', body: { ref: 'main', inputs: { job: 'all', sha: '' } } }]);
  });
});

test('slow-jobs.sh on a PR: the jobs whose paths it touches, all of them for a workflow change or the full-ci label', { skip: process.platform === 'win32' && 'bash' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'slow-scope-'));
  const git = (...a: string[]) => spawnSync('git', ['-C', dir, '-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).stdout.trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const pr = (file: string, full = 'false') => {
    git('checkout', '-q', '-B', 'pr', base);
    const p = join(dir, file);
    spawnSync('mkdir', ['-p', join(p, '..')]);
    writeFileSync(p, 'y\n');
    git('add', file);
    git('commit', '-q', '-m', 'change');
    const r = spawnSync('bash', [join(repoRoot, 'scripts', 'ci', 'slow-jobs.sh')], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', EVENT: 'pull_request', FULL: full, PR_BASE: base, PR_HEAD: git('rev-parse', 'HEAD') } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n').find((l) => l.startsWith('run='))!.slice(4).trim().split(/\s+/).filter(Boolean);
  };
  const all = Object.keys(b.SLOW_JOBS);
  assert.deepEqual(pr('docs/a.md'), []);
  assert.deepEqual(pr('docs/a.md', 'true'), all, 'the full-ci label');
  assert.deepEqual(pr('.github/workflows/ci.yml'), all);
  assert.deepEqual(pr('scripts/bootstrap.sh'), ['bootstrap', 'bootstrap-windows', 'testrun-real-systemd', 'add-project-real-systemd', 'auth-probe-real-users'], "the server install's ending is proven on real systemd (add-project's job)");
  assert.deepEqual(pr('src/dashboard-detach.ts'), ['bootstrap', 'bootstrap-windows'], "the install's last step, the wizard URL");
  assert.deepEqual(pr('web/src/components/DashboardKey.tsx'), ['bootstrap', 'bootstrap-windows'], 'the page that URL opens asks for the key');
  assert.deepEqual(pr('src/os/linux.ts'), ['testrun-real-systemd', 'add-project-real-systemd', 'auth-probe-real-users']);
});
