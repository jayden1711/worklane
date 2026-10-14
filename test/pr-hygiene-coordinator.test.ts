// Stale PR hygiene in the coordinator (src/coordinator/pr-hygiene.ts), over a real git remote and a file backlog:
// a stale PR of the harness's gets main merged in (and then merges once green), a conflicting one goes to the
// conflict path (labelled, never forced), an abandoned one is closed with a comment (branch kept), and a person's
// PR, a held PR and a PR left to an owner are never touched. Each pass records its counts.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventPayload } from '../src/events/types.js';
import { prsView } from '../src/projection.js';
import { DEFAULT_COMMIT_IDENTITY } from '../src/runner.js';
import { approve, changeOnMain, conflictOnMain, git, green, openPr, skip, type OpenPr } from './repro-state-graph/harness.js';

const DAY = 86_400_000;

/** Move the pass's clock `days` ahead. */
const after = (t: OpenPr, days: number) => {
  (t.c as unknown as { hygieneNow: () => number }).hygieneNow = () => Date.now() + days * DAY;
};
const remoteMain = (t: OpenPr) => git(t.f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]!;
const lastPass = (t: OpenPr) => t.f.log.read(0, ['pr_hygiene.pass']).at(-1)!.payload as EventPayload<'pr_hygiene.pass'>;

test('a stale PR of the harness gets main merged in (a signed-off merge commit as the harness), is re-tested, and merges once green', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  const before = t.remoteHead();
  const tip = changeOnMain(t, 'README.md', (s) => `${s}\nmain moved on\n`);
  // Fresh: nothing to do.
  assert.equal((await t.c.prHygienePass())!.merged_in, 0);
  assert.equal(t.remoteHead(), before, 'a fresh PR is left as it is');
  after(t, 4);
  const counts = await t.c.prHygienePass();
  assert.deepEqual(counts, { merged_in: 1, conflicting: 0, closed: 0, held: 0, skipped: 0 });
  const head = t.remoteHead();
  assert.notEqual(head, before);
  git(t.f.repo, 'fetch', '-q', 'origin');
  assert.deepEqual(git(t.f.repo, 'rev-list', '--parents', '-n', '1', head).split(' ').slice(1), [before, tip], 'a merge commit of the PR head and main: no rebase, no force');
  assert.match(git(t.f.repo, 'log', '-1', '--format=%B', head), new RegExp(`Signed-off-by: ${DEFAULT_COMMIT_IDENTITY.name} <${DEFAULT_COMMIT_IDENTITY.email.replace(/[.+]/g, '\\$&')}>`));
  assert.equal(git(t.f.repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', head), `${DEFAULT_COMMIT_IDENTITY.name} <${DEFAULT_COMMIT_IDENTITY.email}>|${DEFAULT_COMMIT_IDENTITY.name} <${DEFAULT_COMMIT_IDENTITY.email}>`);
  assert.equal(remoteMain(t), tip, 'main is never pushed');
  const merged = t.f.log.read(0, ['pr_hygiene.merged_in']).at(-1)!.payload as EventPayload<'pr_hygiene.merged_in'>;
  assert.deepEqual({ ...merged, base_days: undefined }, { issue: t.n, number: t.opened.number, from: before, head, base_sha: tip, base_days: undefined });
  // The PR watch takes the new head: green on it, the evaluator's verdict on the head it was made on carries, and it merges.
  t.sync();
  await green(t);
  const done = t.f.log.read(0, ['merge.done']).map((e) => e.payload as EventPayload<'merge.done'>);
  assert.deepEqual(done.map((d) => d.head), [head], `merged at the merge-in head; decisions: ${JSON.stringify(t.f.log.read(0, ['merge.decided', 'pr.status']).map((e) => e.payload))}`);
});

test('a stale conflicting PR goes to the conflict path: labelled and told once, never forced', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { edit: (cfg) => (cfg.project.conflicts.fix = false) });
  const before = t.remoteHead();
  conflictOnMain(t);
  after(t, 4);
  assert.deepEqual(await t.c.prHygienePass(), { merged_in: 0, conflicting: 1, closed: 0, held: 0, skipped: 0 });
  assert.equal(t.remoteHead(), before, 'nothing pushed to a conflicting PR');
  assert.ok(t.pr().labels.includes('needs-owner'), `labelled; got ${t.pr().labels.join(', ')}`);
  const told = () => t.pr().comments.filter((c) => /conflicts with its base/.test(c.body)).length;
  assert.equal(told(), 1);
  // The next pass leaves it to the owner (held), and says nothing again.
  assert.deepEqual(await t.c.prHygienePass(), { merged_in: 0, conflicting: 0, closed: 0, held: 1, skipped: 0 });
  assert.equal(told(), 1);
  assert.equal(t.remoteHead(), before);
});

test('an abandoned PR (its task closed, quiet for abandon_after_days) is closed with a comment, its branch kept', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() });
  const before = t.remoteHead();
  changeOnMain(t, 'README.md', (s) => `${s}\nmain moved on\n`);
  await t.f.backlog.close(t.n);
  after(t, 5);
  // Stale with its task closed, but not quiet long enough: not merged in, not closed.
  assert.deepEqual(await t.c.prHygienePass(), { merged_in: 0, conflicting: 0, closed: 0, held: 0, skipped: 1 });
  assert.equal(t.pr().state, 'open');
  assert.equal(t.remoteHead(), before);
  after(t, 15);
  assert.deepEqual(await t.c.prHygienePass(), { merged_in: 0, conflicting: 0, closed: 1, held: 0, skipped: 0 });
  assert.equal(t.pr().state, 'closed');
  const comment = t.pr().comments.at(-1)!.body;
  assert.match(comment, /Closing this PR as abandoned: its task #\d+ is closed, and it has had no commit or comment for 1[45] days/);
  assert.equal(t.remoteHead(), before, 'the branch is kept');
  assert.equal((t.f.log.read(0, ['pr.closed']).at(-1)!.payload as EventPayload<'pr.closed'>).number, t.opened.number);
  // Closed: no longer watched, so the next pass doesn't see it.
  assert.deepEqual(await t.c.prHygienePass(), { merged_in: 0, conflicting: 0, closed: 0, held: 0, skipped: 0 });
});

test("a person's PR is never touched, however stale", { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() });
  // A person's branch and PR, from the same old base.
  const dir = join(mkdtempSync(join(tmpdir(), 'person-')), 'c');
  git(t.f.base, 'clone', '-q', t.f.remote, dir);
  git(dir, 'checkout', '-q', '-b', 'someone/change');
  writeFileSync(join(dir, 'PERSON.md'), 'mine\n');
  git(dir, 'add', 'PERSON.md');
  git(dir, '-c', 'user.email=p@example.com', '-c', 'user.name=Person', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'A person change');
  git(dir, 'push', '-q', 'origin', 'someone/change');
  const personHead = git(dir, 'rev-parse', 'HEAD');
  const theirs = await t.f.backlog.openPr('someone/change', 'main', 'A person change', 'mine', { headSha: personHead });
  changeOnMain(t, 'README.md', (s) => `${s}\nmain moved on\n`);
  after(t, 30);
  await t.c.prHygienePass();
  assert.equal(git(t.f.repo, 'ls-remote', 'origin', 'refs/heads/someone/change').split('\t')[0], personHead, "a person's branch is never pushed");
  const pr = t.f.backlog.prs().find((p) => p.number === theirs.number)!;
  assert.equal(pr.state, 'open');
  assert.deepEqual(pr.comments, []);
  assert.deepEqual(pr.labels, []);
  assert.ok(!lastPass(t).prs.some((p) => p.number === theirs.number), 'not even looked at');
  assert.ok(lastPass(t).prs.some((p) => p.number === t.opened.number && p.outcome === 'merged_in'), "the harness's own stale PR was");
});

test('a held PR, one left to an owner, or one someone else pushed to is never updated or closed, only counted', { skip }, async () => {
  for (const hold of ['label', 'decided', 'pushed'] as const) {
    const t = await openPr({ 'evaluator-verdict': approve() });
    changeOnMain(t, 'README.md', (s) => `${s}\nmain moved on\n`);
    if (hold === 'label') await t.f.backlog.addLabels(t.opened.number, ['hold']);
    if (hold === 'decided') t.f.log.append('merge.decided', { issue: t.n, number: t.opened.number, head: t.opened.head, auto: false, reasons: ['high-risk: auth'] }, 'test');
    if (hold === 'pushed') t.f.backlog.setPr(t.opened.number, { headSha: 'e'.repeat(40) });
    await t.f.backlog.close(t.n); // abandoned too, were it not held
    const head = t.remoteHead();
    after(t, 30);
    assert.deepEqual(await t.c.prHygienePass(), { merged_in: 0, conflicting: 0, closed: 0, held: 1, skipped: 0 }, hold);
    assert.equal(t.remoteHead(), head, `${hold}: not updated`);
    assert.equal(t.pr().state, 'open', `${hold}: not closed`);
    assert.equal(t.pr().comments.length, 0, `${hold}: nothing said`);
  }
});

test('the counts are reported: one pass event per pass, on the timer, and the latest on the PR page', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() });
  changeOnMain(t, 'README.md', (s) => `${s}\nmain moved on\n`);
  const passes = () => t.f.log.read(0, ['pr_hygiene.pass']).length;
  const n0 = passes();
  assert.ok(n0 >= 1, 'the first tick ran a pass');
  await t.c.tick();
  assert.equal(passes(), n0, 'not again within every_hours');
  after(t, 4);
  await t.c.tick();
  assert.equal(passes(), n0 + 1, 'due again after every_hours: the timer runs it');
  assert.deepEqual({ ...lastPass(t), prs: lastPass(t).prs.map((p) => [p.number, p.outcome]) }, { merged_in: 1, conflicting: 0, closed: 0, held: 0, skipped: 0, prs: [[t.opened.number, 'merged_in']] });
  const view = prsView(t.f.log.read());
  assert.equal(view.hygiene?.line, '1 merged in, 0 conflicting, 0 closed, 0 held for an owner, 0 skipped');
});
