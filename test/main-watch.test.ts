// The main watch (src/main-watch.ts) over a real git remote and a fake GitHub: which commits on the default branch
// are accounted for, at most one API call a minute, and a last checked commit that survives a restart.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Role } from '../src/dashboard-auth.js';
import { GitHubMainWatchApi } from '../src/github/main-watch-api.js';
import { acceptGit, acceptMerge, CONFIG_PATH, judge, LINK_LAG_MS, MAIN_WATCH_CALL_MS, MainWatch, outcomesAt, readWatchState, repoGit, type Acceptance, type AcceptTarget, type CheckRunAt, type Compared, type MainWatchApi, type MergedPull, type ProtectionMode, type StatusAt, subjectPrNumber } from '../src/main-watch.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ident = ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false'];

/** A remote, a clone people push from, and the coordinator's clone the watch reads. */
function world(o: { config?: string } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'main-watch-'));
  const remote = join(base, 'remote.git');
  const person = join(base, 'person');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(base, 'init', '-q', '-b', 'main', person);
  writeFileSync(join(person, 'a.txt'), 'a\n');
  git(person, 'add', 'a.txt');
  if (o.config !== undefined) {
    mkdirSync(dirname(join(person, CONFIG_PATH)), { recursive: true });
    writeFileSync(join(person, CONFIG_PATH), o.config);
    git(person, 'add', CONFIG_PATH);
  }
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
  /** GitHub's compare, by `base...head`; not set: head is behind base (not in that merge). */
  const compares = new Map<string, Compared>();
  const g = { protection: 'none' as 'enforced' | 'none', now: 0 };
  const call = (what: string) => calls.push({ at: g.now, what });
  const api: MainWatchApi = {
    protection: async () => (call('protection'), g.protection),
    commitPulls: async (sha) => (call(`pulls ${sha.slice(0, 7)}`), pulls.get(sha) ?? []),
    pull: async (n) => (call(`pull #${n}`), prs.get(n)!),
    checkRuns: async (sha) => (call(`runs ${sha.slice(0, 7)}`), runs.get(sha) ?? []),
    statuses: async (sha) => (call(`statuses ${sha.slice(0, 7)}`), statuses.get(sha) ?? []),
    role: async (login) => (call(`role ${login}`), roles.get(login) ?? null),
    compare: async (base, head) => (call(`compare ${base.slice(0, 7)}...${head.slice(0, 7)}`), compares.get(`${base}...${head}`) ?? { status: 'behind', aheadBy: 0, behindBy: 1 }),
  };
  /** A PR merged at `at` by `by`, its merge commit `merge`, its head `head`. */
  const pr = (number: number, merge: string, head: string, at: string, by: string | null, bot = false): MergedPull => {
    const p = { number, url: `https://github.com/example-org/example-shop/pull/${number}`, mergedAt: at, mergeCommit: merge, mergedBy: by, mergedByBot: bot, head, base: 'main' };
    pulls.set(merge, [p]);
    prs.set(number, p);
    return p;
  };
  return { api, calls, pulls, prs, runs, statuses, roles, compares, g, pr };
}

const T = Date.parse('2026-10-12T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ci = (o: Partial<CheckRunAt> = {}): CheckRunAt => ({ name: 'ci', status: 'completed', conclusion: 'success', startedAt: iso(T - 10 * 60_000), completedAt: iso(T - 5 * 60_000), ...o });

function watcher(w: ReturnType<typeof world>, gh: ReturnType<typeof fakeGitHub>, o: { harness?: Map<string, { number: number; head: string; at: string }>; required?: string[] } = {}) {
  const out = { modes: [] as { mode: ProtectionMode; detail: string }[], checked: [] as { sha: string; how: string; number: number }[], accepted: [] as { sha: string; number: number | null; a: Acceptance }[], unaccounted: [] as { sha: string; reason: string; number: number | null; revert: boolean }[] };
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
    accepted: (sha, number, a) => out.accepted.push({ sha, number, a }),
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
async function started(o: { harness?: Map<string, { number: number; head: string; at: string }>; required?: string[]; config?: string } = {}) {
  const w = world(o.config === undefined ? {} : { config: o.config });
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

test("main watch: a merge is judged by the required_checks committed at its first parent, not the startup config's", async () => {
  // The startup config still lists a check the default branch has since dropped (a clone whose working tree was
  // never updated): the merge is judged by the config as committed just before it, so it's accounted for.
  const s = await started({ required: ['ci', 'test (macos-latest)'], config: 'required_checks:\n  - ci\n' });
  const m = s.w.mergedPr();
  s.gh.pr(7, m.merge, m.head, iso(T), 'example-collaborator');
  s.gh.roles.set('example-collaborator', 'writer');
  s.gh.runs.set(m.head, [ci()]);
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.unaccounted, [], 'the dropped check is not required of it');
  assert.deepEqual(s.checked, [{ sha: m.merge, how: 'person', number: 7 }]);

  // And the other way: a check added on the branch since startup is required.
  const a = await started({ required: ['ci'], config: 'required_checks: [ci, lint]\n' });
  const n = a.w.mergedPr();
  a.gh.pr(8, n.merge, n.head, iso(T), 'example-collaborator');
  a.gh.roles.set('example-collaborator', 'writer');
  a.gh.runs.set(n.head, [ci()]);
  await run(a.gh, a.watch, 7);
  assert.equal(a.unaccounted.length, 1);
  assert.match(a.unaccounted[0]!.reason, /lint missing/);
  assert.doesNotMatch(a.unaccounted[0]!.reason, /loaded at startup/);
});

test('main watch: with no config.yaml readable at the first parent, the startup config judges, and the reason says so', async () => {
  for (const [label, config] of [
    ['absent', undefined],
    ['not YAML', 'required_checks: [ci\n'],
    ['invalid required_checks', 'required_checks: 3\n'],
  ] as const) {
    const s = await started({ required: ['ci', 'test (macos-latest)'], ...(config === undefined ? {} : { config }) });
    const m = s.w.mergedPr();
    s.gh.pr(7, m.merge, m.head, iso(T), 'example-collaborator');
    s.gh.roles.set('example-collaborator', 'writer');
    s.gh.runs.set(m.head, [ci()]);
    await run(s.gh, s.watch, 7);
    assert.equal(s.unaccounted.length, 1, label);
    assert.match(s.unaccounted[0]!.reason, /test \(macos-latest\) missing/, label);
    assert.match(s.unaccounted[0]!.reason, /judged by the required_checks loaded at startup: .*config\.yaml/, label);
  }
});

test('main watch: a direct push is unaccounted (with a revert) once its commit-to-PR link stayed empty for LINK_LAG_MS, a call a minute', async () => {
  const s = await started();
  const before = s.gh.calls.length;
  const sha = s.w.directPush();
  await run(s.gh, s.watch, 1);
  assert.equal(s.unaccounted.length, 0, 'not on the first empty answer: the link may just lag');
  await run(s.gh, s.watch, 3);
  assert.equal(s.unaccounted.length, 1);
  assert.equal(s.unaccounted[0]!.sha, sha);
  assert.equal(s.unaccounted[0]!.revert, true, 'a revert PR is asked for');
  assert.match(s.unaccounted[0]!.reason, /was pushed to main directly: no merged PR has it/);
  const asked = s.gh.calls.slice(before);
  assert.deepEqual(asked.map((c) => c.what), Array(1 + LINK_LAG_MS / MAIN_WATCH_CALL_MS).fill(`pulls ${sha.slice(0, 7)}`), 'only the link, asked until LINK_LAG_MS after its first answer');
  assert.equal(asked.at(-1)!.at - asked[0]!.at, LINK_LAG_MS);
  assert.deepEqual(s.checked, []);
});

test('regression: a squash merge whose commit-to-PR link lags is accounted once GitHub links it, never a direct push', async () => {
  // A squash merge has one parent and a subject GitHub doesn't own ("Title (#N)"), so no merge subject names the PR;
  // judged on the first empty answer, it was a direct push and got a revert PR.
  const s = await started();
  const sha = s.w.directPush(); // a squash merge is one commit on main, like a push
  s.gh.prs.set(41, { number: 41, url: 'https://github.com/example-org/example-shop/pull/41', mergedAt: iso(T), mergeCommit: sha, mergedBy: 'example-collaborator', mergedByBot: false, head: 'f'.repeat(40), base: 'main' });
  s.gh.roles.set('example-collaborator', 'writer');
  s.gh.runs.set('f'.repeat(40), [ci()]);
  await run(s.gh, s.watch, 1); // the link is still empty
  assert.equal(s.gh.calls.filter((c) => c.what === `pulls ${sha.slice(0, 7)}`).length, 1);
  s.gh.pulls.set(sha, [s.gh.prs.get(41)!]); // GitHub links it a few seconds later
  await run(s.gh, s.watch, 6);
  assert.deepEqual(s.unaccounted, [], 'no revert PR for a normal squash merge');
  assert.deepEqual(s.checked, [{ sha, how: 'person', number: 41 }]);
});

test('regression: a commit inside a rebase merge is the PR\'s by GitHub\'s compare; an earlier direct push the PR\'s merge descends from is not', async () => {
  // Git ancestry said both were "in" the PR's merge: every earlier commit on main is an ancestor of a later merge.
  const s = await started();
  const pushed = s.w.directPush(); // a direct push, before the PR merged
  const r1 = s.w.directPush(); // the PR's two commits, rebased onto main
  const r2 = s.w.directPush();
  const pr = { number: 42, url: 'https://github.com/example-org/example-shop/pull/42', mergedAt: iso(T), mergeCommit: r2, mergedBy: 'example-collaborator', mergedByBot: false, head: 'e'.repeat(40), base: 'main', commits: 2 };
  s.gh.prs.set(42, pr);
  for (const c of [pushed, r1, r2]) s.gh.pulls.set(c, [pr]); // GitHub's link lists the PR for the pushed commit too (its branch had it)
  s.gh.compares.set(`${pushed}...${r2}`, { status: 'ahead', aheadBy: 2, behindBy: 0 });
  s.gh.compares.set(`${r1}...${r2}`, { status: 'ahead', aheadBy: 1, behindBy: 0 });
  s.gh.roles.set('example-collaborator', 'writer');
  s.gh.runs.set('e'.repeat(40), [ci()]);
  await run(s.gh, s.watch, 20);
  assert.deepEqual(s.unaccounted.map((u) => u.sha), [pushed], 'the push before the PR merged is a direct push');
  assert.match(s.unaccounted[0]!.reason, /#42's merge .* doesn't include it: 2 commit\(s\) ahead of it, and the PR has 2/);
  assert.deepEqual(s.checked.map((c) => [c.sha, c.number]), [[r1, 42], [r2, 42]], 'both rebased commits are the PR\'s');
});

test('regression: a merge commit GitHub has not linked to its PR yet is judged by the PR its subject names, never as a direct push', async () => {
  // Main 09f60340 (#307's merge) was judged 6 s after it landed: GitHub's commit-to-PR link was still empty, and the
  // watch opened a revert PR for a normal merge. The PR the merge subject names answers at once.
  const s = await started();
  const m = s.w.mergedPr();
  const n = Number(/#(\d+)/.exec(git(s.w.remote, 'log', '-1', '--format=%s', m.merge))?.[1] ?? 'NaN');
  s.gh.pr(n, m.merge, m.head, iso(T), 'example-collaborator');
  s.gh.pulls.delete(m.merge); // the link lags: no merged PR for the commit yet
  s.gh.roles.set('example-collaborator', 'writer');
  s.gh.runs.set(m.head, [ci()]);
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.unaccounted, [], 'no revert PR for a normal merge');
  assert.deepEqual(s.checked, [{ sha: m.merge, how: 'person', number: n }]);
});

test('a made-up merge subject is still a direct push: the named PR\'s own merge commit is another', async () => {
  const s = await started();
  const real = s.w.mergedPr();
  const n = Number(/#(\d+)/.exec(git(s.w.remote, 'log', '-1', '--format=%s', real.merge))?.[1] ?? 'NaN');
  s.gh.pr(n, real.merge, real.head, iso(T), 'example-collaborator');
  s.gh.roles.set('example-collaborator', 'writer');
  s.gh.runs.set(real.head, [ci()]);
  await run(s.gh, s.watch, 6);
  const fake = s.w.mergedPr(); // a second merge commit, which no PR has; its subject names another number
  s.gh.prs.set(Number(/#(\d+)/.exec(git(s.w.remote, 'log', '-1', '--format=%s', fake.merge))?.[1] ?? 'NaN'), { ...s.gh.prs.get(n)!, number: Number(/#(\d+)/.exec(git(s.w.remote, 'log', '-1', '--format=%s', fake.merge))?.[1]) });
  await run(s.gh, s.watch, 6);
  assert.equal(s.unaccounted.length, 1);
  assert.equal(s.unaccounted[0]!.sha, fake.merge);
  assert.match(s.unaccounted[0]!.reason, /pushed to main directly/);
});

test('subjectPrNumber reads this repo\'s and GitHub\'s merge subjects, nothing else', () => {
  assert.equal(subjectPrNumber('Merge #307: Tests: example repos run no background git maintenance'), 307);
  assert.equal(subjectPrNumber('Merge pull request #12 from someone/branch'), 12);
  assert.equal(subjectPrNumber('Fix #307 in the merge flow'), null);
  assert.equal(subjectPrNumber('Merge branch main into feature'), null);
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
  assert.equal(s.unaccounted.length, 0);
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
  await run(s.gh, s.watch, 4);
  assert.deepEqual(s.unaccounted.map((u) => u.sha), [a]);
  const askedA = s.gh.calls.filter((x) => x.what === `pulls ${a.slice(0, 7)}`).length;
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
  assert.equal(s.gh.calls.filter((x) => x.what === `pulls ${a.slice(0, 7)}`).length, askedA, 'a was not asked about again');
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

// ---------------------------------------------------------------- bootstrap merges an admin accepted

/** An admin's accept, as the dashboard makes it: over the coordinator's clone, with the PRs judged already. */
const accept = (w: ReturnType<typeof world>, target: AcceptTarget, judgedPrs: number[] = [], reason = "bootstrap: the suite can't run yet") =>
  acceptMerge({ stateFile: w.stateFile, git: acceptGit(w.coord, 'origin', 'main'), branch: 'main', target, reason, by: 'example-owner', judgedPrs });

/** An open PR #n: a branch from main with one commit, its head at refs/pull/n/head as GitHub keeps it. */
function openPr(w: ReturnType<typeof world>, n: number) {
  const person = join(w.base, 'person');
  let k = 0;
  const push = () => {
    git(person, 'checkout', '-q', '-B', `pr${n}`, ...(k ? [`pr${n}`] : []));
    writeFileSync(join(person, `pr${n}-${++k}.txt`), `${n}.${k}\n`);
    git(person, 'add', '-A');
    git(person, ...ident, 'commit', '-q', '-m', `pr ${n} (${k})`);
    const head = git(person, 'rev-parse', 'HEAD');
    git(person, 'push', '-q', '-f', 'origin', `HEAD:refs/pull/${n}/head`);
    git(person, 'checkout', '-q', 'main');
    return head;
  };
  const p = { head: push(), push: () => (p.head = push()) };
  /** Merged with a merge commit (GitHub's merge button), or squashed. */
  const merge = (how: 'merge' | 'squash' = 'merge') => {
    if (how === 'merge') git(person, ...ident, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${n}`, p.head);
    else {
      git(person, 'merge', '-q', '--squash', p.head);
      git(person, ...ident, 'commit', '-q', '-m', `PR ${n} (#${n})`);
    }
    git(person, 'push', '-q', 'origin', 'main');
    return git(person, 'rev-parse', 'HEAD');
  };
  return Object.assign(p, { merge });
}

test('main watch: a hand merge an admin accepted by its sha is accounted (no stop, alert or revert); the next one, not accepted, still trips', async () => {
  const s = await started();
  s.gh.roles.set('example-owner', 'owner');
  // The project's required check can't run yet: the admin's merge has it missing.
  const m = s.w.mergedPr();
  s.gh.pr(22, m.merge, m.head, iso(T), 'example-owner');
  const r = accept(s.w, { sha: m.merge.slice(0, 12) });
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.equal(r.acceptance.sha, m.merge, 'kept as the full sha');
  await run(s.gh, s.watch, 7);
  assert.equal(s.unaccounted.length, 0, 'no stop, no alert, no revert PR');
  assert.deepEqual(s.accepted.map((x) => [x.sha, x.number, x.a.by, x.a.reason]), [[m.merge, null, 'example-owner', "bootstrap: the suite can't run yet"]]);
  assert.deepEqual(s.checked, []);
  assert.equal(readWatchState(s.w.stateFile).last, m.merge);
  assert.deepEqual(s.gh.calls.map((c) => c.what).filter((c) => c.includes(m.merge.slice(0, 7))), [], 'an accepted sha takes no API call');
  // The next hand merge, just like it but not accepted, trips as before.
  const n = s.w.mergedPr();
  s.gh.pr(23, n.merge, n.head, iso(T), 'example-owner');
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.unaccounted.map((u) => [u.sha, u.revert]), [[n.merge, true]]);
  assert.match(s.unaccounted[0]!.reason, /#23 was merged into main with required checks not green.*ci missing/);
  // One being checked (the watch is part-way through it) can be accepted too.
  const p = s.w.mergedPr();
  s.gh.pr(24, p.merge, p.head, iso(T), 'example-owner');
  await run(s.gh, s.watch, 1);
  assert.equal(readWatchState(s.w.stateFile).pending?.sha, p.merge, 'being checked');
  assert.ok(accept(s.w, { sha: p.merge }).ok);
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.accepted.map((x) => x.sha), [m.merge, p.merge]);
  assert.equal(s.unaccounted.length, 1);
});

test('main watch: a PR accepted by number before it merges is accounted when it merges at that head (merge or squash); pushed to after, it trips', async () => {
  const s = await started();
  s.gh.roles.set('example-owner', 'owner');
  // Accept, then merge: the owner's case.
  const a = openPr(s.w, 25);
  const r = accept(s.w, { pr: 25 });
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.equal(r.acceptance.head, a.head, "pinned to the PR's head now");
  const am = a.merge();
  s.gh.pr(25, am, a.head, iso(T), 'example-owner');
  await run(s.gh, s.watch, 7);
  assert.equal(s.unaccounted.length, 0, 'no stop, no alert, no revert PR');
  assert.deepEqual(s.accepted.map((x) => [x.sha, x.number]), [[am, 25]]);
  // Squashed: the same.
  const b = openPr(s.w, 26);
  assert.ok(accept(s.w, { pr: 26 }).ok);
  const bm = b.merge('squash');
  s.gh.pr(26, bm, b.head, iso(T), 'example-owner');
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.accepted.map((x) => [x.sha, x.number]), [[am, 25], [bm, 26]]);
  assert.equal(s.unaccounted.length, 0);
  // Accepted, then pushed to: the head merged isn't the one accepted, so it is judged as any merge.
  const c = openPr(s.w, 27);
  assert.ok(accept(s.w, { pr: 27 }).ok);
  c.push();
  const cm = c.merge();
  s.gh.pr(27, cm, c.head, iso(T), 'example-owner');
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.unaccounted.map((u) => u.sha), [cm]);
  assert.match(s.unaccounted[0]!.reason, /#27 was merged into main with required checks not green/);
  assert.equal(s.accepted.length, 2);
});

test('main watch accept: a rewrite, a commit not on the branch, one already judged and one off the first-parent line are refused', async () => {
  const s = await started();
  s.gh.roles.set('example-owner', 'owner');
  const baseline = readWatchState(s.w.stateFile).last!;
  // Already judged: the last commit checked, and one before it.
  assert.match((accept(s.w, { sha: baseline }) as { error: string }).error, /judged already/);
  const g = s.w.mergedPr();
  s.gh.pr(30, g.merge, g.head, iso(T), 'example-owner');
  s.gh.runs.set(g.head, [ci()]);
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.checked.map((x) => x.sha), [g.merge]);
  for (const sha of [g.merge, baseline]) {
    const r = accept(s.w, { sha });
    assert.ok(!r.ok && r.status === 409 && /judged already/.test(r.error), `${sha.slice(0, 8)}: ${JSON.stringify(r)}`);
  }
  // A PR judged already, by the watch's events, or whose head is on the branch at or before the last checked.
  assert.match((accept(s.w, { pr: 30 }, [30]) as { error: string }).error, /#30's merge was judged already/);
  const person = join(s.w.base, 'person');
  git(person, 'push', '-q', 'origin', `${g.head}:refs/pull/30/head`);
  assert.match((accept(s.w, { pr: 30 }) as { error: string }).error, /on main already, at or before the last commit checked/);
  // Not on the branch: a commit on another branch, a sha nothing has, a PR the remote doesn't have.
  git(person, 'checkout', '-q', '-b', 'elsewhere');
  writeFileSync(join(person, 'e.txt'), 'e\n');
  git(person, 'add', '-A');
  git(person, ...ident, 'commit', '-q', '-m', 'elsewhere');
  const foreign = git(person, 'rev-parse', 'HEAD');
  git(person, 'push', '-q', 'origin', 'elsewhere');
  git(person, 'checkout', '-q', 'main');
  git(s.w.coord, 'fetch', '-q', 'origin');
  for (const sha of [foreign, 'f'.repeat(40)]) {
    const r = accept(s.w, { sha });
    assert.ok(!r.ok && r.status === 404 && /is not a commit on main/.test(r.error), `${sha.slice(0, 8)}: ${JSON.stringify(r)}`);
  }
  assert.match((accept(s.w, { pr: 999 }) as { error: string }).error, /no PR #999 on the remote/);
  // On the branch, but inside a merge: the watch judges the merge commit, so that is what is accepted.
  const h = s.w.mergedPr();
  const inside = accept(s.w, { sha: h.head });
  assert.ok(!inside.ok && /not on its first-parent line/.test(inside.error), JSON.stringify(inside));
  // No reason refused too; and the same thing twice.
  assert.match((accept(s.w, { sha: h.merge }, [], '  ') as { error: string }).error, /a reason is required/);
  assert.ok(accept(s.w, { sha: h.merge }).ok);
  assert.match((accept(s.w, { sha: h.merge }) as { error: string }).error, /accepted already/);
  s.gh.pr(32, h.merge, h.head, iso(T), 'example-owner');
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.accepted.map((x) => x.sha), [h.merge]);
  // A force-push: neither the rewritten tip nor a PR can be accepted while it waits to be judged.
  git(person, 'reset', '-q', '--hard', 'HEAD~1');
  writeFileSync(join(person, 'x.txt'), 'x\n');
  git(person, 'add', '-A');
  git(person, ...ident, 'commit', '-q', '-m', 'rewritten');
  git(person, 'push', '-q', '--force', 'origin', 'main');
  const rewritten = git(person, 'rev-parse', 'HEAD');
  openPr(s.w, 31);
  for (const target of [{ sha: rewritten }, { pr: 31 }] as AcceptTarget[]) {
    const r = accept(s.w, target);
    assert.ok(!r.ok && r.status === 409 && /was rewritten since the last commit checked .*: a force-push can't be accepted/.test(r.error), `${JSON.stringify(target)}: ${JSON.stringify(r)}`);
  }
  // And the rewrite still trips, with no revert.
  await run(s.gh, s.watch, 2);
  assert.match(s.unaccounted.at(-1)!.reason, /main was rewritten/);
  assert.equal(s.unaccounted.at(-1)!.revert, false);
  assert.equal(s.accepted.length, 1);
});

test('main watch accept: nothing to accept while GitHub guards the branch, or before the watch has a starting commit', async () => {
  const w = world();
  const gh = fakeGitHub();
  const s = watcher(w, gh);
  assert.match((accept(w, { pr: 1 }) as { error: string }).error, /isn't guarding main \(not started\)/);
  gh.g.protection = 'enforced';
  await run(gh, s.watch, 1);
  assert.match((accept(w, { pr: 1 }) as { error: string }).error, /isn't guarding main \(github\)/);
});

test('judge: an accepted sha is accounted at once; an accepted PR only at the head accepted', () => {
  const at = iso(T);
  const a: Acceptance = { id: 'x', sha: null, pr: 5, head: 'b'.repeat(40), base: 'c'.repeat(40), by: 'example-owner', reason: 'r', at };
  const o = { branch: 'main', required: ['ci'], accepted: [a, { ...a, id: 'y', sha: 'a'.repeat(40), pr: null, head: null }] };
  assert.deepEqual(judge('a'.repeat(40), { harness: null }, o), { done: true, accounted: true, how: 'accepted', number: null, acceptance: o.accepted[1] });
  const pr = (head: string): MergedPull => ({ number: 5, url: '', mergedAt: at, mergeCommit: 'd'.repeat(40), mergedBy: null, mergedByBot: false, head, base: 'main' });
  const f = (head: string) => ({ harness: null, pulls: [pr(head)], pr: pr(head) });
  const v = judge('d'.repeat(40), f('b'.repeat(40)), o);
  assert.ok(v.done && v.accounted && v.how === 'accepted' && v.number === 5);
  const w = judge('d'.repeat(40), f('e'.repeat(40)), o);
  assert.ok(w.done && !w.accounted, 'another head: judged as any merge');
  const h = judge('d'.repeat(40), { harness: { number: 5, head: 'b'.repeat(40), at } }, o);
  assert.ok(h.done && h.accounted && h.how === 'accepted', "the harness's own merge of it too");
});

test("GitHubMainWatchApi: compare reads GitHub's ahead/behind counts; a PR carries its commit count", async () => {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    if (url.includes('/compare/')) return new Response(JSON.stringify({ status: 'ahead', ahead_by: 1, behind_by: 0, commits: [] }));
    return new Response(JSON.stringify({ number: 9, html_url: 'https://github.com/x/y/pull/9', merged_at: iso(T), merge_commit_sha: 'b'.repeat(40), merged_by: { login: 'example-owner', type: 'User' }, head: { sha: 'c'.repeat(40) }, base: { ref: 'main' }, commits: 3 }));
  }) as unknown as typeof fetch;
  const api = new GitHubMainWatchApi('x/y', async () => 't', f);
  assert.deepEqual(await api.compare('a'.repeat(40), 'b'.repeat(40)), { status: 'ahead', aheadBy: 1, behindBy: 0 });
  assert.ok(urls[0]!.endsWith(`/repos/x/y/compare/${'a'.repeat(40)}...${'b'.repeat(40)}?per_page=1`), urls[0]);
  assert.equal((await api.pull(9)).commits, 3);
});
