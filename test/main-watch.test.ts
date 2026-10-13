// The main watch (src/main-watch.ts) over a real git remote and a fake GitHub: which commits on the default branch
// are accounted for, at most one API call a minute, and a last checked commit that survives a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Role } from '../src/dashboard-auth.js';
import { judge, MAIN_WATCH_CALL_MS, MainWatch, outcomesAt, readWatchState, repoGit, type CheckRunAt, type MainWatchApi, type MergedPull, type ProtectionMode, type StatusAt } from '../src/main-watch.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ident = ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false'];

/** A remote, a clone people push from, and the coordinator's clone the watch reads. */
function world() {
  const base = mkdtempSync(join(tmpdir(), 'main-watch-'));
  const remote = join(base, 'remote.git');
  const person = join(base, 'person');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(base, 'init', '-q', '-b', 'main', person);
  writeFileSync(join(person, 'a.txt'), 'a\n');
  git(person, 'add', 'a.txt');
  git(person, ...ident, 'commit', '-q', '-m', 'init');
  git(person, 'remote', 'add', 'origin', remote);
  git(person, 'push', '-q', 'origin', 'main');
  const coord = join(base, 'coord');
  git(base, 'clone', '-q', remote, coord);
  let n = 0;
  /** A commit pushed straight to main. */
  const directPush = () => {
    writeFileSync(join(person, `d${++n}.txt`), `${n}\n`);
    git(person, 'add', '-A');
    git(person, ...ident, 'commit', '-q', '-m', `direct ${n}`);
    git(person, 'push', '-q', 'origin', 'main');
    return git(person, 'rev-parse', 'HEAD');
  };
  /** A branch merged into main with a merge commit, as GitHub's merge button does: the merge commit and the PR head. */
  const mergedPr = () => {
    git(person, 'checkout', '-q', '-b', `f${++n}`);
    writeFileSync(join(person, `f${n}.txt`), `${n}\n`);
    git(person, 'add', '-A');
    git(person, ...ident, 'commit', '-q', '-m', `feature ${n}`);
    const head = git(person, 'rev-parse', 'HEAD');
    git(person, 'checkout', '-q', 'main');
    git(person, ...ident, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${n}`, head);
    git(person, 'push', '-q', 'origin', 'main');
    return { merge: git(person, 'rev-parse', 'HEAD'), head };
  };
  return { base, remote, coord, directPush, mergedPr, stateFile: join(base, 'main-watch.json') };
}

/** A GitHub that answers from what the test set, counting every call. */
function fakeGitHub() {
  const calls: { at: number; what: string }[] = [];
  const pulls = new Map<string, MergedPull[]>();
  const prs = new Map<number, MergedPull>();
  const runs = new Map<string, CheckRunAt[]>();
  const statuses = new Map<string, StatusAt[]>();
  const roles = new Map<string, Role | null>();
  const g = { protection: 'none' as 'enforced' | 'none', now: 0 };
  const call = (what: string) => calls.push({ at: g.now, what });
  const api: MainWatchApi = {
    protection: async () => (call('protection'), g.protection),
    commitPulls: async (sha) => (call(`pulls ${sha.slice(0, 7)}`), pulls.get(sha) ?? []),
    pull: async (n) => (call(`pull #${n}`), prs.get(n)!),
    checkRuns: async (sha) => (call(`runs ${sha.slice(0, 7)}`), runs.get(sha) ?? []),
    statuses: async (sha) => (call(`statuses ${sha.slice(0, 7)}`), statuses.get(sha) ?? []),
    role: async (login) => (call(`role ${login}`), roles.get(login) ?? null),
  };
  /** A PR merged at `at` by `by`, its merge commit `merge`, its head `head`. */
  const pr = (number: number, merge: string, head: string, at: string, by: string | null, bot = false): MergedPull => {
    const p = { number, url: `https://github.com/example-org/example-shop/pull/${number}`, mergedAt: at, mergeCommit: merge, mergedBy: by, mergedByBot: bot, head, base: 'main' };
    pulls.set(merge, [p]);
    prs.set(number, p);
    return p;
  };
  return { api, calls, pulls, prs, runs, statuses, roles, g, pr };
}

const T = Date.parse('2026-10-12T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ci = (o: Partial<CheckRunAt> = {}): CheckRunAt => ({ name: 'ci', status: 'completed', conclusion: 'success', startedAt: iso(T - 10 * 60_000), completedAt: iso(T - 5 * 60_000), ...o });

function watcher(w: ReturnType<typeof world>, gh: ReturnType<typeof fakeGitHub>, o: { harness?: Map<string, { number: number; head: string; at: string }>; required?: string[] } = {}) {
  const out = { modes: [] as { mode: ProtectionMode; detail: string }[], checked: [] as { sha: string; how: string; number: number }[], unaccounted: [] as { sha: string; reason: string; number: number | null; revert: boolean }[] };
  const watch = new MainWatch({
    stateFile: w.stateFile,
    branch: 'main',
    required: () => o.required ?? ['ci'],
    api: gh.api,
    git: repoGit(w.coord, 'origin', 'main'),
    harnessMerge: (sha) => o.harness?.get(sha) ?? null,
    now: () => gh.g.now,
    mode: (mode, detail) => out.modes.push({ mode, detail }),
    checked: (sha, how, number) => out.checked.push({ sha, how, number }),
    unaccounted: async (u) => void out.unaccounted.push(u),
  });
  return { watch, ...out };
}

/** Run the coordinator's timer for `minutes`, a pass every 10 s. */
async function run(gh: ReturnType<typeof fakeGitHub>, watch: MainWatch, minutes: number) {
  for (let i = 0; i < minutes * 6; i++) {
    gh.g.now += 10_000;
    await watch.step();
  }
}

/** A watch that has asked about protection and taken main's tip as its baseline. */
async function started(o: { harness?: Map<string, { number: number; head: string; at: string }> } = {}) {
  const w = world();
  const gh = fakeGitHub();
  gh.g.now = T + 60 * 60_000;
  const s = watcher(w, gh, o);
  await run(gh, s.watch, 1);
  assert.deepEqual(s.modes.map((m) => m.mode), ['main_watch'], 'no protection on GitHub: the watch is on');
  assert.equal(readWatchState(w.stateFile).last, git(w.coord, 'rev-parse', 'origin/main'), "main's tip is the baseline");
  return { w, gh, ...s };
}

test('main watch: a green PR merged by a writer is accounted for; nothing stops', async () => {
  const s = await started();
  const m = s.w.mergedPr();
  s.gh.pr(7, m.merge, m.head, iso(T), 'example-collaborator');
  s.gh.roles.set('example-collaborator', 'writer');
  s.gh.runs.set(m.head, [ci()]);
  await run(s.gh, s.watch, 6);
  assert.deepEqual(s.unaccounted, [], 'nothing unaccounted');
  assert.deepEqual(s.checked, [{ sha: m.merge, how: 'person', number: 7 }]);
  assert.equal(readWatchState(s.w.stateFile).last, m.merge);
});

test('main watch: a direct push is unaccounted (with a revert), found with one call', async () => {
  const s = await started();
  const before = s.gh.calls.length;
  const sha = s.w.directPush();
  await run(s.gh, s.watch, 2);
  assert.equal(s.unaccounted.length, 1);
  assert.equal(s.unaccounted[0]!.sha, sha);
  assert.equal(s.unaccounted[0]!.revert, true, 'a revert PR is asked for');
  assert.match(s.unaccounted[0]!.reason, /was pushed to main directly: no merged PR has it/);
  assert.deepEqual(s.gh.calls.slice(before).map((c) => c.what), [`pulls ${sha.slice(0, 7)}`], 'one call told');
  assert.deepEqual(s.checked, []);
});

test('main watch: a PR merged with a failing, pending or missing required check is unaccounted', async () => {
  for (const [label, runs, re] of [
    ['failing', [ci({ conclusion: 'failure' })], /ci fail/],
    ['still running when merged', [ci({ status: 'in_progress', completedAt: null })], /ci pending/],
    ['green only after the merge', [ci({ completedAt: iso(T + 60_000) })], /ci pending/],
    ['missing', [], /ci missing/],
  ] as const) {
    const s = await started();
    const m = s.w.mergedPr();
    s.gh.pr(8, m.merge, m.head, iso(T), 'example-owner');
    s.gh.roles.set('example-owner', 'owner');
    s.gh.runs.set(m.head, [...runs]);
    await run(s.gh, s.watch, 7);
    assert.equal(s.unaccounted.length, 1, label);
    assert.match(s.unaccounted[0]!.reason, /#8 was merged into main with required checks not green/, label);
    assert.match(s.unaccounted[0]!.reason, re, label);
    assert.deepEqual(s.checked, [], label);
  }
});

test('main watch: a merge by an unknown actor, an unmapped person or a bot is unaccounted', async () => {
  for (const [label, by, role, bot, re] of [
    ['no merger', null, null, false, /by an unknown actor/],
    ['unmapped', 'someone-else', null, false, /isn't a mapped admin or writer/],
    ['a viewer', 'someone-else', 'viewer', false, /isn't a mapped admin or writer/],
    ['a bot', 'automerge[bot]', null, true, /by a bot/],
  ] as const) {
    const s = await started();
    const m = s.w.mergedPr();
    s.gh.pr(9, m.merge, m.head, iso(T), by, bot);
    if (by) s.gh.roles.set(by, role);
    s.gh.runs.set(m.head, [ci()]);
    await run(s.gh, s.watch, 7);
    assert.equal(s.unaccounted.length, 1, label);
    assert.match(s.unaccounted[0]!.reason, re, label);
  }
});

test("main watch: the harness's own merge with green checks passes, without asking who merged it", async () => {
  const harness = new Map<string, { number: number; head: string; at: string }>();
  const s = await started({ harness });
  const m = s.w.mergedPr();
  harness.set(m.merge, { number: 11, head: m.head, at: iso(T) });
  s.gh.runs.set(m.head, [ci()]);
  const before = s.gh.calls.length;
  await run(s.gh, s.watch, 3);
  assert.deepEqual(s.checked, [{ sha: m.merge, how: 'harness', number: 11 }]);
  assert.deepEqual(s.unaccounted, []);
  assert.deepEqual(s.gh.calls.slice(before).map((c) => c.what), [`runs ${m.head.slice(0, 7)}`]);
  // Not green on the head it merged: unaccounted, whoever merged it.
  const r = s.w.mergedPr();
  harness.set(r.merge, { number: 12, head: r.head, at: iso(T) });
  s.gh.runs.set(r.head, [ci({ conclusion: 'failure' })]);
  await run(s.gh, s.watch, 3);
  assert.match((s.unaccounted as { reason: string }[])[0]?.reason ?? '', /the harness merged #12 into main with required checks not green/);
});

test('main watch: at most one API call a minute, across many commits and a restart', async () => {
  const s = await started();
  for (let i = 0; i < 3; i++) {
    const m = s.w.mergedPr();
    s.gh.pr(20 + i, m.merge, m.head, iso(T), 'example-collaborator');
    s.gh.runs.set(m.head, [ci({ name: 'other' })]); // not the required check: the statuses are read too
  }
  s.gh.roles.set('example-collaborator', 'writer');
  s.w.directPush();
  await run(s.gh, s.watch, 9);
  // A restart in the middle: a new watch on the same state file.
  const again = watcher(s.w, s.gh);
  await run(s.gh, again.watch, 20);
  const at = s.gh.calls.map((c) => c.at);
  for (let i = 1; i < at.length; i++) assert.ok(at[i]! - at[i - 1]! >= MAIN_WATCH_CALL_MS, `calls ${i - 1} and ${i} are ${(at[i]! - at[i - 1]!) / 1000} s apart`);
  assert.equal(s.unaccounted.length + again.unaccounted.length, 4, 'every commit was judged: 3 PRs missing ci, and the push');
});

test('main watch: a restart neither checks a commit again nor skips one', async () => {
  const s = await started();
  const a = s.w.directPush();
  await run(s.gh, s.watch, 2);
  assert.deepEqual(s.unaccounted.map((u) => u.sha), [a]);
  const b = s.w.mergedPr();
  const c = s.w.directPush();
  s.gh.pr(30, b.merge, b.head, iso(T), 'example-owner');
  s.gh.roles.set('example-owner', 'owner');
  s.gh.runs.set(b.head, [ci()]);
  await run(s.gh, s.watch, 2); // part-way through b
  const again = watcher(s.w, s.gh);
  await run(s.gh, again.watch, 10);
  assert.deepEqual(again.checked.map((x) => x.sha), [b.merge], 'b, once');
  assert.deepEqual(again.unaccounted.map((u) => u.sha), [c], 'c, and not a again');
  assert.equal(s.gh.calls.filter((x) => x.what === `pulls ${a.slice(0, 7)}`).length, 1, 'a was asked about once');
  assert.equal(readWatchState(s.w.stateFile).last, c);
});

test('main watch: GitHub enforcing the protection leaves it to GitHub; a rewritten main is unaccounted, with no revert', async () => {
  const w = world();
  const gh = fakeGitHub();
  gh.g.protection = 'enforced';
  const s = watcher(w, gh);
  await run(gh, s.watch, 5);
  assert.deepEqual(s.modes.map((m) => m.mode), ['github']);
  assert.deepEqual(gh.calls.map((c) => c.what), ['protection'], 'nothing else is asked');
  const r = await started();
  r.w.directPush();
  await run(r.gh, r.watch, 2);
  // Someone force-pushes main back to before the checked commit.
  const person = join(r.w.base, 'person');
  git(person, 'reset', '-q', '--hard', 'HEAD~1');
  writeFileSync(join(person, 'x.txt'), 'x\n');
  git(person, 'add', '-A');
  git(person, ...ident, 'commit', '-q', '-m', 'rewritten');
  git(person, 'push', '-q', '--force', 'origin', 'main');
  await run(r.gh, r.watch, 1);
  const last = r.unaccounted.at(-1)!;
  assert.match(last.reason, /main was rewritten/);
  assert.equal(last.revert, false);
});

test('outcomesAt and judge: checks are read as they stood at merge time; no required checks judge nothing green', () => {
  const at = iso(T);
  assert.deepEqual(outcomesAt(['ci'], [ci(), ci({ startedAt: iso(T + 1000), completedAt: iso(T + 2000), conclusion: 'failure' })], null, at), [{ name: 'ci', outcome: 'pass' }], 'a rerun after the merge does not count');
  assert.deepEqual(outcomesAt(['ci'], [], null, at), [{ name: 'ci', outcome: 'unknown' }]);
  assert.deepEqual(outcomesAt(['ci'], [], [{ context: 'ci', state: 'success', createdAt: iso(T - 1000) }], at), [{ name: 'ci', outcome: 'pass' }]);
  assert.deepEqual(outcomesAt(['ci'], [], [{ context: 'ci', state: 'success', createdAt: iso(T + 1000) }], at), [{ name: 'ci', outcome: 'missing' }]);
  const v = judge('a'.repeat(40), { harness: { number: 3, head: 'b'.repeat(40), at } }, { branch: 'main', required: [] });
  assert.ok(v.done && !v.accounted);
});
