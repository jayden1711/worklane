// #727 round 7: a truncated or refused GitHub read never ends as ready. Readiness (GitHubBacklog's pages, through
// PinnedChecks.of) and the main watch's reads (GitHubMainWatchApi) over stand-in REST answers: past the page cap, or
// refused part-way, a read throws (the PR waits; the watch asks again or judges the merge unaccounted), never a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubBacklog } from '../src/backlog/github.js';
import { PinnedChecks } from '../src/check-source.js';
import { GitHubMainWatchApi } from '../src/github/main-watch-api.js';
import { TooManyPages } from '../src/main-watch.js';
import { readiness } from '../src/pr-watch.js';

const HEAD = 'a'.repeat(40);
const PINNED_APP = 1111;
const OTHER_APP = 2222;
const run = (id: number, name: string, app: number, conclusion = 'success') => ({ id, name, status: 'completed', conclusion, html_url: `https://github.example/o/r/runs/${id}`, app: { id: app, slug: `app-${app}` }, check_suite: { id: app * 10 } });
/** 100 passing runs of other names: a full page. */
const filler = (page: number) => Array.from({ length: 100 }, (_, i) => run(page * 1000 + i, `other-${page}-${i}`, OTHER_APP));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const RATE_LIMITED = () => json({ message: 'API rate limit exceeded for installation' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) });
const NO_ACCESS = () => json({ message: 'Resource not accessible by integration' }, 403);
let token = 0;

/**
 * Readiness of `ci`, pinned to App 1111, whose own run passes on page 1: the check-run pages `runs(page)` (filter=latest),
 * and the combined status's pages `status(page)`. Rejects when the read throws.
 */
async function ready(o: { runs: (page: number) => unknown[]; status?: (page: number) => Response }) {
  const f = (async (url: string) => {
    const u = new URL(url);
    const page = Number(u.searchParams.get('page') ?? '1');
    if (u.pathname === `/repos/o/r/commits/${HEAD}/check-runs`) return json({ check_runs: o.runs(page) });
    if (u.pathname === `/repos/o/r/commits/${HEAD}/status`) return o.status ? o.status(page) : json({ statuses: [] });
    return json({ message: 'Not Found' }, 404);
  }) as typeof fetch;
  // A fresh token each time, so no rate limit here is shared with another test's budget.
  const t = `tok-${++token}`;
  const pinned = new PinnedChecks({ backlog: new GitHubBacklog('o/r', () => t, f), branch: () => 'main', repo: () => 'o/r', configured: () => ({ ci: { app_id: PINNED_APP } }) });
  const r = readiness({ required: ['ci'], checks: await pinned.of(HEAD), head: HEAD, evaluated: { head: HEAD, approved: true } });
  return r.ready ? 'ready' : r.reasons.join('; ');
}

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

test("a status read refused part-way, or rate-limited, throws; only a first page refused as a token's permission (403) or none (404) means no statuses", async () => {
  const runs = (p: number) => (p === 1 ? [run(1, 'ci', PINNED_APP)] : []);
  const failingFirst = () => json({ statuses: [{ context: 'ci', state: 'failure' }, ...Array.from({ length: 29 }, (_, i) => ({ context: `s${i}`, state: 'success' }))] });
  // A failing pinned status on page 1, then page 2 refused (rate limit) or gone (404): throws (READY on 961ecbad).
  await assert.rejects(ready({ runs, status: (p) => (p === 1 ? failingFirst() : RATE_LIMITED()) }), /403/);
  await assert.rejects(ready({ runs, status: (p) => (p === 1 ? failingFirst() : json({ message: 'Not Found' }, 404)) }), /404/);
  // Page 1 rate-limited: throws (READY on 961ecbad).
  await assert.rejects(ready({ runs, status: () => RATE_LIMITED() }), /403/);
  // Page 1 refused as the token's permission, or 404: no statuses, as on main.
  assert.equal(await ready({ runs, status: () => NO_ACCESS() }), 'ready');
  assert.equal(await ready({ runs, status: () => json({ message: 'Not Found' }, 404) }), 'ready');
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

test("the main watch's statuses: refused part-way or rate-limited throws; a first page refused as the token's permission, or 404, is none", async () => {
  const full = () => json(Array.from({ length: 100 }, (_, i) => ({ context: `s${i}`, state: 'success', created_at: '2026-10-12T09:00:00Z' })));
  // Page 2 refused: throws (961ecbad returned the 100 read so far).
  await assert.rejects(watchApi({ statuses: (p) => (p === 1 ? full() : NO_ACCESS()) }).statuses(HEAD), /403 reading the statuses .*page 2/);
  await assert.rejects(watchApi({ statuses: (p) => (p === 1 ? full() : json({ message: 'Not Found' }, 404)) }).statuses(HEAD), /404/);
  // Page 1 rate-limited: throws (961ecbad returned none).
  await assert.rejects(watchApi({ statuses: () => RATE_LIMITED() }).statuses(HEAD), /403/);
  // Page 1 refused as the token's permission, or 404: none, as on main.
  assert.deepEqual(await watchApi({ statuses: () => NO_ACCESS() }).statuses(HEAD), []);
  assert.deepEqual(await watchApi({ statuses: () => json({ message: 'Not Found' }, 404) }).statuses(HEAD), []);
});

test("the main watch's check runs past 10 full pages: TooManyPages, carrying the 1000 read (the watch then judges a pinned merge unaccounted)", async () => {
  const api = watchApi({ runs: (p) => filler(p) });
  const e = await api.checkRuns(HEAD).then(
    () => null,
    (x: unknown) => x,
  );
  assert.ok(e instanceof TooManyPages, String(e));
  assert.equal(e.read.length, 1000);
  assert.equal(e.read.filter((r) => 'extra' in r).length, 900, 'pages 2 to 10 are extra: judged by name, only page 1, as main read it');
});
