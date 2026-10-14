// The direct-push alert (src/direct-push-alert.ts): where GitHub doesn't protect the default branch, a commit that
// lands without a PR is posted to the Discord ops channel at once, mentioning the owners, once per commit; a PR's
// merge is never; and config.yaml main_watch.direct_push_alert: false turns it off. Discord itself is never called:
// a fake chat source records each post, and the real adapter is checked with a fake fetch.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Role } from '../src/dashboard-auth.js';
import { lastDirectPush } from '../src/dashboard.js';
import type { EventPayload } from '../src/events/types.js';
import { GitHubMainWatchApi } from '../src/github/main-watch-api.js';
import { DiscordIntake } from '../src/intake/discord.js';
import { IntakeConfig, type IntakeSource, type ReplyOptions } from '../src/intake/report.js';
import { CONFIG_PATH, type MainWatchApi, type MergedPull } from '../src/main-watch.js';
import { FakeRunner } from '../src/runner.js';
import { coordinator, fixture, git, type Fixture } from './repro-state-graph/harness.js';

const ident = ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false'];

// Placeholder ids and logins only.
const OWNER_ID = '100000000001';
const TEAMMATE_ID = '100000000003';
const OPS_CHANNEL = '300000000001';
const DASH = 'https://dashboard.example.test';

const intakeConfig = (owners: string[]) =>
  IntakeConfig.parse({
    version: 1,
    discord: {
      enabled: true,
      guild: '555555',
      channels: ['111111'],
      allowed_senders: [OWNER_ID, TEAMMATE_ID],
      people: { [OWNER_ID]: 'example-owner', [TEAMMATE_ID]: 'example-collaborator' },
      ops_channel: OPS_CHANNEL,
      dashboard_url: DASH,
      owners,
    },
  });

/** A chat source that records every post: where, its text, and whom it would mention. */
function fakeChat() {
  const posts: { where: string; text: string; mentions: string[] }[] = [];
  const src: IntakeSource & { posts: typeof posts } = {
    name: 'discord',
    posts,
    take: async () => [],
    reply: async (t, text, opts?: ReplyOptions) => (posts.push({ where: t.id, text, mentions: opts?.mentions ?? [] }), true),
    openThread: async () => '900000',
    watch: () => undefined,
  };
  return src;
}

function world(o: { owners?: string[]; alertOff?: boolean } = {}) {
  const f = fixture();
  mkdirSync(f.stateDir, { recursive: true });
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = ['ci'];
  const pulls = new Map<string, MergedPull[]>();
  const roles = new Map<string, Role | null>();
  const calls: string[] = [];
  const api: MainWatchApi = {
    protection: async () => (calls.push('protection'), 'none'),
    commitPulls: async (sha) => (calls.push('pulls'), pulls.get(sha) ?? []),
    pull: async (n) => (calls.push('pull'), [...pulls.values()].flat().find((p) => p.number === n)!),
    checkRuns: async () => (calls.push('runs'), []),
    statuses: async () => (calls.push('statuses'), []),
    role: async (login) => (calls.push('role'), roles.get(login) ?? null),
    compare: async () => (calls.push('compare'), { status: 'behind', aheadBy: 0, behindBy: 1 }),
    pusher: async () => (calls.push('pusher'), { login: 'example-pusher', from: 'activity' }),
  };
  const chat = fakeChat();
  const cfg = intakeConfig(o.owners ?? [OWNER_ID]);
  const clock = { t: Date.now() };
  const c = coordinator(f, new FakeRunner(() => ({ structured: {} })), {
    prPollMs: 0,
    autoMerge: () => true,
    mainWatch: { api, now: () => clock.t },
    intake: { config: () => cfg, sources: [chat] },
  });
  const watch = async (minutes = 1) => {
    for (let i = 0; i < minutes; i++) {
      clock.t += 61_000;
      await (c as unknown as { watchMain(): Promise<void> }).watchMain();
    }
  };
  // Someone else's clone, to push and merge from; the default branch carries the required checks (and the switch).
  const person = join(mkdtempSync(join(tmpdir(), 'person-')), 'p');
  git(f.base, 'clone', '-q', f.remote, person);
  appendFileSync(join(person, CONFIG_PATH), `\nrequired_checks: ["ci"]\n${o.alertOff ? 'main_watch:\n  direct_push_alert: false\n' : ''}`);
  git(person, 'add', CONFIG_PATH);
  git(person, ...ident, 'commit', '-q', '-m', 'required_checks');
  git(person, 'push', '-q', 'origin', 'main');
  const directPush = (file: string, subject: string) => {
    writeFileSync(join(person, file), `${file}\n`);
    git(person, 'add', file);
    git(person, ...ident, 'commit', '-q', '-m', subject);
    git(person, 'push', '-q', 'origin', 'main');
    return git(person, 'rev-parse', 'HEAD');
  };
  return { f, c, watch, person, directPush, chat, pulls, roles, calls, clock };
}

const of = <T>(f: Fixture, type: Parameters<Fixture['log']['read']>[1] extends (infer U)[] | undefined ? U : never) => f.log.read(0, [type]).map((e) => e.payload as T);
const opsPosts = (w: ReturnType<typeof world>) => w.chat.posts.filter((p) => p.where === OPS_CHANNEL);

test('direct-push alert: a direct push gives exactly one ops post, mentioning the owners, with the sha, pusher, subject and the main watch link', async () => {
  const w = world();
  await w.watch(2); // protection asked; main's tip is the baseline
  const sha = w.directPush('hotfix.txt', 'Hotfix the totals by hand');
  await w.watch(4); // GitHub's empty commit-to-PR link is asked again for LINK_LAG_MS first
  const posts = opsPosts(w);
  assert.equal(posts.length, 1, 'one post to the ops channel');
  const p = posts[0]!;
  assert.deepEqual(p.mentions, [OWNER_ID], 'the mapped owner is mentioned');
  assert.ok(p.text.includes(sha.slice(0, 12)), 'names the sha');
  assert.match(p.text, /Pushed by: example-pusher/);
  assert.match(p.text, /Subject: Hotfix the totals by hand/);
  assert.ok(p.text.includes(`${DASH}/machine#main-watch`), "links to the dashboard's main watch");
  assert.doesNotMatch(p.text, /@example\.com/, 'never an email');
  assert.ok(w.calls.includes('pulls'), "GitHub's commit-to-PR link was asked before it was called a direct push");
  // The main watch's own handling still happens: stopped, alerted.
  assert.equal(of(w.f, 'main_watch.unaccounted').length, 1);
  const view = lastDirectPush(w.f.log.read(0));
  assert.equal(view?.status, 'posted');
  assert.equal(view?.mentioned, 1);
});

test('direct-push alert: a PR merge gives no post, even one the watch flags; a direct push after it does', async () => {
  const w = world();
  await w.watch(2);
  // A PR, merged by an admin with its required check missing: unaccounted, but it came through a PR.
  git(w.person, 'checkout', '-q', '-b', 'feature/totals');
  writeFileSync(join(w.person, 'feature.txt'), 'feature\n');
  git(w.person, 'add', 'feature.txt');
  git(w.person, ...ident, 'commit', '-q', '-m', 'feature');
  const head = git(w.person, 'rev-parse', 'HEAD');
  git(w.person, 'checkout', '-q', 'main');
  git(w.person, ...ident, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #41', head);
  git(w.person, 'push', '-q', 'origin', 'main');
  const merge = git(w.person, 'rev-parse', 'HEAD');
  const at = new Date(w.clock.t).toISOString();
  w.pulls.set(merge, [{ number: 41, url: 'https://github.com/x/y/pull/41', mergedAt: at, mergeCommit: merge, mergedBy: 'example-owner', mergedByBot: false, head, base: 'main' }]);
  w.roles.set('example-owner', 'owner');
  await w.watch(6);
  assert.deepEqual(of<EventPayload<'main_watch.unaccounted'>>(w.f, 'main_watch.unaccounted').map((u) => u.sha), [merge], 'the watch flagged the merge');
  assert.equal(opsPosts(w).length, 0, 'no ops post for a PR merge');
  assert.equal(of(w.f, 'main_watch.direct_push').length, 0);
  // A direct push after it: posted.
  const sha = w.directPush('hotfix.txt', 'Hotfix');
  await w.watch(4); // GitHub's empty commit-to-PR link is asked again for LINK_LAG_MS first
  assert.equal(opsPosts(w).length, 1);
  assert.ok(opsPosts(w)[0]!.text.includes(sha.slice(0, 12)));
});

test('direct-push alert: a second check of the same sha gives no second post', async () => {
  const w = world();
  await w.watch(2);
  const sha = w.directPush('hotfix.txt', 'Hotfix');
  await w.watch(4); // GitHub's empty commit-to-PR link is asked again for LINK_LAG_MS first
  assert.equal(opsPosts(w).length, 1);
  // The same commit judged again (as after a restart that lost the watch's place): no second post.
  const md = w.c as unknown as { mainUnaccounted(o: object): Promise<void>; directPushNoted(sha: string, url: string, push: object): Promise<void>; directPushOutbound(): Promise<void> };
  await md.directPushNoted(sha, `https://github.com/x/y/commit/${sha}`, { kind: 'direct', alert: true });
  await md.directPushOutbound();
  await w.watch(3);
  assert.equal(opsPosts(w).length, 1, 'still one post');
  assert.equal(of(w.f, 'main_watch.direct_push').length, 1, 'recorded once');
});

test('direct-push alert: nothing is posted when main_watch.direct_push_alert is false, and the dashboard says it is off', async () => {
  const w = world({ alertOff: true });
  await w.watch(2);
  w.directPush('hotfix.txt', 'Hotfix');
  await w.watch(4); // GitHub's empty commit-to-PR link is asked again for LINK_LAG_MS first
  assert.equal(of(w.f, 'main_watch.unaccounted').length, 1, 'the main watch still stops and alerts');
  const pushes = of<EventPayload<'main_watch.direct_push'>>(w.f, 'main_watch.direct_push');
  assert.equal(pushes.length, 1, 'the direct push is recorded');
  assert.equal(pushes[0]!.alert, false);
  assert.equal(opsPosts(w).length, 0, 'no ops post');
  const view = lastDirectPush(w.f.log.read(0));
  assert.equal(view?.status, 'off');
  assert.match(view?.note ?? '', /direct_push_alert: false/);
});

test('direct-push alert: without Discord owners it posts with no mention, and the dashboard says why', async () => {
  const w = world({ owners: [] });
  await w.watch(2);
  w.directPush('hotfix.txt', 'Hotfix');
  await w.watch(4); // GitHub's empty commit-to-PR link is asked again for LINK_LAG_MS first
  const posts = opsPosts(w);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0]!.mentions, []);
  const view = lastDirectPush(w.f.log.read(0));
  assert.equal(view?.status, 'posted');
  assert.match(view?.note ?? '', /no discord\.owners/);
});

test('direct-push alert: the adapter pings owners in the ops channel only, never in another channel or anyone else', async () => {
  const sent: { url: string; body: { content: string; allowed_mentions: { parse: string[]; users?: string[] } } }[] = [];
  const bot = new DiscordIntake({
    token: 'x',
    guild: '555555',
    channels: ['111111'],
    allowedSenders: [OWNER_ID],
    prefixes: [],
    owners: [OWNER_ID],
    opsChannel: OPS_CHANNEL,
    fetch: (async (url: string, init: { body: string }) => (sent.push({ url, body: JSON.parse(init.body) }), new Response('{}'))) as unknown as typeof fetch,
  });
  await bot.reply(OPS_CHANNEL, 'alert', [OWNER_ID, TEAMMATE_ID]);
  await bot.reply('111111', 'elsewhere', [OWNER_ID]);
  assert.deepEqual(sent[0]!.body.allowed_mentions.users, [OWNER_ID], 'only the owner, in the ops channel');
  assert.ok(sent[0]!.body.content.endsWith(`<@${OWNER_ID}>`));
  assert.equal(sent[1]!.body.allowed_mentions.users, undefined, 'nobody pinged in another channel');
});

test("direct-push alert: the pusher is the push's actor from the repo's activity, else the commit's GitHub author; a login, never an email", async () => {
  const sha = 'a'.repeat(40);
  const answer = (activity: unknown[]) =>
    (async (url: string) => {
      if (url.includes('/activity?')) return new Response(JSON.stringify(activity));
      if (url.endsWith(`/commits/${sha}`)) return new Response(JSON.stringify({ author: { login: 'example-author' }, commit: { author: { email: 'ada@example.com' } } }));
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
  const viaPush = new GitHubMainWatchApi('x/y', async () => 't', answer([{ after: 'b'.repeat(40), activity_type: 'push', actor: { login: 'someone-else' } }, { after: sha, activity_type: 'push', actor: { login: 'example-pusher' } }]));
  assert.deepEqual(await viaPush.pusher('main', sha), { login: 'example-pusher', from: 'activity' });
  const viaCommit = new GitHubMainWatchApi('x/y', async () => 't', answer([]));
  assert.deepEqual(await viaCommit.pusher('main', sha), { login: 'example-author', from: 'commit' });
});
