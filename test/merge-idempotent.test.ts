// #733: the engine's merge is idempotent across a crash. merge.attempted is recorded before GitHub's merge API call
// (mergeOurs, the one door of every merge site); a crash between GitHub's merge and merge.done is settled on the PR
// watch's next pass (src/merge-policy-reconcile.ts), and the main watch then counts the commit as the engine's own,
// judged as of GitHub's merged_at. Only the engine's own App counts (its bot user's id and login, from the App's
// credentials): a merge by anyone else, at another head, after a failed or deferred attempt, or with no App identity
// known stays unaccounted exactly as before. A merge call that keeps throwing never holds up the other PRs, and its
// tries are capped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import type { CommitCheck } from '../src/backlog/types.js';
import { approveMerge } from '../src/decide.js';
import type { StoredEvent } from '../src/events/types.js';
import { CONFIG_PATH, type CheckRunAt, type MainWatchApi, type MergedPull } from '../src/main-watch.js';
import { mergeMessage } from '../src/merge-policy-train.js';
import { agents, coordinator, fixture, git, passing, skip } from './repro-state-graph/harness.js';

type C = { watchPrs(): Promise<void>; watchMain(): Promise<void> };
type Payload = Record<string, unknown>;
const ident = ['-c', 'user.email=gh@example.com', '-c', 'user.name=GitHub', '-c', 'commit.gpgsign=false'];
/** The engine's GitHub App's bot user, as GitHub reports who merged a PR it merged: its login and numeric id. */
const APP = 'example-engine[bot]';
const APP_ID = 4242;
const full: CommitCheck = { name: 'full', source: 'check_run', status: 'completed', conclusion: 'success', id: 2 };

/**
 * A repo whose default branch carries its required_checks (the main watch judges a merge by them), the engine's
 * clone, a file backlog whose merges are the engine's App's, and a GitHub for the main watch: no protection, and each
 * merged PR as the test says. `engineBot`: the App identity the coordinator was started with (null: none known).
 */
function world(o: { batching?: boolean; autoMerge?: boolean; engineBot?: { login: string; id: number } | null } = {}) {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = o.batching ? ['ci', 'full'] : ['ci'];
  f.cfg.project.combined_check = false;
  if (o.batching) f.cfg.tests.land.pr_batch = { enabled: true, max: 8, shards: 1, fast_checks: ['ci'], full_checks: ['full'] };
  appendFileSync(join(f.repo, CONFIG_PATH), `\nrequired_checks: ${JSON.stringify(f.cfg.project.required_checks)}\n`);
  git(f.repo, 'add', CONFIG_PATH);
  git(f.repo, 'commit', '-q', '-m', 'required_checks');
  git(f.repo, 'push', '-q', 'origin', 'main');
  const base = git(f.repo, 'rev-parse', 'HEAD');
  // The merge API merges as the engine's App.
  (f.backlog as unknown as { merger: { login: string; id: number } }).merger = { login: APP, id: APP_ID };

  const pulls = new Map<string, MergedPull[]>();
  /** Check runs by head, when a test sets them; otherwise every check finished long before any merge. */
  const runs = new Map<string, CheckRunAt[]>();
  const old = '2020-01-01T00:00:00.000Z';
  const api: MainWatchApi = {
    protection: async () => 'none',
    commitPulls: async (sha) => pulls.get(sha) ?? [],
    pull: async (n) => [...pulls.values()].flat().find((p) => p.number === n)!,
    checkRuns: async (sha): Promise<CheckRunAt[]> => runs.get(sha) ?? (await f.backlog.checks(sha)).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, startedAt: old, completedAt: old })),
    statuses: async () => [],
    role: async () => null,
    compare: async () => ({ status: 'behind', aheadBy: 0, behindBy: 1 }),
  };
  const clock = { t: Date.now() };
  const engineBot = o.engineBot === undefined ? { login: APP, id: APP_ID } : o.engineBot;
  const start = (prPollMs = 0) => coordinator(f, agents(), { prPollMs, autoMerge: () => o.autoMerge ?? true, mainWatch: { api, now: () => clock.t, ...(engineBot ? { engineBot } : {}) } } as never) as unknown as C;

  /** One of the engine's PRs off main, green on its head; with no verdict, the merge policy leaves it to the owner. */
  const pr = async (name: string, opts: { verdict?: boolean } = {}) => {
    const issue = f.backlog.open({ title: `Add ${name}`, body: 'x', author: 'example-owner', labels: ['ready'] });
    const branch = `${BRAND.cli}/issue-${issue}`;
    git(f.repo, 'checkout', '-q', '-b', branch, base);
    writeFileSync(join(f.repo, 'src', `${name}.js`), `export const ${name} = 1;\n`);
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-q', '-m', `Add ${name}`);
    const head = git(f.repo, 'rev-parse', 'HEAD');
    git(f.repo, 'push', '-q', 'origin', branch);
    git(f.repo, 'checkout', '-q', 'main');
    f.log.append('issue.claimed', { issue, instance: 'alice', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'alice');
    const p = await f.backlog.openPr(branch, 'main', `Add ${name}`, 'x', { headSha: head });
    f.log.append('pr.opened', { issue, number: p.number, url: p.url, head, draft: false }, 'alice');
    if (opts.verdict !== false) f.log.append('eval.verdict', { issue, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'alice');
    f.backlog.setChecks(head, o.batching ? [...passing, full] : passing);
    return { issue, number: p.number, head, branch };
  };

  /** GitHub's merge: a merge commit of `head` (fetched from `branch`) onto main, with this message. */
  const mergeCommit = (branch: string, head: string, subject: string, body?: string) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'gh-merge-')), 'c');
    git(f.base, 'clone', '-q', f.remote, dir);
    git(dir, 'fetch', '-q', 'origin', branch);
    git(dir, ...ident, 'merge', '-q', '--no-ff', '-m', subject, ...(body ? ['-m', body] : []), head);
    git(dir, 'push', '-q', 'origin', 'main');
    return git(dir, 'rev-parse', 'HEAD');
  };
  // The engine's own merges go through the merge API, which merges for real on the test remote.
  f.backlog.mergeWith = (p) => mergeCommit(p.head, p.headSha, p.title ?? `Merge pull request #${p.number}`, p.body);

  /** How GitHub answers the main watch about PR `number`, merged as `sha` at `head` by `by`. */
  const onGitHub = (number: number, sha: string, head: string, by: string) => {
    pulls.set(sha, [{ number, url: `https://github.com/x/y/pull/${number}`, mergedAt: new Date().toISOString(), mergeCommit: sha, mergedBy: by, mergedByBot: by.endsWith('[bot]'), head, base: 'main' }]);
  };

  /** Someone merges PR `p` at `head` on GitHub (`by`, with user id `id`), with this message. */
  const mergedBy = (by: string, p: { number: number; branch: string }, head: string, subject: string, body?: string, id?: number) => {
    const sha = mergeCommit(p.branch, head, subject, body);
    f.backlog.setPr(p.number, { headSha: head, merged: true, mergeSha: sha, mergedBy: by, ...(id !== undefined ? { mergedById: id } : {}), mergedAt: new Date().toISOString() } as never);
    onGitHub(p.number, sha, head, by);
    return sha;
  };

  const watch = async (c: C, minutes: number) => {
    for (let i = 0; i < minutes; i++) {
      clock.t += 61_000;
      await c.watchMain();
    }
  };
  /** One pass of the PR watch; whether it threw (an unanswered merge call ends the pass on older code). */
  const pass = async (c: C) =>
    c.watchPrs().then(
      () => 'ok',
      () => 'threw',
    );
  const of = (type: string) => f.log.read(0, [type as never]).map((e) => e.payload as Payload);
  const forPr = (type: string, number: number) => of(type).filter((p) => p.number === number);
  const stopped = () => existsSync(join(f.stateDir, 'auto-merge-stopped.json'));
  const reverts = () => f.backlog.prs().filter((p) => p.head.startsWith(`${BRAND.cli}/revert-`));
  const merged = (number: number) => f.backlog.prs().find((p) => p.number === number)!.merged === true;
  /** The merge events of PR `number`, in log order. */
  const trail = (number: number) =>
    f.log
      .read(0, ['merge.attempted', 'merge.done', 'merge.failed', 'merge.deferred'] as never)
      .filter((e: StoredEvent) => (e.payload as Payload).number === number)
      .map((e: StoredEvent) => e.type);
  return { f, pr, start, watch, pass, of, forPr, stopped, reverts, merged, trail, mergedBy, onGitHub, runs, base };
}

/** The engine's merge message for `number` at `head`, replayed by someone else. */
const engineMessage = (number: number, head: string) => mergeMessage({ title: 'Forged', number, head, product: BRAND.name });

/** mergePr that merges on GitHub, then loses the answer (the process died, or the connection dropped). */
function mergeThenThrow(w: ReturnType<typeof world>, only: number) {
  const real = w.f.backlog.mergePr.bind(w.f.backlog);
  w.f.backlog.mergePr = async (n, sha, title, body) => {
    const r = await real(n, sha, title, body);
    if (n === only) throw new Error('socket hang up');
    return r;
  };
  return () => void (w.f.backlog.mergePr = real);
}

/** mergePr that never reaches GitHub (for `only`, or every PR). */
function neverAnswers(w: ReturnType<typeof world>, only?: number, message = 'socket hang up') {
  const real = w.f.backlog.mergePr.bind(w.f.backlog);
  w.f.backlog.mergePr = async (n, sha, title, body) => {
    if (only === undefined || n === only) throw new Error(message);
    return real(n, sha, title, body);
  };
  return () => void (w.f.backlog.mergePr = real);
}

test('crash after GitHub merged: the next pass records merge.done (reconciled), and the main watch counts it as the engine\'s: no stop, no revert PR', { skip }, async () => {
  const w = world();
  const a = await w.pr('alpha');
  let c = w.start();
  await w.watch(c, 2); // protection: none; main's tip is the baseline
  const restore = mergeThenThrow(w, a.number);
  await w.pass(c);
  const merged = w.f.backlog.prs().find((p) => p.number === a.number)!;
  assert.ok(merged.merged, 'GitHub merged it');
  const sha = merged.mergeSha!;
  w.onGitHub(a.number, sha, a.head, APP); // GitHub: merged by the engine's App, a bot
  const crashed = w.trail(a.number);
  const attempted = w.forPr('merge.attempted', a.number).map((p) => [p.issue, p.head]);
  // The main watch picks the new commit up before anything records the merge.
  await w.watch(c, 1);
  // A restart: a new coordinator over the same log and state.
  restore();
  c = w.start();
  await w.pass(c);
  const done = w.forPr('merge.done', a.number).map((d) => [d.sha, d.head, d.reconciled, d.merged_at === merged.mergedAt]);
  await w.watch(c, 8);
  await w.pass(c); // settled once: a later pass adds nothing
  // All at once, so a failure shows the whole outcome.
  assert.deepEqual(
    {
      crashed,
      attempted,
      done,
      trail: w.trail(a.number),
      checked: w.of('main_watch.checked').map((x) => [x.sha, x.how]),
      unaccounted: w.of('main_watch.unaccounted').map((x) => x.sha),
      stopped: w.stopped(),
      reverts: w.reverts().length,
    },
    {
      crashed: ['merge.attempted'], // the intent recorded; the answer never came
      attempted: [[a.issue, a.head]],
      done: [[sha, a.head, true, true]], // reconciled, at the attempted head, GitHub's merge commit and merged_at
      trail: ['merge.attempted', 'merge.done'], // appended after the attempt; nothing rewritten
      checked: [[sha, 'harness']], // the engine's own merge
      unaccounted: [],
      stopped: false, // auto-merge goes on
      reverts: 0, // no revert PR
    },
  );
});

test('a PR merged by someone else at the same head, with no merge.attempted, is still unaccounted (even with the engine\'s merge message); the engine\'s own crashed merge beside it is reconciled', { skip }, async () => {
  const w = world();
  const b = await w.pr('beta', { verdict: false }); // no verdict: the policy leaves it to the owner, and never attempts it
  const a = await w.pr('alpha');
  let c = w.start();
  await w.watch(c, 2);
  const restore = mergeThenThrow(w, a.number);
  await w.pass(c);
  restore();
  const shaA = w.f.backlog.prs().find((p) => p.number === a.number)!.mergeSha!;
  w.onGitHub(a.number, shaA, a.head, APP);
  const msg = engineMessage(b.number, b.head);
  const shaB = w.mergedBy('another-tool[bot]', b, b.head, msg.subject, msg.body, 999);
  c = w.start();
  await w.pass(c);
  await w.watch(c, 12);
  const alerts = w.of('main_watch.unaccounted');
  assert.deepEqual(
    {
      trailB: w.trail(b.number),
      closedB: w.forPr('pr.closed', b.number).map((p) => p.merged),
      doneA: w.forPr('merge.done', a.number).map((d) => [d.sha, d.reconciled]),
      checked: w.of('main_watch.checked').map((x) => [x.sha, x.how]),
      unaccounted: alerts.map((x) => [x.sha, /merged into main by a bot/.test(String(x.reason))]),
      stopped: w.stopped(),
      reverts: w.reverts().map((p) => p.head),
    },
    {
      trailB: [], // never attempted, so never recorded as the engine's merge
      closedB: [true],
      doneA: [[shaA, true]], // the control: the engine's own crashed merge is reconciled
      checked: [[shaA, 'harness']],
      unaccounted: [[shaB, true]], // B: merged by a bot, unaccounted as before
      stopped: true, // auto-merge stops
      reverts: [`${BRAND.cli}/revert-${shaB.slice(0, 12)}`], // one revert PR, of B
    },
  );
});

test('a PR merged at a head other than the attempted one is not reconciled: unaccounted, as before', { skip }, async () => {
  const w = world();
  const p = await w.pr('gamma');
  let c = w.start();
  await w.watch(c, 2);
  const restore = neverAnswers(w);
  await w.pass(c);
  restore();
  // A push to the branch, then the engine's App merges the new head (as by hand), with the engine's message for it.
  git(w.f.repo, 'checkout', '-q', p.branch);
  writeFileSync(join(w.f.repo, 'src', 'gamma2.js'), 'export const gamma2 = 2;\n');
  git(w.f.repo, 'add', '-A');
  git(w.f.repo, 'commit', '-q', '-m', 'More');
  const moved = git(w.f.repo, 'rev-parse', 'HEAD');
  git(w.f.repo, 'push', '-q', 'origin', p.branch);
  git(w.f.repo, 'checkout', '-q', 'main');
  const msg = engineMessage(p.number, moved);
  const sha = w.mergedBy(APP, p, moved, msg.subject, msg.body, APP_ID);
  c = w.start();
  await w.pass(c);
  await w.watch(c, 12);
  assert.deepEqual(
    {
      attempted: w.forPr('merge.attempted', p.number).map((x) => x.head),
      trail: w.trail(p.number),
      closed: w.forPr('pr.closed', p.number).map((x) => x.merged),
      unaccounted: w.of('main_watch.unaccounted').map((x) => x.sha),
      stopped: w.stopped(),
    },
    {
      attempted: [p.head], // the attempt was at the first head
      trail: ['merge.attempted'], // never reconciled: merged at another head
      closed: [true],
      unaccounted: [sha], // as before
      stopped: true,
    },
  );
});

test('an open attempt whose call never reached GitHub, then that same head is merged with another message, or squashed: not reconciled, unaccounted as before', { skip }, async () => {
  const w = world();
  const merge = await w.pr('theta');
  const squash = await w.pr('iota');
  let c = w.start();
  await w.watch(c, 2);
  const restore = neverAnswers(w);
  await w.pass(c); // both attempted; neither call answered
  restore();
  // theta: a merge commit of the attempted head with GitHub's own message, even by the engine's App.
  const shaMerge = w.mergedBy(APP, merge, merge.head, `Merge pull request #${merge.number} from example/theta`, undefined, APP_ID);
  // iota: squashed onto main at the attempted head, with the engine's message replayed.
  const dir = join(mkdtempSync(join(tmpdir(), 'gh-squash-')), 'c');
  git(w.f.base, 'clone', '-q', w.f.remote, dir);
  git(dir, 'fetch', '-q', 'origin', squash.branch);
  git(dir, ...ident, 'merge', '-q', '--squash', squash.head);
  const m = engineMessage(squash.number, squash.head);
  git(dir, ...ident, 'commit', '-q', '-m', m.subject, '-m', m.body);
  git(dir, 'push', '-q', 'origin', 'main');
  const shaSquash = git(dir, 'rev-parse', 'HEAD');
  w.f.backlog.setPr(squash.number, { merged: true, mergeSha: shaSquash, mergedBy: APP, mergedById: APP_ID, mergedAt: new Date().toISOString() } as never);
  w.onGitHub(squash.number, shaSquash, squash.head, APP);
  c = w.start();
  await w.pass(c);
  await w.watch(c, 16);
  assert.deepEqual(
    {
      trails: [w.trail(merge.number), w.trail(squash.number)],
      unaccounted: w.of('main_watch.unaccounted').map((x) => x.sha),
      stopped: w.stopped(),
    },
    {
      // Open attempts at the very head GitHub merged, yet neither is the engine's merge: a merge commit with another
      // message, and a squash (no merge commit of the head), with the engine's message replayed.
      trails: [['merge.attempted'], ['merge.attempted']],
      unaccounted: [shaMerge, shaSquash], // as before
      stopped: true,
    },
  );
});

test('an open attempt, then a person merges that same head as a merge commit replaying the engine\'s message: not reconciled, unaccounted as before', { skip }, async () => {
  const w = world();
  const p = await w.pr('kappa');
  let c = w.start();
  await w.watch(c, 2);
  const restore = neverAnswers(w);
  await w.pass(c);
  restore();
  const m = engineMessage(p.number, p.head);
  const sha = w.mergedBy('someone-with-push', p, p.head, m.subject, m.body, 7); // not a mapped admin or writer
  c = w.start();
  await w.pass(c);
  await w.watch(c, 12);
  const alerts = w.of('main_watch.unaccounted');
  assert.deepEqual(
    {
      trail: w.trail(p.number),
      unaccounted: alerts.map((x) => [x.sha, /isn't a mapped admin or writer/.test(String(x.reason))]),
      stopped: w.stopped(),
    },
    {
      trail: ['merge.attempted'], // open at exactly the merged head, yet not the engine's merge
      unaccounted: [[sha, true]], // as before
      stopped: true,
    },
  );
});

/**
 * An open attempt, then PR `p` merged at exactly the attempted head as a two-parent merge commit replaying the engine's
 * own merge line, by `by` (user id `id`): everything the engine's own merge would show but the merger.
 */
async function replayedByOther(o: { by: string; id?: number; engineBot?: { login: string; id: number } | null }) {
  const w = world(o.engineBot === undefined ? {} : { engineBot: o.engineBot });
  const p = await w.pr('lambda');
  let c = w.start();
  await w.watch(c, 2);
  const restore = neverAnswers(w);
  await w.pass(c);
  restore();
  const m = engineMessage(p.number, p.head);
  const sha = w.mergedBy(o.by, p, p.head, m.subject, m.body, o.id);
  c = w.start();
  await w.pass(c);
  await w.watch(c, 12);
  return {
    got: {
      trail: w.trail(p.number),
      checked: w.of('main_watch.checked').map((x) => x.sha),
      unaccounted: w.of('main_watch.unaccounted').map((x) => x.sha),
      stopped: w.stopped(),
      reverts: w.reverts().map((x) => x.head),
    },
    want: {
      trail: ['merge.attempted'], // not reconciled
      checked: [],
      unaccounted: [sha], // as today
      stopped: true, // the stop
      reverts: [`${BRAND.cli}/revert-${sha.slice(0, 12)}`], // and a revert PR for the owner
    },
  };
}

test('an open attempt, then another App or bot merges that same head as a merge commit replaying the engine\'s line: not reconciled; unaccounted, stopped, a revert PR, as today', { skip }, async () => {
  for (const by of ['other-tool[bot]', 'github-actions[bot]']) {
    const r = await replayedByOther({ by, id: 41898282 });
    assert.deepEqual(r.got, r.want, by);
  }
});

test('the engine App\'s login with another user id: not the engine\'s merge; unaccounted, as today', { skip }, async () => {
  const r = await replayedByOther({ by: APP, id: APP_ID + 1 });
  assert.deepEqual(r.got, r.want);
});

test('no App identity known (a token install, or the lookup failed): even a merge by the engine App\'s own account stays unaccounted', { skip }, async () => {
  const r = await replayedByOther({ by: APP, id: APP_ID, engineBot: null });
  assert.deepEqual(r.got, r.want);
  // And GitHub naming no id for the merger: never the engine's.
  const s = await replayedByOther({ by: APP });
  assert.deepEqual(s.got, s.want);
});

test('a reconciled merge is judged as of GitHub\'s merged_at: a required check that failed between the attempt and the merge leaves it unaccounted', { skip }, async () => {
  const w = world();
  const a = await w.pr('mu');
  let c = w.start();
  await w.watch(c, 2);
  const restore = mergeThenThrow(w, a.number);
  await w.pass(c);
  restore();
  const attempted = Date.parse(w.f.log.read(0, ['merge.attempted']).at(-1)!.ts);
  const iso = (ms: number) => new Date(attempted + ms).toISOString();
  // GitHub merged 20 s after the attempt; ci passed long before, and a re-run started after the attempt failed before the merge.
  w.f.backlog.setPr(a.number, { mergedAt: iso(20_000) } as never);
  w.runs.set(a.head, [
    { name: 'ci', status: 'completed', conclusion: 'success', startedAt: iso(-600_000), completedAt: iso(-300_000) },
    { name: 'ci', status: 'completed', conclusion: 'failure', startedAt: iso(5_000), completedAt: iso(15_000) },
  ]);
  const sha = w.f.backlog.prs().find((p) => p.number === a.number)!.mergeSha!;
  w.onGitHub(a.number, sha, a.head, APP);
  c = w.start();
  await w.pass(c);
  await w.watch(c, 8);
  const alerts = w.of('main_watch.unaccounted');
  assert.deepEqual(
    {
      done: w.forPr('merge.done', a.number).map((d) => [d.reconciled, d.merged_at]),
      checked: w.of('main_watch.checked').map((x) => x.sha),
      unaccounted: alerts.map((x) => [x.sha, /required checks not green .* ci fail/.test(String(x.reason))]),
      stopped: w.stopped(),
    },
    {
      done: [[true, iso(20_000)]], // the engine's own merge, recorded with GitHub's time
      checked: [],
      unaccounted: [[sha, true]], // ci had failed by the time it merged: judged like any merge, as of then
      stopped: true,
    },
  );
});

test('merge.attempted followed by merge.failed (or merge.deferred) reconciles to nothing, even when the engine\'s App then merges that very head with the engine\'s message', { skip }, async () => {
  const w = world();
  const failed = await w.pr('delta');
  const deferred = await w.pr('epsilon');
  let c = w.start();
  await w.watch(c, 2);
  const real = w.f.backlog.mergePr.bind(w.f.backlog);
  w.f.backlog.mergePr = async (n) => ({ ok: false, why: n === failed.number ? 'Pull Request is not mergeable' : 'Head branch is not up to date with the base branch' });
  await w.pass(c);
  w.f.backlog.mergePr = real;
  const before = [w.trail(failed.number), w.trail(deferred.number)];
  const m1 = engineMessage(failed.number, failed.head);
  const sha1 = w.mergedBy(APP, failed, failed.head, m1.subject, m1.body, APP_ID);
  const m2 = engineMessage(deferred.number, deferred.head);
  const sha2 = w.mergedBy(APP, deferred, deferred.head, m2.subject, m2.body, APP_ID);
  c = w.start();
  await w.pass(c);
  await w.watch(c, 16);
  assert.deepEqual(
    {
      before,
      after: [w.trail(failed.number), w.trail(deferred.number)],
      unaccounted: w.of('main_watch.unaccounted').map((x) => x.sha),
      stopped: w.stopped(),
    },
    {
      before: [
        ['merge.attempted', 'merge.failed'],
        ['merge.attempted', 'merge.deferred'],
      ],
      after: [
        ['merge.attempted', 'merge.failed'], // a failed attempt is never reconciled: nothing appended
        ['merge.attempted', 'merge.deferred'], // nor a deferred one
      ],
      unaccounted: [sha1, sha2], // both, as before
      stopped: true,
    },
  );
});

test('an attempt whose call never reached GitHub, with the PR still open on the next pass, is recorded as failed, then merged normally', { skip }, async () => {
  const w = world();
  const p = await w.pr('zeta');
  let c = w.start();
  const restore = neverAnswers(w);
  await w.pass(c);
  restore();
  c = w.start();
  await w.pass(c);
  assert.deepEqual(w.trail(p.number), ['merge.attempted', 'merge.failed', 'merge.attempted', 'merge.done']);
  assert.match(String(w.forPr('merge.failed', p.number)[0]!.why), /still open: not merged/);
  assert.equal(w.forPr('merge.done', p.number)[0]!.reconciled, undefined, 'its own merge, recorded as it answered');
});

for (const path of ['approved', 'auto'] as const) {
  test(`a merge call that always throws (403), ahead of a healthy PR, on the ${path} path: the healthy PR merges on the first pass, and the failing one's tries are capped`, { skip }, async () => {
    const w = world({ autoMerge: path === 'auto' });
    const a = await w.pr('nu');
    if (path === 'approved') {
      const c0 = w.start(60_000);
      await w.pass(c0); // with auto-merge off, the policy leaves it to the owner
      const r = approveMerge(w.f.log, { issue: a.issue, number: a.number, head: a.head, who: { login: 'example-owner', role: 'owner', via: 'discord' }, instance: 'alice', repo: w.f.cfg.project.project.repo });
      assert.ok(r.ok);
    }
    const b = await w.pr('xi'); // healthy, behind A in the watch's order
    neverAnswers(w, a.number, 'GitHub 403: Resource not accessible by integration');
    // A restart (nothing polled yet), with auto-merge on for B.
    const c = coordinator(w.f, agents(), { prPollMs: 60_000, autoMerge: () => true }) as unknown as C;
    const passes: string[] = [];
    const mergedAt: number[] = [];
    const sizes: number[] = [];
    for (let i = 0; i < 10; i++) {
      passes.push(await w.pass(c));
      if (w.merged(b.number) && !mergedAt.length) mergedAt.push(i + 1);
      sizes.push(w.trail(a.number).length);
    }
    const tries = w.trail(a.number).filter((t) => t === 'merge.attempted').length;
    assert.deepEqual(
      { passes, bMergedOnPass: mergedAt[0] ?? null, aMerged: w.merged(a.number), tries, settled: sizes.slice(-4).every((s) => s === sizes.at(-1)) },
      { passes: Array(10).fill('ok'), bMergedOnPass: 1, aMerged: false, tries: 3, settled: true },
    );
    assert.equal(w.of('coordinator.error').filter((e) => e.where === `merge #${a.number}` && /403/.test(String(e.message))).length, 3, 'each unanswered call is recorded');
    if (path === 'approved') assert.match(String(w.forPr('merge.failed', a.number).at(-1)!.why), /approved by @example-owner, but merging failed 3 times at this head/);
  });
}

/** A batch that tested PR `p` on main as it is and passed, its full check posted (as the PR batcher records it). */
function greenBatch(w: ReturnType<typeof world>, p: { issue: number; number: number; head: string }) {
  const prs = [{ issue: p.issue, number: p.number, head: p.head }];
  const step = (s: string, extra: Payload = {}) => w.f.log.append('pr_batch.step', { id: 'batch-1', step: s, prs, sha: 'b'.repeat(40), base: w.base, parent: null, tier: null, run: null, detail: '', ...extra } as never, 'alice');
  w.f.log.append('pr_batch.queued', { issue: p.issue, number: p.number, head: p.head }, 'alice');
  step('built');
  step('green', { run: { id: 'run-1', ok: true, tiers: [{ tier: 'unit', ok: true, durationMs: 1, summary: 'ok', logRef: 'log://1' }] } });
  step('checks_posted');
}

for (const site of ['auto', 'approved', 'batched'] as const) {
  test(`merge.attempted is recorded before GitHub's merge API is called: the ${site} merge`, { skip }, async () => {
    const w = world({ batching: site === 'batched', autoMerge: site !== 'approved' });
    const p = await w.pr('eta');
    if (site === 'batched') greenBatch(w, p);
    const c = w.start();
    const order: string[] = [];
    const real = w.f.backlog.mergePr.bind(w.f.backlog);
    w.f.backlog.mergePr = async (n, sha, title, body) => {
      order.push(`call: attempted=${w.forPr('merge.attempted', n).some((x) => x.head === sha)}`);
      return real(n, sha, title, body);
    };
    if (site === 'approved') {
      await c.watchPrs(); // the policy leaves it to the owner
      assert.equal(w.forPr('merge.decided', p.number).at(-1)!.auto, false);
      assert.deepEqual(order, [], 'not merged before the approval');
      const r = approveMerge(w.f.log, { issue: p.issue, number: p.number, head: p.head, who: { login: 'example-owner', role: 'owner', via: 'discord' }, instance: 'alice', repo: w.f.cfg.project.project.repo });
      assert.ok(r.ok);
    }
    await c.watchPrs();
    assert.deepEqual(order, ['call: attempted=true'], 'one call, after its attempt was recorded');
    assert.deepEqual(w.trail(p.number), ['merge.attempted', 'merge.done']);
    assert.deepEqual(w.forPr('merge.attempted', p.number).map((x) => [x.issue, x.number, x.head]), [[p.issue, p.number, p.head]]);
    // Each site's own comment: the path it merged by.
    const said = w.f.backlog.prs().find((x) => x.number === p.number)!.comments.map((x) => x.body).join('\n');
    const by = { auto: /Auto-merged as `[0-9a-f]{8}` \(a merge commit of the evaluated head/, approved: /Merged on @example-owner's approval/, batched: /onto exactly the main its batch batch-1 tested/ }[site];
    assert.match(said, by);
  });
}
