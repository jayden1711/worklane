// A dashboard with one open decision of every kind and a PR held for a person, each with the detail its asker records
// (src/decision-context.ts) and the log around it, for the decision detail tests (test/decision-detail.test.ts and
// test/decision-detail-chrome.test.ts). Real git commits for the diff, a file backlog for the PR body.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { changeContext, investigationContext, summaryContext } from '../src/decision-context.js';
import { EventLog } from '../src/events/log.js';
import { RunRecorder } from '../src/run-record.js';
import { exampleProject, exampleRoles } from './helpers.js';

/** Text only the owners may see: a check's output and the tamper guard's flag. */
export const OWNER_ONLY = { tail: 'OWNERONLY-TAIL not ok 3 - refunds round', tamper: 'OWNERONLY-TAMPER test/refund.test.js weakened' };
/** Text no viewer may see: the agents' own words and findings. */
export const WRITERS_ONLY = ['WRITERSONLY-SUMMARY the lock is freed late', 'WRITERSONLY-CLAIM lock freed on the second sweep', 'WRITERSONLY-ADVICE check the refund path', 'WRITERSONLY-REASON did not run the refund path'];
export const PR_BODY = ['Intent paragraph.', '', '## Fail-without', 'Without the fix, `node --test dist/test/refund.test.js` fails: 1 of 3.', '', '## What this can never do', '- It never refunds twice.', '', '## Tests', 'npm test'].join('\n');

/** Every kind's decision id in the fixture; `pr` is the held PR's. */
export const KINDS = ['land', 'investigation', 'question', 'domain', 'plan', 'intake', 'delegation', 'pr'] as const;

export async function decisionFixture() {
  const { dir: root } = exampleProject();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  const base = git('rev-parse', 'HEAD');
  mkdirSync(join(root, 'src', 'billing'), { recursive: true });
  mkdirSync(join(root, 'src', 'auth'), { recursive: true });
  writeFileSync(join(root, 'src', 'billing', 'refund.js'), 'export const refund = (cents) => Math.round(cents);\n');
  writeFileSync(join(root, 'src', 'auth', 'session.js'), 'export const ttl = 3600;\n');
  git('add', 'src');
  git('commit', '-q', '-m', 'refund rounding');
  const head = git('rev-parse', 'HEAD');

  const dir = mkdtempSync(join(tmpdir(), 'decision-detail-'));
  const stateDir = join(dir, 'state');
  const eventsDb = join(dir, 'events.db');
  const backlog = new FileBacklog(join(dir, 'backlog.json'));
  const pr = await backlog.openPr('agent/issue-8', 'main', 'Round refunds to the cent', PR_BODY, { headSha: head });

  const log = new EventLog(eventsDb);
  const a = (type: string, payload: unknown) => log.append(type as never, payload as never, 'coordinator');
  const titles = ['Refunds round wrong', 'Why is the claim stale?', 'Pick the refund threshold', 'Fetch the rates', 'Split the orders table', '', '', 'Round refunds to the cent'];
  titles.forEach((title, i) => title && a('issue.seen', { issue: i + 1, title, labels: [], author: 'example-owner', owner: 'example-owner', actionable: true, why: 'ok' }));
  const files = [
    { path: 'src/billing/refund.js', added: 1, removed: 0 },
    { path: 'src/auth/session.js', added: 1, removed: 0 },
  ];
  const ask = (id: string, kind: string, issue: number | null, question: string, options: string[], recommendation: string, receipts: string[], context?: unknown) =>
    a('decision.asked', { id, kind, issue, owner: 'example-owner', question, options, recommendation, receipts, ...(context ? { context } : {}) });
  ask('d-land', 'land', 1, 'Approve landing #1 (L3)?', ['approve', 'reject'], 'approve', [`head ${head.slice(0, 8)}`, 'money-path: src/billing/refund.js'], changeContext({
    base,
    head,
    files,
    level: { level: 'L3', reasons: ['money-path: src/billing/refund.js', 'auth: src/auth/session.js'], categories: { 'money-path': ['src/billing/refund.js'], auth: ['src/auth/session.js'], 'app-non-money': ['src/auth/session.js'] } },
    verdict: { patch_correct: true, test_correct: true, confidence: 'medium', advice: WRITERS_ONLY[2]!, confidence_reason: WRITERS_ONLY[3]! },
    checks: [{ check: 'test', status: 'fail', duration_ms: 1200, tail: OWNER_ONLY.tail }, { check: 'lint', status: 'pass', duration_ms: 300 }],
    tampered: [OWNER_ONLY.tamper],
  }));
  ask('d-inv', 'question', 2, 'How should this proceed?', ['approve-fix', 'investigate-more', 'close'], 'approve-fix', ['confidence high', '1 finding(s)', 'Recommendation: Free it in the first sweep.'], investigationContext({ summary: WRITERS_ONLY[0]!, findings: [{ claim: WRITERS_ONLY[1]!, evidence: 'src/reconcile.js:472 frees the lock only on the second sweep' }], confidence: 'high', unverified: ['whether a crash mid-sweep is common'] }));
  ask('d-ask', 'question', 3, 'Which refund threshold?', ['$50', '$75'], '', ['Need the threshold.', 'Recommendation: The fixtures decide it.'], summaryContext('Need the threshold before the refund rule.'));
  ask('d-domain', 'domain', 4, 'Allow rates.example.org for the repo?', ['allow-repo', 'allow-once', 'deny'], 'deny', ['the run asked for it while fetching rates']);
  ask('d-plan', 'plan', 5, 'Approve the plan for #5?', ['approve', 'revise', 'reject'], 'approve', ['3 steps, touches migrations']);
  a('plan.posted', { issue: 5, plan: { steps: [] }, held: true, reasons: ['touches migrations'], comments_at: 0, decision: 'd-plan' });
  ask('d-intake', 'intake', null, 'File this report (via email) as an issue: "Refund button does nothing"?', ['approve', 'edit', 'reject'], 'approve', ['intake:r1']);
  ask('d-deleg', 'delegation', null, 'Stop waiting for you on docs changes? 12 PRs in a row were approved unchanged', ['loosen', 'keep'], 'loosen', ['12 clean']);

  // The held PR, as the log has it: proposed, levelled, evaluated, checked, opened, its CI, and the merge policy's call.
  a('change.proposed', { issue: 8, branch: 'agent/issue-8', base, head, files: files.map((f) => f.path), lines: 2, patch_hash: 'p1' });
  a('review.level_set', { issue: 8, head, level: 'L3', reasons: ['money-path: src/billing/refund.js'] });
  a('eval.verdict', { issue: 8, head, patch_hash: 'p1', patch_correct: true, test_correct: true, confidence: 'high', advice: 'fine' });
  a('check.result', { issue: 8, head, stage: 'verify', checks: [{ check: 'test', status: 'pass', exitCode: 0, duration_ms: 900, tail: OWNER_ONLY.tail }] });
  a('pr.opened', { issue: 8, number: pr.number, url: `https://github.com/example/shop/pull/${pr.number}`, head, draft: false });
  a('pr.status', { issue: 8, number: pr.number, head, ready: true, reasons: [], checks: [{ name: 'test', outcome: 'pass' }, { name: 'lint', outcome: 'fail' }] });
  a('merge.decided', { issue: 8, number: pr.number, head, auto: false, reasons: ['money-path: src/billing/refund.js'], why: [{ category: 'money path', text: 'changes how money moves: src/billing/refund.js' }] });

  // The land decision's task: a run Claude refused the login on (#473), and the login held since.
  a('run.finished', { issue: 1, role: 'worker', reason: 'auth_failed', detail: 'API Error: 401 authentication_error' });
  a('claude_auth.failed', { key: 'local:refused', login: 'example@account', lane: 'default', issue: 1, role: 'worker', detail: 'Invalid API key' });
  log.close();
  const run = new RunRecorder(stateDir, { role: 'worker', model: 'sonnet', cwd: join(root, '.claude', 'worktrees', 'issue-1'), issue: 1 });
  run.finish({ reason: 'auth_failed', costUsd: 0, turns: 1, model: 'sonnet', detail: 'API Error: 401' });

  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots'), backlog: () => backlog, machineStats: () => null });
  const ids: Record<(typeof KINDS)[number], string> = { land: 'd-land', investigation: 'd-inv', question: 'd-ask', domain: 'd-domain', plan: 'd-plan', intake: 'd-intake', delegation: 'd-deleg', pr: `pr-${pr.number}` };
  return { d, root, base, head, ids, pr: pr.number, base_url: d.url.split('/?')[0]! };
}
