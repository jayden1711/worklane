// #784 round 9 (the round-8 final check, issuecomment-6319641923, and second review, issuecomment-6319508586): a PR
// about to merge is decided again on the default branch fetched then, not on the tip the watch pass fetched at its
// start (#869's weakening check read a fresh tip for every decision on main; W1 and the two-PRs-in-one-pass shape);
// and the pass's fetch from a remote that never answers is killed, holding nothing.
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
  defaultTipFetched(): Promise<string | null>;
  tipThisPass: string | null | undefined;
  tipFetchMs: number;
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

const P = 'test/rules.test.ts';
const table = (rows: string[], mark?: string) => `import { test } from 'node:test';\n${mark ? `// check-table: ${mark}\n` : ''}export const NEW_ALLOWED = [\n${rows.map((r) => `  '${r}',`).join('\n')}\n];\ntest('t', () => {});\n`;

/** The example project with a bare remote whose main is at the base; a coordinator over it; PRs opened on it. */
function world() {
  const dir = exampleProject().dir;
  const base = write(dir, { [P]: table(['a', 'b']) });
  const bare = join(dir, '..', 'origin.git');
  git(join(dir, '..'), 'init', '-q', '--bare', bare);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', '--force', 'origin', `${base}:refs/heads/main`);
  git(dir, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  const log = new EventLog(join(dir, '..', 'events.db'));
  const backlog = new FileBacklog(join(dir, '..', 'b.json'));
  const c = new Coordinator({ cfg, log, backlog, runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true });
  /** A PR for issue `n` on its own branch from the base, ready to merge. */
  const open = async (n: number, files: Record<string, string>) => {
    git(dir, 'checkout', '-q', '-b', `pr-${n}`, base);
    const head = write(dir, files);
    git(dir, 'push', '-q', 'origin', `pr-${n}`);
    git(dir, 'checkout', '-q', 'main');
    const { number } = await backlog.openPr(`pr-${n}`, 'main', `PR ${n}`, '', { headSha: head });
    log.append('issue.claimed', { issue: n, instance: 'i', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'i');
    const w = { issue: n, number, url: 'u', head, draft: false };
    log.append('pr.opened', w, 'i');
    log.append('eval.verdict', { issue: n, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
    backlog.setPr(number, { mergeableState: 'clean' });
    return { w, pr: await backlog.pullRequest(number), head };
  };
  return { dir, base, log, backlog, c, inner: c as unknown as Inner, open };
}

const merged = (log: EventLog, number: number) => log.read(0, ['merge.done']).some((e) => (e.payload as { number: number }).number === number);
const heldFor = (log: EventLog, number: number) => log.read(0, ['merge.decided']).map((e) => e.payload as EventPayload<'merge.decided'>).filter((p) => p.number === number && !p.auto).flatMap((p) => p.reasons);

test('W1: a mark lands on main after the pass fetched its tip: the PR that grows that table is held, never merged on the old tip', async () => {
  const t = world();
  const grows = await t.open(7, { [P]: table(['a', 'b', 'c']) });
  // The pass fetched main at the base; then the mark landed on main.
  t.inner.tipThisPass = await t.inner.defaultTipFetched();
  git(t.dir, 'checkout', '-q', '-b', 'marked', t.base);
  const marked = write(t.dir, { [P]: table(['a', 'b'], 'never-grow') });
  git(t.dir, 'push', '-q', '--force', 'origin', `${marked}:refs/heads/main`);
  git(t.dir, 'checkout', '-q', 'main');
  await t.inner.mergeOrWait(grows.w, grows.pr);
  assert.equal(merged(t.log, grows.w.number), false, 'never merged on the tip the pass fetched');
  assert.ok(heldFor(t.log, grows.w.number).some((r) => r.includes('weaken')), JSON.stringify(heldFor(t.log, grows.w.number)));
});

test('two PRs in one pass: the first merges and brings a mark to main; the second, held only by that mark, waits', async () => {
  const t = world();
  const marks = await t.open(7, { [P]: table(['a', 'b'], 'never-grow') });
  const grows = await t.open(8, { [P]: table(['a', 'b', 'c']) });
  t.inner.tipThisPass = await t.inner.defaultTipFetched();
  await t.inner.mergeOrWait(marks.w, marks.pr);
  assert.equal(merged(t.log, marks.w.number), true, 'the first merges');
  // Its merge lands on main, as GitHub's does.
  git(t.dir, 'push', '-q', '--force', 'origin', `${marks.head}:refs/heads/main`);
  await t.inner.mergeOrWait(grows.w, grows.pr);
  assert.equal(merged(t.log, grows.w.number), false);
  assert.ok(heldFor(t.log, grows.w.number).some((r) => r.includes('weaken')), JSON.stringify(heldFor(t.log, grows.w.number)));
});

test('the pass\'s fetch from a remote that never answers is killed at its limit, and the event loop is free meanwhile', async () => {
  const t = world();
  // An ssh remote whose transport never answers.
  git(t.dir, 'remote', 'set-url', 'origin', 'ssh://never.invalid/repo.git');
  git(t.dir, 'config', 'core.sshCommand', "sh -c 'sleep 30' --");
  t.inner.tipFetchMs = 1_000;
  let stall = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    stall = Math.max(stall, now - last);
    last = now;
  }, 10);
  const t0 = performance.now();
  const tip = await t.inner.defaultTipFetched();
  const took = performance.now() - t0;
  clearInterval(tick);
  assert.equal(tip, null);
  assert.ok(took < 5_000, `the fetch took ${Math.round(took)} ms`);
  assert.ok(stall < 500, `the event loop was held ${Math.round(stall)} ms`);
});
