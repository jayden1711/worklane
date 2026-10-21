// #784 round 10: a shutdown that cuts a fetch of the default branch short decides nothing, whether it is the watch
// pass's fetch or the fresh one for a PR about to merge (a failed fetch would otherwise hold every PR of the pass, or
// that PR at its head, until the owner acts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FileBacklog } from '../src/backlog/file.js';
import type { PullRequest } from '../src/backlog/types.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { FakeRunner } from '../src/runner.js';
import { exampleProject } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
type Inner = {
  mergeOrWait(w: EventPayload<'pr.opened'>, pr: PullRequest): Promise<void>;
  watchPrs(): Promise<void>;
  defaultTipFetched(): Promise<string | null>;
  tipThisPass: string | null | undefined;
  tipFetchMs: number;
  tipCheckedAt: number;
  stop(): void;
};

function write(dir: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'step');
  return git(dir, 'rev-parse', 'HEAD');
}

/** A ready PR (a docs change) with a bare remote at its base; then the remote is made one that never answers. */
async function world() {
  const dir = exampleProject().dir;
  const base = write(dir, { 'docs/a.md': 'a\n' });
  const bare = join(dir, '..', 'origin.git');
  git(join(dir, '..'), 'init', '-q', '--bare', bare);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', '--force', 'origin', `${base}:refs/heads/main`);
  git(dir, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  git(dir, 'checkout', '-q', '-b', 'pr-7');
  const head = write(dir, { 'docs/a.md': 'b\n' });
  git(dir, 'push', '-q', 'origin', 'pr-7');
  git(dir, 'checkout', '-q', 'main');
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  const log = new EventLog(join(dir, '..', 'events.db'));
  const backlog = new FileBacklog(join(dir, '..', 'b.json'));
  const c = new Coordinator({ cfg, log, backlog, runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true }) as unknown as Inner;
  const { number } = await backlog.openPr('pr-7', 'main', 'PR 7', '', { headSha: head });
  log.append('issue.claimed', { issue: 7, instance: 'i', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'i');
  const w = { issue: 7, number, url: 'u', head, draft: false };
  log.append('pr.opened', w, 'i');
  log.append('eval.verdict', { issue: 7, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
  backlog.setPr(number, { mergeableState: 'clean' });
  const pr = await backlog.pullRequest(number);
  // The pass fetched main before the remote stopped answering.
  const tip = await c.defaultTipFetched();
  git(dir, 'remote', 'set-url', 'origin', 'ssh://never.invalid/repo.git');
  git(dir, 'config', 'core.sshCommand', "sh -c 'sleep 30' --");
  c.tipFetchMs = 20_000;
  return { c, log, w, pr, tip };
}

const decisions = (log: EventLog) => log.read(0, ['merge.decided', 'merge.done']).length;

test('shutdown during the fresh fetch for a PR about to merge: nothing is decided for it', async () => {
  const t = await world();
  t.c.tipThisPass = t.tip;
  const t0 = performance.now();
  const going = t.c.mergeOrWait(t.w, t.pr);
  setTimeout(() => t.c.stop(), 300);
  await going;
  assert.ok(performance.now() - t0 < 10_000, 'the fetch was stopped');
  assert.equal(decisions(t.log), 0, 'no hold and no merge recorded');
});

test('shutdown during the watch pass\'s fetch: the pass decides nothing', async () => {
  const t = await world();
  // The ls-remote of watchPrs' tip check is skipped (just done).
  t.c.tipCheckedAt = Date.now();
  const t0 = performance.now();
  const going = t.c.watchPrs();
  setTimeout(() => t.c.stop(), 300);
  await going;
  assert.ok(performance.now() - t0 < 10_000, 'the fetch was stopped');
  assert.equal(decisions(t.log), 0, 'no hold and no merge recorded');
});
