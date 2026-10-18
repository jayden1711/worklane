import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { BRAND } from '../src/brand.js';
import { checkDraftedIssue } from '../src/backlog/types.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { FakeRunner } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(edit: (cfg: ReturnType<typeof loadConfig>) => void) {
  const base = mkdtempSync(join(tmpdir(), 'delegation-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  const cfg = loadConfig(repo);
  cfg.review!.categories = { ...cfg.review!.categories, copy: ['copy/**'] };
  cfg.review!.delegation = { enabled: true, min_clean: 3 };
  edit(cfg);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const log = new EventLog(join(base, 'events.db'));
  const c = new Coordinator({ cfg, log, backlog, runner: new FakeRunner(() => ({})), repo, instance: 'alice', stateDir: join(base, 'state'), slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  let n = 0;
  /**
   * A harness PR that changed `file`, merged; `corrected`: a writer requested changes on it first. `pr`: its number
   * (a PR the backlog has); `before`: what happened to it before it merged.
   */
  const merged = (file: string, o: { corrected?: boolean; pr?: number; before?: (p: { issue: number; pr: number; head: string }) => void } = {}) => {
    n++;
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), `change ${n}\n`);
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.email=c@example.com', '-c', 'user.name=c', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `change ${n}`);
    const head = git(repo, 'rev-parse', 'HEAD');
    const issue = 100 + n;
    const pr = o.pr ?? 200 + n;
    log.append('issue.claimed', { issue, instance: 'alice', lease: head, base: baseSha, owner: 'example-owner' }, 'test');
    log.append('pr.opened', { issue, number: pr, url: 'u', head, draft: false }, 'test');
    if (o.corrected) log.append('correction.recorded', { key: `review:${pr}`, kind: 'review_changes', issue, pr, by: 'example-owner', text: 't' }, 'test');
    o.before?.({ issue, pr, head });
    log.append('pr.closed', { issue, number: pr, merged: true }, 'test');
    return pr;
  };
  const of = (type: Parameters<EventLog['read']>[1] extends (infer U)[] | undefined ? U : never) => log.read(0, [type]).map((e) => e.payload as Record<string, unknown>);
  return { cfg, log, backlog, c, merged, of };
}

test('a waiting category with min_clean PRs merged unchanged is proposed for loosening once, with the evidence; loosen files the review.yaml change', async () => {
  const t = fixture((cfg) => void (cfg.review!.merge.wait_categories = ['copy']));
  t.merged('copy/a.md');
  t.merged('copy/b.md');
  await t.c.checkDelegation();
  assert.equal(t.of('delegation.suggested').length, 0, 'two is not enough');
  t.merged('copy/c.md');
  await t.c.checkDelegation();
  assert.deepEqual(t.of('delegation.observed').map((p) => [p.categories, p.unchanged]).every(([c, u]) => (c as string[]).includes('copy') && u), true);
  const s = t.of('delegation.suggested');
  assert.deepEqual(s.map((p) => [p.category, p.direction]), [['copy', 'loosen']]);
  const asked = t.of('decision.asked').at(-1)!;
  assert.deepEqual([asked.kind, asked.issue, asked.options, asked.id], ['delegation', null, ['loosen', 'keep'], s[0]!.decision]);
  assert.ok((asked.receipts as string[]).some((r) => /PR #203 \(#103\): clean/.test(r)), 'the evidence');
  await t.c.checkDelegation();
  assert.equal(t.of('delegation.suggested').length, 1, 'never asked twice while it waits');
  assert.equal(t.cfg.review!.merge.wait_categories.includes('copy'), true, 'nothing loosened without an answer');
  t.log.append('decision.answered', { id: s[0]!.decision as string, by: 'example-owner', answer: 'loosen' }, 'test');
  await t.c.checkDelegation();
  const d = t.of('delegation.decided')[0]!;
  assert.deepEqual([d.category, d.answer], ['copy', 'loosen']);
  const filed = await t.backlog.get(d.issue as number);
  assert.equal(filed.title, 'Review: stop waiting for the owner on copy changes');
  assert.equal(checkDraftedIssue(filed.title, filed.body).ok, true);
  assert.deepEqual(filed.labels, ['ready']);
});

test('a PR a writer asked to change breaks the clean record; protected categories are never proposed; off by default', async () => {
  const t = fixture((cfg) => void (cfg.review!.merge.wait_categories = ['copy']));
  t.merged('copy/a.md');
  t.merged('copy/b.md', { corrected: true });
  t.merged('copy/c.md');
  await t.c.checkDelegation();
  assert.equal(t.of('delegation.suggested').length, 0);
  const p = fixture((cfg) => void (cfg.review!.merge.wait_categories = ['migration']));
  for (const f of ['migrations/1.sql', 'migrations/2.sql', 'migrations/3.sql']) p.merged(f);
  await p.c.checkDelegation();
  assert.equal(p.of('delegation.suggested').length, 0, 'migration can never be loosened');
  const off = fixture((cfg) => {
    cfg.review!.merge.wait_categories = ['copy'];
    cfg.review!.delegation.enabled = false;
  });
  for (const f of ['copy/a.md', 'copy/b.md', 'copy/c.md']) off.merged(f);
  await off.c.checkDelegation();
  assert.equal(off.of('delegation.observed').length, 0);
});

test('a loosened category whose PR was reverted is proposed for tightening; keep changes nothing', async () => {
  const t = fixture((cfg) => {
    cfg.review!.merge.wait_categories = [];
    cfg.review!.merge.loosened = ['copy'];
  });
  const pr = t.merged('copy/a.md');
  t.log.append('merge.stopped', { reason: 'main went red', number: pr, sha: null, revert: 'file://pr/9' }, 'test');
  await t.c.checkDelegation();
  const s = t.of('delegation.suggested');
  assert.deepEqual(s.map((p) => [p.category, p.direction]), [['copy', 'tighten']]);
  t.log.append('decision.answered', { id: s[0]!.decision as string, by: 'example-owner', answer: 'keep' }, 'test');
  await t.c.checkDelegation();
  assert.deepEqual(t.of('delegation.decided').map((p) => [p.answer, p.issue]), [['keep', null]]);
  assert.equal((await t.backlog.list('ready')).length, 0);
});

test('each merged PR records whether it waited for a person, who approved it (and as what) and how long that took; the suggestion carries it; nothing is loosened', async () => {
  const t = fixture((cfg) => void (cfg.review!.merge.wait_categories = ['copy']));
  const waits = (p: { issue: number; pr: number; head: string }) => t.log.append('merge.decided', { issue: p.issue, number: p.pr, head: p.head, auto: false, reasons: ['copy waits for the owner'] }, 'test');
  const later = (ms: number) => new Date(Date.now() + ms).toISOString();
  // A writer's approving review on GitHub, 90 minutes after it started waiting (a changes-requested review before it doesn't count).
  const reviewed = (await t.backlog.openPr('b1', 'main', 'copy a', 'b')).number;
  t.merged('copy/a.md', {
    pr: reviewed,
    before: (p) => {
      waits(p);
      t.backlog.addReview(reviewed, { author: 'example-owner', state: 'COMMENTED', body: 'hm', at: later(10 * 60_000) });
      t.backlog.addReview(reviewed, { author: 'example-collaborator', state: 'APPROVED', body: 'ok', at: later(90 * 60_000) });
    },
  });
  // The owner's approval from Discord.
  t.merged('copy/b.md', { before: (p) => (waits(p), t.log.append('merge.approved', { issue: p.issue, number: p.pr, head: p.head, by: 'example-owner', via: 'discord' }, 'test')) });
  // Merged by hand on GitHub with no review: whoever merged it approved it.
  const byHand = (await t.backlog.openPr('b3', 'main', 'copy c', 'b')).number;
  t.backlog.setPr(byHand, { merged: true, closedBy: 'example-owner' });
  t.merged('copy/c.md', { pr: byHand, before: waits });
  // Auto-merged: it waited for nobody.
  t.merged('copy/d.md', { before: (p) => void t.log.append('merge.decided', { issue: p.issue, number: p.pr, head: p.head, auto: true, reasons: [] }, 'test') });
  // Held at an earlier head, then auto-merged at the head that merged: nobody approved it.
  t.merged('copy/e.md', {
    before: (p) => {
      waits({ ...p, head: 'b'.repeat(40) });
      t.log.append('merge.decided', { issue: p.issue, number: p.pr, head: p.head, auto: true, reasons: [] }, 'test');
    },
  });
  // Its landing was asked and a writer approved it on the dashboard; then the harness merged it.
  t.merged('copy/f.md', {
    before: (p) => {
      t.log.append('decision.asked', { id: 'land-1', kind: 'land', issue: p.issue, owner: 'example-owner', question: 'Approve landing?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'test');
      t.log.append('decision.answered', { id: 'land-1', by: 'example-collaborator', answer: 'approve', role: 'writer' }, 'test');
      t.log.append('merge.decided', { issue: p.issue, number: p.pr, head: p.head, auto: true, reasons: [] }, 'test');
      t.log.append('merge.done', { issue: p.issue, number: p.pr, head: p.head, sha: p.head, url: 'u', title: 't' }, 'test');
    },
  });
  await t.c.checkDelegation();
  const o = t.of('delegation.observed');
  assert.deepEqual(
    o.map((p) => [p.held, p.approved_by, p.approver_role]),
    [
      [true, 'example-collaborator', 'writer'],
      [true, 'example-owner', 'owner'],
      [true, 'example-owner', 'owner'],
      [false, null, null],
      [false, null, null],
      [true, 'example-collaborator', 'writer'],
    ],
  );
  assert.ok(Math.abs((o[0]!.wait_ms as number) - 90 * 60_000) < 60_000, `${o[0]!.wait_ms}`);
  assert.equal(typeof o[1]!.wait_ms, 'number');
  assert.equal(o[3]!.wait_ms, null);
  const asked = t.of('decision.asked').at(-1)!;
  assert.equal(asked.kind, 'delegation');
  const receipts = asked.receipts as string[];
  assert.ok(receipts.some((r) => /^Time to approve: median .* over the 4 PRs that waited for a person/.test(r)), receipts.join('\n'));
  assert.ok(receipts.includes('Approved unchanged, by who approved: @example-collaborator (writer) 2 of 2, @example-owner (owner) 2 of 2'), receipts.join('\n'));
  assert.ok(receipts.some((r) => /^PR #\d+ \(#101\): clean, approved by @example-collaborator \(writer\) after 1h 30m$/.test(r)), receipts.join('\n'));
  assert.deepEqual(t.cfg.review!.merge.wait_categories, ['copy'], 'never loosened automatically');
  assert.deepEqual(t.cfg.review!.merge.loosened ?? [], []);
});

test('only someone with a role here, approving the hold at the merged head, is the approver: never an outsider, a bot, the harness, an earlier head or an approval from before the hold', async () => {
  const t = fixture((cfg) => {
    cfg.review!.merge.wait_categories = ['copy'];
    // The harness's own account (the file backlog's actor) even has a role here: still never the approver.
    cfg.project.owners.writers = [...cfg.project.owners.writers, 'coordinator'];
  });
  const waits = (p: { issue: number; pr: number; head: string }) => t.log.append('merge.decided', { issue: p.issue, number: p.pr, head: p.head, auto: false, reasons: ['copy waits for the owner'] }, 'test');
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const pr = async (b: string, closedBy: string) => {
    const n = (await t.backlog.openPr(b, 'main', b, 'b')).number;
    t.backlog.setPr(n, { merged: true, closedBy });
    return n;
  };
  // An outsider's and a bot's approving reviews; a writer merged it by hand.
  const drive = await pr('b1', 'example-collaborator');
  t.merged('copy/a.md', {
    pr: drive,
    before: (p) => {
      waits(p);
      t.backlog.addReview(drive, { author: 'drive-by-outsider', state: 'APPROVED', body: 'lgtm', at: at(60_000) });
      t.backlog.addReview(drive, { author: 'some-app[bot]', state: 'APPROVED', body: 'lgtm', at: at(120_000) });
    },
  });
  // The owner approved an earlier head on Discord; held again at the merged head, a writer merged it by hand.
  const moved = await pr('b2', 'example-collaborator');
  t.merged('copy/b.md', {
    pr: moved,
    before: (p) => {
      waits({ ...p, head: 'b'.repeat(40) });
      t.log.append('merge.approved', { issue: p.issue, number: p.pr, head: 'b'.repeat(40), by: 'example-owner', via: 'discord' }, 'test');
      waits(p);
    },
  });
  // The owner approved an hour before the hold; a writer merged it by hand.
  const early = await pr('b3', 'example-collaborator');
  t.backlog.addReview(early, { author: 'example-owner', state: 'APPROVED', body: 'ok', at: at(-3_600_000) });
  t.merged('copy/c.md', { pr: early, before: waits });
  // Merged by the harness's own account with no merge.done logged (a crash between the merge and the record).
  const own = await pr('b4', 'coordinator');
  await t.backlog.comment(own, `[${BRAND.cli}] @example-owner ready, and waits for you to review and merge`);
  t.merged('copy/d.md', { pr: own, before: waits });
  await t.c.checkDelegation();
  const o = t.of('delegation.observed');
  assert.deepEqual(
    o.map((p) => [p.held, p.approved_by, p.approver_role]),
    [
      [true, 'example-collaborator', 'writer'],
      [true, 'example-collaborator', 'writer'],
      [true, 'example-collaborator', 'writer'],
      [true, null, null],
    ],
  );
  assert.ok(o.slice(0, 3).every((p) => typeof p.wait_ms === 'number' && p.wait_ms >= 0 && p.wait_ms < 60_000), JSON.stringify(o.map((p) => p.wait_ms)));
});

test('the tick checks delegation', async () => {
  const t = fixture((cfg) => void (cfg.review!.merge.wait_categories = ['copy']));
  for (const f of ['copy/a.md', 'copy/b.md', 'copy/c.md']) t.merged(f);
  await t.c.tick();
  assert.equal(t.of('delegation.suggested').length, 1);
});
