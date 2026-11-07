// #784 round 10: the alignment's size cap. A hunk too large to align character by character is aligned by its lines
// first, then line by line where a run of changed lines pairs up (a rename or reflow of each), so a large tested
// refactor merges; a run that still doesn't fit holds the PR with the exact reason, and one just under the cap is placed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import type { PullRequest } from '../src/backlog/types.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { FakeRunner } from '../src/runner.js';
import * as vacuity from '../src/vacuity.js';
import { exampleProject } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
type Run = { tests: string[]; appPaths: string[] };
type Gate = { mergeDecisionFor(n: number, number: number, pr: PullRequest): { auto: boolean; reasons: string[]; vacuityRun?: Run }; vacuityRun(w: EventPayload<'pr.opened'>, pr: PullRequest, run: Run): Promise<void> };

function commit(dir: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'step');
  return git(dir, 'rev-parse', 'HEAD');
}

async function decided(before: Record<string, string>, after: Record<string, string>) {
  const dir = exampleProject().dir;
  const base = commit(dir, { 'dist/.keep': '', ...before });
  const head = commit(dir, after);
  const bare = join(dir, '..', 'origin.git');
  git(join(dir, '..'), 'init', '-q', '--bare', bare);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', '--force', 'origin', `${base}:refs/heads/main`);
  git(dir, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  cfg.review.merge.max_lines = 10_000;
  const log = new EventLog(join(dir, '..', 'events.db'));
  log.append('issue.claimed', { issue: 7, instance: 'i', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'i');
  const w = { issue: 7, number: 9, url: 'u', head, draft: false };
  log.append('pr.opened', w, 'i');
  log.append('eval.verdict', { issue: 7, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true }) as unknown as Gate;
  const p: PullRequest = { number: 9, url: 'u', head: 'b', base: 'main', headSha: head, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' };
  const first = c.mergeDecisionFor(7, 9, p);
  if (first.vacuityRun) await c.vacuityRun(w, p, first.vacuityRun);
  return c.mergeDecisionFor(7, 9, p);
}

const H = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHI';

/**
 * `n` lines of exactly 40 characters (no whitespace), each its own; `tag` keeps one set apart from another, and the
 * removed set's letters run backwards, so the two share no start or end but the last `;`.
 */
const block = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${String(i).padStart(3, '0')}${tag === 'r' ? [...LETTERS].reverse().join('') : LETTERS};`);

test('the cap: a run of 50 removed lines rewritten as 51 can\'t be placed; 49 as 50, just under, can', () => {
  // 50 lines against 51, 40 characters each: about 2,000 by 2,040 cells, past ALIGN_CELLS (4,000,000).
  for (const [n, placed] of [[50, false], [49, true]] as const) {
    const added = block(n + 1, 'a');
    const text = `${added.join('\n')}\n`;
    const r = vacuity.codeRanges(text, [{ at: 0, added: added.map((_, k) => k + 1), removed: block(n, 'r') }]);
    assert.equal(r !== null, placed, `${n} lines`);
    assert.ok((40 * n) * (40 * (n + 1)) > vacuity.ALIGN_CELLS === !placed);
  }
});

test('the cap, at the gate: a function body rewritten past it holds the PR with the exact reason', async () => {
  const body = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `  const ${tag}${i} = '${LETTERS}${i}';`).join('\n');
  const before = `export function f() {\n${body(55, 'r')}\n  return 1;\n}\n`;
  const after = `export function f() {\n${body(56, 'a')}\n  return 1;\n}\n`;
  const d = await decided({ 'src/f.js': before }, { 'src/f.js': after, 'test/x.test.js': `${H}import { f } from '../src/f.js';\ntest('f', () => { assert.equal(f(), 1); });\n` });
  assert.deepEqual([d.auto, d.reasons], [false, ['design: vacuity: its coverage run failed: a change too large to align character by character, so where it changed code can\'t be told']]);
});

test('a tested rename refactor of 90 lines, past the cap as one block, is aligned line by line and merges', async () => {
  const body = (v: string) => [`  const ${v}0 = 1;`, ...Array.from({ length: 89 }, (_, i) => `  const ${v}${i + 1} = ${v}${i} + ${i + 1} * 2;`), `  return ${v}89;`].join('\n');
  const before = `export function f() {\n${body('value')}\n}\n`;
  const after = `export function f() {\n${body('total')}\n}\n`;
  const t = `${H}import { f } from '../src/f.js';\ntest('f', () => { assert.ok(f() > 0); });\n`;
  const d = await decided({ 'src/f.js': before }, { 'src/f.js': after, 'test/x.test.js': t });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});
