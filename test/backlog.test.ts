import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { GitHubBacklog, GitHubError } from '../src/backlog/github.js';
import { actionable, ownerFor, parseContract } from '../src/backlog/types.js';
import { globToRegExp } from '../src/guardrails/glob.js';

const writers = ['owner-a', 'collab-b'];

test('done_when contract: parsed from the issue body and validated', () => {
  const ok = parseContract('Fix totals.\n\n```done_when\n- test: test/price.test.js\n- command: npm test\n- manual: "screenshot read"\n- repro: true\n```\n');
  assert.ok(ok.ok && ok.done_when.length === 4);
  assert.equal(parseContract('no contract here').ok, false);
  const bad = parseContract('```done_when\n- shell: rm -rf /\n```');
  assert.ok(!bad.ok && /invalid/.test(bad.why));
  assert.equal(parseContract('```done_when\n[]\n```').ok, false, 'an empty contract is no contract');
});

test('only writer-opened or writer-approved issues are actionable', async () => {
  const b = new FileBacklog(join(mkdtempSync(join(tmpdir(), 'bl-')), 'b.json'));
  const mine = b.open({ title: 'a', body: '', author: 'owner-a', labels: ['ready'] });
  const outsiderSelfLabeled = b.open({ title: 'b', body: '', author: 'stranger', labels: ['ready'] });
  const outsiderApproved = b.open({ title: 'c', body: '', author: 'stranger', labels: ['ready'], labeler: 'collab-b' });
  const notReady = b.open({ title: 'd', body: '', author: 'owner-a', labels: ['triage'] });
  const check = async (n: number) => (await actionable(await b.get(n), writers, b)).actionable;
  assert.equal(await check(mine), true);
  assert.equal(await check(outsiderSelfLabeled), false);
  assert.equal(await check(outsiderApproved), true);
  assert.equal(await check(notReady), false);
});

test('owner: an assigned writer, else the first matching area, else the default', async () => {
  const owners = { default: 'owner-a', writers, areas: [{ owner: 'collab-b', paths: ['web/**'], labels: ['ui'] }] };
  const m = (g: string, p: string) => globToRegExp(g).test(p);
  const issue = { number: 1, title: '', body: '', labels: [] as string[], author: 'x', assignees: [] as string[], state: 'open' as const };
  assert.equal(ownerFor(issue, ['server/a.js'], owners, m), 'owner-a');
  assert.equal(ownerFor(issue, ['web/page.jsx'], owners, m), 'collab-b');
  assert.equal(ownerFor({ ...issue, labels: ['ui'] }, [], owners, m), 'collab-b');
  assert.equal(ownerFor({ ...issue, assignees: ['collab-b'] }, ['server/a.js'], owners, m), 'collab-b');
});

test('GitHub backlog surfaces classified errors, not "missing permission" for everything', async () => {
  const fake = (status: number, headers: Record<string, string>, body: object) => async () => new Response(JSON.stringify(body), { status, headers });
  const rl = new GitHubBacklog('o/r', () => 't', fake(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60) }, { message: 'API rate limit exceeded' }) as typeof fetch);
  await assert.rejects(rl.get(1), (e: GitHubError) => e.kind === 'rate_limited' && (e.retryAfter ?? 0) > 0);
  const role = new GitHubBacklog('o/r', () => 't', fake(403, {}, { message: 'Resource not accessible by integration' }) as typeof fetch);
  await assert.rejects(role.addLabels(1, ['x']), (e: GitHubError) => e.kind === 'insufficient_role');
});
