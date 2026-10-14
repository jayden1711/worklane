// Merge posts (src/merge-posts.ts): every merge to the default branch, whoever made it, posted once in the Discord ops
// channel with the PR (linked), the merger's login, the merge commit's short sha and the first line of the PR's
// intent, redacted. A direct push (no PR) gets no post from it; intake.yaml discord.post_merges: false turns it off.
// Discord and GitHub are never called: a fake chat source records each post, a fake API answers for GitHub, and the
// default branch is a real git remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntakeConfig, type IntakeSource } from '../src/intake/report.js';
import { mergePostKey, MERGE_POSTS_CALL_MS, readMergePostsState, type MergePostsApi, type MergePull } from '../src/merge-posts.js';
import { FakeRunner } from '../src/runner.js';
import { coordinator, fixture, git } from './repro-state-graph/harness.js';

const ident = ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false'];

// Placeholder ids and logins only.
const OWNER_ID = '100000000001';
const OPS_CHANNEL = '300000000001';
const DASH = 'https://dashboard.example.test';
const REPO_URL = 'https://github.com/example-org/example-repo';

const intakeConfig = (o: { postMerges?: boolean } = {}) =>
  IntakeConfig.parse({
    version: 1,
    discord: {
      enabled: true,
      guild: '555555',
      channels: ['111111'],
      allowed_senders: [OWNER_ID],
      people: { [OWNER_ID]: 'example-owner' },
      ops_channel: OPS_CHANNEL,
      dashboard_url: DASH,
      ...(o.postMerges === undefined ? {} : { post_merges: o.postMerges }),
    },
  });

function fakeChat() {
  const posts: { where: string; text: string }[] = [];
  const src: IntakeSource & { posts: typeof posts } = {
    name: 'discord',
    posts,
    take: async () => [],
    reply: async (t, text) => (posts.push({ where: t.id, text }), true),
    openThread: async () => '900000',
    watch: () => undefined,
  };
  return src;
}

function world(o: { postMerges?: boolean } = {}) {
  const f = fixture();
  mkdirSync(f.stateDir, { recursive: true });
  f.cfg.project.land_mode = 'pr';
  // What GitHub knows: each commit's PRs (the list endpoint has no merged_by), and each PR itself.
  const commitPulls = new Map<string, MergePull[]>();
  const pulls = new Map<number, MergePull>();
  const calls: string[] = [];
  const api: MergePostsApi = {
    commitPulls: async (sha) => (calls.push(`pulls ${sha.slice(0, 8)}`), commitPulls.get(sha) ?? []),
    pull: async (n) => (calls.push(`pull ${n}`), pulls.get(n)!),
  };
  const chat = fakeChat();
  const cfg = intakeConfig(o);
  const clock = { t: Date.now() };
  /** A coordinator over this instance's log and state dir; a second one is a restart. */
  const start = () => coordinator(f, new FakeRunner(() => ({ structured: {} })), { mergePosts: { api, now: () => clock.t }, intake: { config: () => cfg, sources: [chat] } });
  let c = start();
  const pass = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.t += MERGE_POSTS_CALL_MS + 1000;
      await (c as unknown as { postMerges(): Promise<void> }).postMerges();
    }
  };
  const restart = () => {
    c = start();
  };
  // Someone else's clone, to push and merge from.
  const person = join(mkdtempSync(join(tmpdir(), 'person-')), 'p');
  git(f.base, 'clone', '-q', f.remote, person);
  let n = 40;
  /** A PR merged on GitHub (a merge commit), by `by`, with this body and title. */
  const merge = (o: { by?: string; title?: string; body?: string | null } = {}) => {
    const number = ++n;
    git(person, 'checkout', '-q', '-b', `feature/${number}`);
    writeFileSync(join(person, `feature-${number}.txt`), `${number}\n`);
    git(person, 'add', `feature-${number}.txt`);
    git(person, ...ident, 'commit', '-q', '-m', `feature ${number}`);
    const head = git(person, 'rev-parse', 'HEAD');
    git(person, 'checkout', '-q', 'main');
    git(person, ...ident, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${number}`, head);
    git(person, 'push', '-q', 'origin', 'main');
    const sha = git(person, 'rev-parse', 'HEAD');
    const pr: MergePull = { number, url: `${REPO_URL}/pull/${number}`, title: o.title ?? `Feature ${number}`, body: o.body === undefined ? `Adds feature ${number}.\n\nMore detail that is never posted.` : o.body, mergedAt: new Date(clock.t).toISOString(), mergeCommit: sha, mergedBy: null, base: 'main' };
    commitPulls.set(sha, [pr]);
    pulls.set(number, { ...pr, mergedBy: o.by ?? 'example-owner' });
    return { sha, number };
  };
  const directPush = (file: string) => {
    writeFileSync(join(person, file), `${file}\n`);
    git(person, 'add', file);
    git(person, ...ident, 'commit', '-q', '-m', `direct ${file}`);
    git(person, 'push', '-q', 'origin', 'main');
    return git(person, 'rev-parse', 'HEAD');
  };
  return { f, pass, restart, merge, directPush, chat, calls, clock, commitPulls };
}

const mergePosts = (w: ReturnType<typeof world>) => w.chat.posts.filter((p) => p.where === OPS_CHANNEL && p.text.startsWith('**Merged**'));

test('merge posts: a merge gives exactly one ops post, with the linked PR number, the login, the short sha and the intent line', async () => {
  const w = world();
  await w.pass(); // main's tip is the baseline
  const { sha, number } = w.merge({ by: 'example-merger', body: 'Totals skip non-positive quantities.\nSecond line of the first paragraph.\n\nMore detail that is never posted.' });
  await w.pass(4);
  const posts = mergePosts(w);
  assert.equal(posts.length, 1, 'one post to the ops channel');
  const t = posts[0]!.text;
  assert.ok(t.includes(`[#${number}](<${REPO_URL}/pull/${number}>)`), `links the PR: ${t}`);
  assert.match(t, /by @example-merger/);
  assert.ok(t.includes(`\`${sha.slice(0, 8)}\``), 'names the short sha');
  assert.match(t, /Totals skip non-positive quantities\.$/);
  assert.doesNotMatch(t, /Second line|never posted/, 'only the first line of the intent');
  assert.doesNotMatch(t, /@example\.com/, 'never an email');
  assert.ok(w.calls.includes(`pulls ${sha.slice(0, 8)}`), "the PR was found through GitHub's commit-to-PR link");
  assert.ok(w.calls.includes(`pull ${number}`), 'who merged it, from the PR');
  await w.pass(3);
  assert.equal(mergePosts(w).length, 1, 'still one');
});

test('merge posts: the same commit seen twice (its place lost, as after a restart) gives one post', async () => {
  const w = world();
  await w.pass();
  const before = git(w.f.remote, 'rev-parse', 'main');
  const { sha } = w.merge();
  await w.pass(4);
  assert.equal(mergePosts(w).length, 1);
  assert.equal(readMergePostsState(join(w.f.stateDir, 'merge-posts.json')).last, sha, 'its place is kept in the state dir');
  // The state file rolled back to before the merge: the commit is walked again, and not posted again.
  writeFileSync(join(w.f.stateDir, 'merge-posts.json'), JSON.stringify({ version: 1, last: before, lastCallAt: 0, pending: null }));
  w.restart();
  await w.pass(4);
  assert.equal(readMergePostsState(join(w.f.stateDir, 'merge-posts.json')).last, sha, 'walked again');
  assert.equal(mergePosts(w).length, 1, 'still one post');
  assert.equal(w.f.log.read(0, ['discord.posting']).filter((e) => (e.payload as { key: string }).key === mergePostKey(sha)).length, 1);
});

test('merge posts: a PR with an empty body falls back to its title', async () => {
  const w = world();
  await w.pass();
  w.merge({ title: 'Fix the totals for returns', body: '' });
  w.merge({ title: 'Only a template comment', body: '<!-- describe the change -->\n\n' });
  w.merge({ title: 'No body at all', body: null });
  await w.pass(12);
  const posts = mergePosts(w).map((p) => p.text);
  assert.equal(posts.length, 3);
  assert.match(posts[0]!, /: Fix the totals for returns$/);
  assert.match(posts[1]!, /: Only a template comment$/);
  assert.match(posts[2]!, /: No body at all$/);
});

test('merge posts: an email or a token-like string in the intent line is redacted', async () => {
  const w = world();
  await w.pass();
  const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  w.merge({ body: `Rotate the key ${token} reported by ada@example.com today.\n\nDetail.` });
  w.merge({ title: `Title with ${token} and ada@example.com`, body: '' });
  await w.pass(8);
  const posts = mergePosts(w).map((p) => p.text);
  assert.equal(posts.length, 2);
  for (const t of posts) {
    assert.ok(!t.includes(token), `no token: ${t}`);
    assert.doesNotMatch(t, /ada@example\.com/, 'no email');
    assert.match(t, /\[REDACTED\]/);
    assert.match(t, /\[email\]/);
  }
});

test('merge posts: off (discord.post_merges: false) posts nothing and calls nothing', async () => {
  const w = world({ postMerges: false });
  await w.pass();
  w.merge();
  await w.pass(4);
  assert.equal(mergePosts(w).length, 0);
  assert.deepEqual(w.calls, [], 'no GitHub call');
  assert.equal(intakeConfig().discord.post_merges, true, 'on by default');
});

test('merge posts: a direct push (no PR) gets no post from merge posts; a merge after it does', async () => {
  const w = world();
  await w.pass();
  const sha = w.directPush('hotfix.txt');
  await w.pass(6); // its empty commit-to-PR link is asked again for LINK_LAG_MS first
  assert.ok(w.calls.includes(`pulls ${sha.slice(0, 8)}`), 'GitHub was asked for its PR');
  assert.equal(mergePosts(w).length, 0, 'no post for a direct push');
  w.merge();
  await w.pass(4);
  assert.equal(mergePosts(w).length, 1);
});

test('regression: a merge whose commit-to-PR link lags is still posted once GitHub links it', async () => {
  // GitHub links a merge commit to its PR a few seconds after it lands; asked at once, the link was empty and the
  // merge was taken for a direct push: never posted.
  const w = world();
  await w.pass();
  const { sha, number } = w.merge();
  const linked = w.commitPulls.get(sha)!;
  w.commitPulls.delete(sha); // not linked yet
  await w.pass(2);
  assert.ok(w.calls.includes(`pulls ${sha.slice(0, 8)}`), 'GitHub was asked');
  w.commitPulls.set(sha, linked); // linked now
  await w.pass(4);
  assert.equal(mergePosts(w).length, 1, 'posted');
  assert.ok(mergePosts(w)[0]!.text.includes(`#${number}`));
});
