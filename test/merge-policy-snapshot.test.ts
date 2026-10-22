// #1005: one merge decision reads every policy input it takes from the default branch at one commit, its tip fetched
// at the decision's start: the money-path list as well as the registered checks. A clone whose remote-tracking default
// branch is older than the remote's (the list gained a path since its last fetch) must not decide on the older list.
// Scratch repos only; no repo file is read or edited.
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
import { DEFAULT_REVIEW } from '../src/coordinator/shared.js';
import { EventLog } from '../src/events/log.js';
import { HIGH_RISK_REASON } from '../src/merge-policy.js';
import { WEAKENING_REASON } from '../src/merge-policy-weakening.js';
import { FakeRunner } from '../src/runner.js';
import { exampleProject } from './helpers.js';

const LIST = 'money-paths.txt';
const CHARGE = 'web/pay/charge.js';
const TOTALS = 'web/totals.js';

/**
 * A project whose origin's default branch added web/pay/** to the money-path list after the clone's last fetch: the
 * clone's refs/remotes/origin/main is still the base (the tip was pushed by the remote's path, not its name). The PR,
 * claimed on the base, writes `change`. `unreachable`: the remote can't be fetched by the time the decision runs.
 */
function decide(change: Record<string, string>, o: { unreachable?: boolean } = {}) {
  const dir = exampleProject().dir;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    }
    g('add', '-A');
    g('commit', '-q', '-m', 'step');
    return g('rev-parse', 'HEAD');
  };
  const base = commit({ [LIST]: 'web/billing/**\n', [CHARGE]: 'export const fee = 1;\n', [TOTALS]: 'export const total = 1;\n' });
  const origin = join(dir, '..', 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'ignore' });
  g('remote', 'add', 'origin', origin);
  g('push', '-q', 'origin', `${base}:refs/heads/main`);
  g('fetch', '-q', 'origin');
  g('checkout', '-q', '-b', 'tip');
  const tip = commit({ [LIST]: 'web/billing/**\nweb/pay/**\n' });
  // By the remote's path, not its name: the clone's remote-tracking main stays at the base, as after a last fetch
  // made before the default branch moved.
  g('push', '-q', origin, `${tip}:refs/heads/main`);
  assert.equal(g('rev-parse', 'refs/remotes/origin/main'), base, 'fixture: the clone has not fetched the new list');
  g('checkout', '-q', '-b', 'pr', base);
  const head = commit(change);
  if (o.unreachable) g('remote', 'set-url', 'origin', join(dir, '..', 'gone.git'));
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ ...DEFAULT_REVIEW, money_path_source: { file: LIST } });
  const log = new EventLog(join(dir, '..', 'events.db'));
  try {
    const n = 7;
    log.append('issue.claimed', { issue: n, instance: 'i', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'i');
    log.append('pr.opened', { issue: n, number: 9, url: 'u', head, draft: false }, 'i');
    log.append('eval.verdict', { issue: n, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
    const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true, lockScope: () => 'engine' });
    const pr: PullRequest = { number: 9, url: 'u', head: 'pr', base: 'main', headSha: head, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' };
    return c.mergeDecisionFor(n, 9, pr);
  } finally {
    log.close();
  }
}

const moneyReason = (reasons: string[]) => reasons.some((r) => r.startsWith(`${HIGH_RISK_REASON}money-path`) && r.includes(CHARGE));

test('a PR touching a path the default branch added to the money-path list since the last fetch waits, high-risk: money-path', () => {
  const d = decide({ [CHARGE]: 'export const fee = 0;\n' });
  assert.equal(d.auto, false, d.reasons.join(' | '));
  assert.ok(moneyReason(d.reasons), d.reasons.join(' | '));
});

test('control: the same remote, a PR touching an unrelated app file still merges', () => {
  const d = decide({ [TOTALS]: 'export const total = 2;\n' });
  assert.deepEqual(d.reasons, []);
  assert.equal(d.auto, true);
});

test("a default branch that can't be fetched still makes the decision wait (as before: the tip can't be read)", () => {
  const d = decide({ [TOTALS]: 'export const total = 2;\n' }, { unreachable: true });
  assert.equal(d.auto, false, d.reasons.join(' | '));
  assert.ok(d.reasons.some((r) => r.startsWith(WEAKENING_REASON) && r.includes("the default branch's current tip couldn't be read")), d.reasons.join(' | '));
});
