// Fix-forward wired into the coordinator, with real git: two PRs that are each green alone but conflict semantically
// (one renames a function, the other starts calling it by its old name), auto-merged one after the other. The
// default branch goes red on the second (CI here runs the project's real tests on the commit: `node --test`), and
// fix-forward opens a fix task whose PR goes through the normal gates, the culprit attached. A fix that is green
// merges (the only PR that may while the branch is red) and the branch is green again: no revert. A fix whose CI
// fails: the culprit's revert PR, for a human.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import type { EventPayload } from '../src/events/types.js';
import type { RunRequest } from '../src/runner.js';
import { agents, approve, commitAll, coordinator, fixture, git, lastOf, skip } from './repro-state-graph/harness.js';

// A clean environment for the project's own tests: inside node --test, NODE_TEST_CONTEXT would make them report to this run instead.
const ciEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const RENAME = 'Rename totalCents to totalInCents';
const REPORT = 'Add an order report';

/** The worker: the rename (issue `rename`), the report (calling totalCents, which the rename renames), and the fix task's fix. */
const worker = (rename: number, report: number) => (req: RunRequest) => {
  const at = (p: string) => join(req.cwd, p);
  const issue = Number(/issue-(\d+)/.exec(req.cwd)?.[1]);
  if (issue !== rename && issue !== report) {
    writeFileSync(at('src/report.js'), readFileSync(at('src/report.js'), 'utf8').replaceAll('totalCents', 'totalInCents'));
    // With a test of its own that calls the fixed code: a fix with no test waits for the owner (#784's vacuity gate).
    writeFileSync(at('test/report-renamed.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { orderLine } from '../src/report.js';\ntest('order line after the rename', () => { assert.equal(orderLine([{ cents: 3, qty: 3 }]), 'total: 9'); });\n");
    commitAll(req.cwd, 'Call totalInCents in the report');
    return { summary: 'the report calls the renamed function' };
  }
  if (issue === rename) {
    writeFileSync(at('src/price.js'), readFileSync(at('src/price.js'), 'utf8').replaceAll('totalCents', 'totalInCents'));
    // The test imports the renamed function under its old local name, so its assertion lines stay as they are: a
    // rename that changes an assertion line waits for the owner (#783), and this scenario is about the merge after it.
    const t = readFileSync(at('test/price.test.js'), 'utf8');
    const renamed = t.replace('totalCents }', 'totalInCents as totalCents }');
    assert.notEqual(renamed, t, 'the test imports totalCents');
    writeFileSync(at('test/price.test.js'), renamed);
    commitAll(req.cwd, RENAME);
    return { summary: 'renamed' };
  }
  writeFileSync(at('src/report.js'), "import { totalCents } from './price.js';\nexport const orderLine = (items) => `total: ${totalCents(items)}`;\n");
  writeFileSync(at('test/report.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { orderLine } from '../src/report.js';\ntest('order line', () => { assert.equal(orderLine([{ cents: 5, qty: 2 }]), 'total: 10'); });\n");
  commitAll(req.cwd, REPORT);
  return { summary: 'added the report' };
};

async function redAfterTwoMerges() {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = ['ci'];
  f.cfg.project.fix_forward.max_attempts = 1;
  f.cfg.agents.roles.ci_repair = { enabled: false, model: 'sonnet', max_fixes_per_pr: 0 };
  // No combined check before merging (config.yaml combined_check: false): nothing tests the two together before they
  // land, as when GitHub merges each on its own green checks. Only main's CI after the second merge sees it.
  f.cfg.project.combined_check = false;
  const body = (what: string) => `${what}.\n\n\`\`\`done_when\n- suite: full\n\`\`\`\n`;
  const a = f.backlog.open({ title: RENAME, body: body(RENAME), author: 'example-owner', labels: ['ready'] });
  const b = f.backlog.open({ title: REPORT, body: body(REPORT), author: 'example-owner', labels: ['ready'] });
  const c = coordinator(f, agents({ worker: worker(a, b), 'evaluator-verdict': approve() }), { prPollMs: 0, autoMerge: () => true });
  f.backlog.mergeWith = (pr) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'gh-merge-')), 'c');
    git(f.base, 'clone', '-q', f.remote, dir);
    git(dir, 'fetch', '-q', 'origin', pr.head);
    git(dir, '-c', 'user.email=gh@example.com', '-c', 'user.name=GitHub', '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', '-m', `Merge pull request #${pr.number}`, pr.headSha);
    git(dir, 'push', '-q', 'origin', 'main');
    const sha = git(dir, 'rev-parse', 'HEAD');
    rmSync(dir, { recursive: true, force: true });
    return sha;
  };
  // "GitHub's CI": the project's real tests on the commit, as the required check `ci` (with its log).
  let id = 100;
  const ci = (sha: string, force?: 'failure') => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ci-')), 'c');
    git(f.base, 'clone', '-q', f.remote, dir);
    git(dir, 'fetch', '-q', 'origin', sha);
    git(dir, 'checkout', '-q', sha);
    let ok = true;
    let out = '';
    try {
      out = execFileSync('node', ['--test', '--test-reporter=spec'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ciEnv });
    } catch (e) {
      ok = false;
      out = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`;
    }
    rmSync(dir, { recursive: true, force: true });
    if (force) ok = false;
    f.backlog.setChecks(sha, [{ name: 'ci', source: 'check_run', status: 'completed', conclusion: ok ? 'success' : 'failure', id: ++id }]);
    f.backlog.setJobLog(id, out || '(no output)');
    return ok;
  };
  const before = git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]!;
  assert.equal(ci(before), true, 'main is green to start with');
  for (let i = 0; i < 12 && f.log.read(0, ['pr.opened']).length < 2; i++) {
    await c.tick();
    await c.idle();
  }
  const opened = f.log.read(0, ['pr.opened']).map((e) => e.payload as EventPayload<'pr.opened'>);
  const prA = opened.find((o) => o.issue === a)!;
  const prB = opened.find((o) => o.issue === b)!;
  assert.ok(prA && prB, 'both PRs open');
  assert.equal(ci(prA.head), true, 'the rename is green alone');
  assert.equal(ci(prB.head), true, 'the report is green alone');
  // Auto-merged one after the other; CI runs on each merge commit as it lands.
  const judged = new Set<string>();
  const runCi = () => {
    for (const e of f.log.read(0, ['merge.done'])) {
      const m = e.payload as EventPayload<'merge.done'>;
      if (!judged.has(m.sha)) judged.add(m.sha) && ci(m.sha);
    }
  };
  for (let i = 0; i < 8 && !f.log.read(0, ['fix_forward.started']).length; i++) {
    await c.tick();
    await c.idle();
    runCi();
  }
  const merged = f.log.read(0, ['merge.done']).map((e) => e.payload as EventPayload<'merge.done'>);
  assert.deepEqual(merged.map((m) => m.number), [prA.number, prB.number], 'merged one after the other');
  return { f, c, a, b, prA, prB, merged, ci, runCi };
}

/** Ticks until the fix task's PR is open; returns it. */
async function fixPrOpens(t: Awaited<ReturnType<typeof redAfterTwoMerges>>, issue: number) {
  for (let i = 0; i < 8 && !t.f.log.read(0, ['pr.opened']).some((e) => (e.payload as EventPayload<'pr.opened'>).issue === issue); i++) {
    await t.c.tick();
    await t.c.idle();
  }
  const pr = t.f.log.read(0, ['pr.opened']).map((e) => e.payload as EventPayload<'pr.opened'>).find((p) => p.issue === issue);
  assert.ok(pr, `the fix task opened its PR (events: ${[...new Set(t.f.log.read().map((e) => e.type))].join(', ')})`);
  return pr;
}

async function redAndFixTask() {
  const t = await redAfterTwoMerges();
  const [mA, mB] = t.merged;
  assert.equal((t.f.log.read(0, ['merge.main_result']).map((e) => e.payload as EventPayload<'merge.main_result'>).find((r) => r.sha === mA!.sha))!.outcome, 'green', 'main green after the rename');
  const red = t.f.log.read(0, ['merge.main_result']).map((e) => e.payload as EventPayload<'merge.main_result'>).find((r) => r.sha === mB!.sha)!;
  assert.deepEqual({ outcome: red.outcome, failed: red.failed }, { outcome: 'red', failed: ['ci'] }, 'red after the report: the two together break');
  const started = lastOf(t.f.log, 'fix_forward.started') as EventPayload<'fix_forward.started'>;
  assert.deepEqual({ sha: started.sha, last_green: started.last_green }, { sha: mB!.sha, last_green: mA!.sha });
  const culprit = lastOf(t.f.log, 'fix_forward.culprit') as EventPayload<'fix_forward.culprit'>;
  assert.deepEqual({ culprit: culprit.culprit, number: culprit.number, revert_first: culprit.revert_first }, { culprit: mB!.sha, number: t.prB.number, revert_first: [] });
  assert.equal(existsSync(join(t.f.stateDir, 'auto-merge-stopped.json')), false, 'no stop: it is fixed forward');
  assert.ok(!t.f.backlog.prs().some((p) => p.head.includes('revert')), 'no revert PR yet');
  const attempt = lastOf(t.f.log, 'fix_forward.attempt') as EventPayload<'fix_forward.attempt'>;
  const issue = await t.f.backlog.get(attempt.issue);
  assert.equal(issue.title, `Fix main: ci red since #${t.prB.number}`);
  assert.match(issue.body, /totalCents/, 'the failing log is in the task');
  assert.match(issue.body, /\+import \{ totalCents \} from '\.\/price\.js';/, "the culprit's diff");
  assert.match(issue.body, new RegExp(`- #${t.prB.number} .*${REPORT}`), 'the merged PRs');
  const fixPr = await fixPrOpens(t, attempt.issue);
  assert.ok((await t.f.backlog.comments(fixPr.number)).some((x) => new RegExp(`Culprit: #${t.prB.number}`).test(x.body)), 'the culprit is attached to the fix PR');
  return { ...t, attempt, fixPr };
}

test('fix-forward, real git: two PRs green alone, merged one after the other, break main together: a fix PR is opened, and its green merge makes main green again (no revert)', { skip }, async () => {
  const t = await redAndFixTask();
  assert.equal(t.ci(t.fixPr.head), true, "the fix is green on CI");
  for (let i = 0; i < 6 && !t.f.log.read(0, ['fix_forward.green']).length; i++) {
    await t.c.tick();
    await t.c.idle();
    t.runCi();
  }
  const fixMerge = t.f.log.read(0, ['merge.done']).map((e) => e.payload as EventPayload<'merge.done'>).find((m) => m.number === t.fixPr.number);
  assert.ok(fixMerge, 'the fix PR auto-merged through the normal gates');
  const fin = lastOf(t.f.log, 'fix_forward.finished') as EventPayload<'fix_forward.finished'>;
  assert.deepEqual({ outcome: fin.outcome, by: fin.by, culprit: fin.culprit, revert: fin.revert }, { outcome: 'fixed', by: t.fixPr.number, culprit: t.prB.number, revert: null });
  assert.equal((lastOf(t.f.log, 'fix_forward.green') as EventPayload<'fix_forward.green'>).fixed_by, t.fixPr.number);
  assert.ok(!t.f.backlog.prs().some((p) => p.head.includes('revert')), 'no revert PR');
  assert.match(git(t.f.repo, 'show', `${fixMerge.sha}:src/report.js`), /totalInCents/);
});

test('fix-forward, real git: the fix PR fails its CI: the culprit is reverted (a revert PR for a human, with the evidence), auto-merge stopped', { skip }, async () => {
  const t = await redAndFixTask();
  t.ci(t.fixPr.head, 'failure');
  for (let i = 0; i < 6 && !t.f.log.read(0, ['fix_forward.finished']).length; i++) {
    await t.c.tick();
    await t.c.idle();
  }
  assert.ok(!t.f.log.read(0, ['merge.done']).some((e) => (e.payload as EventPayload<'merge.done'>).number === t.fixPr.number), 'the red fix never merged');
  const failed = lastOf(t.f.log, 'fix_forward.attempt_failed') as EventPayload<'fix_forward.attempt_failed'>;
  assert.match(failed.why, new RegExp(`its PR #${t.fixPr.number}'s checks fail`));
  const fin = lastOf(t.f.log, 'fix_forward.finished') as EventPayload<'fix_forward.finished'>;
  assert.equal(fin.outcome, 'reverted');
  const revert = t.f.backlog.prs().find((p) => p.head === `${BRAND.cli}/revert-pr-${t.prB.number}`)!;
  assert.ok(revert, 'the revert PR of the culprit');
  assert.equal(fin.revert?.number, revert.number);
  assert.equal(revert.title, `Revert "${REPORT} (#${t.b})" (#${t.prB.number})`);
  assert.throws(() => git(t.f.repo, 'show', `${revert.headSha}:src/report.js`), 'the revert takes the report out');
  assert.match(git(t.f.repo, 'show', `${revert.headSha}:src/price.js`), /totalInCents/, 'and keeps the rename (not the culprit)');
  assert.match(revert.body, /Why a revert: no fix turned main green within 1 attempt/, 'the evidence: why');
  assert.match(revert.body, new RegExp(`attempt 1 \\(#${t.attempt.issue}\\): its PR #${t.fixPr.number}'s checks fail`), 'the evidence: the fix attempt');
  assert.match(revert.body, new RegExp(`culprit #${t.prB.number}`));
  const comments = await t.f.backlog.comments(revert.number);
  assert.ok(comments.some((x) => new RegExp(`reverts #${t.prB.number}`).test(x.body)));
  assert.ok(revert.labels.includes('needs-owner'));
  assert.ok(existsSync(join(t.f.stateDir, 'auto-merge-stopped.json')), 'auto-merge stopped until the operator clears it');
  assert.ok(!t.c.watchedPrs().some((w) => w.number === revert.number), 'the revert is never watched, so never auto-merged');
});
