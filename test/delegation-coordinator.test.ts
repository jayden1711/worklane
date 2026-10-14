import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
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
  /** A harness PR that changed `file`, merged; `corrected`: a writer requested changes on it first. */
  const merged = (file: string, o: { corrected?: boolean } = {}) => {
    n++;
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), `change ${n}\n`);
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.email=c@example.com', '-c', 'user.name=c', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `change ${n}`);
    const head = git(repo, 'rev-parse', 'HEAD');
    const issue = 100 + n;
    const pr = 200 + n;
    log.append('issue.claimed', { issue, instance: 'alice', lease: head, base: baseSha, owner: 'example-owner' }, 'test');
    log.append('pr.opened', { issue, number: pr, url: 'u', head, draft: false }, 'test');
    if (o.corrected) log.append('correction.recorded', { key: `review:${pr}`, kind: 'review_changes', issue, pr, by: 'example-owner', text: 't' }, 'test');
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

test('the tick checks delegation', async () => {
  const t = fixture((cfg) => void (cfg.review!.merge.wait_categories = ['copy']));
  for (const f of ['copy/a.md', 'copy/b.md', 'copy/c.md']) t.merged(f);
  await t.c.tick();
  assert.equal(t.of('delegation.suggested').length, 1);
});
