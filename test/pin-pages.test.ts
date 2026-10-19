// #727 round 7: a truncated or refused GitHub read never ends as ready. Readiness (GitHubBacklog's pages, through
// PinnedChecks.of) and the main watch's reads (GitHubMainWatchApi) over stand-in REST answers: past the page cap, or
// refused part-way, a read throws (the PR waits; the watch asks again or judges the merge unaccounted), never a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubBacklog } from '../src/backlog/github.js';
import { PinnedChecks } from '../src/check-source.js';
import { GitHubMainWatchApi } from '../src/github/main-watch-api.js';
import { TooManyPages } from '../src/main-watch.js';
import { readiness, requiredOutcomes } from '../src/pr-watch.js';

const HEAD = 'a'.repeat(40);
const PINNED_APP = 1111;
const OTHER_APP = 2222;
const run = (id: number, name: string, app: number, conclusion = 'success') => ({ id, name, status: 'completed', conclusion, html_url: `https://github.example/o/r/runs/${id}`, app: { id: app, slug: `app-${app}` }, check_suite: { id: app * 10 } });
/** 100 passing runs of other names: a full page. */
const filler = (page: number) => Array.from({ length: 100 }, (_, i) => run(page * 1000 + i, `other-${page}-${i}`, OTHER_APP));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
// A reset far ahead (2100-01-01), fixed: no wall clock read, and the limit never looks lifted.
const RATE_LIMITED = () => json({ message: 'API rate limit exceeded for installation' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '4102444800' });
const NO_ACCESS = () => json({ message: 'Resource not accessible by integration' }, 403);
let token = 0;

/**
 * Readiness of `ci`, pinned to App 1111, whose own run passes on page 1: the check-run pages `runs(page)` (filter=latest),
 * and the combined status's pages `status(page)`. Rejects when the read throws.
 */
async function ready(o: { runs: (page: number) => unknown[]; status?: (page: number) => Response; bare?: boolean; calls?: string[] }) {
  const f = (async (url: string) => {
    const u = new URL(url);
    const page = Number(u.searchParams.get('page') ?? '1');
    if (u.pathname.includes('/commits/')) o.calls?.push(`${u.pathname.split('/').at(-1)} ${page}`);
    if (u.pathname === `/repos/o/r/commits/${HEAD}/check-runs`) return json({ check_runs: o.runs(page) });
    if (u.pathname === `/repos/o/r/commits/${HEAD}/status`) return o.status ? o.status(page) : json({ statuses: [] });
    if (u.pathname === '/repos/o/r/branches/main') return json({ name: 'main', protection: { enabled: false } });
    if (u.pathname === '/repos/o/r/rules/branches/main') return json([]);
    return json({ message: 'Not Found' }, 404);
  }) as typeof fetch;
  // A fresh token each time, so no rate limit here is shared with another test's budget.
  const t = `tok-${++token}`;
  // `bare`: nothing pinned (round 8: main's reads and main's verdict). Else `ci` is pinned to App 1111.
  const pinned = new PinnedChecks({ backlog: new GitHubBacklog('o/r', () => t, f), branch: () => 'main', repo: () => 'o/r', configured: () => (o.bare ? {} : { ci: { app_id: PINNED_APP } }), required: () => ['ci'] });
  const r = readiness({ required: ['ci'], checks: await pinned.of(HEAD), head: HEAD, evaluated: { head: HEAD, approved: true } });
  return r.ready ? 'ready' : r.reasons.join('; ');
}

test("round 8: with no required check pinned, readiness makes main's reads and gets main's verdict past every cap and refusal", async () => {
  const bareCi = run(1, 'ci', OTHER_APP);
  const first = [bareCi, ...filler(1).slice(1)];
  // 1,001+ check runs: main read 9 pages and said READY (9c1c8bd5 threw: waited for good).
  const calls: string[] = [];
  assert.equal(await ready({ bare: true, calls, runs: (p) => (p === 1 ? first : p <= 10 ? filler(p) : [run(99_999, 'x', OTHER_APP)]) }), 'ready');
  assert.deepEqual(calls.filter((c) => c.startsWith('check-runs')), Array.from({ length: 9 }, (_, i) => `check-runs ${i + 1}`), 'nine pages, as main');
  assert.deepEqual(calls.filter((c) => c.startsWith('status')), ['status 1'], 'one status page, as main');
  // 301 combined-status contexts: main read page 1 and said READY (9c1c8bd5 threw).
  const fullStatus = () => json({ total_count: 301, statuses: Array.from({ length: 30 }, (_, i) => ({ context: `s${i}`, state: 'success' })) });
  assert.equal(await ready({ bare: true, runs: (p) => (p === 1 ? [bareCi] : []), status: () => fullStatus() }), 'ready');
  // A refused page 2 is never read; a rate-limited page 1 is none, as on main (9c1c8bd5 waited on both).
  assert.equal(await ready({ bare: true, runs: (p) => (p === 1 ? [bareCi] : []), status: (p) => (p === 1 ? fullStatus() : RATE_LIMITED()) }), 'ready');
  assert.equal(await ready({ bare: true, runs: (p) => (p === 1 ? [bareCi] : []), status: () => RATE_LIMITED() }), 'ready');
});

test('readiness reads 10 pages of check runs, a failing run of another source on page 10 blocks, and past page 10 nothing is judged', async () => {
  const pinnedPass = run(1, 'ci', PINNED_APP);
  const firstPage = [pinnedPass, ...filler(1).slice(1)];
  const foreignFail = run(99_999, 'ci', OTHER_APP, 'failure');
  // Pages 1 to 9 full; page 10 has another App's failing ci: blocked (it read 9 pages and said READY on 961ecbad).
  assert.match(await ready({ runs: (p) => (p === 1 ? firstPage : p < 10 ? filler(p) : [foreignFail]) }), /ci: fail/);
  // Pages 1 to 10 full, the failure on page 11: the read throws, so the PR is never ready.
  await assert.rejects(ready({ runs: (p) => (p === 1 ? firstPage : p <= 10 ? filler(p) : [foreignFail]) }), /more than 10 pages of check runs/);
  // Nothing past page 1: ready, as before.
  assert.equal(await ready({ runs: (p) => (p === 1 ? [pinnedPass] : []) }), 'ready');
});

test('a required check pinned: any refused status read throws, a first page refused as the permission (403) or none (404) too (round 8, the owner)', async () => {
  const runs = (p: number) => (p === 1 ? [run(1, 'ci', PINNED_APP)] : []);
  const failingFirst = () => json({ statuses: [{ context: 'ci', state: 'failure' }, ...Array.from({ length: 29 }, (_, i) => ({ context: `s${i}`, state: 'success' }))] });
  // A failing pinned status on page 1, then page 2 refused (rate limit) or gone (404): throws (READY on 961ecbad).
  await assert.rejects(ready({ runs, status: (p) => (p === 1 ? failingFirst() : RATE_LIMITED()) }), /403/);
  await assert.rejects(ready({ runs, status: (p) => (p === 1 ? failingFirst() : json({ message: 'Not Found' }, 404)) }), /404/);
  // Page 1 rate-limited: throws (READY on 961ecbad).
  await assert.rejects(ready({ runs, status: () => RATE_LIMITED() }), /403/);
  // Page 1 refused as the token's permission, or 404: throws too (round 8, the owner's decision; 9c1c8bd5 read no
  // statuses and was READY). With nothing pinned these are main's "no statuses" (the round-8 bare test).
  await assert.rejects(ready({ runs, status: () => NO_ACCESS() }), /403/);
  await assert.rejects(ready({ runs, status: () => json({ message: 'Not Found' }, 404) }), /404/);
  assert.equal(await ready({ bare: true, runs: (p) => (p === 1 ? [run(1, 'ci', OTHER_APP)] : []), status: () => NO_ACCESS() }), 'ready', 'nothing pinned: none, as on main');
  // Read in full, the failing status blocks.
  assert.match(await ready({ runs, status: (p) => (p === 1 ? failingFirst() : json({ statuses: [] })) }), /ci: fail/);
});

/** The main watch's reads over pages `runs(page)` and `statuses(page)`. */
function watchApi(o: { runs?: (page: number) => unknown[]; statuses?: (page: number) => Response }) {
  const f = (async (url: string) => {
    const u = new URL(url);
    const page = Number(u.searchParams.get('page') ?? '1');
    if (u.pathname === `/repos/o/r/commits/${HEAD}/check-runs`) return json({ check_runs: (o.runs ?? (() => []))(page).map((r) => ({ ...(r as object), started_at: '2026-10-12T09:00:00Z', completed_at: '2026-10-12T09:05:00Z' })) });
    if (u.pathname === `/repos/o/r/commits/${HEAD}/statuses`) return (o.statuses ?? (() => json([])))(page);
    return json({ message: 'Not Found' }, 404);
  }) as typeof fetch;
  return new GitHubMainWatchApi('o/r', async () => 't', f);
}

test("the main watch's statuses, a required check pinned: any refusal throws, a first page's 403 or 404 too (round 8); nothing pinned: main's read", async () => {
  const full = () => json(Array.from({ length: 100 }, (_, i) => ({ context: `s${i}`, state: 'success', created_at: '2026-10-12T09:00:00Z' })));
  const pinned = { pinned: true };
  // Page 2 refused: throws (961ecbad returned the 100 read so far).
  await assert.rejects(watchApi({ statuses: (p) => (p === 1 ? full() : NO_ACCESS()) }).statuses(HEAD, pinned), /403 reading the statuses .*page 2/);
  await assert.rejects(watchApi({ statuses: (p) => (p === 1 ? full() : json({ message: 'Not Found' }, 404)) }).statuses(HEAD, pinned), /404/);
  // Page 1 rate-limited: throws (961ecbad returned none).
  await assert.rejects(watchApi({ statuses: () => RATE_LIMITED() }).statuses(HEAD, pinned), /403/);
  // Page 1 refused as the token's permission, or 404: throws too (round 8, the owner's decision; 9c1c8bd5 gave none).
  await assert.rejects(watchApi({ statuses: () => NO_ACCESS() }).statuses(HEAD, pinned), /403/);
  await assert.rejects(watchApi({ statuses: () => json({ message: 'Not Found' }, 404) }).statuses(HEAD, pinned), /404/);
  assert.deepEqual(await watchApi({ statuses: () => NO_ACCESS() }).statuses(HEAD), [], 'nothing pinned: none, as on main');
  // Round 8: nothing pinned: main's read (page 1 only; any 403 or 404 is none).
  assert.equal((await watchApi({ statuses: (p) => (p === 1 ? full() : NO_ACCESS()) }).statuses(HEAD)).length, 100);
  assert.deepEqual(await watchApi({ statuses: () => RATE_LIMITED() }).statuses(HEAD), []);
});

test("the main watch's check runs: nothing pinned, the first page only, as main; a required check pinned, TooManyPages past 10 full pages", async () => {
  const bare = await watchApi({ runs: (p) => (p === 1 ? filler(p) : [run(99_999, 'ci', OTHER_APP, 'failure')]) }).checkRuns(HEAD);
  assert.equal(bare.length, 100, 'one page read, as main (9c1c8bd5 read every page)');
  const api = watchApi({ runs: (p) => filler(p) });
  const e = await api.checkRuns(HEAD, { pinned: true }).then(
    () => null,
    (x: unknown) => x,
  );
  assert.ok(e instanceof TooManyPages, String(e));
  assert.equal(e.read.length, 1000);
  assert.equal(e.read.filter((r) => 'extra' in r).length, 900, 'pages 2 to 10 are extra: judged by name, only page 1, as main read it');
});

test("round 9: a rate-limited rules read never drops a ruleset's pin: after an answer the pin is kept, and before one the rules stay unknown", async () => {
  // The ruleset pins `ci` to App 1111; the commit carries only App 2222's passing `ci`. `rules` answers in turn.
  const ruleset = json([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci', integration_id: PINNED_APP }] } }]);
  const verdicts = async (answers: (() => Response)[]) => {
    let n = 0;
    let clock = 0;
    const f = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname === `/repos/o/r/commits/${HEAD}/check-runs`) return json({ check_runs: [run(1, 'ci', OTHER_APP)] });
      if (u.pathname === `/repos/o/r/commits/${HEAD}/status`) return json({ statuses: [] });
      if (u.pathname === '/repos/o/r/branches/main') return json({ name: 'main', protection: { enabled: false } });
      if (u.pathname === '/repos/o/r/rules/branches/main') return answers[Math.min(n++, answers.length - 1)]!();
      return json({ message: 'Not Found' }, 404);
    }) as typeof fetch;
    const t = `tok-${++token}`;
    const pinned = new PinnedChecks({ backlog: new GitHubBacklog('o/r', () => t, f), branch: () => 'main', repo: () => 'o/r', configured: () => ({}), required: () => ['ci'], now: () => clock });
    const out: string[] = [];
    for (let i = 0; i < answers.length; i++) {
      try {
        const r = readiness({ required: ['ci'], checks: await pinned.of(HEAD), head: HEAD, evaluated: { head: HEAD, approved: true } });
        out.push(r.ready ? 'ready' : r.reasons.join('; '));
      } catch {
        out.push('waits'); // a read threw (a secondary limit pauses every call on the token): not ready this tick
      }
      clock += 11 * 60_000; // past the 10-minute cache: GitHub's rules are asked again
    }
    return out;
  };
  const secondary = () => json({ message: 'You have exceeded a secondary rate limit' }, 403);
  // Answered, then rate-limited: the pin is kept, so App 2222's `ci` is still missing (ff971e5e: READY).
  assert.deepEqual(await verdicts([() => ruleset.clone(), RATE_LIMITED]), ['ci: missing', 'ci: missing']);
  // Answered, then a secondary limit: never READY (ff971e5e: READY).
  assert.ok(!(await verdicts([() => ruleset.clone(), secondary])).includes('ready'));
  // Rate-limited or secondary from the start: the rules are unknown, so `ci` is missing or the read waits (ff971e5e: READY).
  assert.deepEqual(await verdicts([RATE_LIMITED]), ['ci: missing']);
  assert.ok(!(await verdicts([secondary])).includes('ready'));
  // A 403 for permission or a 404 on the first page: no rulesets (GitHub Free), as before: by name, READY.
  assert.deepEqual(await verdicts([NO_ACCESS]), ['ready']);
  assert.deepEqual(await verdicts([() => json({ message: 'Not Found' }, 404)]), ['ready']);
});

test("round 9: an Actions-App pin whose workflow runs weren't read never passes: ci.yml failed, then evil.yml passed, judged outside `required` (fix-forward's episode names)", async () => {
  // GitHub's rules pin `ci` to GitHub Actions (15368). `required` doesn't name `ci` (as when required_checks dropped it,
  // and fix-forward judges the names its episode started with): ff971e5e read as for a bare name, so the two runs fell
  // into one App group and evil.yml's later pass decided.
  const ruleset = () => json([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci', integration_id: 15368 }] } }]);
  const actions = (id: number, suite: number, conclusion: string) => ({ id, name: 'ci', status: 'completed', conclusion, html_url: `https://github.com/o/r/actions/runs/${suite * 10}/job/${id}`, app: { id: 15368, slug: 'github-actions' }, check_suite: { id: suite } });
  const wf = (suite: number, path: string) => ({ id: suite * 10, html_url: `https://github.com/o/r/actions/runs/${suite * 10}`, check_suite_id: suite, path, head_sha: HEAD, repository: { full_name: 'o/r' } });
  const f = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname === `/repos/o/r/commits/${HEAD}/check-runs`) return json({ check_runs: [actions(1, 10, 'failure'), actions(2, 20, 'success')] });
    if (u.pathname === `/repos/o/r/commits/${HEAD}/status`) return json({ statuses: [] });
    if (u.pathname === '/repos/o/r/actions/runs') return json({ workflow_runs: [wf(10, '.github/workflows/ci.yml'), wf(20, '.github/workflows/evil.yml')] });
    if (u.pathname === '/repos/o/r/branches/main') return json({ name: 'main', protection: { enabled: false } });
    if (u.pathname === '/repos/o/r/rules/branches/main') return ruleset();
    return json({ message: 'Not Found' }, 404);
  }) as typeof fetch;
  const t = `tok-${++token}`;
  const pinned = new PinnedChecks({ backlog: new GitHubBacklog('o/r', () => t, f), branch: () => 'main', repo: () => 'o/r', configured: () => ({}), required: () => ['lint'] });
  // The judgement fix-forward makes: requiredOutcomes(ep.started.failed, checks).
  assert.deepEqual(requiredOutcomes(['ci'], await pinned.of(HEAD)).map((c) => c.outcome), ['fail'], 'ci.yml failed: blocked (ff971e5e: pass)');
});

test("round 9: ownVerdict never puts an Actions run in the App group: one whose workflow runs weren't read waits", async () => {
  const { ownVerdict } = await import('../src/check-source.js');
  const actions = (id: number, conclusion: string) => ({ id, name: 'ci', source: 'check_run' as const, status: 'completed', conclusion, app: 15368 });
  // No `workflow` at all (not read): its file is unknown, so whether a later run supersedes can't be told: it waits,
  // never a pass, even when every run passed.
  assert.equal(ownVerdict([actions(1, 'failure'), actions(2, 'success')])?.status, 'in_progress');
  assert.equal(ownVerdict([actions(2, 'success')])?.status, 'in_progress', 'waits');
  // A non-Actions App's runs are its App group: the latest decides (the owner's decision).
  assert.equal(ownVerdict([{ ...actions(1, 'failure'), app: 1111 }, { ...actions(2, 'success'), app: 1111 }])?.conclusion, 'success');
});
