// The parallel merge train (src/merge-policy-train.ts, wired in src/coordinator/merge-flow.ts): several of the
// harness's own green, non-protected PRs merge in one pass of the PR watch, up to tests.yaml land.parallel_merges;
// protected paths still wait for the owner; a moved head is never merged; GitHub's "not up to date" refusal (strict
// protection) is put off with a backoff, never retried in a loop; merge subjects carry no handle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { TestsConfig } from '../src/config/schema.js';
import type { EventPayload } from '../src/events/types.js';
import { deferDelay, DEFER_FIRST_MS, DEFER_MAX_MS, mergeMessage, mergeRefusal } from '../src/merge-policy-train.js';
import { agents, coordinator, fixture, git, passing, skip } from './repro-state-graph/harness.js';

type Train = { watchPrs: () => Promise<void>; trainNow: () => number };

/**
 * `specs.length` harness PRs off main, each changing its own file (a path per spec), green on its head with an
 * approving verdict, auto-merge on, every pass looking at every PR (prPollMs 0).
 */
function train(specs: { path: string; title?: string }[], edit?: (cfg: ReturnType<typeof fixture>['cfg']) => void) {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = ['ci'];
  f.cfg.project.combined_check = false;
  edit?.(f.cfg);
  const base = git(f.repo, 'rev-parse', 'HEAD');
  const prs = specs.map((s, i) => {
    const issue = f.backlog.open({ title: s.title ?? `Task ${i + 1}`, body: 'x', author: 'example-owner', labels: ['ready'] });
    const branch = `${BRAND.cli}/issue-${issue}`;
    git(f.repo, 'checkout', '-q', '-b', branch, base);
    mkdirSync(dirname(join(f.repo, s.path)), { recursive: true });
    writeFileSync(join(f.repo, s.path), `export const v${i} = ${i};\n`);
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-q', '-m', `Task ${i + 1}`);
    const head = git(f.repo, 'rev-parse', 'HEAD');
    git(f.repo, 'checkout', '-q', 'main');
    f.log.append('issue.claimed', { issue, instance: 'alice', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'alice');
    return { issue, branch, head, title: s.title ?? `Task ${i + 1}` };
  });
  const opened: { issue: number; number: number; head: string }[] = [];
  return {
    f,
    async start() {
      for (const p of prs) {
        const pr = await f.backlog.openPr(p.branch, 'main', p.title, 'x', { headSha: p.head });
        f.log.append('pr.opened', { issue: p.issue, number: pr.number, url: pr.url, head: p.head, draft: false }, 'alice');
        f.log.append('eval.verdict', { issue: p.issue, head: p.head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'alice');
        f.backlog.setChecks(p.head, passing);
        opened.push({ issue: p.issue, number: pr.number, head: p.head });
      }
      const c = coordinator(f, agents(), { prPollMs: 0, autoMerge: () => true }) as unknown as Train;
      return { c, opened };
    },
    merged: () => f.log.read(0, ['merge.done']).map((e) => (e.payload as EventPayload<'merge.done'>).number),
  };
}

const plain = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `src/feature-${i + 1}.js` }));

test('merge train: four green non-protected PRs merge in one pass; a fifth waits for the next pass, not for the owner', { skip }, async () => {
  const t = train(plain(5));
  const { c, opened } = await t.start();
  await c.watchPrs();
  assert.deepEqual(t.merged(), opened.slice(0, 4).map((o) => o.number), 'the first four, in one pass');
  const fifth = opened[4]!.number;
  assert.ok(!t.f.backlog.prs().find((p) => p.number === fifth)!.merged, 'the fifth is not merged this pass');
  assert.equal(t.f.log.read(0, ['merge.failed']).length, 0, 'waiting for room is not a failure');
  assert.ok(!t.f.log.read(0, ['merge.decided']).some((e) => !(e.payload as EventPayload<'merge.decided'>).auto), 'nothing goes to the owner');
  await c.watchPrs();
  assert.deepEqual(t.merged(), opened.map((o) => o.number), 'the fifth merges on the next pass');
});

test('merge train: the cap is per instance (tests.yaml land.parallel_merges), validated by the schema', { skip }, async () => {
  assert.equal(TestsConfig.parse({ version: 1, runner: { kind: 'command', changed: 'x', full: 'x', one: 'x {file}' } }).land.parallel_merges, 4, 'default 4');
  const ok = TestsConfig.safeParse({ version: 1, runner: { kind: 'command', changed: 'x', full: 'x', one: 'x {file}' }, land: { parallel_merges: 2 } });
  assert.ok(ok.success && ok.data.land.parallel_merges === 2);
  for (const bad of [0, -1, 1.5, 17, '4']) assert.ok(!TestsConfig.safeParse({ version: 1, runner: { kind: 'command', changed: 'x', full: 'x', one: 'x {file}' }, land: { parallel_merges: bad } }).success, `${String(bad)} is refused`);
  const t = train(plain(3), (cfg) => void (cfg.tests.land.parallel_merges = 1));
  const { c, opened } = await t.start();
  await c.watchPrs();
  assert.deepEqual(t.merged(), [opened[0]!.number], 'one per pass at a cap of 1');
  await c.watchPrs();
  await c.watchPrs();
  assert.deepEqual(t.merged(), opened.map((o) => o.number));
});

test('merge train: a protected-path PR never merges and takes no place in the train', { skip }, async () => {
  const t = train([{ path: '.github/workflows/extra.yml' }, ...plain(5)]);
  const { c, opened } = await t.start();
  const [prot, ...rest] = opened;
  await c.watchPrs();
  assert.deepEqual(t.merged(), rest.slice(0, 4).map((o) => o.number), 'four plain PRs merge; the protected one took no place');
  const d = t.f.log.read(0, ['merge.decided']).map((e) => e.payload as EventPayload<'merge.decided'>).find((p) => p.number === prot!.number)!;
  assert.equal(d.auto, false);
  assert.match(d.reasons.join(), /high-risk: ci-config/);
  for (let i = 0; i < 3; i++) await c.watchPrs();
  assert.ok(!t.merged().includes(prot!.number), 'still waiting for the owner');
  assert.ok(t.merged().includes(rest[4]!.number));
});

test('merge train: a PR whose head moved after it was read is not merged, and nothing is asked of GitHub at the old head', { skip }, async () => {
  const t = train(plain(2));
  const { c, opened } = await t.start();
  const [a, b] = opened;
  const moved = 'e'.repeat(40);
  // A push lands on B's branch while the pass looks at B (after its head was read, before it merges).
  const checks = t.f.backlog.checks.bind(t.f.backlog);
  t.f.backlog.checks = async (sha: string) => {
    const r = await checks(sha);
    if (sha === b!.head) t.f.backlog.setPr(b!.number, { headSha: moved });
    return r;
  };
  const asked: { n: number; sha: string }[] = [];
  const mergePr = t.f.backlog.mergePr.bind(t.f.backlog);
  t.f.backlog.mergePr = (n, sha, title, body) => {
    asked.push({ n, sha });
    return mergePr(n, sha, title, body);
  };
  await c.watchPrs();
  assert.deepEqual(t.merged(), [a!.number]);
  assert.ok(!t.f.backlog.prs().find((p) => p.number === b!.number)!.merged, 'the moved PR is not merged');
  assert.ok(!asked.some((x) => x.n === b!.number), 'no merge call at the old head');
  assert.equal(t.f.log.read(0, ['merge.failed']).length, 0, 'not a failure: the new head is decided afresh');
  for (const x of asked) assert.equal(x.sha, opened.find((o) => o.number === x.n)!.head, 'every merge is pinned to the head it was decided at');
});

test('merge train: GitHub refusing a PR as not up to date (strict protection) is put off with a backoff, not retried in a loop', { skip }, async () => {
  const t = train(plain(1));
  const { c, opened } = await t.start();
  const n = opened[0]!.number;
  let now = Date.parse('2026-10-13T12:00:00Z');
  c.trainNow = () => now;
  let refuse = true;
  let calls = 0;
  const mergePr = t.f.backlog.mergePr.bind(t.f.backlog);
  t.f.backlog.mergePr = async (...a) => {
    calls++;
    return refuse ? { ok: false, why: 'Head branch is not up to date with the base branch' } : mergePr(...a);
  };
  for (let i = 0; i < 10; i++) await c.watchPrs();
  assert.equal(calls, 1, 'one merge call, however many passes run before the retry time');
  const deferred = () => t.f.log.read(0, ['merge.deferred']).map((e) => e.payload as EventPayload<'merge.deferred'>);
  assert.equal(deferred().length, 1);
  assert.equal(Date.parse(deferred()[0]!.retry_at) - now, DEFER_FIRST_MS);
  assert.equal(t.f.log.read(0, ['merge.failed']).length, 0, 'not a failure');
  assert.ok(!t.f.backlog.prs().find((p) => p.number === n)!.labels?.includes('needs-owner'), 'not the owner\'s call');
  now += DEFER_FIRST_MS + 1;
  for (let i = 0; i < 5; i++) await c.watchPrs();
  assert.equal(calls, 2, 'tried again once its time came');
  assert.equal(Date.parse(deferred()[1]!.retry_at) - now, 2 * DEFER_FIRST_MS, 'and put off longer');
  refuse = false;
  now += 2 * DEFER_FIRST_MS + 1;
  await c.watchPrs();
  assert.deepEqual(t.merged(), [n], 'merges once GitHub lets it');
});

test('merge train: a PR GitHub reports as behind is put off, never sent to the owner, and the merge API isn\'t called', { skip }, async () => {
  const t = train(plain(1));
  const { c, opened } = await t.start();
  const n = opened[0]!.number;
  t.f.backlog.setPr(n, { mergeableState: 'behind' });
  let calls = 0;
  const mergePr = t.f.backlog.mergePr.bind(t.f.backlog);
  t.f.backlog.mergePr = (...a) => {
    calls++;
    return mergePr(...a);
  };
  for (let i = 0; i < 5; i++) await c.watchPrs();
  assert.equal(calls, 0);
  assert.equal(t.f.log.read(0, ['merge.deferred']).length, 1, 'one deferral until its retry time');
  assert.ok(!t.f.log.read(0, ['merge.decided']).some((e) => !(e.payload as EventPayload<'merge.decided'>).auto), 'not the owner\'s call');
  const said = t.f.backlog.prs().find((p) => p.number === n)!.comments.filter((x) => /strict branch protection/.test(x.body));
  assert.equal(said.length, 1, 'said once why it waits');
});

test('merge train: merge subjects and messages never carry a handle or an e-mail address', { skip }, async () => {
  const t = train([{ path: 'src/a.js', title: 'Fix totals for @some-person (thanks other@example.com)' }]);
  const { c, opened } = await t.start();
  await c.watchPrs();
  const pr = t.f.backlog.prs().find((p) => p.number === opened[0]!.number)!;
  assert.ok(pr.merged);
  assert.equal(pr.mergeTitle, `Fix totals for (thanks) (#${opened[0]!.number})`);
  assert.doesNotMatch(`${pr.mergeTitle}\n${pr.mergeBody}`, /@|some-person|example\.com/);
});

test('mergeMessage: drops @handles and @org/team mentions and addresses, keeps the rest; never GitHub\'s own "from <owner>/<branch>"', () => {
  const m = (title: string) => mergeMessage({ title, number: 7, head: 'a'.repeat(40), product: 'P' });
  assert.equal(m('Add a guard').subject, 'Add a guard (#7)');
  assert.equal(m('@a-b: fix @org/team thing, cc x@example.com').subject, ': fix thing, cc (#7)');
  assert.equal(m('Keep `a@b` and foo@bar').subject, 'Keep `a@b` and foo@bar (#7)', 'not a handle or an address');
  assert.equal(m('@only').subject, 'Merge (#7)');
  assert.doesNotMatch(m('x').subject + m('x').body, /Merge pull request|from \S+\//);
});

test('mergeRefusal: GitHub\'s merge API refusals', () => {
  assert.equal(mergeRefusal('Head branch is not up to date with the base branch'), 'behind');
  assert.equal(mergeRefusal('Base branch was modified. Review and try the merge again.'), 'base_moved');
  assert.equal(mergeRefusal('Head branch was modified. Review and try the merge again.'), 'head_moved');
  assert.equal(mergeRefusal('Pull Request is not mergeable'), 'other');
  assert.equal(mergeRefusal('Required status check "ci" is expected.'), 'other');
});

test('deferDelay: 2 min, doubling, capped at 30 min', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(deferDelay), [2, 4, 8, 16, 30, 30, 30].map((m) => m * 60_000));
  assert.equal(deferDelay(1e9), DEFER_MAX_MS);
});

