import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRepoScope, tokenKind } from '../src/github-scope.js';

/** A fake GitHub API: pages of repos per path, with Link headers between pages. */
const fakeFetch = (pages: Record<string, { full_name: string }[][]>, status = 200) =>
  (async (url: string) => {
    const u = new URL(url);
    const key = u.pathname;
    const page = Number(u.searchParams.get('page') ?? '1');
    const body = key === '/installation/repositories' ? { repositories: pages[key]![page - 1] } : pages[key]![page - 1];
    const next = pages[key]![page] ? `<https://api.test${key}?per_page=100&page=${page + 1}>; rel="next"` : '';
    return new Response(JSON.stringify(body), { status, headers: next ? { link: next } : {} });
  }) as unknown as typeof fetch;

const shop = { full_name: 'Example-Org/Example-Shop' };

test('token kinds by prefix: personal logins and classic tokens are told apart from scoped ones', () => {
  assert.equal(tokenKind('ghs_x'), 'app-installation');
  assert.equal(tokenKind('github_pat_x'), 'fine-grained');
  for (const t of ['gho_x', 'ghp_x', 'ghu_x']) assert.equal(tokenKind(t), 'personal');
  assert.equal(tokenKind('something'), 'unknown');
});

test('a fine-grained token seeing exactly the instance repo is accepted (names compared case-insensitively)', async () => {
  const r = await checkRepoScope('github_pat_ok', ['example-org/example-shop'], fakeFetch({ '/user/repos': [[shop]] }), 'https://api.test');
  assert.deepEqual(r, { ok: true, kind: 'fine-grained' });
});

test('extra repos on a later page are found; refusals give counts, not names', async () => {
  const r = await checkRepoScope('github_pat_wide', ['example-org/example-shop'], fakeFetch({ '/user/repos': [[shop], [{ full_name: 'example-org/secret-thing' }]] }), 'https://api.test');
  assert.equal(r.ok, false);
  assert.match((r as { why: string }).why, /can reach 1 repo\(s\) outside this instance/);
  assert.doesNotMatch((r as { why: string }).why, /secret-thing/);
});

test('an App installation is checked by its installation repositories, and must include the instance repo', async () => {
  assert.equal((await checkRepoScope('ghs_ok', ['example-org/example-shop'], fakeFetch({ '/installation/repositories': [[shop]] }), 'https://api.test')).ok, true);
  const r = await checkRepoScope('ghs_none', ['example-org/example-shop'], fakeFetch({ '/installation/repositories': [[]] }), 'https://api.test');
  assert.match((r as { why: string }).why, /cannot reach example-org\/example-shop/);
});

test('personal and unknown tokens are refused without a request; an API error refuses too', async () => {
  let called = false;
  const spy = (async () => {
    called = true;
    return new Response('[]');
  }) as unknown as typeof fetch;
  assert.match(((await checkRepoScope('gho_x', ['a/b'], spy)) as { why: string }).why, /personal login/);
  assert.match(((await checkRepoScope('nope', ['a/b'], spy)) as { why: string }).why, /unrecognized token type/);
  assert.equal(called, false);
  const r = await checkRepoScope('github_pat_x', ['a/b'], fakeFetch({ '/user/repos': [[]] }, 401), 'https://api.test');
  assert.match((r as { why: string }).why, /could not check what the token can reach \(GitHub 401/);
});
