import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubBacklog } from '../src/backlog/github.js';
import type { CommitCheck } from '../src/backlog/types.js';
import { readiness, requiredOutcomes } from '../src/pr-watch.js';

const HEAD = 'a'.repeat(40);
const run = (name: string, conclusion: string | null, status = 'completed', id = 1): CommitCheck => ({ name, source: 'check_run', status, conclusion, id });
const approved = { head: HEAD, approved: true };

test('ready: every required check passed on the evaluated head, and the evaluator approved', () => {
  const r = readiness({ required: ['test', 'build'], checks: [run('test', 'success'), run('build', 'success'), run('lint', 'failure')], head: HEAD, evaluated: approved });
  assert.deepEqual(r, { ready: true, reasons: [], checks: [{ name: 'test', outcome: 'pass', id: 1 }, { name: 'build', outcome: 'pass', id: 1 }], failed: [] });
});

test('no required checks configured: never ready (fails closed)', () => {
  const r = readiness({ required: [], checks: [run('test', 'success')], head: HEAD, evaluated: approved });
  assert.equal(r.ready, false);
  assert.match(r.reasons.join(), /no required checks are configured/);
});

test('missing, pending, cancelled, skipped and neutral required checks are not passed; only a failure counts as failed', () => {
  const r = readiness({
    required: ['gone', 'running', 'cancelled', 'skipped', 'neutral', 'red'],
    checks: [run('running', null, 'in_progress'), run('cancelled', 'cancelled'), run('skipped', 'skipped'), run('neutral', 'neutral'), run('red', 'timed_out', 'completed', 7)],
    head: HEAD,
    evaluated: approved,
  });
  assert.equal(r.ready, false);
  assert.deepEqual(r.checks.map((c) => c.outcome), ['missing', 'pending', 'cancelled', 'skipped', 'skipped', 'fail']);
  assert.deepEqual(r.failed, [{ name: 'red', outcome: 'fail', id: 7 }]);
  assert.equal(r.reasons.length, 6);
});

test('a head other than the evaluated commit, a rejection, or no verdict: not ready, with the reason', () => {
  const checks = [run('test', 'success')];
  const moved = readiness({ required: ['test'], checks, head: 'b'.repeat(40), evaluated: approved });
  assert.match(moved.reasons.join(), /head bbbbbbbb is not the commit the evaluator approved \(aaaaaaaa\)/);
  assert.match(readiness({ required: ['test'], checks, head: HEAD, evaluated: { head: HEAD, approved: false } }).reasons.join(), /did not approve/);
  assert.match(readiness({ required: ['test'], checks, head: HEAD, evaluated: null }).reasons.join(), /no evaluator verdict/);
});

test('a commit status counts like a check run; a check run of the same name wins', () => {
  const status = (name: string, conclusion: string | null): CommitCheck => ({ name, source: 'status', status: conclusion ? 'completed' : 'pending', conclusion });
  assert.deepEqual(requiredOutcomes(['deploy'], [status('deploy', 'success')]).map((c) => c.outcome), ['pass']);
  assert.deepEqual(requiredOutcomes(['deploy'], [status('deploy', null)]).map((c) => c.outcome), ['pending']);
  assert.deepEqual(requiredOutcomes(['x'], [status('x', 'success'), run('x', 'failure')]).map((c) => c.outcome), ['fail']);
});

// GitHub over a scripted fetch: each request is answered from `routes` by method and path prefix.
function github(routes: Record<string, (body: unknown) => { status: number; body: unknown }>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.github.com', '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? 'GET', path, body });
    const key = Object.keys(routes).find((k) => `${init.method ?? 'GET'} ${path}`.startsWith(k));
    if (!key) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const r = routes[key]!(body);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { b: new GitHubBacklog('o/r', () => 't', f), calls };
}

test('GitHub checks: check runs (latest per name) plus commit statuses; no statuses permission or none at all is just no statuses', async () => {
  const runs = { check_runs: [{ id: 5, name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://x/5' }] };
  const both = github({
    [`GET /repos/o/r/commits/${HEAD}/check-runs?filter=latest`]: () => ({ status: 200, body: runs }),
    [`GET /repos/o/r/commits/${HEAD}/status`]: () => ({ status: 200, body: { statuses: [{ context: 'deploy', state: 'pending' }, { context: 'docs', state: 'error' }] } }),
  });
  assert.deepEqual(await both.b.checks(HEAD), [
    { name: 'test', source: 'check_run', status: 'completed', conclusion: 'success', id: 5, url: 'https://x/5' },
    { name: 'deploy', source: 'status', status: 'pending', conclusion: null },
    { name: 'docs', source: 'status', status: 'completed', conclusion: 'failure' },
  ]);
  for (const status of [403, 404]) {
    const g = github({
      [`GET /repos/o/r/commits/${HEAD}/check-runs`]: () => ({ status: 200, body: runs }),
      [`GET /repos/o/r/commits/${HEAD}/status`]: () => ({ status, body: { message: 'Resource not accessible by integration' } }),
    });
    assert.equal((await g.b.checks(HEAD)).length, 1, `statuses ${status}`);
  }
  const broken = github({
    [`GET /repos/o/r/commits/${HEAD}/check-runs`]: () => ({ status: 200, body: runs }),
    [`GET /repos/o/r/commits/${HEAD}/status`]: () => ({ status: 500, body: { message: 'boom' } }),
  });
  await assert.rejects(broken.b.checks(HEAD), 'a server error is not "no statuses"');
});

test('GitHub openPr asks for a draft, and opens an ordinary PR where drafts are not supported', async () => {
  const pull = { number: 9, html_url: 'https://x/pull/9', node_id: 'N', head: { ref: 'b', sha: HEAD }, state: 'open' };
  const ok = github({ 'GET /repos/o/r/pulls?state=open': () => ({ status: 200, body: [] }), 'POST /repos/o/r/pulls': () => ({ status: 201, body: { ...pull, draft: true } }) });
  assert.deepEqual(await ok.b.openPr('b', 'main', 't', 'body', { draft: true }), { url: 'https://x/pull/9', number: 9, draft: true });
  assert.equal((ok.calls.find((c) => c.method === 'POST')!.body as { draft: boolean }).draft, true);
  let posts = 0;
  const noDrafts = github({
    'GET /repos/o/r/pulls?state=open': () => ({ status: 200, body: [] }),
    'POST /repos/o/r/pulls': (body) => (++posts === 1 && (body as { draft?: boolean }).draft ? { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'Draft pull requests are not supported in this repository.' }] } } : { status: 201, body: pull }),
  });
  assert.deepEqual(await noDrafts.b.openPr('b', 'main', 't', 'body', { draft: true }), { url: 'https://x/pull/9', number: 9, draft: false });
  const other = github({ 'GET /repos/o/r/pulls?state=open': () => ({ status: 200, body: [] }), 'POST /repos/o/r/pulls': () => ({ status: 422, body: { message: 'Validation Failed', errors: [{ message: 'No commits between main and b' }] } }) });
  await assert.rejects(other.b.openPr('b', 'main', 't', 'body', { draft: true }), /No commits between/);
});

test('GitHub markReady: the GraphQL mutation on the PR node, only for a draft', async () => {
  const pull = (draft: boolean) => ({ number: 9, html_url: 'u', node_id: 'PR_node', head: { ref: 'b', sha: HEAD }, state: 'open', draft });
  const g = github({ 'GET /repos/o/r/pulls/9': () => ({ status: 200, body: pull(true) }), 'POST /graphql': () => ({ status: 200, body: { data: {} } }) });
  await g.b.markReady(9);
  const q = g.calls.find((c) => c.path === '/graphql')!.body as { query: string; variables: { id: string } };
  assert.match(q.query, /markPullRequestReadyForReview/);
  assert.equal(q.variables.id, 'PR_node');
  const notDraft = github({ 'GET /repos/o/r/pulls/9': () => ({ status: 200, body: pull(false) }) });
  await notDraft.b.markReady(9);
  assert.ok(!notDraft.calls.some((c) => c.path === '/graphql'));
  const err = github({ 'GET /repos/o/r/pulls/9': () => ({ status: 200, body: pull(true) }), 'POST /graphql': () => ({ status: 200, body: { errors: [{ message: 'not permitted' }] } }) });
  await assert.rejects(err.b.markReady(9), /not permitted/);
});

test('GitHub pullRequest: merged, closed and open states, head branch and sha', async () => {
  const g = (p: object) => github({ 'GET /repos/o/r/pulls/9': () => ({ status: 200, body: { number: 9, html_url: 'u', node_id: 'n', head: { ref: 'br', sha: HEAD }, ...p } }) }).b.pullRequest(9);
  assert.deepEqual(await g({ state: 'open', draft: true }), { number: 9, url: 'u', head: 'br', headSha: HEAD, draft: true, state: 'open' });
  assert.equal((await g({ state: 'closed', merged: true })).state, 'merged');
  assert.equal((await g({ state: 'closed', merged: false })).state, 'closed');
});

test('GitHub jobLog: the log text; 403 is no Actions: read permission, 404 no log, a rate limit is an error to retry', async () => {
  const log = (status: number, body: string, headers: Record<string, string> = {}) =>
    new GitHubBacklog('o/r', () => 't', (async () => new Response(body, { status, headers })) as typeof fetch).jobLog(11);
  assert.deepEqual(await log(200, '2026-01-01T00:00:00Z FAILED x\n'), { ok: true, text: '2026-01-01T00:00:00Z FAILED x\n' });
  assert.deepEqual(await log(403, JSON.stringify({ message: 'Resource not accessible by integration' })), { ok: false, why: 'forbidden' });
  assert.deepEqual(await log(404, JSON.stringify({ message: 'Not Found' })), { ok: false, why: 'not_found' });
  assert.deepEqual(await log(410, 'gone'), { ok: false, why: 'not_found' });
  await assert.rejects(log(403, JSON.stringify({ message: 'API rate limit exceeded' }), { 'x-ratelimit-remaining': '0' }));
});

test('GitHub requestReview: the reviewers on the PR', async () => {
  const g = github({ 'POST /repos/o/r/pulls/9/requested_reviewers': () => ({ status: 201, body: {} }) });
  await g.b.requestReview(9, ['owner-a']);
  assert.deepEqual(g.calls[0]!.body, { reviewers: ['owner-a'] });
});
